# app_desktop

Electron desktop app for bulk chapter upload.

UI stack: Tailwind CSS + shadcn/ui design tokens.

Tài liệu tiếng Việt chi tiết: `app_desktop/HUONG_DAN_SU_DUNG.md`

## Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start app:

   ```bash
   npm run start
   ```

UI can be rebuilt from Tailwind source (`renderer/styles.source.css`) with:

```bash
npm run styles:build
```

## Build EXE (Windows)

### Dùng logo favicon web hiện tại

- App desktop lấy logo từ favicon web: `../public/logobfang.svg`.
- Trước khi build, chạy:

  ```bash
  npm run icon:sync
  ```

- `build:win` và `build:win:lite` đã tự chạy bước này.

- Script sẽ tự tạo:
  - `app_desktop/assets/icon.png` (icon runtime window)
  - `app_desktop/assets/icon.ico` (icon cho file `.exe`)

### Build nhẹ nhất có thể (khuyến nghị)

```bash
npm run build:win:lite
```

- Dùng target `nsis` để tạo file setup `.exe` thường nhẹ hơn bản portable.
- Build config đã bật:
  - `compression: maximum`
  - `electronLanguages: ["en-US"]`
  - chỉ đóng gói các file cần thiết.

### Build bản portable (không cần cài)

```bash
npm run build:win
```

File output nằm trong `app_desktop/dist/`.

## Flow

1. Enter API endpoint (default `https://api.moetruyen.net`) and API key.
   - After successful login, only endpoint is saved locally.
2. Choose manga from allowed list.
3. Pick parent folder that contains chapter subfolders named by chapter number (`1`, `1.5`, `2`, ...).
4. Edit chapter title in table if needed.
5. For existing chapter conflicts, choose `Bỏ qua` or `Up đè`.
6. Click `Upload hàng loạt`.

No `config.json` file is used anymore.
