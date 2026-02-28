"use strict";

const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config();

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL chưa được cấu hình trong .env");
}

const FORUM_REQUEST_LIKE = "forum-%";

const COUNT_SQL = `
  SELECT
    (
      SELECT COUNT(*)::int
      FROM notifications n
      WHERE n.type = 'forum_post_comment'
        AND (n.manga_id IS NOT NULL OR n.chapter_number IS NOT NULL)
    ) AS forum_post_comment_linked,
    (
      SELECT COUNT(*)::int
      FROM notifications n
      JOIN comments c ON c.id = n.comment_id
      WHERE n.type = 'mention'
        AND COALESCE(c.client_request_id, '') ILIKE $1
        AND (n.manga_id IS NOT NULL OR n.chapter_number IS NOT NULL)
    ) AS forum_mention_linked
`;

const UPDATE_FORUM_POST_COMMENT_SQL = `
  UPDATE notifications n
  SET manga_id = NULL,
      chapter_number = NULL
  WHERE n.type = 'forum_post_comment'
    AND (n.manga_id IS NOT NULL OR n.chapter_number IS NOT NULL)
`;

const UPDATE_FORUM_MENTION_SQL = `
  UPDATE notifications n
  SET manga_id = NULL,
      chapter_number = NULL
  FROM comments c
  WHERE c.id = n.comment_id
    AND n.type = 'mention'
    AND COALESCE(c.client_request_id, '') ILIKE $1
    AND (n.manga_id IS NOT NULL OR n.chapter_number IS NOT NULL)
`;

const run = async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const beforeResult = await client.query(COUNT_SQL, [FORUM_REQUEST_LIKE]);
    const before = beforeResult.rows && beforeResult.rows[0] ? beforeResult.rows[0] : null;
    if (!before) {
      throw new Error("Không lấy được trạng thái notifications trước khi cập nhật.");
    }

    console.log("Notification link audit before fix:");
    console.log(`- forum_post_comment linked rows: ${before.forum_post_comment_linked}`);
    console.log(`- forum mention linked rows: ${before.forum_mention_linked}`);

    await client.query("BEGIN");
    const forumPostUpdate = await client.query(UPDATE_FORUM_POST_COMMENT_SQL);
    const forumMentionUpdate = await client.query(UPDATE_FORUM_MENTION_SQL, [FORUM_REQUEST_LIKE]);
    await client.query("COMMIT");

    console.log("\nApplied notification decouple fix:");
    console.log(`- Updated forum_post_comment rows: ${forumPostUpdate.rowCount || 0}`);
    console.log(`- Updated forum mention rows: ${forumMentionUpdate.rowCount || 0}`);

    const afterResult = await client.query(COUNT_SQL, [FORUM_REQUEST_LIKE]);
    const after = afterResult.rows && afterResult.rows[0] ? afterResult.rows[0] : null;
    if (after) {
      console.log("\nNotification link audit after fix:");
      console.log(`- forum_post_comment linked rows: ${after.forum_post_comment_linked}`);
      console.log(`- forum mention linked rows: ${after.forum_mention_linked}`);
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
  console.error("Failed to fix forum notification links:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
