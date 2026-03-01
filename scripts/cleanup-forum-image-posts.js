#!/usr/bin/env node
"use strict";

const { Pool } = require("pg");
require("dotenv").config();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in environment.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const deleteResult = await client.query(`
      WITH RECURSIVE forum_roots AS (
        SELECT c.id
        FROM comments c
        WHERE c.parent_id IS NULL
          AND COALESCE(c.client_request_id, '') ILIKE 'forum-%'
      ),
      forum_tree AS (
        SELECT c.id, c.id AS root_id, c.content
        FROM comments c
        JOIN forum_roots fr ON fr.id = c.id
        UNION ALL
        SELECT child.id, forum_tree.root_id, child.content
        FROM comments child
        JOIN forum_tree ON child.parent_id = forum_tree.id
      ),
      target_roots AS (
        SELECT DISTINCT root_id
        FROM forum_tree
        WHERE COALESCE(content, '') ~* '<img\\b'
      ),
      subtree AS (
        SELECT c.id
        FROM comments c
        WHERE c.id IN (SELECT root_id FROM target_roots)
        UNION ALL
        SELECT child.id
        FROM comments child
        JOIN subtree ON child.parent_id = subtree.id
      ),
      deleted AS (
        DELETE FROM comments
        WHERE id IN (SELECT id FROM subtree)
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*) FROM target_roots) AS root_posts_deleted,
        (SELECT COUNT(*) FROM deleted) AS comments_deleted
    `);

    const deleteRow = deleteResult && Array.isArray(deleteResult.rows) ? deleteResult.rows[0] : null;
    const rootPostsDeleted = Number(deleteRow && deleteRow.root_posts_deleted) || 0;
    const commentsDeleted = Number(deleteRow && deleteRow.comments_deleted) || 0;

    let draftRowsDeleted = 0;
    const tableExistsResult = await client.query("SELECT to_regclass('public.forum_post_image_drafts') AS table_name");
    const hasDraftTable = Boolean(
      tableExistsResult &&
        Array.isArray(tableExistsResult.rows) &&
        tableExistsResult.rows[0] &&
        tableExistsResult.rows[0].table_name
    );

    if (hasDraftTable) {
      const draftDeleteResult = await client.query("DELETE FROM forum_post_image_drafts");
      draftRowsDeleted = Number(draftDeleteResult && draftDeleteResult.rowCount) || 0;
    }

    await client.query("COMMIT");

    console.log("Forum image cleanup completed.");
    console.log(`- Root forum posts deleted: ${rootPostsDeleted}`);
    console.log(`- Forum comments/replies deleted: ${commentsDeleted}`);
    console.log(`- forum_post_image_drafts rows deleted: ${draftRowsDeleted}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
};

run()
  .catch((error) => {
    console.error("Failed to cleanup forum image posts:", error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => null);
  });
