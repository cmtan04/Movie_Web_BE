import axios from 'axios';
import dotenv from 'dotenv';
import { detectGenreId, extractYear, selectSort, extractTitleQuery } from '../utils/tmdbQueryBuilder.js';

dotenv.config();

export async function searchTMDB(query) {
    try {
        const TMDB_API_KEY = process.env.TMDB_API_KEY;
        const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

        if (!TMDB_API_KEY) {
            console.error("❌ Chưa có TMDB_API_KEY trong .env");
            return null;
        }

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
                ...(year && { primary_release_year: year })
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

        if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
            return null;
        }

        const results = await Promise.all(
            searchResponse.data.results.slice(0, 5).map(async (item) => {
                try {
                    const detailResponse = await axios.get(`${TMDB_BASE_URL}/movie/${item.id}`, {
                        params: {
                            api_key: TMDB_API_KEY,
                            language: 'vi-VN',
                            append_to_response: 'credits'
                        },
                        timeout: 3000
                    });

                    const detail = detailResponse.data;
                    const director = detail.credits?.crew?.find(c => c.job === 'Director')?.name || 'N/A';
                    const cast = detail.credits?.cast?.slice(0, 3)?.map(c => c.name).join(', ') || 'N/A';
                    const genres = detail.genres?.slice(0, 2)?.map(g => g.name).join(', ') || 'N/A';
                    const year = detail.release_date?.split('-')[0] || 'N/A';
                    const rating = detail.vote_average ? `⭐ ${detail.vote_average.toFixed(1)}/10` : '';

                    return {
                        title: `${detail.title} (${year})`,
                        link: `https://www.themoviedb.org/movie/${item.id}`,
                        snippet: `${genres}\n**Đạo diễn:** ${director}\n**Diễn viên:** ${cast}\n${rating}\n\n${detail.overview || 'Chưa có mô tả'}`
                    };
                } catch (detailError) {
                    console.error(`⚠️ Lỗi lấy chi tiết phim ${item.id}:`, detailError.message);
                    const year = item.release_date?.split('-')[0] || 'N/A';
                    const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '';
                    return {
                        title: `${item.title} (${year})`,
                        link: `https://www.themoviedb.org/movie/${item.id}`,
                        snippet: `${rating}\n${item.overview || 'Chưa có mô tả'}`
                    };
                }
            })
        );

        console.log(`🎬 TMDB found ${results.length} results`);
        return results.length > 0 ? results : null;
    } catch (error) {
        console.error("❌ Lỗi tìm kiếm TMDB:", error.message);
        return null;
    }
}
