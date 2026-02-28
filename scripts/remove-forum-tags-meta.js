"use strict";

const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL chưa được cấu hình trong .env");
}

const FORUM_SECTION_SLUGS = new Set([
  "thao-luan-chung",
  "tim-truyen",
  "goi-y",
  "huong-dan",
  "tin-tuc",
]);
const FORUM_META_COMMENT_PATTERN = /<!--\s*forum-meta:([^>]*?)\s*-->/gi;

const normalizeForumSectionSlug = (value) => {
  const slug = (value == null ? "" : String(value))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return FORUM_SECTION_SLUGS.has(slug) ? slug : "";
};

const stripForumTagsMetaFromContent = (value) => {
  const raw = value == null ? "" : String(value);
  return raw.replace(FORUM_META_COMMENT_PATTERN, (_fullMatch, payloadText) => {
    let sectionSlug = "";
    const payload = (payloadText == null ? "" : String(payloadText)).trim();
    if (payload) {
      const pairs = payload
        .split(";")
        .map((item) => (item == null ? "" : String(item)).trim())
        .filter(Boolean);

      for (const pair of pairs) {
        const equalIndex = pair.indexOf("=");
        if (equalIndex <= 0) continue;
        const key = pair.slice(0, equalIndex).trim().toLowerCase();
        if (key !== "section") continue;
        const normalized = normalizeForumSectionSlug(pair.slice(equalIndex + 1));
        if (normalized) {
          sectionSlug = normalized;
          break;
        }
      }
    }

    return sectionSlug ? `<!--forum-meta:section=${sectionSlug}-->` : "";
  });
};

const run = async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  let scanned = 0;
  let updated = 0;

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT id, content
        FROM comments
        WHERE content ILIKE $1
      `,
      ["%<!--forum-meta:%"]
    );

    for (const row of result.rows || []) {
      scanned += 1;
      const commentId = row && row.id != null ? Number(row.id) : 0;
      if (!Number.isFinite(commentId) || commentId <= 0) continue;

      const originalContent = row && row.content != null ? String(row.content) : "";
      const normalizedContent = stripForumTagsMetaFromContent(originalContent);
      if (normalizedContent === originalContent) continue;

      await client.query("UPDATE comments SET content = $1 WHERE id = $2", [normalizedContent, Math.floor(commentId)]);
      updated += 1;
    }

    await client.query("COMMIT");
    console.log(`Forum meta tags cleanup completed. Scanned: ${scanned}, Updated: ${updated}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

run().catch((error) => {
  console.error("Failed to cleanup forum meta tags:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
