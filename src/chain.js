import { OpenAI } from "openai";
import client from "./config/mongoDB.config.js";
import dotenv from 'dotenv';
import { InferenceClient } from "@huggingface/inference";

dotenv.config();
const HF_API_TOKEN = process.env.HUGGING_FACE_TOKEN || "";
const HIDE_OVERVIEW = process.env.HIDE_OVERVIEW === '1';

// 1. Cấu hình danh sách Model dự phòng (Ưu tiên từ trên xuống dưới)
const MODEL_PRIORITY_LIST = [

    "arcee-ai/trinity-large-preview:free", // Model ưu tiên hàng đầu
    "openrouter/free"                      // Model dự phòng nếu model trên lỗi

];

const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "MovieDB Chatbot",
    }
});

class RAGChain {
    constructor() {
        this.conversationHistory = [
            {
                role: "system",
                content: "Bạn là trợ lý ảo MovieDB. Chỉ dùng dữ liệu được cung cấp để trả lời về phim. BẮT BUỘC trả lời bằng tiếng Việt"
            }
        ];
    }

    async run(userQuery) {
        // HYBRID SEARCH: kết hợp vector (semantic) + regex (keyword)
        let searchResults = await this.performHybridSearch(userQuery);

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

        if (contextData) {
            const aiMessage = await this.synthesizeAnswer(userQuery, contextData);
            return aiMessage;

            // --- CƠ CHẾ FALLBACK TỰ ĐỘNG ---
            // for (const modelName of MODEL_PRIORITY_LIST) {
            //     try {
            //         console.log(`🚀 [SYSTEM] Đang thử với model: ${modelName}...`);

            //         const response = await openai.chat.completions.create({
            //             model: modelName,
            //             messages: this.conversationHistory.slice(-10),
            //             temperature: 0.7,
            //         });

            //         const aiMessage = response.choices[0].message.content;
            //         this.conversationHistory.push({ role: "assistant", content: aiMessage });

            //         console.log(`✅ [SYSTEM] Thành công với model: ${modelName}`);
            //         return aiMessage;

            //     } catch (error) {
            //         console.error(`❌ [ERROR] Model ${modelName} gặp lỗi:`, error.message);
            //         // Nếu là model cuối cùng mà vẫn lỗi thì mới báo lỗi thật
            //         if (modelName === MODEL_PRIORITY_LIST[MODEL_PRIORITY_LIST.length - 1]) {
            //             return `Không tìm thấy thông tin hoặc tất cả các model đều không phản hồi.`;
            //         }
            //     }
            // }
        } else {
            console.log("Không tìm thấy trong database");
            return "không tìm thấy";
        }


    }

    async synthesizeAnswer(userQuery, context) {
        const finalPrompt = `Dựa vào thông tin sau:\n${context}\n\nHãy trả lời câu hỏi: ${userQuery}`;

        // Không thêm vào history chính để tránh nhiễu
        const messages = [
            ...this.conversationHistory,
            { role: "user", content: finalPrompt }
        ];

        for (const modelName of MODEL_PRIORITY_LIST) {
            try {
                console.log(`🚀 [SYSTEM] Đang tổng hợp câu trả lời với model: ${modelName}...`);

                const response = await openai.chat.completions.create({
                    model: modelName,
                    messages: messages.slice(-10), // Giữ context gần nhất
                    temperature: 0.7,
                });

                const aiMessage = response.choices[0].message.content;
                // Thêm cả câu hỏi gốc và câu trả lời tổng hợp vào history
                this.conversationHistory.push({ role: "user", content: userQuery });
                this.conversationHistory.push({ role: "assistant", content: aiMessage });

                console.log(`✅ [SYSTEM] Tổng hợp thành công với model: ${modelName}`);
                return aiMessage;

            } catch (error) {
                console.error(`❌ [ERROR] Model ${modelName} gặp lỗi khi tổng hợp:`, error.message);
                if (modelName === MODEL_PRIORITY_LIST[MODEL_PRIORITY_LIST.length - 1]) {
                    throw new Error("Tất cả các model đều không phản hồi để tổng hợp câu trả lời.");
                }
            }
        }
    }

