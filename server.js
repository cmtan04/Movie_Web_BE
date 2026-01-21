import express from 'express';
import cors from 'cors';
import client from "./src/config/mongoDB.config.js";
import run from "./src/config/ingest.js";
import { ragChain } from "./src/chain.js";
import axios from 'axios';
import dotenv from 'dotenv';
import { getJson } from "serpapi";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Kết nối MongoDB khi khởi động server
async function startServer() {
    try {
        await client.connect();
        console.log("✓ Kết nối MongoDB thành công!");
    } catch (error) {
        console.error("✗ Lỗi kết nối MongoDB:", error);
        process.exit(1);
    }
}

// Hàm tìm kiếm nội dung trên Google
async function searchGoogle(query) {
    try {
        const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
        const url = 'https://serpapi.com/search.json'
        if (!GOOGLE_API_KEY) {
            console.error("❌ Chưa có GOOGLE_API_KEY trong .env");
            return null;
        }

        console.log(`🔍 Searching Google for: "${query}"`);
        const response = await getJson({
            engine: "google",
            q: query,
            api_key: GOOGLE_API_KEY,
            num: 5
        });

        const results = [];

        if (response.organic_results && response.organic_results.length > 0) {
            for (let item of response.organic_results.slice(0, 5)) {
                results.push({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet
                });
            }
        }

        console.log(`🌐 Google found ${results.length} results`);
        return results.length > 0 ? results : null;
    } catch (error) {
        console.error("❌ Lỗi tìm kiếm Google:", error.message);
        return null;
    }
}

// --- Helper: Xây dựng query hợp lệ cho TMDB từ câu hỏi tiếng Việt ---
const VI_GENRE_MAP = {
    "hành động": 28,
    "hanh dong": 28,
    "action": 28,
    "phiêu lưu": 12,
    "phieu luu": 12,
    "adventure": 12,
    "hài": 35,
    "hai": 35,
    "comedy": 35,
    "kinh dị": 27,
    "kinh di": 27,
    "horror": 27,
    "viễn tưởng": 878,
    "vien tuong": 878,
    "science fiction": 878,
    "tình cảm": 10749,
    "tinh cam": 10749,
    "romance": 10749,
    "giật gân": 53,
    "giat gan": 53,
    "thriller": 53,
    "chính kịch": 18,
    "chinh kich": 18,
    "drama": 18,
    "gia đình": 10751,
    "gia dinh": 10751,
    "family": 10751,
    "hoạt hình": 16,
    "hoat hinh": 16,
    "animation": 16,
    "tội phạm": 80,
    "toi pham": 80,
    "crime": 80,
    "tài liệu": 99,
    "tai lieu": 99,
    "documentary": 99,
    "bí ẩn": 9648,
    "bi an": 9648,
    "mystery": 9648,
    "lịch sử": 36,
    "lich su": 36,
    "history": 36
};

/**
 * Removes diacritical marks from a string and converts it to lowercase.
 * Normalizes the input string by decomposing combined characters (NFD form),
 * removing all diacritical marks (accents, tildes, etc.), and converting to lowercase.
 * Useful for case-insensitive string comparisons and searching with accent-insensitive matching.
 * 
 * @param {string} str - The input string to process
 * @returns {string} The normalized string without diacritics in lowercase
 * 
 * @example
 * stripDiacritics("Café") // returns "cafe"
 * stripDiacritics("Naïve") // returns "naive"
 * stripDiacritics("Señor") // returns "senor"
 */
