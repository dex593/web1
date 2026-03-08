#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const psqlCommand = process.platform === "win32" ? "psql.exe" : "psql";
const MIN_NODE_MAJOR = 20;
const MIN_POSTGRES_MAJOR = 16;

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
    const equalIndex = pair.indexOf("=");
    let key = pair;
    let value = "";

    if (equalIndex >= 0) {
      key = pair.slice(0, equalIndex);
      value = pair.slice(equalIndex + 1);
    } else {
      const next = argv[i + 1];
      if (next != null && !String(next).trim().startsWith("--")) {
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

const parseBoolean = (value, fallback = false) => {
  if (value == null) return Boolean(fallback);
  const text = String(value).trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return Boolean(fallback);
};

const parsePort = (value, fallback) => {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 65535);
};

const quotePgLiteral = (value) => `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
const quotePgIdent = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;

const runCommand = ({ title, command, args = [], cwd = projectRoot, extraEnv = null, capture = false }) => {
  console.log(`\n==> ${title}`);
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: false,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = capture ? String(result.stderr || "").trim() : "";
    const detail = stderr ? `\n${stderr}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${detail}`);
  }

  return result;
};

const commandAvailable = (command, args = ["--version"]) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    shell: false,
    stdio: "ignore"
  });
  if (result.error) return false;
  return result.status === 0;
};

const readPsqlClientMajorVersion = () => {
  const result = spawnSync(psqlCommand, ["--version"], {
    cwd: projectRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    return 0;
  }

  const text = `${String(result.stdout || "")} ${String(result.stderr || "")}`;
  const match = text.match(/(\d+)(?:\.\d+)?/);
  if (!match || !match[1]) return 0;

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : 0;
};

const ensurePsqlClientVersion = (minMajor) => {
  if (!commandAvailable(psqlCommand)) {
    const hint = process.platform === "win32"
      ? "Install PostgreSQL 16+ (psql) and add it to PATH, or run with --skip-db-create."
      : "Install PostgreSQL 16+ client tools (psql), or run with --skip-db-create.";
    throw new Error(`Cannot find ${psqlCommand}. ${hint}`);
  }

  const major = readPsqlClientMajorVersion();
  if (!major) {
    throw new Error(`Cannot detect ${psqlCommand} version. PostgreSQL ${minMajor}+ is required.`);
  }

  if (major < minMajor) {
    throw new Error(`PostgreSQL client ${minMajor}+ is required. Detected ${psqlCommand} major version ${major}.`);
  }

  return major;
};

const ensurePostgresServerVersion = ({ databaseUrl, minMajor }) => {
  const verifierScript = [
    'const { Pool } = require("pg");',
    '(async () => {',
    '  const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    '  try {',
    '    const result = await pool.query("SHOW server_version_num");',
    '    const row = result && Array.isArray(result.rows) ? result.rows[0] : null;',
    '    const raw = row && row.server_version_num != null ? String(row.server_version_num).trim() : "";',
    '    const numeric = Number.parseInt(raw, 10);',
    '    const major = Number.isFinite(numeric) ? Math.floor(numeric / 10000) : 0;',
    '    if (!major) throw new Error("Cannot read PostgreSQL server version.");',
    '    const minMajor = Number.parseInt(process.env.MIN_PG_MAJOR || "16", 10);',
    '    if (!Number.isFinite(minMajor) || minMajor < 1) {',
    '      throw new Error("Invalid minimum PostgreSQL version.");',
    '    }',
    '    if (major < minMajor) {',
    '      throw new Error(`PostgreSQL ${minMajor}+ is required. Detected server major ${major}.`);',
    '    }',
    '    process.stdout.write(String(major));',
    '  } finally {',
    '    await pool.end().catch(() => undefined);',
    '  }',
    '})().catch((error) => {',
    '  const message = error && error.message ? error.message : String(error);',
    '  process.stderr.write(`${message}\\n`);',
    '  process.exit(1);',
    '});'
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", verifierScript], {
    cwd: projectRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: String(databaseUrl || ""),
      MIN_PG_MAJOR: String(minMajor)
    }
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const message = String(result.stderr || "").trim() || "Cannot verify PostgreSQL server version.";
    throw new Error(message);
  }

  const major = Number.parseInt(String(result.stdout || "").trim(), 10);
  if (!Number.isFinite(major) || major < minMajor) {
    throw new Error(`PostgreSQL ${minMajor}+ is required.`);
  }

  return major;
};

const ensureFileFromTemplate = (targetPath, templatePath) => {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`);
  }
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(templatePath, targetPath);
  }
};

