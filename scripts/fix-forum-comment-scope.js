"use strict";

const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL chưa được cấu hình trong .env");
}

const FORUM_META_LIKE = "%<!--forum-meta:%";
const FORUM_REQUEST_PREFIX = "forum-";
const FORUM_REQUEST_LIKE = `${FORUM_REQUEST_PREFIX}%`;

const SUMMARY_SQL = `
  WITH RECURSIVE all_threads AS (
    SELECT
      c.id,
      c.parent_id,
      c.id AS root_id,
      c.client_request_id,
      c.content
    FROM comments c
    WHERE c.parent_id IS NULL

    UNION ALL

    SELECT
      child.id,
      child.parent_id,
      at.root_id,
      child.client_request_id,
      child.content
    FROM comments child
    JOIN all_threads at ON child.parent_id = at.id
  ),
  forum_roots AS (
    SELECT DISTINCT at.root_id
    FROM all_threads at
    WHERE (
      at.id = at.root_id
      AND at.content ILIKE $1
    )
    OR COALESCE(at.client_request_id, '') ILIKE $2
    OR EXISTS (
      SELECT 1
      FROM forum_post_bookmarks b
      WHERE b.comment_id = at.root_id
    )
  ),
  forum_rows AS (
    SELECT
      at.id,
      at.root_id,
      at.parent_id,
      at.client_request_id
    FROM all_threads at
    JOIN forum_roots fr ON fr.root_id = at.root_id
  )
  SELECT
    (SELECT COUNT(*)::int FROM comments) AS total_comments,
    (SELECT COUNT(*)::int FROM forum_roots) AS inferred_forum_topics,
    (SELECT COUNT(*)::int FROM forum_rows) AS inferred_forum_comments,
    (
      SELECT COUNT(*)::int
      FROM forum_rows fr
      WHERE COALESCE(fr.client_request_id, '') ILIKE $2
    ) AS prefixed_forum_comments,
    (
      SELECT COUNT(*)::int
      FROM forum_rows fr
      WHERE COALESCE(fr.client_request_id, '') NOT ILIKE $2
    ) AS missing_prefix_forum_comments,
    (
      SELECT COUNT(*)::int
      FROM comments c
      WHERE COALESCE(c.client_request_id, '') ILIKE $2
    ) AS total_prefixed_comments,
    (
      SELECT COUNT(*)::int
      FROM comments c
      WHERE COALESCE(c.client_request_id, '') ILIKE $2
        AND NOT EXISTS (
          SELECT 1
          FROM forum_rows fr
          WHERE fr.id = c.id
        )
    ) AS prefixed_outside_forum_scope
`;

const SAMPLE_SQL = `
  WITH RECURSIVE all_threads AS (
    SELECT
      c.id,
      c.parent_id,
      c.id AS root_id,
      c.client_request_id,
      c.content
    FROM comments c
    WHERE c.parent_id IS NULL

    UNION ALL

    SELECT
      child.id,
      child.parent_id,
      at.root_id,
      child.client_request_id,
      child.content
    FROM comments child
    JOIN all_threads at ON child.parent_id = at.id
  ),
  forum_roots AS (
    SELECT DISTINCT at.root_id
    FROM all_threads at
    WHERE (
      at.id = at.root_id
      AND at.content ILIKE $1
    )
    OR COALESCE(at.client_request_id, '') ILIKE $2
    OR EXISTS (
      SELECT 1
      FROM forum_post_bookmarks b
      WHERE b.comment_id = at.root_id
    )
  ),
  forum_rows AS (
    SELECT
      at.id,
      at.root_id,
      at.parent_id,
      at.client_request_id,
      at.content
    FROM all_threads at
    JOIN forum_roots fr ON fr.root_id = at.root_id
  )
  SELECT
    fr.id,
    fr.root_id,
    fr.parent_id,
    COALESCE(fr.client_request_id, '') AS client_request_id,
    LEFT(
      REGEXP_REPLACE(COALESCE(fr.content, ''), '<[^>]+>', ' ', 'g'),
      140
    ) AS preview
  FROM forum_rows fr
  WHERE COALESCE(fr.client_request_id, '') NOT ILIKE $2
  ORDER BY fr.root_id DESC, fr.parent_id NULLS FIRST, fr.id ASC
  LIMIT $3
`;

