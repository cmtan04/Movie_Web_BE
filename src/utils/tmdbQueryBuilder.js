const VI_GENRE_MAP = {
    "hành động": 28, "hanh dong": 28, "action": 28,
    "phiêu lưu": 12, "phieu luu": 12, "adventure": 12,
    "hài": 35, "hai": 35, "comedy": 35,
    "kinh dị": 27, "kinh di": 27, "horror": 27,
    "viễn tưởng": 878, "vien tuong": 878, "science fiction": 878,
    "tình cảm": 10749, "tinh cam": 10749, "romance": 10749,
    "giật gân": 53, "giat gan": 53, "thriller": 53,
    "chính kịch": 18, "chinh kich": 18, "drama": 18,
    "gia đình": 10751, "gia dinh": 10751, "family": 10751,
    "hoạt hình": 16, "hoat hinh": 16, "animation": 16,
    "tội phạm": 80, "toi pham": 80, "crime": 80,
    "tài liệu": 99, "tai lieu": 99, "documentary": 99,
    "bí ẩn": 9648, "bi an": 9648, "mystery": 9648,
    "lịch sử": 36, "lich su": 36, "history": 36
};

const STOPWORDS = [
    'cac', 'các', 'nhung', 'những', 'bo', 'bộ', 'phim', 'hay', 'nhat', 'nhất',
    'top', 'xem', 've', 'về', 'thuoc', 'thuộc', 'the loai', 'thể loại', 'gi', 'gì',
    'nao', 'nào', 'kieu', 'kiểu', 'tuong tu', 'tương tự', 'hot', 'moi', 'mới',
    'tot', 'tốt', 'de cu', 'đề cử'
];

function stripDiacritics(str) {
    return (str || "").normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function detectGenreId(query) {
    const q = stripDiacritics(query);
    for (const key in VI_GENRE_MAP) {
        if (q.includes(stripDiacritics(key))) {
            return VI_GENRE_MAP[key];
        }
    }
    return null;
}

export function extractYear(query) {
    const q = query.toLowerCase();
    const m = q.match(/(?:(?:nam|năm)\s*)(\d{4})/);
    if (m) return parseInt(m[1], 10);
    const y = q.match(/\b(19\d{2}|20\d{2})\b/);
    return y ? parseInt(y[1], 10) : null;
}

export function extractTitleQuery(original) {
    const quoted = original.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
    if (quoted && quoted[1]) return quoted[1].trim();

    let q = stripDiacritics(original).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = q.split(' ').filter(t => !!t);
    const filtered = tokens.filter(t => !STOPWORDS.includes(t));
    const candidate = filtered.join(' ').trim();
    return candidate.length >= 2 ? candidate : '';
}

export function selectSort(query) {
    const q = query.toLowerCase();
    if (/hay|nh\u1ea5t|\btop\b|\bdiem cao\b|rating cao/.test(q)) {
        return 'vote_average.desc';
    }
    if (/pho bien|thinh hanh|trending|moi|hot/.test(stripDiacritics(q))) {
        return 'popularity.desc';
    }
    return null;
}
