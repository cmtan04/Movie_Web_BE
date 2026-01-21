import fs from 'fs';
import csv from 'csv-parser';
import axios from 'axios';
import client from "./mongoDB.config.js";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const HF_API_URL = "http://localhost:8000/embed";
const HF_API_TOKEN = process.env.HF_API_TOKEN || "";

// Delay helper để tránh rate limit
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));


//=======CHUNKING CONFIG========//
const CHUNK_SIZE = 512; // Số ký tự per chunk
const CHUNK_OVERLAP = 64; // Overlap giữa chunks

// Khởi tạo text splitter từ LangChain (tách thông minh theo câu/dấu câu)
const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " ", ""],
    keepSeparator: true,
});

// =======LẤY EMBEDDINGS ==========//
async function getVectors(texts) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        const response = await axios.post(HF_API_URL, { inputs: texts }, { headers });
        return response.data;
    } catch (error) {
        console.error("Lỗi lấy embeddings từ Hugging Face:", error.message);
        return null;
    }
}

async function readCSV(filePath) {
    return new Promise((resolve, reject) => {
        const data = [];
        fs.createReadStream(filePath)
            .pipe(csv({
                skipEmptyLines: true,
                quote: '"',
                escape: '"',
                strict: true
            }))
            .on('data', (row) => data.push(row))
            .on('end', () => resolve(data))
            .on('error', reject);
    });
}