const readTextFile = (targetPath) => fs.readFileSync(targetPath, "utf8");

const writeTextFile = (targetPath, content) => {
  fs.writeFileSync(targetPath, content, "utf8");
};

const readEnvMap = (content) => {
  const map = {};
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return;
    const key = match[1];
    const value = match[2];
    map[key] = value;
  });
  return map;
};

const upsertEnvValues = (content, updates) => {
  const source = String(content || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const nextLines = [];
  const seen = new Set();

  lines.forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      nextLines.push(line);
      return;
    }

    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      nextLines.push(line);
      return;
    }

    seen.add(key);
    nextLines.push(`${key}=${updates[key]}`);
  });

  Object.keys(updates).forEach((key) => {
    if (seen.has(key)) return;
    nextLines.push(`${key}=${updates[key]}`);
  });

  return `${nextLines.join("\n").replace(/\n+$/g, "")}\n`;
};

const buildDatabaseUrl = ({ user, password, host, port, database }) => {
  const encodedUser = encodeURIComponent(String(user || ""));
  const encodedPassword = encodeURIComponent(String(password || ""));
  return `postgresql://${encodedUser}:${encodedPassword}@${host}:${port}/${database}`;
};

const resolveSessionSecret = (existingValue) => {
  const current = String(existingValue || "").trim();
  const looksPlaceholder = /chuoi-ngau-nhien|replace|example/i.test(current);
  if (current.length >= 32 && !looksPlaceholder) {
    return current;
  }
  return crypto.randomBytes(48).toString("hex");
};

const maskDatabaseUrl = (url) => {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch (_error) {
    return String(url || "");
  }
};

