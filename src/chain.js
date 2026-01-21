import { OpenAI } from "openai";
import client from "./config/mongoDB.config.js";
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();
const HF_API_URL = "https://cmtan04-movie-chatbot.hf.space/embed";
const HF_API_TOKEN = process.env.HF_API_TOKEN || "";
const HIDE_OVERVIEW = process.env.HIDE_OVERVIEW === '1';

// 1. Cấu hình danh sách Model dự phòng (Ưu tiên từ trên xuống dưới)
const MODEL_PRIORITY_LIST = [

    "meta-llama/llama-3.3-70b-instruct:free",      // Ưu tiên 1: Đa năng nhất
    "z-ai/glm-4.5-air:free",                // Ưu tiên 2: Hiểu tiếng Việt sâu
    "qwen/qwen-2.5-vl-7b-instruct:free",     // Ưu tiên 3: Xử lý cực tốt nếu có HÌNH ẢNH/VIDEO
    "xiaomi/mimo-v2-flash:free"             // Ưu tiên 4: Tốc độ siêu nhanh

];

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "MovieDB Chatbot",
    }
});

export class RAGChain {
    constructor() {
        // Lưu conversation history theo sessionId/userId
        this.sessions = new Map();
        this.MAX_HISTORY = 10; // Giữ tối đa 10 messages gần nhất
    }

