#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { Pool } = require("pg");
const { buildMangaSlugForWebtoonState } = require("../src/utils/manga-slug");

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

const applyChanges = process.argv.includes("--apply");
const SAMPLE_LIMIT = 20;

const MANGA_SLUGS_SQL = `
  SELECT
    m.id,
    m.title,
    m.slug,
    EXISTS (
      SELECT 1
      FROM manga_genres mg
      JOIN genres g ON g.id = mg.genre_id
      WHERE mg.manga_id = m.id
        AND lower(trim(g.name)) = 'webtoon'
    ) AS is_webtoon
  FROM manga m
  ORDER BY m.id ASC
`;

const printUpdateSample = (rows) => {
  const sampleRows = rows.slice(0, SAMPLE_LIMIT);
  sampleRows.forEach((row) => {
    console.log(`- #${row.id}: ${row.slug} -> ${row.desiredSlug}`);
  });
  if (rows.length > SAMPLE_LIMIT) {
    console.log(`- ... và ${rows.length - SAMPLE_LIMIT} truyện khác`);
  }
};

const printCollisionSample = (collisionRows) => {
  collisionRows.slice(0, SAMPLE_LIMIT).forEach((entry) => {
    console.log(`- slug '${entry.slug}' bị trùng giữa các manga: ${entry.ids.join(", ")}`);
  });
  if (collisionRows.length > SAMPLE_LIMIT) {
    console.log(`- ... và ${collisionRows.length - SAMPLE_LIMIT} slug trùng khác`);
  }
};

const main = async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const result = await client.query(MANGA_SLUGS_SQL);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const evaluatedRows = rows.map((row) => {
      const mangaId = Number(row && row.id);
      const title = row && row.title ? row.title : "";
      const currentSlug = row && row.slug ? String(row.slug).trim() : "";
      const isWebtoon = Boolean(row && row.is_webtoon);
      const desiredSlug = buildMangaSlugForWebtoonState({
        mangaId,
        title,
        isWebtoon
      });
      return {
        id: mangaId,
        title,
        slug: currentSlug,
        desiredSlug,
        isWebtoon
      };
    });

    const slugToIds = new Map();
    evaluatedRows.forEach((row) => {
      if (!row.desiredSlug) return;
      if (!slugToIds.has(row.desiredSlug)) {
        slugToIds.set(row.desiredSlug, []);
      }
      slugToIds.get(row.desiredSlug).push(row.id);
    });

    const collisions = Array.from(slugToIds.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([slug, ids]) => ({ slug, ids }));

    const rowsToUpdate = evaluatedRows.filter((row) => row.desiredSlug && row.slug !== row.desiredSlug);
    const webtoonCount = evaluatedRows.filter((row) => row.isWebtoon).length;

    console.log("Manual manga slug migration");
    console.log(`- total manga: ${evaluatedRows.length}`);
    console.log(`- webtoon manga: ${webtoonCount}`);
    console.log(`- rows needing update: ${rowsToUpdate.length}`);
    console.log(`- dry run: ${applyChanges ? "no" : "yes"}`);

    if (collisions.length) {
      console.log("");
      console.error("Slug collision detected. Aborting.");
      printCollisionSample(collisions);
      process.exitCode = 1;
      return;
    }

    if (rowsToUpdate.length) {
      console.log("");
      printUpdateSample(rowsToUpdate);
    }

    if (!applyChanges) {
      console.log("\nDry run only. No changes applied.");
      console.log("Run with --apply to update manga.slug manually.");
      return;
    }

    if (!rowsToUpdate.length) {
      console.log("\nNo slug changes needed.");
      return;
    }

    await client.query("BEGIN");
    for (const row of rowsToUpdate) {
      await client.query("UPDATE manga SET slug = $1 WHERE id = $2", [row.desiredSlug, row.id]);
    }
    await client.query("COMMIT");

    console.log(`\nApplied ${rowsToUpdate.length} slug update(s).`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback error
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  console.error("Manual manga slug migration failed.");
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
