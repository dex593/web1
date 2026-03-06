# Hướng Dẫn Sử Dụng `app_desktop`

## 1) Mục đích

`app_desktop` là app Electron để upload chapter hàng loạt bằng API key:

- Chọn truyện bạn có quyền đăng chapter.
- Chọn thư mục mẹ chứa nhiều thư mục chapter con.
- Upload hàng loạt theo thứ tự chapter.
- Nén ảnh local trước khi upload (nhanh hơn cho server web chính).

---

## 2) Chuẩn bị trước khi dùng

### A. Server API (`api_server`)

Server API phải chạy được và kết nối đúng DB + S3:

- `DATABASE_URL`: trỏ đúng database đang chạy web.
- `API_KEY_SECRET`: **phải trùng** `SESSION_SECRET` của web chính.
- S3 config: `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`.

Kiểm tra nhanh:

```bash
curl -i https://api.moetruyen.net/health
```

### B. API key tài khoản

- Vào trang Account trên web để tạo API key.
- API key chỉ hiện 1 lần khi tạo, cần lưu lại ngay.

---

## 3) Cài app và chạy

Trong thư mục `app_desktop`:

```bash
npm install
npm run start
```

---

## 4) Đăng nhập trong app

Khi mở app:

1. Nhập `API endpoint` (mặc định: `https://api.moetruyen.net`).
2. Nhập `API key`.
3. Bấm `Kết nối`.

Sau khi kết nối thành công, app chỉ lưu endpoint vào local storage để lần mở sau tự điền lại.

Nếu hợp lệ, app sẽ hiện:

- thông tin tài khoản (gọn),
- danh sách truyện có quyền upload chapter.

---

## 5) Quy ước thư mục upload

Chọn **thư mục mẹ**, bên trong có các thư mục con theo số chapter:

```text
parent-folder/
  184/
    001.jpg
    002.jpg
    003.jpg
  185/
    1.png
    2.png
```

Lưu ý:

- Tên thư mục chapter phải parse được thành số (`1`, `1.5`, `2`, ...).
- Ảnh hỗ trợ: `.jpg`, `.jpeg`, `.png`, `.webp`.
- Mỗi chapter tối đa 220 ảnh.
- App tự tạo/cập nhật `config.json` trong thư mục mẹ.

---

## 6) Ý nghĩa bảng upload

- `Chọn`: tick chapter muốn upload.
- `Chap`: số chapter.
- `Folder`: tên thư mục chapter.
- `Ảnh`: số lượng ảnh đọc được.
- `Tiêu đề chapter`: nhập tên chapter.
- `Tình trạng`:
  - chapter mới: hiển thị `Mới`.
  - chapter đã tồn tại: chọn `Bỏ qua` hoặc `Up đè`.
- `Trạng thái`:
  - chưa chạy: `Sẵn sàng`.
  - đang chạy: hiện tiến độ `x/n` + vòng xoay.
  - xong: `Hoàn thành` màu xanh.

---

## 7) Cách upload hàng loạt

1. Chọn truyện.
2. Bấm `Chọn thư mục mẹ`.
3. Kiểm tra table, chỉnh `Tiêu đề chapter` nếu cần.
4. Với chapter trùng, chọn `Bỏ qua` hoặc `Up đè`.
5. Chỉnh `Retry mỗi bước` và `Delay giữa chapter`.
6. Bấm `Upload hàng loạt`.

Trong lúc chạy:

- Upload theo **thứ tự chapter**.
- Trong 1 chapter: upload song song **3 ảnh/lần** để tăng tốc.
- Thành công chapter nào sẽ tự bỏ tick chapter đó.

---

## 8) Nút chức năng chính

- `Làm mới`: reset bảng upload + reset danh sách truyện + xóa log rồi tải lại dữ liệu.
  - Nút này sẽ mờ/khóa khi đang upload.
- `Đổi API key`: đăng nhập lại bằng key khác.
- `Chọn thư mục mẹ`: chọn thư mục nguồn chapter.
- `Tải lại thư mục`: đọc lại thư mục mẹ hiện tại.
- `Lưu config.json`: lưu tay ngay lập tức.

---

## 9) Cơ chế nén ảnh

Ảnh được nén local trước khi gửi API:

- auto rotate theo EXIF,
- resize max width 1200 (không phóng to ảnh nhỏ),
- xuất WebP (`quality: 77`, `effort: 6`).

---

## 10) Sự cố thường gặp

### Không kết nối được API

- Đảm bảo endpoint đúng `https://...`.
- Test `GET /health` phải trả `200`.

### Báo API key invalid/revoked

- Tạo lại API key trên web.
- Kiểm tra `API_KEY_SECRET` ở `api_server` có trùng `SESSION_SECRET` web không.

### Upload xong nhưng web đọc ảnh lỗi

- Kiểm tra `CHAPTER_CDN_BASE_URL` của web.
- Kiểm tra rule CDN/proxy/rewrite.
- Purge cache CDN nếu vừa đổi hạ tầng.

### Chapter báo không đủ quyền

- Tài khoản chưa có quyền upload chapter cho nhóm/truyện đó.

---

## 11) Best practices

- Upload thử 1 chapter trước khi chạy số lượng lớn.
- Đặt tên ảnh theo thứ tự rõ ràng (`001`, `002`, ...).
- Giữ `Retry` ở mức 2-3 và `Delay` 500-1200ms để ổn định.