    getSession(sessionId = 'default') {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, [
                {
                    role: "system",
                    content: "Bạn là trợ lý ảo MovieDB chuyên về phim ảnh. Bạn có khả năng nhớ các câu hỏi trước đó trong cuộc trò chuyện. Chỉ dùng dữ liệu được cung cấp để trả lời một cách chính xác và chi tiết. BẮT BUỘC trả lời bằng tiếng Việt. Nếu người dùng hỏi về thông tin từ câu hỏi trước, hãy tham khảo lịch sử hội thoại. Khi trả lời, hãy luôn dựa trên dữ liệu được cung cấp và không bịa ra thông tin."
                }
            ]);
        }
        return this.sessions.get(sessionId);
    }

    clearSession(sessionId = 'default') {
        this.sessions.delete(sessionId);
    }

    async run(userQuery, sessionId = 'default') {
        // Lấy conversation history cho session này
        const conversationHistory = this.getSession(sessionId);

        // HYBRID SEARCH: kết hợp vector (semantic) + regex (keyword)
        let searchResults = await this.performHybridSearch(userQuery);

        console.log(`📋 Search Results for "${userQuery}":`, {
            count: searchResults.length,
            titles: searchResults.map(m => m.title),
            hasMetadata: searchResults.map(m => !!m.title && !!m.overview)
        });

        // Xây context với thêm metadata (đạo diễn, diễn viên, năm, điểm)
        let contextData = searchResults.map((m, i) => {
            const director = m?.cast_crew_full?.crew?.find(p => p.job === 'Director')?.name || "Không rõ";
            const topCast = (m?.cast_crew_full?.cast || []).slice(0, 3).map(c => c.name).join(', ');
            const base = `Phim ${i + 1}: ${m.title} | Năm: ${m.release_date || 'Không rõ'} | Điểm: ${m.vote_average || 'N/A'} | Đạo diễn: ${director} | Diễn viên: ${topCast}`;
            if (!HIDE_OVERVIEW) {
                return `${base} | Nội dung: ${m.overview}`;
            }
            return base;
        }).join("\n");

        console.log(`📝 Context Data:\n${contextData}`);

        const finalPrompt = contextData
            ? `Dữ liệu phim:\n${contextData}\n\nCâu hỏi: ${userQuery}`
            : `Câu hỏi: ${userQuery}`;

        conversationHistory.push({ role: "user", content: finalPrompt });

        // Giới hạn history (giữ system message + 10 messages gần nhất)
        if (conversationHistory.length > this.MAX_HISTORY + 1) {
            conversationHistory.splice(1, conversationHistory.length - this.MAX_HISTORY - 1);
        }

        // --- CƠ CHẾ FALLBACK TỰ ĐỘNG ---
        for (const modelName of MODEL_PRIORITY_LIST) {
            try {
                console.log(`🚀 [SYSTEM] Đang thử với model: ${modelName}...`);

                const response = await openai.chat.completions.create({
                    model: modelName,
                    messages: conversationHistory,
                    temperature: 0.7,
                });

                const aiMessage = response.choices[0].message.content;
                conversationHistory.push({ role: "assistant", content: aiMessage });

                console.log(`✅ [SYSTEM] Thành công với model: ${modelName}`);
                return aiMessage;

            } catch (error) {
                console.error(`❌ [ERROR] Model ${modelName} gặp lỗi:`, error.message);
                console.warn(`⚠️ [WARNING] Model ${modelName} bị lỗi hoặc hết lượt. Đang đổi model tiếp theo...`);
                // Nếu là model cuối cùng mà vẫn lỗi thì mới báo lỗi thật
                if (modelName === MODEL_PRIORITY_LIST[MODEL_PRIORITY_LIST.length - 1]) {
                    throw new Error("Tất cả các model đều không phản hồi.");
                }
            }
        }
    }

    // Tổng hợp kết quả từ TMDB hoặc Google thành câu trả lời tự nhiên
    async synthesizeAnswer(userQuery, contextData) {
        try {
            const prompt = `Dựa trên thông tin sau đây, hãy trả lời câu hỏi của người dùng một cách tự nhiên, chi tiết và có cấu trúc rõ ràng bằng tiếng Việt:

                            ${contextData}

                            Câu hỏi: ${userQuery}

                            Hãy tổng hợp thông tin trên thành câu trả lời mạch lạc, dễ hiểu. Nếu có nhiều phim/kết quả, liệt kê ngắn gọn từng item với thông tin quan trọng nhất. Hãy chắc chắn rằng câu trả lời của bạn hoàn toàn dựa trên dữ liệu được cung cấp.`;

            const response = await openai.chat.completions.create({
                model: MODEL_PRIORITY_LIST[0],
                messages: [
                    {
                        role: "system",
                        content: "Bạn là trợ lý phim ảnh thông minh. Tổng hợp thông tin được cung cấp thành câu trả lời tự nhiên, chính xác và dễ hiểu. Trả lời bằng tiếng Việt."
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
            });

            return response.choices[0].message.content;
        } catch (error) {
            console.error("❌ Lỗi synthesize answer:", error.message);
            throw error;
        }
    }

    // Regex search mở rộng nhiều trường: title, overview, genres, keywords, homepage, release_date, cast, crew
    async performSearch(query) {
        if (!query) return [];
        const db = client.db("movie_bot");
        const collection = db.collection("movies");
        const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);
        if (keywords.length === 0) return [];

        // Tạo regex patterns cho mỗi keyword
        const regexPatterns = keywords.map(k => new RegExp(k, 'i'));

        // Tạo các điều kiện $or cho từng keyword
        const orConditions = [];

        for (const pattern of regexPatterns) {
            orConditions.push({ title: pattern });
            orConditions.push({ overview: pattern });
            orConditions.push({ genres: pattern });
            orConditions.push({ keywords: pattern });
            orConditions.push({ 'cast_crew_full.cast.name': pattern });
            orConditions.push({ 'cast_crew_full.crew.name': pattern });
        }

        const chunks = await collection.find({
            $and: [
                { $or: orConditions },
                { isChunk: true }
            ]
        }).limit(30).toArray();

        console.log(`🔍 Regex search for "${query}": found ${chunks.length} chunks`);

        // Nhóm chunks theo phim
        return this.groupChunksByMovie(chunks);
    }

    // Vector search ưu tiên: Atlas $vectorSearch nếu có; fallback tính cosine similarity phía Node
    async performVectorSearch(query) {
        if (!query) return [];
        const db = client.db("movie_bot");
        const collection = db.collection("movies");

        const embedding = await this.getQueryEmbedding(query);
        if (!embedding || !Array.isArray(embedding) || embedding.length === 0) return [];

        // Thử dùng Aggregation $vectorSearch (cần index 'movies_embedding_index')
        try {
            const pipeline = [
                {
                    $vectorSearch: {
                        index: 'movies_embedding_index',
                        path: 'embedding',
                        queryVector: embedding,
                        numCandidates: 100,
                        limit: 20,  // Giảm để nhanh hơn
                    }
                },
                {
                    $project: {
                        title: 1,
                        movieTitle: 1,
                        overview: 1,
                        genres: 1,
                        keywords: 1,
                        release_date: 1,
                        vote_average: 1,
                        cast_crew_full: 1,
                        chunkIndex: 1,
                        chunkText: 1,
                        isChunk: 1,
                        _score: { $meta: 'vectorSearchScore' }
                    }
                }
            ];
            const results = await collection.aggregate(pipeline).toArray();
            if (results && results.length) return this.groupChunksByMovie(results);
        } catch (e) {
            // Nếu chưa cấu hình Vector Search, sẽ fall back phía Node
        }

        // Fallback: tính cosine similarity phía Node (ít hiệu năng nhưng hoạt động với dataset nhỏ)
        const docs = await collection.find({}, {
            projection: {
                title: 1, movieTitle: 1, overview: 1, genres: 1, keywords: 1, release_date: 1,
                vote_average: 1, cast_crew_full: 1, embedding: 1, chunkIndex: 1, chunkText: 1, isChunk: 1
            }
        }).toArray();

        const scored = docs
            .filter(d => Array.isArray(d.embedding))
            .map(d => ({ ...d, _score: this.cosineSimilarity(embedding, d.embedding) }))
            .sort((a, b) => b._score - a._score)
            .slice(0, 20)  // Giảm từ 50 → 20
            .map(({ embedding: _emb, ...rest }) => rest);

        return this.groupChunksByMovie(scored);
    }

    // Nhóm chunks cùng phim, ưu tiên chunk có score cao nhất
    async groupChunksByMovie(results) {
        const movieMap = new Map();

        for (const chunk of results) {
            const movieTitle = chunk.movieTitle || chunk.title;
            const existing = movieMap.get(movieTitle);

            // Lấy chunk có _score cao nhất
            if (!existing || (chunk._score && chunk._score > (existing._score || 0))) {
                movieMap.set(movieTitle, chunk);
            }
        }

        // Lấy các movie title từ chunks
        const movieTitles = Array.from(movieMap.keys());
        console.log(`🎬 Extracting ${movieTitles.length} movies from chunks:`, movieTitles);

        // Query MongoDB để lấy đầy đủ movie objects
        const db = client.db("movie_bot");
        const collection = db.collection("movies");

        try {
            // Thử query: lấy documents có title match (có thể là full movies hoặc chunks)
            const movies = await collection.find({
                title: { $in: movieTitles }
            }).limit(5).toArray();

            console.log(`✅ Retrieved ${movies.length} documents:`, movies.map(m => m.title));

            // Filter để lấy những document có đầy đủ metadata (không phải chunks)
            // Chunks thường ngắn, movies thường có overview dài
            const fullMovies = movies.filter(m =>
                m.overview && m.overview.length > 50 &&
                (m.cast_crew_full || m.genres)
            );

            if (fullMovies.length > 0) {
                console.log(`✅ Filtered to ${fullMovies.length} full movie documents`);
                return fullMovies;
            }

            // Nếu không filter được, trả về tất cả (fallback)
            console.log(`⚠️ No full movie documents found, returning all documents`);
            return movies.length > 0 ? movies : Array.from(movieMap.values()).slice(0, 5);
        } catch (error) {
            console.error(`❌ Error querying movies:`, error.message);
            return Array.from(movieMap.values()).slice(0, 5);
        }
    }

    async getQueryEmbedding(text) {
        try {
            const headers = { 'Content-Type': 'application/json' };
            const resp = await axios.post(HF_API_URL, { inputs: text }, { headers });

            // Hugging Face API trả về array hoặc nested array
            const data = resp.data;
            if (Array.isArray(data)) {
                // Nếu là array 1 chiều (embedding trực tiếp)
                if (typeof data[0] === 'number') return data;
                // Nếu là nested array (batch)
                if (Array.isArray(data[0])) return data[0];
            }
            return null;
        } catch (err) {
            console.error('Lỗi lấy embedding:', err.message);
            return null;
        }
    }

    cosineSimilarity(a, b) {
        if (!a || !b || a.length !== b.length) return 0;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom ? (dot / denom) : 0;
    }

    // Phát hiện intent và chọn strategy tìm kiếm tối ưu
    detectSearchStrategy(query) {
        const q = query.toLowerCase();

        // Keyword search: fields cụ thể (budget, revenue, year, runtime)
        const hasFieldQuery = /ngân sách|budget|chi phí|tiền làm|doanh thu|revenue|kiếm được|thu về|năm \d{4}|phát hành|ra mắt|thời lượng|runtime|phút|giờ|dài|trang web|homepage|website/.test(q);

        // Semantic search: plot, mood, theme, similarity
        const hasSemanticQuery = /về|nội dung|cốt truyện|giống như|tương tự|kiểu|thể loại nào|tâm trạng|cảm xúc|chủ đề/.test(q);

        // Actor/Director search: tên người
        const hasPersonQuery = /diễn viên|đạo diễn|actor|actress|director|cast|crew|vai diễn/.test(q);

        // Nếu chỉ có field query → dùng regex
        if (hasFieldQuery && !hasSemanticQuery) {
            return 'regex';
        }

        // Nếu chỉ có semantic query → dùng vector
        if (hasSemanticQuery && !hasFieldQuery && !hasPersonQuery) {
            return 'vector';
        }

        // Default: hybrid (parallel)
        return 'hybrid';
    }

    // HYBRID SEARCH: kết hợp vector (semantic) + regex (keyword) với parallel execution
    async performHybridSearch(query) {
        if (!query) return [];

        const strategy = this.detectSearchStrategy(query);

        // Nếu intent rõ ràng, chỉ dùng 1 strategy (tiết kiệm thời gian)
        if (strategy === 'regex') {
            return await this.performSearch(query);
        }

        if (strategy === 'vector') {
            const results = await this.performVectorSearch(query);
            return results.length > 0 ? results : await this.performSearch(query);
        }

        // Hybrid: chạy song song vector + regex (parallel search)
        const [vectorResults, regexResults] = await Promise.allSettled([
            this.performVectorSearch(query),
            this.performSearch(query)
        ]);

        const vectorDocs = vectorResults.status === 'fulfilled' ? vectorResults.value : [];
        const regexDocs = regexResults.status === 'fulfilled' ? regexResults.value : [];

        // Merge và deduplicate theo _id
        const seenIds = new Set();
        const merged = [];

        // Ưu tiên vector results (có _score)
        for (const doc of vectorDocs) {
            const id = doc._id?.toString() || doc.title;
            if (!seenIds.has(id)) {
                seenIds.add(id);
                merged.push({ ...doc, source: 'vector' });
            }
        }

        // Thêm regex results (chưa có trong vector)
        for (const doc of regexDocs) {
            const id = doc._id?.toString() || doc.title;
            if (!seenIds.has(id)) {
                seenIds.add(id);
                merged.push({ ...doc, source: 'regex' });
            }
        }

        return merged.slice(0, 5);
    }
}

export const ragChain = new RAGChain();
