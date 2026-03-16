#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { Pool } = require("pg");
const createInitDbDomain = require("../src/domains/init-db-domain");
const {
  DB_JSON_PATH,
  extractManagedTablesFromSource,
  loadDbJson,
  projectRoot
} = require("./lib/db-schema-utils");

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

const includeDestructive = process.argv.includes("--include-destructive");
const verbose = process.argv.includes("--verbose");
const strictDbJson = process.argv.includes("--strict-db-json");

const buildExpectedSchema = () => {
  const dbJson = loadDbJson();
  if (!dbJson) {
    throw new Error("db.json is missing. Run: npm run db:schema:json:sync");
  }

  const tables = [];
  const columnsByTable = new Map();

  for (const tableEntry of dbJson.tables) {
    const tableName = String(tableEntry && tableEntry.name ? tableEntry.name : "").trim().toLowerCase();
    if (!tableName) continue;
    if (!tables.includes(tableName)) {
      tables.push(tableName);
    }

    const columnMap = new Map();
    const columnEntries = Array.isArray(tableEntry && tableEntry.columns) ? tableEntry.columns : [];
    for (const columnEntry of columnEntries) {
      const columnName = String(columnEntry && columnEntry.name ? columnEntry.name : "").trim().toLowerCase();
      if (!columnName) continue;
      const dataType = String(columnEntry && columnEntry.data_type ? columnEntry.data_type : "").trim().toLowerCase();
      const isNullable = Boolean(columnEntry && columnEntry.is_nullable);
      columnMap.set(columnName, {
        dataType,
        isNullable
      });
    }
    columnsByTable.set(tableName, columnMap);
  }

  tables.sort();

  return {
    tables,
    columnsByTable,
    dbJson
  };
};

const EXPECTED_SCHEMA = buildExpectedSchema();
const EXPECTED_TABLES = EXPECTED_SCHEMA.tables;
const EXPECTED_COLUMNS_BY_TABLE = EXPECTED_SCHEMA.columnsByTable;

const SOURCE_TABLES = extractManagedTablesFromSource();
const expectedSet = new Set(EXPECTED_TABLES);
const sourceSet = new Set(SOURCE_TABLES);

const missingInDbJson = SOURCE_TABLES.filter((tableName) => !expectedSet.has(tableName));
if (missingInDbJson.length) {
  console.warn(
    `db.json is missing schema tables declared in source: ${missingInDbJson.join(", ")}. Run: npm run db:schema:json:sync`
  );
}

const staleInDbJson = EXPECTED_TABLES.filter((tableName) => !sourceSet.has(tableName));

const pool = new Pool({ connectionString: DATABASE_URL });

const toPgQuery = (sql, params = []) => {
  const text = (sql || "").toString();
  if (!Array.isArray(params) || params.length === 0) {
    return { text, values: [] };
  }

  let index = 0;
  const converted = text.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });

  return {
    text: converted,
    values: params
  };
};

const dbQuery = async (sql, params = []) => {
  const payload = toPgQuery(sql, params);
  return pool.query(payload.text, payload.values);
};

const dbAllRaw = async (sql, params = []) => {
  const result = await dbQuery(sql, params);
  return result.rows || [];
};

const dbGetRaw = async (sql, params = []) => {
  const rows = await dbAllRaw(sql, params);
  return rows && rows.length ? rows[0] : null;
};

const dbRunRaw = async (sql, params = []) => {
  const result = await dbQuery(sql, params);
  return {
    changes: typeof result.rowCount === "number" ? result.rowCount : 0,
    lastID: undefined,
    rows: result.rows || []
  };
};

const normalizeSql = (value) => (value || "")
  .toString()
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

const compactSql = (value) => {
  const text = (value || "").toString().replace(/\s+/g, " ").trim();
  if (text.length <= 140) return text;
  return `${text.slice(0, 137)}...`;
};

