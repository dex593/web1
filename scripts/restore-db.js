#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config();

const toBool = (value, defaultValue = false) => {
  if (value == null) return Boolean(defaultValue);
  const raw = String(value).trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return Boolean(defaultValue);
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
};

const sanitizePrefix = (value) => {
  const raw = String(value || "database").trim();
  const safe = raw.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "database";
};

const parseArgs = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    if (!token) continue;

    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }

    if (!token.startsWith("--")) continue;

    const pair = token.slice(2);
    const equalsIndex = pair.indexOf("=");
    let key = pair;
    let value = "";

    if (equalsIndex >= 0) {
      key = pair.slice(0, equalsIndex);
      value = pair.slice(equalsIndex + 1);
    } else {
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith("--")) {
        value = String(next);
        i += 1;
      } else {
        value = "true";
      }
    }

    options[key] = value;
  }
  return options;
};

const printHelp = () => {
  console.log([
    "Usage: node scripts/restore-db.js [options]",
    "",
    "Required:",
    "  DATABASE_URL                   PostgreSQL connection string",
    "",
    "Important safety:",
    "  Restore is destructive in replace mode.",
    "  You must pass --yes (or RESTORE_YES=true) to execute.",
    "",
    "Options:",
    "  --file <path>                  Backup file/folder to restore",
    "                                 Supports: .dump, .tar, .sql, .dir, .meta.json",
    "  --out-dir <path>               Backup directory for auto-discovery (default: backups)",
    "  --prefix <name>                Backup prefix for auto-discovery (default: database)",
    "  --format <auto|custom|tar|plain|directory>",
    "                                 Restore format (default: auto)",
    "  --mode <replace|safe>          replace: clean existing objects; safe: do not clean",
    "                                 (default: replace)",
    "  --schema <name>                Restore one schema (pg_restore formats)",
    "  --jobs <N>                     Parallel jobs for pg_restore when supported",
    "  --verbose                      Verbose restore output",
    "  --dry-run                      Print resolved command and exit",
    "  --yes                          Confirm restore execution",
    "  --pg-restore-bin <path>        Custom pg_restore binary (default: pg_restore)",
    "  --psql-bin <path>              Custom psql binary (default: psql)",
    "",
    "Env alternatives:",
    "  RESTORE_FILE, BACKUP_DIR, BACKUP_PREFIX, RESTORE_FORMAT, RESTORE_MODE,",
    "  RESTORE_SCHEMA, RESTORE_JOBS, RESTORE_VERBOSE, RESTORE_YES,",
    "  PG_RESTORE_BIN, PSQL_BIN",
    "",
    "Examples:",
    "  npm run restore:db -- --file backups/database_20260216_130000Z.dump --yes",
    "  npm run restore:db -- --out-dir /var/backups --prefix bfang --yes",
    "  node scripts/restore-db.js --file backups/database_latest.sql --mode safe --yes",
    ""
  ].join("\n"));
};

const quoteIdentifier = (value) => {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Schema name cannot be empty.");
  }
  return `"${text.replace(/"/g, '""')}"`;
};