const createDatabaseAndRole = (options) => {
  ensurePsqlClientVersion(MIN_POSTGRES_MAJOR);

  const baseArgs = [
    "-h",
    options.dbHost,
    "-p",
    String(options.dbPort),
    "-U",
    options.postgresAdminUser,
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1"
  ];

  const authEnv = options.postgresAdminPassword
    ? {
      PGPASSWORD: options.postgresAdminPassword
    }
    : null;

  const roleSql = [
    "DO $$",
    "BEGIN",
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quotePgLiteral(options.dbUser)}) THEN`,
    `    CREATE ROLE ${quotePgIdent(options.dbUser)} WITH LOGIN PASSWORD ${quotePgLiteral(options.dbPassword)};`,
    "  ELSE",
    `    ALTER ROLE ${quotePgIdent(options.dbUser)} WITH LOGIN PASSWORD ${quotePgLiteral(options.dbPassword)};`,
    "  END IF;",
    "END",
    "$$;"
  ].join("\n");

  runCommand({
    title: "Ensure PostgreSQL role",
    command: psqlCommand,
    args: [...baseArgs, "-c", roleSql],
    extraEnv: authEnv
  });

  const existsResult = runCommand({
    title: "Check PostgreSQL database",
    command: psqlCommand,
    args: [...baseArgs, "-tAc", `SELECT 1 FROM pg_database WHERE datname = ${quotePgLiteral(options.dbName)};`],
    extraEnv: authEnv,
    capture: true
  });

  const exists = String(existsResult.stdout || "").trim() === "1";
  if (!exists) {
    runCommand({
      title: "Create PostgreSQL database",
      command: psqlCommand,
      args: [...baseArgs, "-c", `CREATE DATABASE ${quotePgIdent(options.dbName)} OWNER ${quotePgIdent(options.dbUser)};`],
      extraEnv: authEnv
    });
  } else {
    runCommand({
      title: "Ensure PostgreSQL database owner",
      command: psqlCommand,
      args: [...baseArgs, "-c", `ALTER DATABASE ${quotePgIdent(options.dbName)} OWNER TO ${quotePgIdent(options.dbUser)};`],
      extraEnv: authEnv
    });
  }

  const dbArgs = [
    "-h",
    options.dbHost,
    "-p",
    String(options.dbPort),
    "-U",
    options.postgresAdminUser,
    "-d",
    options.dbName,
    "-v",
    "ON_ERROR_STOP=1"
  ];

  runCommand({
    title: "Grant schema privileges",
    command: psqlCommand,
    args: [...dbArgs, "-c", `GRANT ALL ON SCHEMA public TO ${quotePgIdent(options.dbUser)};`],
    extraEnv: authEnv
  });
};

const printHelp = () => {
  console.log([
    "Usage: node scripts/setup-all.js [options]",
    "",
    "Cross-platform project bootstrap for Windows and Ubuntu.",
    `Requirements: Node.js LTS ${MIN_NODE_MAJOR}+ and PostgreSQL ${MIN_POSTGRES_MAJOR}+.`,
    "This script installs dependencies, creates env files, prepares DB,",
    "runs schema bootstrap, and builds required assets.",
    "",
    "Options:",
    "  --db-host <host>                 PostgreSQL host (default: 127.0.0.1)",
    "  --db-port <port>                 PostgreSQL port (default: 5432)",
    "  --db-name <name>                 App database name (default: moetruyen)",
    "  --db-user <user>                 App database user (default: moetruyen)",
    "  --db-pass <pass>                 App database password (default: moetruyen123)",
    "  --postgres-admin-user <user>     Admin DB user for create/alter (default: postgres)",
    "  --postgres-admin-password <pass> Admin DB password (optional)",
    "  --admin-user <user>              Web admin username (default: admin)",
    "  --admin-pass <pass>              Web admin password (default: 12345)",
    "  --app-port <port>                Web port (default: 3000)",
    "  --api-port <port>                API server port (default: 3001)",
    "  --with-api <true|false>          Install api_server deps (default: true)",
    "  --with-forum <true|false>        Install/build sampleforum (default: true)",
    "  --with-desktop <true|false>      Install app_desktop deps (default: false)",
    "  --skip-db-create                 Skip role/database create step",
    "  --start                          Start web server (`npm run dev`) after setup",
    "  --help                           Show this help",
    "",
    "Examples:",
    "  npm run setup:all",
    "  npm run setup:all -- --db-pass=secret --postgres-admin-password=postgres",
    "  npm run setup:all -- --skip-db-create --with-desktop=true",
    ""
  ].join("\n"));
};

const main = () => {
  if (process.platform !== "win32" && process.platform !== "linux") {
    throw new Error("This setup script supports Windows and Linux/Ubuntu only.");
  }

  const nodeMajor = Number.parseInt(String(process.versions && process.versions.node || "0").split(".")[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    throw new Error(`Node.js LTS ${MIN_NODE_MAJOR}+ is required. Please upgrade Node.js and run again.`);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const options = {
    dbHost: String(args["db-host"] || process.env.SETUP_DB_HOST || "127.0.0.1").trim() || "127.0.0.1",
    dbPort: parsePort(args["db-port"] || process.env.SETUP_DB_PORT, 5432),
    dbName: String(args["db-name"] || process.env.SETUP_DB_NAME || "moetruyen").trim() || "moetruyen",
    dbUser: String(args["db-user"] || process.env.SETUP_DB_USER || "moetruyen").trim() || "moetruyen",
    dbPassword: String(args["db-pass"] || process.env.SETUP_DB_PASS || "moetruyen123"),
    postgresAdminUser:
      String(args["postgres-admin-user"] || process.env.POSTGRES_ADMIN_USER || "postgres").trim() || "postgres",
    postgresAdminPassword: String(
      args["postgres-admin-password"] || process.env.POSTGRES_ADMIN_PASSWORD || process.env.PGPASSWORD || ""
    ),
    webAdminUser: String(args["admin-user"] || process.env.SETUP_ADMIN_USER || "admin").trim() || "admin",
    webAdminPass: String(args["admin-pass"] || process.env.SETUP_ADMIN_PASS || "12345"),
    appPort: parsePort(args["app-port"] || process.env.SETUP_APP_PORT, 3000),
    apiPort: parsePort(args["api-port"] || process.env.SETUP_API_PORT, 3001),
    withApi: parseBoolean(args["with-api"], true),
    withForum: parseBoolean(args["with-forum"], true),
    withDesktop: parseBoolean(args["with-desktop"], false),
    skipDbCreate: parseBoolean(args["skip-db-create"], false),
    startWeb: parseBoolean(args.start, false)
  };

  const rootEnvTemplatePath = path.join(projectRoot, ".env.example");
  const rootEnvPath = path.join(projectRoot, ".env");
  const apiEnvTemplatePath = path.join(projectRoot, "api_server", ".env.example");
  const apiEnvPath = path.join(projectRoot, "api_server", ".env");

  ensureFileFromTemplate(rootEnvPath, rootEnvTemplatePath);
  if (options.withApi) {
    ensureFileFromTemplate(apiEnvPath, apiEnvTemplatePath);
  }

  const rootEnvOriginal = readTextFile(rootEnvPath);
  const rootEnvMap = readEnvMap(rootEnvOriginal);

  const databaseUrl = buildDatabaseUrl({
    user: options.dbUser,
    password: options.dbPassword,
    host: options.dbHost,
    port: options.dbPort,
    database: options.dbName
  });

  const sessionSecret = resolveSessionSecret(rootEnvMap.SESSION_SECRET);
  const rootEnvUpdates = {
    PORT: String(options.appPort),
    APP_ENV: String(rootEnvMap.APP_ENV || "development").trim() || "development",
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: sessionSecret,
    ADMIN_USER: options.webAdminUser,
    ADMIN_PASS: options.webAdminPass,
    ADMIN_PASSWORD_LOGIN_ENABLED: "1",
    FORUM_PAGE_ENABLED: options.withForum ? "true" : "false"
  };

  if (!String(rootEnvMap.NEWS_PAGE_ENABLED || "").trim()) {
    rootEnvUpdates.NEWS_PAGE_ENABLED = "off";
  }

  const rootEnvNext = upsertEnvValues(rootEnvOriginal, rootEnvUpdates);
  writeTextFile(rootEnvPath, rootEnvNext);

  if (options.withApi) {
    const apiEnvOriginal = readTextFile(apiEnvPath);
    const apiEnvUpdates = {
      PORT: String(options.apiPort),
      DATABASE_URL: databaseUrl,
      API_KEY_SECRET: sessionSecret,
      WEB_BASE_URL: `http://127.0.0.1:${options.appPort}`
    };

    [
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_FORCE_PATH_STYLE",
      "S3_CHAPTER_PREFIX"
    ].forEach((key) => {
      const value = String(rootEnvMap[key] || "").trim();
      if (!value) return;
      apiEnvUpdates[key] = value;
    });

    const apiEnvNext = upsertEnvValues(apiEnvOriginal, apiEnvUpdates);
    writeTextFile(apiEnvPath, apiEnvNext);
  }

  console.log("\nSetup configuration:");
  console.log(`- Platform: ${process.platform}`);
  console.log(`- Web database: ${maskDatabaseUrl(databaseUrl)}`);
  console.log(`- Web port: ${options.appPort}`);
  console.log(`- API enabled: ${options.withApi ? "yes" : "no"}`);
  console.log(`- Forum enabled: ${options.withForum ? "yes" : "no"}`);
  console.log(`- Desktop deps install: ${options.withDesktop ? "yes" : "no"}`);

  runCommand({
    title: "Install root dependencies",
    command: npmCommand,
    args: ["install"]
  });

  if (options.withApi) {
    runCommand({
      title: "Install api_server dependencies",
      command: npmCommand,
      args: ["--prefix", "api_server", "install"]
    });
  }

  if (options.withForum) {
    runCommand({
      title: "Install sampleforum dependencies",
      command: npmCommand,
      args: ["--prefix", "sampleforum", "install"]
    });
  }

  if (options.withDesktop) {
    runCommand({
      title: "Install app_desktop dependencies",
      command: npmCommand,
      args: ["--prefix", "app_desktop", "install"]
    });
  }

  if (!options.skipDbCreate) {
    createDatabaseAndRole(options);
  } else {
    console.log("\n==> Skip database create step (--skip-db-create)");
  }

  const postgresServerMajor = ensurePostgresServerVersion({
    databaseUrl,
    minMajor: MIN_POSTGRES_MAJOR
  });
  console.log(`\n==> PostgreSQL server version check passed (major ${postgresServerMajor})`);

  runCommand({
    title: "Bootstrap database schema",
    command: npmCommand,
    args: ["run", "db:bootstrap"]
  });

  runCommand({
    title: "Build web styles",
    command: npmCommand,
    args: ["run", "styles:build"]
  });

  if (options.withForum) {
    runCommand({
      title: "Build sampleforum frontend",
      command: npmCommand,
      args: ["--prefix", "sampleforum", "run", "build"]
    });
  }

  console.log("\nSetup completed successfully.");
  console.log(`- Root env: ${path.relative(projectRoot, rootEnvPath)}`);
  if (options.withApi) {
    console.log(`- API env: ${path.relative(projectRoot, apiEnvPath)}`);
  }
  console.log("\nRun services:");
  console.log(`- Web: ${npmCommand} run dev`);
  if (options.withApi) {
    console.log(`- API: ${npmCommand} --prefix api_server run start`);
  }

  if (options.startWeb) {
    runCommand({
      title: "Start web server",
      command: npmCommand,
      args: ["run", "dev"]
    });
  }
};

try {
  main();
} catch (error) {
  console.error("\nSetup failed.");
  console.error(error && error.message ? error.message : error);
  process.exit(1);
}
