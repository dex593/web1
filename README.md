# BFANG Manga Platform

Monorepo cho hệ sinh thái Mòe Truyện/BFANG gồm web đọc truyện, API upload độc lập và app desktop upload chapter hàng loạt.

## Thành phần chính

- `web` (root project): site người dùng + admin CMS, chạy mặc định `http://127.0.0.1:3000`.
- `api_server/`: API độc lập cho app desktop (xác thực API key, upload chapter), chạy mặc định `http://127.0.0.1:3001`.
- `app_desktop/`: app Electron để upload hàng loạt từ thư mục local.
- `sampleforum/`: frontend forum riêng (tùy chọn, build ra `/forum`).

## Cấu trúc thư mục

```text
.
├─ server.js                # Entrypoint web server
├─ app.js                   # Composition root
├─ src/                     # Domain + routes chính
├─ views/                   # EJS templates
├─ public/                  # Static assets
├─ scripts/                 # Script vận hành
├─ api_server/              # Standalone upload API server
├─ app_desktop/             # Electron desktop uploader
└─ sampleforum/             # Forum frontend (optional)
```

## Yêu cầu hệ thống

- Node.js 20+
- PostgreSQL 14+
- S3-compatible object storage (MinIO/B2/S3...) cho ảnh chapter/forum

## 1) Chạy web server (root)

### Cài dependencies

```bash
npm install
```

### Tạo `.env`

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

### Biến tối thiểu

```env
PORT=3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/your_db
SESSION_SECRET=mot_chuoi_bi_mat_dai_it_nhat_32_ky_tu
APP_ENV=development
```

### Chạy

```bash
npm run dev
```

Mở nhanh:

- Site: `http://127.0.0.1:3000`
- Admin login: `http://127.0.0.1:3000/admin/login`
- Account: `http://127.0.0.1:3000/account`

## 2) Chạy `api_server` (upload API độc lập)

`api_server` không phụ thuộc runtime web server, nhưng dùng chung DB + storage.

### Cài dependencies

```bash
npm --prefix api_server install
```

### Cấu hình môi trường

```bash
cp api_server/.env.example api_server/.env
```

Biến quan trọng:

- `PORT` (mặc định `3001`)
- `DATABASE_URL` (phải trỏ đúng DB của web)
- `API_KEY_SECRET` (**phải trùng** `SESSION_SECRET` của web)
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`

### Chạy

```bash
npm --prefix api_server run start
```

Kiểm tra:

```bash
curl -i http://127.0.0.1:3001/health
```

## 3) Chạy `app_desktop`

### Cài dependencies

```bash
npm --prefix app_desktop install
```

### Chạy app

```bash
npm --prefix app_desktop run start
```

Trong app:

1. Nhập API endpoint (mặc định `https://api.moetruyen.net`).
2. Nhập API key đã tạo từ trang account web.
3. Chọn truyện -> chọn thư mục mẹ -> upload hàng loạt.

Tài liệu desktop chi tiết: `app_desktop/HUONG_DAN_SU_DUNG.md`.

## Build `.exe` cho desktop

```bash
npm --prefix app_desktop run build:win
```

Output mặc định:

- `app_desktop/dist/moetruyen-uploader-<version>.exe`

## Biến môi trường quan trọng (web root)

### Core

- `PORT`, `DATABASE_URL`, `APP_ENV`, `SESSION_SECRET`
- `SITE_URL`, `PUBLIC_SITE_URL`, `APP_DOMAIN`

### Auth/Admin/Security

- `ADMIN_USER`, `ADMIN_PASS`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- `TRUST_PROXY`, `SESSION_COOKIE_SECURE`, `CSP_ENABLED`

### Storage

- `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `CHAPTER_CDN_BASE_URL`
- `S3_CHAPTER_PREFIX`, `S3_FORUM_PREFIX`, `S3_FORUM_CDN_BASE_URL`

## Script chính (root)

- `npm run dev`: chạy web server (kèm build CSS trước khi chạy)
- `npm run start`: chạy web server production
- `npm run styles:build`: build `public/styles.css`
- `npm run styles:watch`: watch CSS
- `npm run purge:tmp`: dọn tmp local/remote
- `npm run backup:db`: backup DB
- `npm run restore:db`: restore DB

## Bảo mật & Git hygiene

- Không commit file bí mật và dữ liệu runtime:
  - `.env`, `api_server/.env`, `app_desktop/.env`
  - `uploads/`, `backups/`
  - build output như `app_desktop/dist/`
- API key người dùng chỉ hiển thị 1 lần khi tạo trên web.
- App desktop hiện chỉ lưu endpoint local; không tự persist API key.

## Sự cố thường gặp

- `401 API key invalid/revoked`: kiểm tra `API_KEY_SECRET` của `api_server` có trùng `SESSION_SECRET` web.
- Upload thành công nhưng web không hiện ảnh: kiểm tra `CHAPTER_CDN_BASE_URL`, proxy/CDN rule, purge cache.
- Không thấy `/forum`: cần bật `FORUM_PAGE_ENABLED=true` và build `sampleforum/dist`.