const detectFormatFromPath = async (targetPath) => {
  const absolute = path.resolve(targetPath);
  let stat = null;
  try {
    stat = await fs.promises.stat(absolute);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Backup path does not exist: ${absolute}`);
    }
    throw error;
  }

  const lowerName = absolute.toLowerCase();
  if (stat.isDirectory()) {
    if (lowerName.endsWith(".dir")) {
      return { format: "directory", path: absolute };
    }
    return { format: "directory", path: absolute };
  }

  if (lowerName.endsWith(".dump")) return { format: "custom", path: absolute };
  if (lowerName.endsWith(".tar")) return { format: "tar", path: absolute };
  if (lowerName.endsWith(".sql")) return { format: "plain", path: absolute };
  if (lowerName.endsWith(".meta.json")) {
    const payload = JSON.parse(await fs.promises.readFile(absolute, "utf8"));
    if (!payload || typeof payload.outputPath !== "string" || !payload.outputPath.trim()) {
      throw new Error(`Invalid metadata file: ${absolute}`);
    }
    return detectFormatFromPath(payload.outputPath);
  }

  throw new Error(`Cannot detect backup format from file extension: ${absolute}`);
};

const normalizeFormat = (value) => {
  const raw = String(value || "auto").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "custom" || raw === "c") return "custom";
  if (raw === "tar" || raw === "t") return "tar";
  if (raw === "plain" || raw === "sql" || raw === "p") return "plain";
  if (raw === "directory" || raw === "dir" || raw === "d") return "directory";
  throw new Error(`Unsupported restore format: ${value}`);
};

const normalizeMode = (value) => {
  const raw = String(value || "replace").trim().toLowerCase();
  if (raw === "replace" || raw === "clean" || raw === "overwrite") return "replace";
  if (raw === "safe" || raw === "append" || raw === "merge") return "safe";
  throw new Error(`Unsupported restore mode: ${value}`);
};

const findLatestBackup = async ({ outDir, prefix }) => {
  let entries = [];
  try {
    entries = await fs.promises.readdir(outDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Backup directory does not exist: ${outDir}`);
    }
    throw error;
  }

  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const runPattern = new RegExp(`^${escapedPrefix}_(\\d{8}_\\d{6}Z)\\.(dump|tar|sql|dir|meta\\.json)$`, "i");
  const candidates = [];

  for (const entry of entries) {
    const match = runPattern.exec(entry.name);
    if (!match) continue;
    const stamp = match[1];
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".meta.json")) continue;

    const absolutePath = path.join(outDir, entry.name);
    const isSupportedFile = entry.isFile() && (lower.endsWith(".dump") || lower.endsWith(".tar") || lower.endsWith(".sql"));
    const isSupportedDir = entry.isDirectory() && lower.endsWith(".dir");
    if (!isSupportedFile && !isSupportedDir) continue;

    candidates.push({ stamp, absolutePath });
  }

  candidates.sort((a, b) => b.stamp.localeCompare(a.stamp));
  if (!candidates.length) {
    throw new Error(`No backup file found in ${outDir} with prefix ${prefix}.`);
  }

  return candidates[0].absolutePath;
};

const resolveRestoreTarget = async ({ fileOption, outDir, prefix, formatOption }) => {
  const explicitFile = String(fileOption || "").trim();
  const initialPath = explicitFile ? path.resolve(explicitFile) : await findLatestBackup({ outDir, prefix });
  const detected = await detectFormatFromPath(initialPath);

  if (formatOption !== "auto" && formatOption !== detected.format) {
    throw new Error(
      `Restore format mismatch: expected ${formatOption}, detected ${detected.format} from ${detected.path}`
    );
  }

  return {
    path: detected.path,
    format: detected.format,
    wasAutoDiscovered: !explicitFile
  };
};

