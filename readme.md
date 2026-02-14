# BFANG Team Web

Small Node.js + Express app for manga publishing and admin management.

## Quick start

1. Install dependencies: `npm install`
2. Create `.env` with:
   - `DATABASE_URL`
   - `ADMIN_USER`
   - `ADMIN_PASS`
3. Run app: `npm run dev` (or `npm run start`)

## Main pages

- `/` home
- `/manga` manga list
- `/manga/:slug` manga detail
- `/admin` admin login/dashboard

## Notes

- Chapter images use S3-compatible storage (MinIO/S3/B2 API).
- Do not commit `.env`, `data/*.db`, or `uploads/`.