function stripDiacritics(str) {
    return (str || "").normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function detectGenreId(query) {
    const q = stripDiacritics(query);
    for (const key of Object.keys(VI_GENRE_MAP)) {
        if (q.includes(stripDiacritics(key))) {
            return VI_GENRE_MAP[key];
        }
    }
    return null;
}

function extractYear(query) {
    const q = query.toLowerCase();
    const m = q.match(/(?:(?:nam|năm)\s*)(\d{4})/);
    if (m) return parseInt(m[1], 10);
    const y = q.match(/\b(19\d{2}|20\d{2})\b/);
    return y ? parseInt(y[1], 10) : null;
}

const STOPWORDS = [
    'cac', 'các', 'nhung', 'những', 'bo', 'bộ', 'phim', 'hay', 'nhat', 'nhất',
    'top', 'xem', 've', 'về', 'thuoc', 'thuộc', 'the loai', 'thể loại', 'gi', 'gì',
    'nao', 'nào', 'kieu', 'kiểu', 'tuong tu', 'tương tự', 'hot', 'moi', 'mới',
    'tot', 'tốt', 'de cu', 'đề cử'
];

function extractTitleQuery(original) {
    const quoted = original.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
    if (quoted && quoted[1]) return quoted[1].trim();

    // Remove diacritics and stopwords to get a potential title phrase
    let q = stripDiacritics(original).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = q.split(' ').filter(t => !!t);
    const filtered = tokens.filter(t => !STOPWORDS.includes(t));
    const candidate = filtered.join(' ').trim();
    return candidate.length >= 2 ? candidate : '';
}

function selectSort(query) {
    const q = query.toLowerCase();
    if (/hay|nh\u1ea5t|\btop\b|\bdiem cao\b|rating cao/.test(q)) {
        return 'vote_average.desc';
    }
    if (/pho bien|thinh hanh|trending|moi|hot/.test(stripDiacritics(q))) {
        return 'popularity.desc';
    }
    return null;
}

// Hàm tìm kiếm phim trên TMDB (FREE, chỉ cần API key) với query builder
async function searchTMDB(query) {
    try {
        const TMDB_API_KEY = process.env.TMDB_API_KEY;
        const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

        if (!TMDB_API_KEY) {
            console.error("❌ Chưa có TMDB_API_KEY trong .env");
            return null;
        }

        // Xây dựng query: ưu tiên Discover theo thể loại, nếu không có thì Search theo tiêu đề
        const genreId = detectGenreId(query);
        const year = extractYear(query);
        const sortBy = selectSort(query) || 'vote_average.desc';
        const titleQuery = extractTitleQuery(query);

        let endpoint = '';
        let params = { api_key: TMDB_API_KEY, language: 'vi-VN', page: 1 };

        if (genreId) {
            endpoint = 'discover/movie';
            params = {
                ...params,
                with_genres: genreId,
                sort_by: sortBy,
                'vote_count.gte': 200,
                ...(year ? { primary_release_year: year } : {})
            };
            console.log(`🔍 TMDB Discover with_genres=${genreId}, sort_by=${sortBy}, year=${year || 'any'}`);
        } else if (titleQuery) {
            endpoint = 'search/movie';
            params = { ...params, query: titleQuery, include_adult: false };
            console.log(`🔍 TMDB Search title="${titleQuery}"`);
        } else {
            console.log('⚠️ Không trích xuất được tiêu đề/thể loại phù hợp cho TMDB');
            return null;
        }

        const searchResponse = await axios.get(`${TMDB_BASE_URL}/${endpoint}`, { params, timeout: 5000 });
        console.log(`✓ TMDB ${endpoint} response:`, searchResponse.data.results?.length || 0, `results`);

        const results = [];

        if (searchResponse.data.results && searchResponse.data.results.length > 0) {
            // Lấy tối đa 5 kết quả
            for (let item of searchResponse.data.results.slice(0, 5)) {
                try {
                    // Lấy chi tiết phim để có đầy đủ thông tin
                    const detailResponse = await axios.get(`${TMDB_BASE_URL}/movie/${item.id}`, {
                        params: {
                            api_key: TMDB_API_KEY,
                            language: 'vi-VN',
                            append_to_response: 'credits'
                        },
                        timeout: 3000
                    });

                    const detail = detailResponse.data;
                    const title = detail.title;
                    const year = detail.release_date?.split('-')[0] || 'N/A';
                    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';

                    // Lấy director
                    const director = detail.credits?.crew?.find(c => c.job === 'Director')?.name || 'N/A';

                    // Lấy cast (3 diễn viên chính)
                    const cast = detail.credits?.cast?.slice(0, 3)?.map(c => c.name).join(', ') || 'N/A';

                    // Lấy thể loại
                    const genres = detail.genres?.slice(0, 2)?.map(g => g.name).join(', ') || 'N/A';

                    // Mô tả chi tiết
                    const snippet = `${genres}
                        **Đạo diễn:** ${director}
                        **Diễn viên:** ${cast}
                        ${rating}

                        ${detail.overview || 'Chưa có mô tả'}`;

                    results.push({
                        title: `${title} (${year})`,
                        link: `https://www.themoviedb.org/movie/${item.id}`,
                        snippet: snippet
                    });
                } catch (detailError) {
                    console.error(`⚠️ Lỗi lấy chi tiết phim ${item.id}:`, detailError.message);
                    // Fallback nếu lấy detail thất bại
                    const title = item.title;
                    const year = item.release_date?.split('-')[0] || 'N/A';
                    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '';

                    results.push({
                        title: `${title} (${year})`,
                        link: `https://www.themoviedb.org/movie/${item.id}`,
                        snippet: `${rating}\n${item.overview || 'Chưa có mô tả'}`
                    });
                }
            }
        }

        console.log(`🎬 TMDB found ${results.length} results`);
        return results.length > 0 ? results : null;
    } catch (error) {
        console.error("❌ Lỗi tìm kiếm TMDB:", error.message);
        return null;
    }
}

// Endpoint để xóa lịch sử chat (reset)
app.post('/chat/clear', (req, res) => {
    try {
        ragChain.clearSession('default');
        res.status(200).json({
            status: 'success',
            message: 'Lịch sử chat đã được xóa'
        });
    } catch (error) {
        console.error("Lỗi xóa lịch sử:", error);
        res.status(500).json({ error: "Lỗi máy chủ" });
    }
});

// Route GET cho SSE (streaming)
app.get('/chat/stream', async (req, res) => {
    const message = req.query.message;

    if (!message || message.trim() === '') {
        res.status(400).json({ error: "Vui lòng nhập tin nhắn" });
        return;
    }

    // Thiết lập SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Hàm gửi event
    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        //Tìm kiếm trong Database
        console.log("🔍 [STEP 1] Tìm kiếm trong Database...");
        sendEvent({ type: 'db_search', message: '⏳ Đang tìm trong kho dữ liệu...' });

        const dbAnswer = await ragChain.run(message);

        console.log("📊 DB Answer:", dbAnswer);

        let answer = dbAnswer;
        let searchedDb = true;
        let searchedTmdb = false;
        let searchedGoogle = false;
        let source = 'database';

        // Kiểm tra nếu DB không tìm thấy dữ liệu
        const notFoundPatterns = [
            "Không tìm thấy",
            "không có thông tin",
            "không rõ",
            "không phát hiện",
            "lỗi máy chủ",
            "tất cả các model",
            "xin lỗi",
            "không có kết quả"
        ];

        const isNotFoundDb = notFoundPatterns.some(pattern =>
            dbAnswer.toLowerCase().includes(pattern.toLowerCase())
        );

        // Nếu DB không tìm thấy, tìm trên TMDB
        if (isNotFoundDb) {
            console.log("⚠️ DB không tìm thấy, chuyển sang tìm TMDB...");
            sendEvent({ type: 'db_not_found', message: 'Không tìm thấy trong cơ sở dữ liệu, đang tìm trên Internet...' });
            searchedTmdb = true;
            const tmdbResults = await searchTMDB(message);

            if (tmdbResults && tmdbResults.length > 0) {
                console.log("✅ Tìm thấy trong TMDB");
                source = 'tmdb';
                sendEvent({ type: 'tmdb_found', message: '✅ Tìm thấy trên Internet, đang tổng hợp...' });

                const tmdbContext = tmdbResults
                    .map((r, i) => `Phim ${i + 1}: ${r.title}\n${r.snippet}`)
                    .join('\n\n');

                try {
                    answer = await ragChain.synthesizeAnswer(message, tmdbContext);
                } catch (error) {
                    console.error("❌ Lỗi tổng hợp TMDB results:", error.message);
                    const formattedResults = tmdbResults
                        .map((r, i) => `${i + 1}. **${r.title}**\n${r.snippet}\n🔗 [Xem chi tiết](${r.link})`)
                        .join('\n\n');
                    answer = `${formattedResults}`;
                }
            } else {
                // 3️⃣ BƯỚC 3: Nếu TMDB cũng không tìm thấy, tìm nội dung trên Google
                console.log("⚠️ TMDB không tìm thấy, chuyển sang tìm Google...");
                searchedGoogle = true;
                const googleResults = await searchGoogle(message);

                if (googleResults && googleResults.length > 0) {
                    console.log("✅ Tìm thấy trong Google");
                    source = 'google';
                    sendEvent({ type: 'google_found', message: 'Tìm thấy trên Internet, đang tổng hợp...' });

                    const googleContext = googleResults
                        .map((r, i) => `Kết quả ${i + 1}: ${r.title}\n${r.snippet}`)
                        .join('\n\n');

                    try {
                        answer = await ragChain.synthesizeAnswer(message, googleContext);
                    } catch (error) {
                        console.error("❌ Lỗi tổng hợp Google results:", error.message);
                        const formattedResults = googleResults
                            .map((r, i) => `${i + 1}. **${r.title}**\n${r.snippet}\n🔗 [Xem chi tiết](${r.link})`)
                            .join('\n\n');
                        answer = `${formattedResults}`;
                    }
                } else {
                    console.log("❌ Không tìm thấy dữ liệu từ cả ba nguồn");
                    answer = "Xin lỗi, tôi không tìm thấy thông tin liên quan từ cơ sở dữ liệu và Internet. Vui lòng thử với câu hỏi khác.";
                    source = 'none';
                }
            }
        }

        // Gửi kết quả cuối
        sendEvent({
            type: 'final',
            message: answer,
            searchedDb,
            searchedTmdb,
            searchedGoogle,
            source
        });

        res.end();  // Kết thúc stream
    } catch (error) {
        console.error("Lỗi xử lý câu hỏi:", error);
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Lỗi máy chủ' })}\n\n`);
        res.end();
    }
});

const PORT = process.env.PORT || 3002;



startServer().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
    });
});
