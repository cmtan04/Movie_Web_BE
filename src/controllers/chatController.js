import { ragChain } from "../chain.js";
import { searchTMDB } from "../services/tmdbService.js";
import { searchGoogle } from "../services/googleSearchService.js";

const notFoundPatterns = [
    "Không tìm thấy", "không có thông tin", "không rõ", "không phát hiện",
    "lỗi máy chủ", "tất cả các model", "xin lỗi", "không có kết quả"
];

const sendEvent = (res, data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const streamChat = async (req, res) => {
    const message = req.query.message;

    if (!message || message.trim() === '') {
        return res.status(400).json({ error: "Vui lòng nhập tin nhắn" });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        console.log("🔍 [STEP 1] Tìm kiếm trong Database...");
        sendEvent(res, { type: 'db_search', message: 'db_searching' });

        const dbAnswer = await ragChain.run(message);
        console.log("📊 DB Answer:", dbAnswer);

        let answer = dbAnswer;
        let source = 'database';
        let searchedDb = true, searchedTmdb = false, searchedGoogle = false;

        const isNotFoundDb = notFoundPatterns.some(pattern =>
            dbAnswer.toLowerCase().includes(pattern.toLowerCase())
        );

        if (isNotFoundDb) {
            console.log("⚠️ DB không tìm thấy, chuyển sang tìm TMDB...");
            sendEvent(res, { type: 'db_not_found', message: 'db_not_found' });
            searchedTmdb = true;
            const tmdbResults = await searchTMDB(message);

            if (tmdbResults && tmdbResults.length > 0) {
                console.log("✅ Tìm thấy trong TMDB");
                source = 'tmdb';
                sendEvent(res, { type: 'tmdb_found', message: '✅ Tìm thấy trên Internet, đang tổng hợp...' });

                const tmdbContext = tmdbResults.map((r, i) => `Phim ${i + 1}: ${r.title}\n${r.snippet}`).join('\n\n');
                try {
                    answer = await ragChain.synthesizeAnswer(message, tmdbContext);
                } catch (error) {
                    console.error("❌ Lỗi tổng hợp TMDB results:", error.message);
                    answer = tmdbResults.map((r, i) => `${i + 1}. **${r.title}**\n${r.snippet}\n🔗 [Xem chi tiết](${r.link})`).join('\n\n');
                }
            } else {
                console.log("⚠️ TMDB không tìm thấy, chuyển sang tìm Google...");
                searchedGoogle = true;
                const googleResults = await searchGoogle(message);

                if (googleResults && googleResults.length > 0) {
                    console.log("✅ Tìm thấy trong Google");
                    source = 'google';
                    sendEvent(res, { type: 'google_found', message: 'Tìm thấy trên Internet, đang tổng hợp...' });

                    const googleContext = googleResults.map((r, i) => `Kết quả ${i + 1}: ${r.title}\n${r.snippet}`).join('\n\n');
                    try {
                        answer = await ragChain.synthesizeAnswer(message, googleContext);
                    } catch (error) {
                        console.error("❌ Lỗi tổng hợp Google results:", error.message);
                        answer = googleResults.map((r, i) => `${i + 1}. **${r.title}**\n${r.snippet}\n🔗 [Xem chi tiết](${r.link})`).join('\n\n');
                    }
                } else {
                    console.log("❌ Không tìm thấy dữ liệu từ cả ba nguồn");
                    answer = "Xin lỗi, tôi không tìm thấy thông tin liên quan từ cơ sở dữ liệu và Internet. Vui lòng thử với câu hỏi khác.";
                    source = 'none';
                }
            }
        } else {
            console.log("✅ Tìm thấy trong Database, không cần tìm thêm.");
            answer = dbAnswer;
        }

        sendEvent(res, { type: 'final', message: answer, searchedDb, searchedTmdb, searchedGoogle, source });
        res.end();
    } catch (error) {
        console.error("Lỗi xử lý câu hỏi:", error);
        sendEvent(res, { type: 'error', message: 'Lỗi máy chủ' });
        res.end();
    }
};

export const clearChatHistory = (req, res) => {
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
};
