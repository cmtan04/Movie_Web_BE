import { getJson } from "serpapi";
import dotenv from 'dotenv';

dotenv.config();

export async function searchGoogle(query) {
    try {
        const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
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

        const results = (response.organic_results || []).slice(0, 5).map(item => ({
            title: item.title,
            link: item.link,
            snippet: item.snippet
        }));

        console.log(`🌐 Google found ${results.length} results`);
        return results.length > 0 ? results : null;
    } catch (error) {
        console.error("❌ Lỗi tìm kiếm Google:", error.message);
        return null;
    }
}
