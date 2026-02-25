// Hashtag Helper Functions

/**
 * Extract hashtags từ text
 * @param {string} text - Nội dung tin tức
 * @returns {Array} - Mảng các hashtag (lowercase, không dấu #)
 */
function extractHashtags(text) {
    if (!text) return [];
    
    // Regex: #word hoặc #word_with_underscore
    const hashtagRegex = /#(\w+)/g;
    const matches = text.match(hashtagRegex);
    
    if (!matches) return [];
    
    // Remove # và convert to lowercase
    return matches.map(tag => tag.substring(1).toLowerCase());
}

/**
 * Get categories từ hashtags (có thể nhiều categories)
 * @param {Array} hashtags - Mảng hashtags
 * @returns {Array} - Mảng categories
 */
function getCategoriesFromHashtags(hashtags) {
    if (!hashtags || hashtags.length === 0) return ['other'];
    
    const lowerHashtags = hashtags.map(tag => tag.toLowerCase());
    const categories = [];
    
    if (lowerHashtags.includes('anime')) categories.push('anime');
    if (lowerHashtags.includes('manga')) categories.push('manga');
    if (lowerHashtags.includes('lightnovel') || lowerHashtags.includes('light_novel')) categories.push('lightnovel');
    
    return categories.length > 0 ? categories : ['other'];
}

/**
 * Get category từ hashtags (primary category - for badge display)
 * Priority: anime > manga > lightnovel > other
 * @param {Array} hashtags - Mảng hashtags
 * @returns {string} - Category name
 */
function getCategoryFromHashtags(hashtags) {
    const categories = getCategoriesFromHashtags(hashtags);
    return categories[0]; // Return first/primary category
}

/**
 * Get all categories với count
 * @param {Array} newsArray - Mảng tin tức
 * @returns {Object} - {anime: 5, manga: 3, lightnovel: 2, other: 1}
 */
function getCategoryCounts(newsArray) {
    const counts = {
        anime: 0,
        manga: 0,
        lightnovel: 0,
        other: 0,
        all: newsArray.length
    };
    
    newsArray.forEach(item => {
        const hashtags = extractHashtags(item.noidung);
        const categories = getCategoriesFromHashtags(hashtags);
        // Mỗi tin có thể thuộc nhiều category
        categories.forEach(cat => {
            if (counts[cat] !== undefined) {
                counts[cat]++;
            }
        });
    });
    
    return counts;
}

/**
 * Filter news by category
 * @param {Array} newsArray - Mảng tin tức
 * @param {string} category - Category name
 * @returns {Array} - Filtered news
 */
function filterByCategory(newsArray, category) {
    if (!category || category === 'all') return newsArray;
    
    return newsArray.filter(item => {
        const hashtags = extractHashtags(item.noidung);
        const categories = getCategoriesFromHashtags(hashtags);
        return categories.includes(category); // Check if category is in array
    });
}

/**
 * Get category info
 * @param {string} category - Category name
 * @returns {Object} - {name, icon, color, description}
 */
function getCategoryInfo(category) {
    const categories = {
        all: {
            name: 'Tất cả',
            icon: 'fas fa-th-large',
            color: '#f8f8f2',
            description: 'Tất cả tin tức'
        },
        anime: {
            name: 'Anime',
            icon: 'fas fa-tv',
            color: '#e5e5e5',
            description: 'Tin tức về Anime'
        },
        manga: {
            name: 'Manga',
            icon: 'fas fa-book-open',
            color: '#d4d4d4',
            description: 'Tin tức về Manga'
        },
        lightnovel: {
            name: 'Light Novel',
            icon: 'fas fa-book',
            color: '#b5b5b5',
            description: 'Tin tức về Light Novel'
        },
        other: {
            name: 'Khác',
            icon: 'fas fa-ellipsis-h',
            color: '#8b8b8b',
            description: 'Tin tức khác'
        }
    };
    
    return categories[category] || categories.other;
}

/**
 * Convert hashtags to clickable links
 * @param {string} text - Text content
 * @param {string} basePath - Base path for category links
 * @returns {string} - HTML with hashtag links
 */
function convertHashtagsToLinks(text, basePath = '') {
    if (!text) return '';

    const safeBasePath = (basePath || '').toString().trim().replace(/\/+$/, '');
    const categoryBasePath = safeBasePath || '';
    
    // Regex: #word hoặc #word_with_underscore
    return text.replace(/#(\w+)/g, function(match, tag) {
        const lowerTag = tag.toLowerCase();
        let category = 'other';
        
        if (lowerTag === 'anime') category = 'anime';
        else if (lowerTag === 'manga') category = 'manga';
        else if (lowerTag === 'lightnovel' || lowerTag === 'light_novel') category = 'lightnovel';
        
        if (category !== 'other') {
            return `<a href="${categoryBasePath}/?category=${category}" class="hashtag">${match}</a>`;
        }
        return `<span class="hashtag-text">${match}</span>`;
    });
}

module.exports = {
    extractHashtags,
    getCategoriesFromHashtags,
    getCategoryFromHashtags,
    getCategoryCounts,
    filterByCategory,
    getCategoryInfo,
    convertHashtagsToLinks
};
