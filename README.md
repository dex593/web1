# BFANG Manga Web

Website đọc manga của BFANG Team, xây bằng Node.js + Express + PostgreSQL, có trang quản trị riêng để vận hành.

## Mục lục

- [1. Tổng quan](#1-tổng-quan)
- [2. Tính năng chính](#2-tính-năng-chính)
- [3. Công nghệ sử dụng](#3-công-nghệ-sử-dụng)
- [4. Cấu trúc thư mục](#4-cấu-trúc-thư-mục)
- [5. Cài đặt nhanh (local)](#5-cài-đặt-nhanh-local)
- [6. Cấu hình .env](#6-cấu-hình-env)
- [7. Chạy web](#7-chạy-web)
- [8. Hướng dẫn sử dụng](#8-hướng-dẫn-sử-dụng)
- [9. Scripts vận hành](#9-scripts-vận-hành)
- [10. API/route quan trọng](#10-apiroute-quan-trọng)
- [11. Bảo mật và tối ưu hiệu năng](#11-bảo-mật-và-tối-ưu-hiệu-năng)
- [12. Sự cố thường gặp](#12-sự-cố-thường-gặp)
- [13. Giới hạn và lưu ý](#13-giới-hạn-và-lưu-ý)
- [14. Pháp lý và tuyên bố miễn trừ](#14-pháp-lý-và-tuyên-bố-miễn-trừ)

## 1. Tổng quan

BFANG Manga Web là hệ thống quản lý manga gồm:

- Khu vực công khai cho người đọc: trang chủ, danh sách truyện, chi tiết truyện, trang đọc chương.
- Hệ thống tài khoản người dùng qua OAuth (Google/Discord), kèm hồ sơ cá nhân và lịch sử đọc.
- Hệ thống bình luận theo cây (comment/reply), mention, like/report, kiểm soát spam.
- Hệ thống thông báo realtime (SSE) khi có mention trong bình luận.
- Trang quản trị đầy đủ: truyện, chương, thể loại, bình luận, huy hiệu, thành viên, nội dung trang chủ.
- Hạ tầng lưu trữ ảnh chapter qua S3-compatible object storage (Backblaze B2/MinIO/S3).

Database được tự khởi tạo/migrate khi server chạy lần đầu qua `initDb()` trong `app.js`.

## 2. Tính năng chính

### 2.1 Người đọc

- Trang chủ với số liệu tổng truyện/chương, block thông báo, truyện nổi bật và mới cập nhật.
- Thư viện truyện (`/manga`) có tìm kiếm nâng cao:
  - Từ khóa (`q`),
  - Lọc thể loại include/exclude (nút 3 trạng thái: chọn, loại trừ, bỏ chọn),
  - Phân trang.
- Trang chi tiết truyện:
  - Danh sách chương,
  - Thông tin tác giả/nhóm dịch/thể loại,
  - Mô tả thu gọn/mở rộng,
  - Nút chia sẻ,
  - Nút đọc tiếp theo lịch sử cá nhân.
- Trang đọc chương:
  - Lazy load ảnh,
  - Điều hướng chương trước/sau,
  - Dropdown chọn chương,
  - Phím tắt chuyển chương mũi tên trái/phải,
  - Tự prefetch vài ảnh chương kế tiếp để tăng mức độ trải nghiệm.

### 2.2 Tài khoản người dùng

- Đăng nhập OAuth qua Google/Discord.
- Trang tài khoản (`/account`):
  - Tên hiển thị,
  - Avatar tùy chỉnh (JPG/PNG/WebP, tối đa 2MB),
  - Facebook/Discord,
  - Bio.
- Đồng bộ hồ sơ người dùng sang dữ liệu bình luận.
- Trang lịch sử đọc (`/account/history`) lưu tối đa 10 truyện gần nhất.

### 2.3 Bình luận, tương tác, chống spam

- Bình luận ở cấp truyện và cấp chương.
- Reply một cấp (trả lời comment gốc).
- Mention user trong bình luận.
- Hỗ trợ emoji + sticker trong nội dung bình luận.
- Like/report bình luận theo user đăng nhập.
- Xóa bình luận theo quyền:
  - Chủ comment,
  - Chủ comment cha trong nhánh,
  - Hoặc người có quyền moderation (`can_delete_any_comment`).
- Bộ chống spam:
  - Giới hạn độ dài bình luận (500 ký tự),
  - Cooldown giữa các lần gửi (10 giây),
  - Chặn nội dung trùng lặp trong cửa sổ thời gian ngắn,
  - Idempotency key để chống submit trùng,
  - Kích hoạt Turnstile khi phát hiện hành vi nghi ngờ.
- Từ cấm (forbidden words): tự động thay bằng `***` khi bình luận.

### 2.4 Thông báo realtime

- Thông báo khi người dùng được mention.
- Kênh realtime bằng Server-Sent Events tại `/notifications/stream`.
- Fallback polling ở client nếu stream gián đoạn.
- Đánh dấu đã đọc từng thông báo hoặc tất cả.

### 2.5 Trang quản trị

- Dashboard thống kê tổng quan.
- Quản lý trang chủ (notice + truyện nổi bật).
- Quản lý truyện:
  - Tạo/sửa/xóa,
  - Ẩn/hiện,
  - Upload bìa,
  - Chế độ Oneshot có ràng buộc dữ liệu.
- Quản lý chương:
  - Tạo/chỉnh sửa/xóa,
  - Upload trang ảnh theo draft token,
  - Theo dõi trạng thái xử lý ảnh (`processing/failed`) và retry,
  - Xóa hàng loạt chương.
- Quản lý bình luận:
  - Tìm kiếm/lọc/sắp xếp,
  - Xóa lẻ/xóa hàng loạt,
  - Quản lý danh sách từ cấm.
- Quản lý thể loại: CRUD + thống kê số truyện theo thể loại.
- Quản lý huy hiệu:
  - CRUD,
  - Sắp xếp ưu tiên,
  - Quyền theo badge (`can_access_admin`, `can_delete_any_comment`, `can_comment`).
- Quản lý thành viên:
  - Cập nhật hồ sơ,
  - Gán/gỡ badge,
  - Ban/unban.

## 3. Công nghệ sử dụng

- Runtime: Node.js
- Web framework: Express
- Template engine: EJS
- Database: PostgreSQL (`pg`)
- Session: `express-session` + PostgreSQL session store (`web_sessions`)
- Auth: Passport OAuth2 (Google + Discord)
- Upload/ảnh: multer + sharp
- Object storage ảnh chapter: S3-compatible API (`@aws-sdk/client-s3`)
- Tối ưu asset: `clean-css` + `terser` + `compression`

## 4. Cấu trúc thư mục

```text
.
├─ server.js
├─ app.js
├─ src/
│  └─ routes/
│     ├─ site-routes.js
│     ├─ admin-and-engagement-routes.js
│     └─ engagement-routes.js
├─ package.json
├─ .env
├─ scripts/
│  ├─ backup-db.js
│  ├─ restore-db.js
│  └─ purge-tmp.js
├─ public/
│  ├─ styles.css
│  ├─ auth.js
│  ├─ comments.js
│  ├─ notifications.js
│  ├─ reader.js
│  ├─ account.js
│  ├─ reading-history.js
│  ├─ admin.js
│  ├─ admin-sso.js
│  └─ stickers/
├─ views/
│  ├─ index.ejs
│  ├─ manga.ejs
│  ├─ manga-detail.ejs
│  ├─ chapter.ejs
│  ├─ account.ejs
│  ├─ reading-history.ejs
│  └─ admin/*.ejs
└─ uploads/
```

## 5. Cài đặt nhanh (local)

### 5.1 Yêu cầu

- Node.js 20+ (khuyến nghị LTS mới)
- PostgreSQL

### 5.2 Cài dependency

```bash
npm install
```

### 5.3 Cấu hình môi trường

```bash
cp .env.example .env
```

Sau đó chỉnh `.env` theo mục [6](#6-cấu-hình-env).

## 6. Cấu hình env

### 6.1 Bắt buộc tối thiểu

- `DATABASE_URL`: chuỗi kết nối PostgreSQL.

Ví dụ local:

```env
PORT=3000
DATABASE_URL=postgresql://postgres:12345@localhost:5432/xxxx
SESSION_SECRET=mot_chuoi_ngau_nhien_rat_dai
ADMIN_USER=admin
ADMIN_PASS=12345
ADMIN_PASSWORD_LOGIN_ENABLED=1
APP_ENV=development
TRUST_PROXY=0
```

### 6.2 Nhóm biến quan trọng

#### Ứng dụng

- `PORT`: cổng chạy server (mặc định `3000`).
- `APP_ENV`: `development` hoặc `production`.
- `APP_DOMAIN`: domain công khai (dùng để suy callback/canonical URL).
- `SITE_URL`, `PUBLIC_SITE_URL`: override origin công khai.
- `OAUTH_CALLBACK_BASE_URL`: ép callback OAuth về URL cố định.

#### Session và proxy

- `SESSION_SECRET`: bắt buộc ở production, nên >= 32 ký tự.
- `TRUST_PROXY`: `1` nếu chạy sau reverse proxy (Nginx/Cloudflare...).
- `SESSION_COOKIE_SECURE`: ép cookie secure (khuyến nghị bật ở production HTTPS).

#### Admin đăng nhập mật khẩu

- `ADMIN_USER`, `ADMIN_PASS`: tài khoản admin dạng password.
- `ADMIN_PASSWORD_LOGIN_ENABLED`:
  - `1`: cho phép login bằng user/pass,
  - `0`: tắt password login, chỉ cho admin badge qua OAuth.

#### OAuth

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`

#### Turnstile

- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`

#### Lưu trữ ảnh chapter (S3-compatible)

- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `CHAPTER_CDN_BASE_URL`
- `S3_CHAPTER_PREFIX` (mặc định: `chapters`)

#### Bảo mật/asset

- `CSP_ENABLED` (mặc định bật)
- `CSP_REPORT_ONLY`
- `JS_MINIFY_ENABLED` (minify JS khi startup)

## 7. Chạy web

### Development

```bash
npm run dev
```

### Production

```bash
npm run start
```

Web sẽ tự:

- Khởi tạo/migrate schema DB,
- Build cache minified JS (nếu bật),
- Bật các job dọn dẹp định kỳ (session, cover temp, draft chapter, notification cũ),
- Resume các job xử lý chapter bị dang dở.

## 8. Hướng dẫn sử dụng

### 8.1 Người dùng cuối

1. Vào trang chủ `/` xem truyện nổi bật và cập nhật mới.
2. Vào `/manga` để tìm truyện theo tên/tác giả/thể loại.
3. Vào trang truyện để đọc danh sách chương và bình luận.
4. Vào trang chương để đọc ảnh và dùng điều hướng chương.
5. Đăng nhập OAuth để:
   - Bình luận,
   - Like/report,
   - Nhận thông báo mention,
   - Quản lý profile,
   - Theo dõi lịch sử đọc.

### 8.2 Quản trị

1. Đăng nhập `/admin/login` bằng password hoặc OAuth (nếu có badge Admin).
2. Vào `/admin` để xem dashboard.
3. Quản lý nội dung theo từng module:
   - `/admin/homepage`
   - `/admin/manga`
   - `/admin/genres`
   - `/admin/comments`
   - `/admin/badges`
   - `/admin/members`

## 9. Scripts vận hành

### 9.1 NPM scripts

- `npm run start`: chạy server.
- `npm run dev`: chạy server (dev).
- `npm run purge:tmp`: dọn dữ liệu tạm local + remote.
- `npm run backup:db`: backup PostgreSQL bằng `pg_dump`.
- `npm run restore:db`: restore PostgreSQL bằng `pg_restore`/`psql`.

### 9.2 Backup database

Lệnh mặc định:

```bash
npm run backup:db
```

Tùy chọn chính:

- `--out-dir <path>`: thư mục backup (mặc định `backups`)
- `--prefix <name>`: tiền tố file (mặc định `database`)
- `--format <custom|plain|tar|directory>`
- `--schema <name>`
- `--compress <0-9>`
- `--keep <N>`: giữ N bản backup mới nhất
- `--verbose`
- `--bin <path>`: đường dẫn `pg_dump`

Ví dụ:

```bash
node scripts/backup-db.js --format plain --out-dir backups --keep 14
```

Kết quả gồm file backup + file metadata `*.meta.json`.

### 9.3 Restore database

Lưu ý: restore có thể phá hủy dữ liệu hiện tại ở chế độ `replace`.

```bash
npm run restore:db -- --file backups/database_20260216_130000Z.dump --yes
```

Tùy chọn chính:

- `--file <path>`: file/folder backup
- `--out-dir <path>` + `--prefix <name>`: tự tìm bản mới nhất
- `--format <auto|custom|tar|plain|directory>`
- `--mode <replace|safe>`
- `--schema <name>`
- `--jobs <N>`
- `--dry-run`
- `--yes` (bắt buộc để chạy thật)
- `--pg-restore-bin <path>` / `--psql-bin <path>`

Ví dụ:

```bash
npm run restore:db -- --out-dir backups --prefix database --yes
```

### 9.4 Dọn dữ liệu tạm

```bash
npm run purge:tmp
```

Script sẽ:

- Xóa file trong `uploads/covers/tmp`,
- Xóa bản ghi `chapter_drafts`,
- Xóa file tạm trên object storage theo prefix `<chapterPrefix>/tmp/`.

## 10. API/route quan trọng

### 10.1 Public pages

- `GET /`
- `GET /manga`
- `GET /manga/:slug`
- `GET /manga/:slug/chapters/:number`
- `GET /privacy-policy`
- `GET /terms-of-service`
- `GET /robots.txt`
- `GET /sitemap.xml`

### 10.2 Auth + profile

- `GET /auth/session`
- `POST /auth/logout`
- `POST /auth/profile`
- `GET /auth/google`, `GET /auth/google/callback`
- `GET /auth/discord`, `GET /auth/discord/callback`
- `GET /account`, `GET /account/history`
- `GET /account/me`
- `GET /account/reading-history`
- `POST /account/reading-history`
- `POST /account/avatar/upload`
- `POST /account/profile/sync`

### 10.3 Comment + reaction + notification

- `POST /manga/:slug/comments`
- `POST /manga/:slug/chapters/:number/comments`
- `GET /manga/:slug/comment-mentions`
- `POST /comments/link-labels`
- `POST /comments/reactions`
- `POST /comments/:id/like`
- `POST /comments/:id/report`
- `POST /comments/:id/delete`
- `GET /comments/users/:id`
- `GET /notifications/stream`
- `GET /notifications`
- `POST /notifications/read-all`
- `POST /notifications/:id/read`

### 10.4 Admin

- Auth: `/admin/login`, `/admin/sso`, `/admin/logout`
- Dashboard/homepage: `/admin`, `/admin/homepage`
- Manga: `/admin/manga`, `/admin/manga/new`, `/admin/manga/:id/edit`, `/admin/manga/:id/delete`, `/admin/manga/:id/visibility`
- Chapter: `/admin/manga/:id/chapters`, `/admin/manga/:id/chapters/new`, `/admin/chapters/:id/edit`, `/admin/chapters/:id/delete`, `/admin/chapters/:id/processing/retry`
- Chapter draft upload: `/admin/chapter-drafts/:token/*`
- Comments moderation: `/admin/comments*`
- Members: `/admin/members*`
- Badges: `/admin/badges*`
- Genres: `/admin/genres*`
- Jobs: `/admin/jobs/:id`

## 11. Bảo mật và tối ưu hiệu năng

### 11.1 Bảo mật

- Header cứng: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP`.
- CSP có nonce, bật/tắt qua env.
- HSTS khi production HTTPS.
- Session lưu trong PostgreSQL (`web_sessions`), cookie `httpOnly`, `sameSite=lax`, `secure` theo cấu hình.
- Kiểm tra same-origin cho các route ghi dữ liệu nhạy cảm (admin/account/comments/notifications).
- Rate limit cho đăng nhập admin.
- Turnstile challenge cho luồng comment nghi ngờ bot.
- Xóa dữ liệu nhạy cảm khỏi phản hồi công khai (ví dụ email không lộ qua API profile comment user).

### 11.2 Tối ưu

- Gzip/Brotli qua middleware `compression` (trừ SSE).
- Minify JS runtime cache + minify CSS ở production.
- Caching cho sitemap, sticker manifest, static uploads.
- Query thư viện truyện đã tối ưu cho lọc/sắp xếp/phân trang.
- Lazy-load script nặng ở client (comments/notifications/reading history theo ngữ cảnh).

## 12. Sự cố thường gặp

### `DATABASE_URL chưa được cấu hình`

- Kiểm tra `.env` đã có `DATABASE_URL` hợp lệ.

### Không đăng nhập OAuth được

- Kiểm tra đủ cặp `*_CLIENT_ID` và `*_CLIENT_SECRET`.
- Kiểm tra callback URL ở provider trùng với `OAUTH_CALLBACK_BASE_URL`/domain thực tế.

### Upload chapter lỗi do storage

- Kiểm tra các biến `S3_*` và `CHAPTER_CDN_BASE_URL`.
- Kiểm tra bucket và quyền ghi/xóa object.

### `pg_dump`/`pg_restore`/`psql` không tìm thấy

- Cài PostgreSQL client tools.
- Hoặc truyền đường dẫn binary bằng `--bin`, `--pg-restore-bin`, `--psql-bin`.

### Không vào được admin dù đã login OAuth

- Tài khoản phải có badge có quyền `can_access_admin = true` (thường là `Admin`).

## 13. Giới hạn và lưu ý

- Chưa có test automation trong `package.json`.
- Chưa có pipeline CI/CD đóng gói sẵn.
## 14. Pháp lý và tuyên bố miễn trừ

- Website có trang riêng:
  - `GET /privacy-policy`
  - `GET /terms-of-service`
- Khi sử dụng hệ thống, người dùng cần tuân thủ điều khoản của website và điều khoản của các dịch vụ bên thứ ba (OAuth, storage, hạ tầng).
- Dịch vụ được cung cấp theo nguyên tắc "as is" và "as available"; không bảo đảm không gián đoạn tuyệt đối.
- Tự chịu trách nhiệm cấu hình bảo mật, sao lưu dữ liệu, quản lý quyền truy cập và tuân thủ pháp luật địa phương.
