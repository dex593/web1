# api_web

`api_web` là API bridge đơn giản cho `app_desktop`.

Mục tiêu: chỉ trả về đúng dữ liệu cần để kéo chapter từ MangaDex/WeebDex sang hệ thống upload nội bộ.

## Chạy nhanh

```bash
cd api_web
npm install
npm run start
```

Server mặc định: `http://127.0.0.1:3002`

---

## Endpoint mới (đơn giản)

- `GET /health`
- `GET /web/mangadex/manga/:id`
- `GET /web/mangadex/chapter/:chapterId`
- `GET /web/weebdex/manga/:id`
- `GET /web/weebdex/chapter/:chapterId`

---

## 1) MangaDex - danh sách chapter phục vụ desktop

### `GET /web/mangadex/manga/:id`

Trả về:

- thông tin manga cơ bản (`id`, `title`, `description`, `coverUrl`)
- danh sách chapter tiếng Việt (`translatedLanguage = vi`)
- mỗi chapter có:
  - `chapterId`
  - `chapterNumber`
  - `chapterTitle`
  - `volume`
  - `translatedLanguage`
  - `groups` (nhóm dịch)
  - `groupLabel`

Query hỗ trợ:

- `order=asc|desc` (mặc định `desc`)
- `timeoutMs` (mặc định `20000`)

> Lưu ý: API hiện **khóa cứng tiếng Việt**. Các query ngôn ngữ khác sẽ bị bỏ qua.

Ví dụ:

```bash
curl "http://127.0.0.1:3002/web/mangadex/manga/c4ca02fb-8378-433b-8049-fbbea5d25cba"
```

---

## 2) MangaDex - link ảnh theo chapter

### `GET /web/mangadex/chapter/:chapterId`

Trả về:

- `imageUrls` (danh sách ảnh ưu tiên theo query)
- `imageUrlsOriginal` (ảnh gốc theo runtime At-Home `https://<host>.mangadex.network/data/...`)
- `imageUrlsRuntime` (alias tương thích ngược, cùng dạng với `imageUrlsOriginal`)
- `imageUrlsDataSaver` (**giữ dạng runtime cũ** từ `baseUrl` At-Home)

Query hỗ trợ:

- `preferDataSaver=true|false` (mặc định `true`)
- `includeDataSaver=true|false` (mặc định `true`)
- `timeoutMs`

Khuyến nghị cho desktop uploader: dùng `imageUrlsOriginal` để kéo ảnh gốc trước khi nén WebP và upload.

Ví dụ:

```bash
curl "http://127.0.0.1:3002/web/mangadex/chapter/73efdab9-887a-4cca-a95a-84bdc3a00619"
```

---

## 3) WeebDex - danh sách chapter phục vụ desktop

### `GET /web/weebdex/manga/:id`

Trả về cùng cấu trúc chapter như MangaDex (`chapterId`, `chapterNumber`, `chapterTitle`, `groups`, ...),
mặc định chỉ trả chapter tiếng Việt.

Query hỗ trợ:

- `order=asc|desc` (mặc định `desc`)
- `sort=name|publishedAt` (mặc định `name`)
- `chapterPageSize` (mặc định `100`)
- `detailConcurrency` (mặc định `4`)
- `timeoutMs`

> Lưu ý: API hiện **khóa cứng tiếng Việt**. Các query ngôn ngữ khác sẽ bị bỏ qua.

Ví dụ:

```bash
curl "http://127.0.0.1:3002/web/weebdex/manga/kmo5vht28h"
```

---

## 4) WeebDex - link ảnh theo chapter

### `GET /web/weebdex/chapter/:chapterId`

Trả về:

- `imageUrls` (danh sách ảnh ưu tiên theo query)
- `imageUrlsOriginal` (link gốc theo mẫu `{node}/data/{chapterId}/{name}`)
- `imageUrlsOptimized`

Query hỗ trợ:

- `preferOptimizedImages=true|false` (mặc định `true`)
- `timeoutMs`

Ví dụ:

```bash
curl "http://127.0.0.1:3002/web/weebdex/chapter/sue5lb51go"
```

---

## CORS

Service mở CORS toàn cục:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`
- `Access-Control-Allow-Headers: Content-Type,Authorization,Accept`

Nên có thể gọi trực tiếp từ app desktop/web.

---

## Header cấu hình cho MangaDex

`api_web` hiện gửi sẵn 2 header khi gọi MangaDex:

- `Referer` (mặc định: `https://mangadex.org/`)
- `User-Agent` (mặc định: `bfang-api-web/1.0`)

Bạn có thể override qua `.env`:

```env
MANGADEX_REFERER=https://mangadex.org/
MANGADEX_USER_AGENT=bfang-api-web/1.0
```

Nếu bạn muốn test bằng chuỗi User-Agent khác (ví dụ browser UA), chỉ cần đổi `MANGADEX_USER_AGENT`.
Khuyến nghị production: dùng User-Agent riêng của app/service thay vì giả lập browser.
