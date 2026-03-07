# api_server

Standalone API server for desktop bulk chapter uploads.

## Run

1. Copy env template and fill values:

   - `api_server/.env.example` -> `api_server/.env`
   - `API_KEY_SECRET` must match web server `SESSION_SECRET`
   - `DATABASE_URL` and S3 settings must point to the same DB/storage used by web server
   - `API_ALLOWED_ORIGINS` (optional) can restrict browser CORS origins; defaults to `WEB_BASE_URL`

2. Install deps:

   ```bash
   npm install
   ```

3. Start:

   ```bash
   npm run start
   ```

API default: `http://127.0.0.1:3001`

## Main endpoints

- `GET /health`
- `GET /v1/bootstrap`
- `GET /v1/manga/:mangaId/chapters`
- `POST /v1/uploads/start`
- `POST /v1/uploads/:sessionId/pages`
- `POST /v1/uploads/:sessionId/complete`
- `DELETE /v1/uploads/:sessionId`