const runCommand = ({ bin, args }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: "inherit",
      shell: false
    });

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error(`Cannot find binary: ${bin}`));
        return;
      }
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${bin} exited with code ${code}`));
    });
  });
};

const buildPgRestoreArgs = ({ databaseUrl, backupPath, mode, schema, jobs, verbose, format }) => {
  const args = [
    `--dbname=${databaseUrl}`,
    "--no-owner",
    "--no-privileges"
  ];

  if (mode === "replace") {
    args.push("--clean", "--if-exists");
  }

  if (schema) {
    args.push(`--schema=${schema}`);
  }

  const supportsJobs = format === "custom" || format === "directory";
  const safeJobs = Math.max(1, Number.isFinite(jobs) ? jobs : 1);
  if (supportsJobs && safeJobs > 1) {
    args.push(`--jobs=${safeJobs}`);
  } else {
    args.push("--single-transaction");
  }

  if (verbose) {
    args.push("--verbose");
  }

  args.push(backupPath);
  return args;
};

const buildPsqlRestoreArgs = ({ databaseUrl, backupPath, verbose }) => {
  const args = [
    `--dbname=${databaseUrl}`,
    "--set",
    "ON_ERROR_STOP=1",
    "--single-transaction",
    "--file",
    backupPath
  ];

  if (verbose) {
    args.push("--echo-errors");
  }

  return args;
};

const buildPsqlSchemaResetArgs = ({ databaseUrl, schema }) => {
  const quoted = quoteIdentifier(schema || "public");
  const sql = `DROP SCHEMA IF EXISTS ${quoted} CASCADE; CREATE SCHEMA ${quoted};`;
  return [
    `--dbname=${databaseUrl}`,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    sql
  ];
};

const run = async () => {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const databaseUrl = (process.env.DATABASE_URL || "").toString().trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL. Add it to env before running restore.");
  }

  const outDirRaw = cli["out-dir"] || process.env.BACKUP_DIR || "backups";
  const outDir = path.resolve(process.cwd(), String(outDirRaw));
  const prefix = sanitizePrefix(cli.prefix || process.env.BACKUP_PREFIX || "database");
  const formatOption = normalizeFormat(cli.format || process.env.RESTORE_FORMAT || "auto");
  const mode = normalizeMode(cli.mode || process.env.RESTORE_MODE || "replace");
  const schema = (cli.schema || process.env.RESTORE_SCHEMA || "").toString().trim();
  const jobs = Math.max(1, toInt(cli.jobs || process.env.RESTORE_JOBS, 1));
  const verbose = toBool(cli.verbose || process.env.RESTORE_VERBOSE, false);
  const dryRun = toBool(cli["dry-run"], false);
  const confirmed = toBool(cli.yes || process.env.RESTORE_YES, false);
  const pgRestoreBin = (cli["pg-restore-bin"] || process.env.PG_RESTORE_BIN || "pg_restore").toString().trim() || "pg_restore";
  const psqlBin = (cli["psql-bin"] || process.env.PSQL_BIN || "psql").toString().trim() || "psql";

  const fileOption = cli.file || process.env.RESTORE_FILE || "";
  const target = await resolveRestoreTarget({
    fileOption,
    outDir,
    prefix,
    formatOption
  });

  console.log("Resolved restore target:");
  console.log(`- Path: ${target.path}`);
  console.log(`- Format: ${target.format}`);
  console.log(`- Mode: ${mode}`);
  if (schema) {
    console.log(`- Schema filter: ${schema}`);
  }
  if (target.wasAutoDiscovered) {
    console.log("- Source: latest backup auto-discovered by prefix/out-dir");
  }

  if (dryRun) {
    console.log("Dry run complete. No restore executed.");
    return;
  }

  if (!confirmed) {
    throw new Error("Restore confirmation missing. Re-run with --yes (or RESTORE_YES=true).");
  }

  const startedAt = Date.now();

  if (target.format === "plain") {
    if (schema) {
      console.warn("WARN: --schema filter is not supported for plain SQL restore; restoring file as-is.");
    }

    if (mode === "replace") {
      const resetArgs = buildPsqlSchemaResetArgs({ databaseUrl, schema: schema || "public" });
      console.log(`Running schema reset with ${psqlBin}...`);
      await runCommand({ bin: psqlBin, args: resetArgs });
    }

    const restoreArgs = buildPsqlRestoreArgs({
      databaseUrl,
      backupPath: target.path,
      verbose
    });
    console.log(`Restoring with ${psqlBin}...`);
    await runCommand({ bin: psqlBin, args: restoreArgs });
  } else {
    const restoreArgs = buildPgRestoreArgs({
      databaseUrl,
      backupPath: target.path,
      mode,
      schema,
      jobs,
      verbose,
      format: target.format
    });
    console.log(`Restoring with ${pgRestoreBin}...`);
    await runCommand({ bin: pgRestoreBin, args: restoreArgs });
  }

  const durationMs = Date.now() - startedAt;
  console.log("Restore completed.");
  console.log(`- Elapsed: ${(durationMs / 1000).toFixed(2)}s`);
};

run().catch((error) => {
  console.error("Restore failed:");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