const isSchemaStatement = (sql) => {
  const normalized = normalizeSql(sql);
  if (!normalized) return false;

  if (/^create table if not exists\b/.test(normalized)) return true;
  if (/^alter table\b.+\badd column if not exists\b/.test(normalized)) return true;
  if (/^create unique index if not exists\b/.test(normalized)) return true;
  if (/^create index if not exists\b/.test(normalized)) return true;

  if (!includeDestructive) return false;

  if (/^drop index if exists\b/.test(normalized)) return true;
  if (/^alter table\b.+\bdrop column if exists\b/.test(normalized)) return true;
  if (/^alter table\b.+\balter column\b/.test(normalized)) return true;
  if (/^alter table\b.+\brename to\b/.test(normalized)) return true;
  if (/^drop table if exists\b/.test(normalized)) return true;

  return false;
};

const main = async () => {
  const stats = {
    executed: 0,
    skipped: 0,
    failed: 0
  };

  const skippedSamples = [];

  const dbRun = async (sql, params = []) => {
    if (!isSchemaStatement(sql)) {
      stats.skipped += 1;
      if (skippedSamples.length < 12) {
        skippedSamples.push(compactSql(sql));
      }
      return {
        changes: 0,
        lastID: undefined,
        rows: []
      };
    }

    try {
      const result = await dbRunRaw(sql, params);
      stats.executed += 1;
      if (verbose) {
        console.log(`OK ${compactSql(sql)}`);
      }
      return result;
    } catch (error) {
      stats.failed += 1;
      console.error(`FAIL ${compactSql(sql)}`);
      throw error;
    }
  };

  const dbGet = async (sql, params = []) => {
    const normalized = normalizeSql(sql);
    if (/\bfrom\s+init_migrations\b/.test(normalized)) {
      return { key: "schema_only" };
    }
    return dbGetRaw(sql, params);
  };

  const dbAll = async (sql, params = []) => dbAllRaw(sql, params);

  const initDbDomain = createInitDbDomain({
    ONESHOT_GENRE_NAME: "Oneshot",
    dbAll,
    dbGet,
    dbRun,
    ensureHomepageDefaults: async () => {},
    migrateLegacyGenres: async () => {},
    migrateMangaSlugs: async () => {},
    migrateMangaStatuses: async () => {},
    resetMemberBadgeCache: () => {},
    team: {
      name: "BFANG Team"
    }
  });

  console.log("Syncing database schema (structure only)...");
  if (includeDestructive) {
    console.log("Destructive schema updates are enabled.");
  }

  await initDbDomain.initDb();

  const tableRows = await dbAllRaw(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `
  );

  const existing = new Set(
    tableRows
      .map((row) => (row && row.table_name ? String(row.table_name).trim() : ""))
      .filter(Boolean)
  );

  const expected = new Set(EXPECTED_TABLES);
  const missing = EXPECTED_TABLES.filter((tableName) => !existing.has(tableName));
  const extra = Array.from(existing).filter((tableName) => !expected.has(tableName)).sort();

  const columnRows = await dbAllRaw(
    `
      SELECT table_name, column_name, data_type, (is_nullable = 'YES') AS is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
      ORDER BY table_name, ordinal_position
    `
  );

  const existingColumnsByTable = new Map();
  for (const row of columnRows) {
    const tableName = String(row && row.table_name ? row.table_name : "").trim().toLowerCase();
    const columnName = String(row && row.column_name ? row.column_name : "").trim().toLowerCase();
    if (!tableName || !columnName) continue;
    if (!existingColumnsByTable.has(tableName)) {
      existingColumnsByTable.set(tableName, new Map());
    }
    existingColumnsByTable.get(tableName).set(columnName, {
      dataType: String(row && row.data_type ? row.data_type : "").trim().toLowerCase(),
      isNullable: Boolean(row && row.is_nullable)
    });
  }

  const missingColumns = [];
  const extraColumns = [];
  const columnDefinitionMismatches = [];

  for (const tableName of EXPECTED_TABLES) {
    const expectedColumnMap = EXPECTED_COLUMNS_BY_TABLE.get(tableName) || new Map();
    const existingColumnMap = existingColumnsByTable.get(tableName) || new Map();

    for (const [columnName, expectedMeta] of expectedColumnMap.entries()) {
      if (!existingColumnMap.has(columnName)) {
        missingColumns.push({ tableName, columnName });
        continue;
      }

      const existingMeta = existingColumnMap.get(columnName);
      const expectedType = String(expectedMeta && expectedMeta.dataType ? expectedMeta.dataType : "").trim().toLowerCase();
      const existingType = String(existingMeta && existingMeta.dataType ? existingMeta.dataType : "").trim().toLowerCase();
      const expectedNullable = Boolean(expectedMeta && expectedMeta.isNullable);
      const existingNullable = Boolean(existingMeta && existingMeta.isNullable);

      if (expectedType !== existingType || expectedNullable !== existingNullable) {
        columnDefinitionMismatches.push({
          tableName,
          columnName,
          expectedType,
          existingType,
          expectedNullable,
          existingNullable
        });
      }
    }

    for (const [columnName] of existingColumnMap.entries()) {
      if (!expectedColumnMap.has(columnName)) {
        extraColumns.push({ tableName, columnName });
      }
    }
  }

  console.log("\nSchema sync completed.");
  console.log(`Executed schema statements: ${stats.executed}`);
  console.log(`Skipped non-schema statements: ${stats.skipped}`);

  if (stats.failed > 0) {
    console.log(`Failed schema statements: ${stats.failed}`);
  }

  if (missing.length) {
    console.log("\nMissing expected tables after sync:");
    missing.forEach((tableName) => {
      console.log(`- ${tableName}`);
    });
  } else {
    console.log("\nAll expected tables are present.");
  }

  if (missingColumns.length) {
    console.log("\nMissing expected columns after sync:");
    missingColumns.forEach((entry) => {
      console.log(`- ${entry.tableName}.${entry.columnName}`);
    });
  } else {
    console.log("All expected columns are present.");
  }

  if (columnDefinitionMismatches.length) {
    console.log("\nColumn definition mismatches (type/nullability):");
    columnDefinitionMismatches.forEach((entry) => {
      console.log(
        `- ${entry.tableName}.${entry.columnName}: expected ${entry.expectedType || "(unknown)"} nullable=${entry.expectedNullable}, got ${entry.existingType || "(unknown)"} nullable=${entry.existingNullable}`
      );
    });
  }

  if (extra.length) {
    console.log("\nExtra tables found (kept unchanged):");
    extra.forEach((tableName) => {
      console.log(`- ${tableName}`);
    });
  }

  if (extraColumns.length) {
    console.log("\nExtra columns found compared to db.json:");
    extraColumns.forEach((entry) => {
      console.log(`- ${entry.tableName}.${entry.columnName}`);
    });
  }

  if (skippedSamples.length && verbose) {
    console.log("\nSample skipped statements:");
    skippedSamples.forEach((statement) => {
      console.log(`- ${statement}`);
    });
  }

  const dbJsonRelativePath = DB_JSON_PATH.startsWith(projectRoot)
    ? DB_JSON_PATH.slice(projectRoot.length + 1).replace(/\\/g, "/")
    : DB_JSON_PATH;

  if (staleInDbJson.length) {
    console.warn(`\n${dbJsonRelativePath} contains tables that are not declared by schema source files:`);
    staleInDbJson.forEach((tableName) => {
      console.warn(`- ${tableName}`);
    });
  }

  const hardMismatch = missing.length > 0 || missingColumns.length > 0 || columnDefinitionMismatches.length > 0;
  const strictMismatch = strictDbJson && (extra.length > 0 || extraColumns.length > 0 || staleInDbJson.length > 0);

  if (hardMismatch || strictMismatch) {
    throw new Error(
      `Database schema does not match ${dbJsonRelativePath}. Run: npm run db:schema:json:sync`
    );
  }
};

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (error) => {
    console.error("Schema sync failed.");
    console.error(error && error.message ? error.message : error);
    await pool.end();
    process.exit(1);
  });
