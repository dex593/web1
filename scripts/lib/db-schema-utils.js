"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const DB_JSON_PATH = path.join(projectRoot, "db.json");

const SCHEMA_SOURCE_FILES = [
  path.join(projectRoot, "src", "domains", "init-db-domain.js"),
  path.join(projectRoot, "src", "routes", "forum-api-draft-utils.js"),
  path.join(projectRoot, "src", "routes", "forum-api-section-utils.js"),
  path.join(projectRoot, "scripts", "repair-forum-storage.js")
];

const extractManagedTablesFromSource = () => {
  const tables = new Set();
  const pattern = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

  for (const filePath of SCHEMA_SOURCE_FILES) {
    if (!fs.existsSync(filePath)) continue;

    const text = fs.readFileSync(filePath, "utf8");
    let match = pattern.exec(text);
    while (match) {
      const tableName = String(match[1] || "").trim().toLowerCase();
      if (tableName) {
        tables.add(tableName);
      }
      match = pattern.exec(text);
    }

    if (text.includes("CREATE TABLE IF NOT EXISTS ${INIT_MIGRATIONS_TABLE}")) {
      tables.add("init_migrations");
    }
  }

  return Array.from(tables)
    .filter((tableName) => tableName && !tableName.endsWith("_next"))
    .sort();
};

const loadDbJson = () => {
  if (!fs.existsSync(DB_JSON_PATH)) {
    return null;
  }

  const raw = fs.readFileSync(DB_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("db.json is invalid.");
  }
  if (!Array.isArray(parsed.tables)) {
    throw new Error("db.json must contain a 'tables' array.");
  }

  return parsed;
};

module.exports = {
  DB_JSON_PATH,
  SCHEMA_SOURCE_FILES,
  extractManagedTablesFromSource,
  loadDbJson,
  projectRoot
};
