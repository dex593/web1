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
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
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

const formatUtcStamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());
  return `${year}${month}${day}_${hour}${minute}${second}Z`;
};

const normalizeFormat = (value) => {
  const raw = String(value || "custom").trim().toLowerCase();
  if (raw === "c" || raw === "custom") {
    return { pgValue: "custom", extension: "dump", isDirectory: false };
  }
  if (raw === "p" || raw === "plain" || raw === "sql") {
    return { pgValue: "plain", extension: "sql", isDirectory: false };
  }
  if (raw === "t" || raw === "tar") {
    return { pgValue: "tar", extension: "tar", isDirectory: false };
  }
  if (raw === "d" || raw === "directory" || raw === "dir") {
    return { pgValue: "directory", extension: "dir", isDirectory: true };
  }
  throw new Error(`Unsupported backup format: ${value}`);
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

    if (!token.startsWith("--")) {
      continue;
    }

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
    "Usage: node scripts/backup-db.js [options]",
    "",
    "Required:",
    "  DATABASE_URL                 PostgreSQL connection string",
    "",
    "Options:",
    "  --out-dir <path>             Backup directory (default: backups)",
    "  --prefix <name>              File prefix (default: database)",
    "  --format <custom|plain|tar|directory>",
    "                               Output format (default: custom)",
    "  --schema <name>              Backup one schema only (optional)",
    "  --compress <0-9>             Compression level for non-plain formats",
    "  --keep <N>                   Keep latest N backup runs; delete older ones",
    "  --verbose                    Enable pg_dump verbose mode",
    "  --bin <path>                 Custom pg_dump binary path",
    "",
    "Env alternatives:",
    "  BACKUP_DIR, BACKUP_PREFIX, BACKUP_FORMAT, BACKUP_SCHEMA,",
    "  BACKUP_COMPRESS_LEVEL, BACKUP_KEEP_LAST, BACKUP_VERBOSE, PG_DUMP_BIN",
    "",
    "Examples:",
    "  npm run backup:db",
    "  node scripts/backup-db.js --format plain --out-dir /var/backups --keep 14",
    ""
  ].join("\n"));
};

const resolveFileSize = async (targetPath) => {
  const stat = await fs.promises.stat(targetPath);
  if (stat.isFile()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return 0;
  }

  let total = 0;
  const walk = async (dirPath) => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const fileStat = await fs.promises.stat(fullPath);
        total += fileStat.size;
      }
    }
  };

  await walk(targetPath);
  return total;
};

const cleanupOldBackups = async ({ outDir, prefix, keepLast }) => {
  if (!Number.isFinite(keepLast) || keepLast < 1) return { deletedRuns: 0, deletedEntries: 0 };

  const entries = await fs.promises.readdir(outDir, { withFileTypes: true });
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const runPattern = new RegExp(`^${escapedPrefix}_(\\d{8}_\\d{6}Z)`);
  const runs = new Map();

  entries.forEach((entry) => {
    const match = runPattern.exec(entry.name);
    if (!match) return;
    const runId = match[1];
    if (!runs.has(runId)) {
      runs.set(runId, []);
    }
    runs.get(runId).push(entry.name);
  });

  const sortedRunIds = Array.from(runs.keys()).sort((a, b) => b.localeCompare(a));
  const toDelete = sortedRunIds.slice(keepLast);
  let deletedEntries = 0;

  for (const runId of toDelete) {
    const names = runs.get(runId) || [];
    for (const name of names) {
      const targetPath = path.join(outDir, name);
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      deletedEntries += 1;
    }
  }

  return {
    deletedRuns: toDelete.length,
    deletedEntries
  };
};

const run = async () => {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const databaseUrl = (process.env.DATABASE_URL || "").toString().trim();
  if (!databaseUrl) {
    throw new Error("Missing DATABASE_URL. Add it to env before running backup.");
  }

  const formatConfig = normalizeFormat(cli.format || process.env.BACKUP_FORMAT || "custom");
  const outDirRaw = cli["out-dir"] || process.env.BACKUP_DIR || "backups";
  const outDir = path.resolve(process.cwd(), String(outDirRaw));
  const prefix = sanitizePrefix(cli.prefix || process.env.BACKUP_PREFIX || "database");
  const schema = (cli.schema || process.env.BACKUP_SCHEMA || "").toString().trim();
  const keepLast = toInt(cli.keep || process.env.BACKUP_KEEP_LAST, 0);
  const compressLevel = Math.max(0, Math.min(9, toInt(cli.compress || process.env.BACKUP_COMPRESS_LEVEL, 9)));
  const verbose = toBool(cli.verbose || process.env.BACKUP_VERBOSE, false);
  const pgDumpBin = (cli.bin || process.env.PG_DUMP_BIN || "pg_dump").toString().trim() || "pg_dump";
  const timestamp = formatUtcStamp(new Date());

  await fs.promises.mkdir(outDir, { recursive: true });

  const baseName = `${prefix}_${timestamp}`;
  const outputPath = formatConfig.isDirectory
    ? path.join(outDir, `${baseName}.${formatConfig.extension}`)
    : path.join(outDir, `${baseName}.${formatConfig.extension}`);

  const args = [
    `--dbname=${databaseUrl}`,
    `--format=${formatConfig.pgValue}`,
    `--file=${outputPath}`,
    "--no-owner",
    "--no-privileges",
    "--encoding=UTF8"
  ];

  if (schema) {
    args.push(`--schema=${schema}`);
  }

  if (formatConfig.pgValue !== "plain") {
    args.push(`--compress=${compressLevel}`);
  }

  if (verbose) {
    args.push("--verbose");
  }

  console.log(`Starting backup with ${pgDumpBin}...`);
  console.log(`- Output: ${outputPath}`);
  console.log(`- Format: ${formatConfig.pgValue}`);
  if (schema) {
    console.log(`- Schema: ${schema}`);
  }

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const child = spawn(pgDumpBin, args, {
      stdio: "inherit",
      shell: false
    });

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(
          new Error(
            `Cannot find pg_dump binary (${pgDumpBin}). Install PostgreSQL client tools or set PG_DUMP_BIN.`
          )
        );
        return;
      }
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pg_dump exited with code ${code}`));
    });
  });

  const sizeBytes = await resolveFileSize(outputPath);
  const durationMs = Date.now() - startedAt;
  const metadata = {
    createdAt: new Date().toISOString(),
    outputPath,
    format: formatConfig.pgValue,
    schema: schema || null,
    sizeBytes,
    durationMs
  };

  const metadataPath = `${outputPath}.meta.json`;
  await fs.promises.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const cleanupSummary = await cleanupOldBackups({ outDir, prefix, keepLast });

  console.log("Backup completed.");
  console.log(`- Backup file: ${outputPath}`);
  console.log(`- Metadata: ${metadataPath}`);
  console.log(`- Size: ${sizeBytes} bytes`);
  console.log(`- Duration: ${(durationMs / 1000).toFixed(2)}s`);
  if (keepLast > 0) {
    console.log(`- Retention: kept ${keepLast} run(s), removed ${cleanupSummary.deletedRuns} run(s)`);
  }
};

run().catch((error) => {
  console.error("Backup failed:");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