const OUTSIDE_SAMPLE_SQL = `
  WITH RECURSIVE all_threads AS (
    SELECT
      c.id,
      c.parent_id,
      c.id AS root_id,
      c.client_request_id,
      c.content
    FROM comments c
    WHERE c.parent_id IS NULL

    UNION ALL

    SELECT
      child.id,
      child.parent_id,
      at.root_id,
      child.client_request_id,
      child.content
    FROM comments child
    JOIN all_threads at ON child.parent_id = at.id
  ),
  forum_roots AS (
    SELECT DISTINCT at.root_id
    FROM all_threads at
    WHERE (
      at.id = at.root_id
      AND at.content ILIKE $1
    )
    OR COALESCE(at.client_request_id, '') ILIKE $2
    OR EXISTS (
      SELECT 1
      FROM forum_post_bookmarks b
      WHERE b.comment_id = at.root_id
    )
  ),
  forum_rows AS (
    SELECT at.id
    FROM all_threads at
    JOIN forum_roots fr ON fr.root_id = at.root_id
  )
  SELECT
    c.id,
    c.parent_id,
    c.manga_id,
    c.chapter_number,
    COALESCE(c.client_request_id, '') AS client_request_id,
    LEFT(
      REGEXP_REPLACE(COALESCE(c.content, ''), '<[^>]+>', ' ', 'g'),
      140
    ) AS preview
  FROM comments c
  WHERE COALESCE(c.client_request_id, '') ILIKE $2
    AND NOT EXISTS (
      SELECT 1
      FROM forum_rows fr
      WHERE fr.id = c.id
    )
  ORDER BY c.id ASC
  LIMIT $3
`;

const UPDATE_SQL = `
  WITH RECURSIVE all_threads AS (
    SELECT
      c.id,
      c.parent_id,
      c.id AS root_id,
      c.client_request_id,
      c.content
    FROM comments c
    WHERE c.parent_id IS NULL

    UNION ALL

    SELECT
      child.id,
      child.parent_id,
      at.root_id,
      child.client_request_id,
      child.content
    FROM comments child
    JOIN all_threads at ON child.parent_id = at.id
  ),
  forum_roots AS (
    SELECT DISTINCT at.root_id
    FROM all_threads at
    WHERE (
      at.id = at.root_id
      AND at.content ILIKE $1
    )
    OR COALESCE(at.client_request_id, '') ILIKE $2
    OR EXISTS (
      SELECT 1
      FROM forum_post_bookmarks b
      WHERE b.comment_id = at.root_id
    )
  ),
  forum_rows AS (
    SELECT
      at.id,
      at.client_request_id
    FROM all_threads at
    JOIN forum_roots fr ON fr.root_id = at.root_id
  )
  UPDATE comments c
  SET client_request_id = CONCAT('${FORUM_REQUEST_PREFIX}legacy-', c.id::text)
  FROM forum_rows fr
  WHERE c.id = fr.id
    AND COALESCE(fr.client_request_id, '') NOT ILIKE $2
`;

const printSummary = (summary) => {
  console.log("Forum scope audit");
  console.log(`- Total comments: ${summary.total_comments}`);
  console.log(`- Inferred forum topics: ${summary.inferred_forum_topics}`);
  console.log(`- Inferred forum comments: ${summary.inferred_forum_comments}`);
  console.log(`- Forum comments with prefix: ${summary.prefixed_forum_comments}`);
  console.log(`- Forum comments missing prefix: ${summary.missing_prefix_forum_comments}`);
  console.log(`- Total prefixed comments: ${summary.total_prefixed_comments}`);
  console.log(`- Prefixed outside inferred forum scope: ${summary.prefixed_outside_forum_scope}`);
};

