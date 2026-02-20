#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PurgeCSS } = require("purgecss");

const rootDir = path.resolve(__dirname, "..");
const modulesDir = path.join(rootDir, "public", "styles", "modules");
const purgeReportPath = path.join(rootDir, "public", "styles", "purge-report.json");

const toGlob = (value) => value.split(path.sep).join("/");

const buildContentGlobs = () => [
  toGlob(path.join(rootDir, "views", "**", "*.ejs")),
  toGlob(path.join(rootDir, "public", "**", "*.js")),
  toGlob(path.join(rootDir, "src", "**", "*.js")),
  toGlob(path.join(rootDir, "app.js")),
  toGlob(path.join(rootDir, "server.js"))
];

const listModuleCssFiles = () => {
  if (!fs.existsSync(modulesDir)) {
    throw new Error("Missing public/styles/modules. Run npm run styles:split first.");
  }

  const entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => (entry && entry.name ? String(entry.name).trim() : ""))
    .filter((name) => /^module-\d+\.css$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }))
    .map((name) => path.join(modulesDir, name));

  if (!files.length) {
    throw new Error("No generated CSS modules found. Run npm run styles:split first.");
  }

  return files;
};

const defaultExtractor = (content) => content.match(/[A-Za-z0-9_:/.%@-]+/g) || [];

const safelist = {
  standard: [
    /^is-/,
    /^has-/,
    /^fa-/,
    /^button/,
    /^modal/,
    "open",
    "hidden"
  ],
  deep: [
    /^admin-/,
    /^site-/,
    /^reader-/,
    /^notify-/,
    /^chat-/,
    /^team-/,
    /^profile-/,
    /^auth-/,
    /^manga-/,
    /^chapter-/
  ]
};

const bytes = (text) => Buffer.byteLength((text || "").toString(), "utf8");

const main = async () => {
  const cssFiles = listModuleCssFiles();
  const content = buildContentGlobs();
  const beforeByFile = new Map(
    cssFiles.map((filePath) => [filePath, bytes(fs.readFileSync(filePath, "utf8"))])
  );

  const purge = new PurgeCSS();
  const results = await purge.purge({
    content,
    css: cssFiles,
    defaultExtractor,
    safelist,
    rejected: true
  });

  const reportRows = [];
  let totalBefore = 0;
  let totalAfter = 0;

  results.forEach((result, index) => {
    const fallbackPath = cssFiles[index] || "";
    const filePath = result && result.file ? path.resolve(result.file) : fallbackPath;
    const cssText = `${(result && result.css ? result.css : "").toString().trim()}\n`;
    fs.writeFileSync(filePath, cssText, "utf8");

    const beforeSize = Number(beforeByFile.get(filePath)) || 0;
    const afterSize = bytes(cssText);
    totalBefore += beforeSize;
    totalAfter += afterSize;

    reportRows.push({
      file: path.relative(rootDir, filePath),
      beforeBytes: beforeSize,
      afterBytes: afterSize,
      removedBytes: Math.max(0, beforeSize - afterSize),
      rejectedSelectors: Array.isArray(result && result.rejected) ? result.rejected.length : 0
    });
  });

  const report = {
    generatedAt: new Date().toISOString(),
    content,
    files: reportRows,
    totals: {
      beforeBytes: totalBefore,
      afterBytes: totalAfter,
      removedBytes: Math.max(0, totalBefore - totalAfter)
    }
  };

  fs.writeFileSync(purgeReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Purged ${reportRows.length} CSS modules.`);
  console.log(`Removed ${report.totals.removedBytes} bytes.`);
  console.log(`Report: ${path.relative(rootDir, purgeReportPath)}`);
};

main().catch((error) => {
  console.error("Failed to purge CSS modules.");
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
