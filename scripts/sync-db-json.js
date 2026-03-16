#!/usr/bin/env node

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const {
  DB_JSON_PATH,
  SCHEMA_SOURCE_FILES,
  extractManagedTablesFromSource,
  projectRoot
} = require("./lib/db-schema-utils");

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

const includeAllTables = process.argv.includes("--all");

const toTableList = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort();
};

const toRepoPath = (absolutePath) =>
  path.relative(projectRoot, absolutePath).replace(/\\/g, "/");

const normalizeColumnRows = (rows = []) =>
  rows.map((row) => ({
    name: String(row.column_name || "").trim().toLowerCase(),
    data_type: String(row.data_type || "").trim().toLowerCase(),
    is_nullable: Boolean(row.is_nullable)
  }));

const main = async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const schemaRowResult = await pool.query("SELECT current_schema() AS schema_name");
    const schemaName =
      schemaRowResult.rows && schemaRowResult.rows[0] && schemaRowResult.rows[0].schema_name
        ? String(schemaRowResult.rows[0].schema_name)
        : "public";

    const sourceManagedTables = extractManagedTablesFromSource();

    const managedTables = includeAllTables
      ? []
      : toTableList(sourceManagedTables);

    const tableRowsResult = includeAllTables
      ? await pool.query(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = $1
              AND table_type = 'BASE TABLE'
            ORDER BY table_name
          `,
          [schemaName]
        )
      : await pool.query(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = $1
              AND table_type = 'BASE TABLE'
              AND table_name = ANY($2::text[])
            ORDER BY table_name
          `,
          [schemaName, managedTables]
        );

    const existingTables = toTableList(
      (tableRowsResult.rows || []).map((row) => row && row.table_name)
    );

    const targetTables = includeAllTables ? existingTables : managedTables;

    const columnsResult = targetTables.length
      ? await pool.query(
          `
            SELECT
              table_name,
              column_name,
              data_type,
              (is_nullable = 'YES') AS is_nullable,
              ordinal_position
            FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name = ANY($2::text[])
            ORDER BY table_name, ordinal_position
          `,
          [schemaName, targetTables]
        )
      : { rows: [] };

    const columnsByTable = new Map();
    for (const row of columnsResult.rows || []) {
      const tableName = String(row && row.table_name ? row.table_name : "").trim().toLowerCase();
      if (!tableName) continue;
      if (!columnsByTable.has(tableName)) {
        columnsByTable.set(tableName, []);
      }
      columnsByTable.get(tableName).push(row);
    }

    const snapshotTables = targetTables.map((tableName) => {
      const normalizedTableName = String(tableName || "").trim().toLowerCase();
      const rows = columnsByTable.get(normalizedTableName) || [];
      return {
        name: normalizedTableName,
        exists: existingTables.includes(normalizedTableName),
        columns: normalizeColumnRows(rows)
      };
    });

    const missingInDatabase = snapshotTables.filter((table) => !table.exists).map((table) => table.name);
    const emptyColumns = snapshotTables
      .filter((table) => Array.isArray(table.columns) && table.columns.length === 0)
      .map((table) => table.name);

    if (missingInDatabase.length || emptyColumns.length) {
      console.error("Refusing to write db.json because schema snapshot is incomplete.");
      if (missingInDatabase.length) {
        console.error("Missing tables in database:");
        missingInDatabase.forEach((name) => {
          console.error(`- ${name}`);
        });
      }
      if (emptyColumns.length) {
        console.error("Tables with zero discovered columns:");
        emptyColumns.forEach((name) => {
          console.error(`- ${name}`);
        });
      }
      process.exit(1);
    }

    const payload = {
      version: 1,
      schema: schemaName,
      generated_at: new Date().toISOString(),
      generated_by: "scripts/sync-db-json.js",
      source_files: SCHEMA_SOURCE_FILES.map((filePath) => toRepoPath(filePath)),
      tables: snapshotTables
    };

    fs.writeFileSync(DB_JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Synced ${path.relative(projectRoot, DB_JSON_PATH)} (${snapshotTables.length} tables).`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error("Failed to sync db.json.");
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
