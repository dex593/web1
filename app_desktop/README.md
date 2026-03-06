# app_desktop

Electron desktop app for bulk chapter upload.

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

## Flow

1. Enter API endpoint (default `https://api.moetruyen.net`) and API key.
   - After successful login, only endpoint is saved locally.
2. Choose manga from allowed list.
3. Pick parent folder that contains chapter subfolders named by chapter number (`1`, `1.5`, `2`, ...).
4. Edit chapter title in table if needed.
5. For existing chapter conflicts, choose `Bỏ qua` or `Up đè`.
6. Click `Upload hàng loạt`.

`config.json` is auto-created in the selected parent folder.
