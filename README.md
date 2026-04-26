# Mòe Truyện

## 1) Tổng quan

Project này là hệ thống đọc truyện dùng **Node.js + Express + EJS + PostgreSQL**. Web chính dùng **Bun** để cài dependencies và chạy scripts.

Các thành phần chính:

- Web chính (bắt buộc): đọc truyện, bình luận, tài khoản, team, admin.
- `sampleforum` (tuỳ chọn): frontend forum, được serve tại `/forum` sau khi build.
- `api_server` (tuỳ chọn): API upload dành cho desktop bulk uploader.
- `api_web` (tuỳ chọn): API bridge MangaDex/WeebDex.
- `app_desktop` (tuỳ chọn): app Electron upload chapter.

## 2) Yêu cầu hệ thống

- Node.js **20+**
- Bun **1.3+**
- PostgreSQL **16+**

Node.js vẫn cần thiết vì server khởi động bằng `node server.js`; Bun là package manager/script runner chính của web.

Nếu dùng backup/restore DB: cần `pg_dump`, `pg_restore`, `psql` trong PATH.

## 3) Cài đặt chi tiết (project mới)

### Bước 1: Clone source

```bash
git clone <REPO_URL>
cd web1
```

### Bước 2: Cài dependencies

```bash
bun install
```

### Bước 3: Tạo database PostgreSQL

Ví dụ bằng `psql`:

```sql
CREATE USER bfang WITH PASSWORD '12345';
CREATE DATABASE bfang OWNER bfang;
```

### Bước 4: Tạo `.env`

Linux/macOS:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### Bước 5: Cấu hình biến tối thiểu trong `.env`

```env
PORT=3000
APP_ENV=development
DATABASE_URL=postgresql://bfang:12345@localhost:5432/bfang

SESSION_SECRET=<chuoi-ngau-nhien-it-nhat-32-ky-tu>
ADMIN_USER=admin
ADMIN_PASS=12345
ADMIN_PASSWORD_LOGIN_ENABLED=1

NEWS_PAGE_ENABLED=off
FORUM_PAGE_ENABLED=false
```

### Bước 6: Bootstrap DB

```bash
bun run db:bootstrap
```

Lệnh này chạy tuần tự:

1. sync schema DB,
2. chạy init maintenance,
3. repair + verify forum storage,
4. sync snapshot schema về `db.json`.

### Bước 7: Chạy server

```bash
bun run dev
```

Mặc định: `http://127.0.0.1:3000`

### Bước 8: Smoke test cơ bản

- `/`
- `/manga`
- `/manga/:slug`
- `/manga/:slug/chapters/:number`
- `/admin/login`

---

## 4) Cài nhanh (rút gọn)

### Cách tự động

```bash
bun run setup:all
bun run dev
```

### Cách thủ công

```bash
bun install
cp .env.example .env
bun run db:bootstrap
bun run dev
```

PowerShell:

```powershell
bun install
Copy-Item .env.example .env
bun run db:bootstrap
bun run dev
```

## 5) Cập nhật bản đang chạy (staging/production)

Khuyến nghị theo thứ tự sau:

1. Backup DB trước:

   ```bash
   bun run backup:db
   ```

2. Pull code + cài lại deps:

   ```bash
   git pull
   bun install
   ```

3. Soát biến mới trong `.env.example`, bổ sung vào `.env` thực tế.

4. Chạy bootstrap:

   ```bash
   bun run db:bootstrap
   ```

   Nếu cần schema destructive (rất cẩn thận):

   ```bash
   bun run db:bootstrap:strict
   ```

5. Nếu dùng forum frontend: build lại `sampleforum`.
6. Restart service, smoke test lại các route chính.

## 6) Biến môi trường quan trọng

Xem đầy đủ tại `.env.example`.

### Nhóm cốt lõi

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `DATABASE_URL` | Có | Thiếu biến này app không khởi động. |
| `SESSION_SECRET` | Bắt buộc ở production | Dev có thể dùng fallback tạm. |
| `ADMIN_USER`, `ADMIN_PASS` | Cần nếu bật login mật khẩu admin | Dùng cho `/admin/login`. |
| `ADMIN_PASSWORD_LOGIN_ENABLED` | Nên set | `1/0` bật/tắt login mật khẩu admin. |
| `APP_ENV` | Nên set | `development` / `production`. |
| `PORT` | Tuỳ chọn | Mặc định `3000`. |

### Nhóm tuỳ chọn phổ biến

