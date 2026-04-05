require("dotenv").config();

const { Pool } = require("pg");

const run = async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    const insertedFromMirror = await pool.query(`
      INSERT INTO manga_translation_teams (manga_id, team_id)
      SELECT m.id, m.translation_team_id
      FROM manga m
      JOIN translation_teams t ON t.id = m.translation_team_id
      WHERE m.translation_team_id IS NOT NULL
      ON CONFLICT DO NOTHING
      RETURNING manga_id, team_id
    `);

    const insertedFromGroupName = await pool.query(`
      INSERT INTO manga_translation_teams (manga_id, team_id)
      SELECT DISTINCT tokenized.manga_id, t.id
      FROM (
        SELECT
          m.id AS manga_id,
          BTRIM(
            REGEXP_SPLIT_TO_TABLE(
              REGEXP_REPLACE(COALESCE(m.group_name, ''), '\\s*(/|&|\\+|;|\\||,)\\s*|\\s+x\\s+', ',', 'gi'),
              ','
            )
          ) AS team_name_token
        FROM manga m
        WHERE m.group_name IS NOT NULL
          AND TRIM(m.group_name) <> ''
      ) tokenized
      JOIN translation_teams t
        ON t.status = 'approved'
       AND t.name = tokenized.team_name_token
      WHERE tokenized.team_name_token <> ''
      ON CONFLICT DO NOTHING
      RETURNING manga_id, team_id
    `);

    const synced = await pool.query(`
      WITH linked AS (
        SELECT
          m.id AS manga_id,
          COALESCE(
            MIN(CASE WHEN mtt.team_id = m.translation_team_id THEN mtt.team_id END),
            MIN(mtt.team_id)
          ) AS primary_team_id,
          string_agg(
            t.name,
            ' / '
            ORDER BY
              CASE WHEN mtt.team_id = m.translation_team_id THEN 0 ELSE 1 END,
              mtt.team_id ASC,
              lower(t.name) ASC,
              t.id ASC
          ) AS group_name
        FROM manga m
        JOIN manga_translation_teams mtt ON mtt.manga_id = m.id
        JOIN translation_teams t ON t.id = mtt.team_id
        GROUP BY m.id
      )
      UPDATE manga m
      SET
        translation_team_id = linked.primary_team_id,
        group_name = linked.group_name
      FROM linked
      WHERE linked.manga_id = m.id
      RETURNING m.id, m.translation_team_id, m.group_name
    `);

    console.log(
      JSON.stringify(
        {
          insertedFromMirror: insertedFromMirror.rowCount,
          insertedFromGroupName: insertedFromGroupName.rowCount,
          syncedManga: synced.rowCount,
          syncedIds: synced.rows
            .map((row) => Number(row.id))
            .filter((id) => Number.isFinite(id) && id > 0)
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
};

run().catch((error) => {
  console.error("Failed to backfill manga translation team links", error);
  process.exit(1);
});