async function run() {

    try {
        await client.connect();
        console.log("Kết nối MongoDB thành công!");

        const collection = client.db("movie_bot").collection("movies");

        // Tạo unique index để tránh duplicate chunks
        await collection.createIndex(
            { movieTitle: 1, chunkIndex: 1 },
            { unique: true, sparse: true }
        );
        console.log("Tạo unique index cho chunks");

        const castMap = new Map();

        console.log("1. Đang đọc file Cast & Crew...");
        const creditsPath = path.join(__dirname, '../data/csv/tmdb_5000_credits.csv');
        const creditsData = await readCSV(creditsPath);

        creditsData.forEach((row) => {
            try {
                if (!row.cast || !row.crew || row.cast.trim() === '' || row.crew.trim() === '') return;

                const castData = JSON.parse(row.cast);
                const crewData = JSON.parse(row.crew);

                if (!Array.isArray(castData) || !Array.isArray(crewData)) return;

                const director = crewData.find(person => person.job === 'Director')?.name || "Không rõ";
                const top3Cast = castData.slice(0, 3).map(c => c.name).join(', ');

                castMap.set(row.title, {
                    full_data: { cast: castData, crew: crewData },
                    embedding_text: `Đạo diễn: ${director}. Diễn viên: ${top3Cast}.`
                });
            } catch (e) {
                // Skip các phim có JSON không hợp lệ
            }
        });
        console.log(`Đọc xong ${creditsData.length} phim từ credits.csv`);

        console.log("2. Đang đọc file Movies...");
        const moviesPath = path.join(__dirname, '../data/csv/tmdb_5000_movies.csv');
        const moviesRaw = await readCSV(moviesPath);
        console.log(`Đọc xong ${moviesRaw.length} phim từ movies.csv`);

        console.log("3. Xử lý dữ liệu và lấy embeddings (batch size: 30)...");

        // Lọc các phim có đầy đủ thông tin
        const validMovies = moviesRaw.filter(m => {
            return m.title && m.title.trim() !== '' &&
                m.overview && m.overview.trim() !== '' &&
                m.overview !== 'N/A' &&
                castMap.has(m.title);
        });

        console.log(`Tìm thấy ${validMovies.length}/${moviesRaw.length} phim có đầy đủ thông tin`);

        for (let i = 0; i < validMovies.length; i += 30) {
            const batch = validMovies.slice(i, i + 30);

            // Tạo chunks cho từng phim
            const preparedBatch = [];
            for (const m of batch) {
                const castInfo = castMap.get(m.title);

                // Chuẩn hóa thành mảng các tên sạch
                const parseList = (val) => {
                    if (!val) return [];
                    try {
                        const arr = JSON.parse(val);
                        if (Array.isArray(arr)) {
                            return arr.map(x => (x?.name ?? x)?.toString?.() ?? '').filter(Boolean);
                        }
                    } catch (_) {
                        return val.split(/\||,|;|\s{2,}/).map(s => s.trim()).filter(Boolean);
                    }
                    return [];
                };

                const genreNames = parseList(m.genres);
                const keywordNames = parseList(m.keywords);
                const year = (m.release_date && m.release_date.slice(0, 4)) || 'Không rõ';

                const directorName = castInfo?.full_data?.crew?.find(p => p.job === 'Director')?.name || 'Không rõ';
                const topCastNames = (castInfo?.full_data?.cast || []).slice(0, 5).map(c => c.name).filter(Boolean);

                // Build full text with metadata
                const fullText = [
                    `Phim: ${m.title}`,
                    `Nội dung: ${m.overview}`,
                    `Năm: ${year}`,
                    `Điểm: ${m.vote_average ?? 'N/A'}/10 (${m.vote_count ?? 'N/A'} phiếu)`,
                    `Thể loại: ${genreNames.join(', ') || 'Không rõ'}`,
                    `Từ khóa: ${keywordNames.join(', ') || 'Không rõ'}`,
                    `Đạo diễn: ${directorName}`,
                    `Diễn viên: ${topCastNames.join(', ') || 'Không rõ'}`,
                    `Thời lượng: ${m.runtime ?? 'N/A'} phút`,
                    `Ngân sách: ${m.budget ?? 'N/A'} USD`,
                    `Doanh thu: ${m.revenue ?? 'N/A'} USD`,
                    `Phổ biến: ${m.popularity ?? 'N/A'}`
                ].join('. ') + '.';

                // Cắt text thành chunks bằng LangChain splitter
                const chunks = await textSplitter.splitText(fullText);

                // Tạo document cho từng chunk
                for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
                    preparedBatch.push({
                        movieTitle: m.title,
                        chunkIndex: chunkIdx,
                        chunkTotal: chunks.length,
                        chunkText: chunks[chunkIdx],
                        text_for_ai: chunks[chunkIdx],
                        // Metadata gốc
                        title: m.title,
                        budget: m.budget,
                        genres: m.genres,
                        homepage: m.homepage,
                        keywords: m.keywords,
                        overview: m.overview,
                        popularity: m.popularity,
                        release_date: m.release_date,
                        revenue: m.revenue,
                        runtime: m.runtime,
                        vote_average: m.vote_average,
                        vote_count: m.vote_count,
                        cast_crew_full: castInfo.full_data,
                        isChunk: true
                    });
                }
            }

            // Kiểm tra chunk nào đã có trong DB (theo movieTitle + chunkIndex)
            const chunkKeys = preparedBatch.map(p => ({ movieTitle: p.movieTitle, chunkIndex: p.chunkIndex }));
            const existingChunks = await collection.find({
                $or: chunkKeys
            }).project({ movieTitle: 1, chunkIndex: 1 }).toArray();

            const existingSet = new Set(existingChunks.map(c => `${c.movieTitle}#${c.chunkIndex}`));

            // Lọc chỉ chunks mới (chưa có trong DB)
            const newChunks = preparedBatch.filter(p => !existingSet.has(`${p.movieTitle}#${p.chunkIndex}`));
            const newMovieTitles = [...new Set(newChunks.map(p => p.movieTitle))];

            if (newChunks.length === 0) {
                console.log(`Batch ${Math.floor(i / 30) + 1}: Tất cả chunks đã có trong DB, bỏ qua`);
                continue;
            }

            // Lấy embeddings chỉ cho chunks mới
            const vectors = await getVectors(newChunks.map(p => p.chunkText || p.text_for_ai));

            if (vectors) {
                const finalDocs = newChunks.map((p, idx) => {
                    const { text_for_ai, chunkText, ...docToSave } = p;
                    return {
                        ...docToSave,
                        embedding: vectors[idx],
                        createdAt: new Date()
                    };
                });

                // Insert chunks mới
                try {
                    await collection.insertMany(finalDocs, { ordered: false });
                    console.log(`✓ Nạp batch ${Math.floor(i / 30) + 1}/${Math.ceil(validMovies.length / 30)}: Thêm ${finalDocs.length} chunks từ ${newMovieTitles.length} phim (${existingChunks.length} chunks đã có)`);
                } catch (insertError) {
                    if (insertError.code === 11000) {
                        console.warn(`Batch ${Math.floor(i / 30) + 1}: Có ${insertError.result?.insertedCount || 0} chunks được insert, ${finalDocs.length - (insertError.result?.insertedCount || 0)} chunks trùng bỏ qua`);
                    } else {
                        throw insertError;
                    }
                }
            } else {
                console.warn(`Batch ${Math.floor(i / 30) + 1} bị lỗi khi lấy embeddings`);
            }

            // Delay 500ms giữa các batch để tránh rate limit
            if (i + 30 < validMovies.length) {
                await delay(500);
            }
        }

        // Đếm tổng chunks đã nạp
        const totalChunks = await collection.countDocuments({});
        console.log(`\nHoàn tất nạp dữ liệu!`);
        console.log(`Tổng chunks trong DB: ${totalChunks}`);
    } catch (error) {
        console.error("Lỗi:", error.message);
        process.exit(1);
    } finally {
        await client.close();
        console.log("Đóng kết nối MongoDB");
    }
}

export default run;