- Forum/News: `FORUM_PAGE_ENABLED`, `NEWS_PAGE_ENABLED`, `NEWS_DATABASE_URL`, `NEWS_DATABASE_NAME`.
- Redis cache: `REDIS_*`, `ENDPOINT_CACHE_*`.
- S3/MinIO: `S3_*`, `CHAPTER_CDN_BASE_URL`, `S3_CHAPTER_PREFIX`, `S3_MEDIA_PREFIX`, `MEDIA_CDN_BASE_URL`.
- Upload qua `api_server`: `CHAPTER_UPLOAD_API_URL`, `MEDIA_UPLOAD_API_URL`, `CHAPTER_UPLOAD_SHARED_SECRET`, `MEDIA_UPLOAD_SHARED_SECRET`.
- OAuth: `GOOGLE_CLIENT_ID/SECRET`, `DISCORD_CLIENT_ID/SECRET`, `OAUTH_CALLBACK_BASE_URL`.
- Turnstile: `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
- Google Drive upload ảnh bình luận/tin nhắn: `GOOGLE_DRIVE_*`, `COMMENT_IMAGE_UPLOAD_ENABLED`, `MESSAGE_IMAGE_UPLOAD_ENABLED`.
- Mạng/session production: `TRUST_PROXY`, `SESSION_COOKIE_SECURE`, `SITE_URL`, `PUBLIC_SITE_URL`, `APP_DOMAIN`.

## 7) Scripts chính

### Chạy app

- `bun run dev` — chạy server dev (có `predev` build Vite assets: CSS + JS).
- `bun run start` — chạy server production-like (có `prestart` build Vite assets: CSS + JS).
- `bun run assets:build` / `bun run assets:watch` — build/watch CSS + JS của web chính qua Vite.
- `bun run styles:build` / `bun run styles:watch` — alias tương thích, cùng chạy Vite asset build.
- Source JS nằm ở `resources/js/` và `resources/news/js/`; không sửa JS trực tiếp trong `public/`.
- Vite ghi JS generated vào `public/build/` đang bị ignore, còn Express vẫn giữ URL public cũ như `/reader.js`, `/sw.js`, `/tin-tuc/assets/js/main.js`.

### DB / vận hành

- `bun run db:bootstrap`
- `bun run db:bootstrap:strict`
- `bun run db:schema:sync`
- `bun run db:schema:sync:strict`
- `bun run db:schema:json:sync`
- `bun run db:schema:json:sync:all`
- `bun run db:init:maintenance`
- `bun run db:init:maintenance:apply`
- `bun run db:forum:repair`
- `bun run db:forum:repair:apply`
- `bun run backup:db`
- `bun run restore:db`

### Forum test/tools

- `bun run test:forum:unit`
- `bun run test:forum:smoke`
- `bun run test:forum`

## 8) Quy tắc schema (`db.json`)

`db.json` là snapshot schema dùng để đối chiếu.

Khi đổi cấu trúc DB (thêm/sửa bảng/cột):

1. Sửa code schema.
2. Chạy `bun run db:schema:sync`.
3. Chạy `bun run db:schema:json:sync`.
4. Commit code + `db.json` cùng nhau.

## 9) Bật module tuỳ chọn

Các module bên dưới là package phụ có `package-lock.json` riêng, nên lệnh ví dụ vẫn dùng npm trừ khi bạn chuyển riêng package đó sang Bun.

### `sampleforum`

```bash
npm --prefix sampleforum install
npm --prefix sampleforum run build
```

Set `.env`:

```env
FORUM_PAGE_ENABLED=true
```

### `api_server` (upload API)

```bash
npm --prefix api_server install
cp api_server/.env.example api_server/.env
npm --prefix api_server run start
```

Lưu ý: `API_KEY_SECRET` của `api_server` phải khớp `SESSION_SECRET` của web chính.

### `api_web` (bridge MangaDex/WeebDex)

```bash
npm --prefix api_web install
npm --prefix api_web run start
```

### `app_desktop`

```bash
npm --prefix app_desktop install
npm --prefix app_desktop run start
```

## 10) Troubleshooting nhanh

- **Lỗi `DATABASE_URL...`**: chưa set đúng `DATABASE_URL` trong `.env`.
- **Login admin lỗi**: kiểm tra `ADMIN_USER`, `ADMIN_PASS`, `ADMIN_PASSWORD_LOGIN_ENABLED`.
- **Bật forum nhưng `/forum` không chạy**: cần `FORUM_PAGE_ENABLED=true` và tồn tại `sampleforum/dist/index.html`.
- **Upload xong không thấy ảnh**: kiểm tra `CHAPTER_CDN_BASE_URL`, bucket/prefix, và cấu hình S3.