const printRows = ({ title, rows, formatter }) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const row of list) {
    console.log(formatter(row));
  }
};

const run = async () => {
  const args = new Set(process.argv.slice(2));
  const applyChanges = args.has("--apply");
  const sampleLimitRaw = Number(process.env.FORUM_SCOPE_AUDIT_SAMPLE_LIMIT || 20);
  const sampleLimit = Number.isFinite(sampleLimitRaw) && sampleLimitRaw > 0
    ? Math.min(Math.floor(sampleLimitRaw), 200)
    : 20;

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const initialSummaryResult = await client.query(SUMMARY_SQL, [FORUM_META_LIKE, FORUM_REQUEST_LIKE]);
    const initialSummary = initialSummaryResult.rows && initialSummaryResult.rows[0] ? initialSummaryResult.rows[0] : null;
    if (!initialSummary) {
      throw new Error("Không thể đọc summary comments/forum.");
    }

    printSummary(initialSummary);

    if (Number(initialSummary.prefixed_outside_forum_scope) > 0) {
      const outsideSample = await client.query(OUTSIDE_SAMPLE_SQL, [
        FORUM_META_LIKE,
        FORUM_REQUEST_LIKE,
        sampleLimit,
      ]);
      printRows({
        title: "Sample prefixed rows outside inferred forum scope:",
        rows: outsideSample.rows,
        formatter: (row) => {
          const id = row && row.id != null ? String(row.id) : "";
          const parentId = row && row.parent_id != null ? String(row.parent_id) : "null";
          const mangaId = row && row.manga_id != null ? String(row.manga_id) : "";
          const chapterNumber = row && row.chapter_number != null ? String(row.chapter_number) : "null";
          const requestId = row && row.client_request_id != null ? String(row.client_request_id) : "";
          const preview = row && row.preview != null ? String(row.preview).replace(/\s+/g, " ").trim() : "";
          return `- id=${id}, parent=${parentId}, manga=${mangaId}, chapter=${chapterNumber}, requestId='${requestId}', preview='${preview}'`;
        },
      });
    }

    if (!applyChanges) {
      if (Number(initialSummary.missing_prefix_forum_comments) > 0) {
        const sampleResult = await client.query(SAMPLE_SQL, [FORUM_META_LIKE, FORUM_REQUEST_LIKE, sampleLimit]);
        printRows({
          title: "Sample rows missing forum prefix:",
          rows: sampleResult.rows,
          formatter: (row) => {
            const id = row && row.id != null ? String(row.id) : "";
            const rootId = row && row.root_id != null ? String(row.root_id) : "";
            const parentId = row && row.parent_id != null ? String(row.parent_id) : "null";
            const requestId = row && row.client_request_id != null ? String(row.client_request_id) : "";
            const preview = row && row.preview != null ? String(row.preview).replace(/\s+/g, " ").trim() : "";
            return `- id=${id}, root=${rootId}, parent=${parentId}, requestId='${requestId}', preview='${preview}'`;
          },
        });
      }

      console.log("\nDry run complete. Dùng --apply để cập nhật client_request_id cho legacy forum comments.");
      return;
    }

    await client.query("BEGIN");
    const updateResult = await client.query(UPDATE_SQL, [FORUM_META_LIKE, FORUM_REQUEST_LIKE]);
    await client.query("COMMIT");

    const updatedRows = updateResult && Number.isFinite(updateResult.rowCount)
      ? Number(updateResult.rowCount)
      : 0;
    console.log(`\nApplied: updated ${updatedRows} rows.`);

    const finalSummaryResult = await client.query(SUMMARY_SQL, [FORUM_META_LIKE, FORUM_REQUEST_LIKE]);
    const finalSummary = finalSummaryResult.rows && finalSummaryResult.rows[0] ? finalSummaryResult.rows[0] : null;
    if (finalSummary) {
      console.log("\nAfter apply:");
      printSummary(finalSummary);
    }
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
  console.error("Failed to fix forum comment scope:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
