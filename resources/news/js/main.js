// Toast Notification Function
const resolveNewsBasePath = () => {
    const root = document && document.body ? document.body : null;
    const raw = root ? (root.getAttribute('data-news-base-path') || '') : '';
    const normalized = raw.toString().trim().replace(/\/+$/, '');
    return normalized || '/tin-tuc';
};

const NEWS_BASE_PATH = resolveNewsBasePath();

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// LocalStorage Functions for Viewed News
function saveViewedNews(newsId, title, image, video, time) {
    let viewedNews = JSON.parse(localStorage.getItem('viewedNews') || '[]');
    
    // Xóa nếu đã tồn tại (để đưa lên đầu)
    viewedNews = viewedNews.filter(item => item.id !== newsId);
    
    // Thêm tin mới vào đầu
    viewedNews.unshift({
        id: newsId,
        title: title,
        image: image,
        video: video,
        time: time,
        viewedAt: new Date().toISOString()
    });
    
    // Giới hạn chỉ lưu 10 tin gần nhất
    if (viewedNews.length > 10) {
        viewedNews = viewedNews.slice(0, 10);
    }
    
    localStorage.setItem('viewedNews', JSON.stringify(viewedNews));
}

function loadViewedNews() {
    const viewedNews = JSON.parse(localStorage.getItem('viewedNews') || '[]');
    const container = document.getElementById('viewed-news');
    
    if (!container) return;
    
    if (viewedNews.length === 0) {
        container.innerHTML = '<p class="no-viewed">Chưa có tin nào được xem</p>';
        return;
    }
    
    let html = '';
    viewedNews.forEach(item => {
        const thumbHtml = item.image 
            ? `<img src="${item.image}" alt="Thumbnail" class="viewed-thumb" onerror="this.style.display='none'">`
            : item.video 
                ? `<div class="viewed-thumb video-thumb"><i class="fas fa-play-circle"></i></div>`
                : `<div class="viewed-thumb no-thumb"><i class="fas fa-image"></i></div>`;
        
        const shortTitle = item.title.length > 80 ? item.title.substring(0, 80) + '...' : item.title;
        
        html += `
            <a href="${NEWS_BASE_PATH}/${item.id}" class="viewed-item">
                ${thumbHtml}
                <div class="viewed-info">
                    <p class="viewed-title">${shortTitle}</p>
                    <span class="viewed-time">${item.time}</span>
                </div>
            </a>
        `;
    });
    
    container.innerHTML = html;
}

// Save current news to viewed history (for detail page)
function saveCurrentNews() {
    const pathname = window.location.pathname;
    const escapedBase = NEWS_BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const detailRegex = new RegExp(`^${escapedBase}/(\\d+)(?:/)?$`);
    const match = pathname.match(detailRegex);
    
    if (match) {
        const newsId = match[1];
        
        // Lấy thông tin từ trang
        const titleElement = document.querySelector('.news-content-detail');
        const imageElement = document.querySelector('.news-image');
        const videoElement = document.querySelector('.news-video');
        const timeElement = document.querySelector('.time');
        
        if (titleElement) {
            const title = titleElement.textContent.trim();
            const image = imageElement ? imageElement.src : null;
            const video = videoElement ? videoElement.querySelector('source').src : null;
            const time = timeElement ? timeElement.textContent : '';
            
            saveViewedNews(newsId, title, image, video, time);
        }
    }
}

// Copy Link Function
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => {
                showToast('✓ Đã copy link vào clipboard!');
            })
            .catch(() => {
                fallbackCopyToClipboard(text);
            });
    } else {
        fallbackCopyToClipboard(text);
    }
}

// Fallback copy method for older browsers
function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        document.execCommand('copy');
        showToast('✓ Đã copy link vào clipboard!');
    } catch (err) {
        showToast('✗ Không thể copy link. Vui lòng thử lại!');
    }
    
    document.body.removeChild(textArea);
}

// Share Function
function shareContent(url, title = 'Anime News') {
    if (navigator.share) {
        navigator.share({
            title: title,
            text: 'Xem tin tức mới nhất về Anime & Manga',
            url: url
        })
        .then(() => {
            showToast('✓ Đã chia sẻ thành công!');
        })
        .catch((error) => {
            if (error.name !== 'AbortError') {
                // Fallback to copy link
                copyToClipboard(url);
            }
        });
    } else {
        // Fallback: Copy to clipboard
        copyToClipboard(url);
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {

    // Load viewed news
    loadViewedNews();
    
    // Save current news if on detail page
    const escapedBase = NEWS_BASE_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escapedBase}/\\d+(?:/)?$`).test(window.location.pathname)) {
        saveCurrentNews();
        // Reload viewed news to show current page at top
        setTimeout(() => loadViewedNews(), 100);
    }
    
    // Copy Link Buttons
    const copyButtons = document.querySelectorAll('.copy-btn');
    copyButtons.forEach(button => {
        button.addEventListener('click', function(e) {
            e.preventDefault();
            const url = this.getAttribute('data-url');
            copyToClipboard(url);
        });
    });
    
    // Share Buttons
    const shareButtons = document.querySelectorAll('.share-btn');
    shareButtons.forEach(button => {
        button.addEventListener('click', function(e) {
            e.preventDefault();
            const url = this.getAttribute('data-url');
            shareContent(url);
        });
    });
    
    // Lazy Loading Images
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                    }
                    observer.unobserve(img);
                }
            });
        });
        
        const lazyImages = document.querySelectorAll('img[data-src]');
        lazyImages.forEach(img => imageObserver.observe(img));
    }
    
    // Smooth Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // Video Auto Pause on Scroll
    const videos = document.querySelectorAll('video');
    if (videos.length > 0 && 'IntersectionObserver' in window) {
        const videoObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                if (!entry.isIntersecting) {
                    video.pause();
                }
            });
        }, {
            threshold: 0.5
        });
        
        videos.forEach(video => videoObserver.observe(video));
    }
    
    // Handle Image Load Error
    document.querySelectorAll('img').forEach(img => {
        img.addEventListener('error', function() {
            this.style.display = 'none';
        });
    });
    
});

// Infinite Scroll (Optional - can be enabled)
/*
let currentPage = 1;
let isLoading = false;

function loadMoreNews() {
    if (isLoading) return;
    
    isLoading = true;
    currentPage++;
    
    fetch(`${NEWS_BASE_PATH}/api/news?page=${currentPage}`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.data.length > 0) {
                // Append news items to feed
                // Implementation depends on your needs
                console.log('Loaded more news:', data.data);
            }
            isLoading = false;
        })
        .catch(error => {
            console.error('Error loading more news:', error);
            isLoading = false;
        });
}

window.addEventListener('scroll', () => {
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 500) {
        loadMoreNews();
    }
});
*/