    // Regex search mở rộng nhiều trường: title, overview, genres, keywords, homepage, release_date, cast, crew
    async performSearch(query) {
        if (!query) return [];
        const db = client.db("movie_bot");
        const collection = db.collection("movies");
        const keywords = query.trim().split(/\s+/).filter(k => k.length > 0);
        if (keywords.length === 0) return [];
        const regexPatterns = keywords.map(k => new RegExp(k, 'i'));

        // Director match: mỗi keyword tạo một $elemMatch riêng để kết hợp job
        const directorConditions = keywords.map(k => ({
            'cast_crew_full.crew': { $elemMatch: { job: 'Director', name: new RegExp(k, 'i') } }
        }));

        const orConditions = [
            { title: { $in: regexPatterns } },
            { overview: { $in: regexPatterns } },
            { genres: { $in: regexPatterns } },
            { keywords: { $in: regexPatterns } },
            { homepage: { $in: regexPatterns } },
            { release_date: { $in: regexPatterns } },
            { 'cast_crew_full.cast': { $elemMatch: { name: { $in: regexPatterns } } } },
            { 'cast_crew_full.crew': { $elemMatch: { name: { $in: regexPatterns } } } },
            ...directorConditions,
        ];

        return await collection.find({ $or: orConditions }).limit(5).toArray();
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
                        numCandidates: 200,
                        limit: 50, // Lấy nhiều chunks hơn để nhóm
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
            .slice(0, 50)
            .map(({ embedding: _emb, ...rest }) => rest);

        return this.groupChunksByMovie(scored);
    }

    // Nhóm chunks cùng phim, ưu tiên chunk có score cao nhất
    groupChunksByMovie(results) {
        const movieMap = new Map();

        for (const chunk of results) {
            const movieTitle = chunk.movieTitle || chunk.title;
            if (!movieMap.has(movieTitle)) {
                // Lấy chunk đầu tiên làm representative
                movieMap.set(movieTitle, chunk);
            }
        }

        return Array.from(movieMap.values()).slice(0, 5);
    }

    async getQueryEmbedding(text) {
        try {
            const client = new InferenceClient(HF_API_TOKEN || undefined);

            const resp = await client.featureExtraction({
                model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                inputs: text,
                provider: "auto"
            });

            // InferenceClient trả về array hoặc nested array
            if (Array.isArray(resp)) {
                if (typeof resp[0] === 'number') return resp;
                if (Array.isArray(resp[0])) return resp[0];
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

    // Phát hiện xem query có đề cập các trường cụ thể không
    detectFieldKeywords(query) {
        const q = query.toLowerCase();
        return {
            budget: /ngân sách|budget|chi phí|tiền làm/.test(q),
            revenue: /doanh thu|revenue|kiếm được|thu về/.test(q),
            year: /năm|year|\d{4}|phát hành|ra mắt/.test(q),
            runtime: /thời lượng|runtime|phút|giờ|dài/.test(q),
            homepage: /trang web|homepage|website|url/.test(q),
            popularity: /phổ biến|popularity|nổi tiếng|trending/.test(q),
            vote: /điểm|rating|vote|đánh giá|imdb/.test(q)
        };
    }

    // HYBRID SEARCH: kết hợp vector (semantic) + regex (keyword) với dedup
    async performHybridSearch(query) {
        if (!query) return [];
        const fieldHints = this.detectFieldKeywords(query);
        const needsRegex = Object.values(fieldHints).some(v => v);

        let vectorResults = [];
        let regexResults = [];

        try {
            vectorResults = await this.performVectorSearch(query);
        } catch (_) {
            // Vector search không khả dụng
        }

        // Nếu phát hiện từ khóa trường cụ thể hoặc vector không trả kết quả, dùng regex
        if (needsRegex || !vectorResults || vectorResults.length === 0) {
            regexResults = await this.performSearch(query);
        }

        // Merge và deduplicate theo _id
        const seenIds = new Set();
        const merged = [];

        // Ưu tiên vector results (có _score)
        for (const doc of vectorResults) {
            const id = doc._id?.toString() || doc.title;
            if (!seenIds.has(id)) {
                seenIds.add(id);
                merged.push({ ...doc, source: 'vector' });
            }
        }

        // Thêm regex results (chưa có trong vector) - không có _score
        for (const doc of regexResults) {
            const id = doc._id?.toString() || doc.title;
            if (!seenIds.has(id)) {
                seenIds.add(id);
                merged.push({ ...doc, source: 'regex' });
            }
        }

        return merged.slice(0, 5);
    }
}

let ragChain = new RAGChain();

export { ragChain };

export async function askChatbot(userPrompt) {
    return await ragChain.run(userPrompt);
}

export async function vectorSearchPreview(query) {
    return await ragChain.performVectorSearch(query);
}

export async function regexSearchPreview(query) {
    return await ragChain.performSearch(query);
}

export async function hybridSearchPreview(query) {
    return await ragChain.performHybridSearch(query);
}

export async function synthesizeAnswer(userQuery, context) {
    return await ragChain.synthesizeAnswer(userQuery, context);
}