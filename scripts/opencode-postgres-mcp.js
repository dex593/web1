#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawn } = require("child_process");

try {
  const envPath = path.resolve(__dirname, "..", ".env");
  require("dotenv").config({ path: envPath });
} catch (_error) {
  // dotenv is optional here; DATABASE_URL can also come from process env.
}

const databaseUrl = (process.env.DATABASE_URL || "").toString().trim();
if (!databaseUrl) {
  process.stderr.write("[postgres-mcp] DATABASE_URL is missing. Configure .env or environment variable.\n");
  process.exit(1);
}

const environment = {
  ...process.env,
  DATABASE_URI: databaseUrl,
};

const candidates = [
  { command: "uvx", args: ["postgres-mcp", "--access-mode=restricted"] },
  { command: "uv", args: ["x", "postgres-mcp", "--access-mode=restricted"] },
];

const runCandidate = (index) => {
  if (index >= candidates.length) {
    process.stderr.write("[postgres-mcp] Unable to start postgres-mcp. Install uv (with uvx) first.\n");
    process.exit(1);
  }

  const current = candidates[index];
  const child = spawn(current.command, current.args, {
    stdio: "inherit",
    env: environment,
    shell: process.platform === "win32",
  });

  child.on("error", (error) => {
    if (error && error.code === "ENOENT") {
      runCandidate(index + 1);
      return;
    }
    const message = error && error.message ? error.message : "unknown error";
    process.stderr.write(`[postgres-mcp] Failed to start: ${message}\n`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (typeof code === "number") {
      process.exit(code);
      return;
    }
    if (signal) {
      process.stderr.write(`[postgres-mcp] Exited by signal: ${signal}\n`);
      process.exit(1);
      return;
    }
    process.exit(0);
  });
};

runCandidate(0);
