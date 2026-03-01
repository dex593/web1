#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

const readArgValue = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  return index + 1 < args.length ? String(args[index + 1] || "") : "";
};

const printChecklist = () => {
  const lines = [
    "Forum post image flow - manual quick checklist",
    "",
    "1) Start app and login.",
    "2) Open Create Post modal.",
    "3) Select image in editor toolbar.",
    "4) Confirm editor shows local-processing status + success message.",
    "5) Before submit, verify draft content keeps image as data:image/... URL.",
    "6) Submit post.",
    "7) Open created post detail page.",
    "8) Inspect rendered post HTML and copy post content HTML.",
    "9) Run this script with copied HTML to validate final URLs:",
    "   npm run qa:forum-images -- --content-file ./tmp/post-content.html",
    "",
    "Validation expectations:",
    "- No 'forum-local-image://' placeholder remains.",
    "- No 'data:image/' URL remains in submitted post.",
    "- At least one '/forum/posts/' URL exists when post has images.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
};

const readInputContent = () => {
  const inline = readArgValue("--content");
  if (inline) return inline;

  const filePath = readArgValue("--content-file");
  if (filePath) {
    const resolved = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Content file not found: ${resolved}`);
    }
    return fs.readFileSync(resolved, "utf8");
  }

  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, "utf8");
  }

  return "";
};

const run = () => {
  if (args.includes("--help") || args.includes("-h")) {
    printChecklist();
    return;
  }

  const content = String(readInputContent() || "").trim();
  if (!content) {
    printChecklist();
    return;
  }

  const hasLocalPlaceholder = /forum-local-image:\/\//i.test(content);
  const hasDataUrl = /data:image\//i.test(content);
  const hasFinalUrl = /\/forum\/posts\//i.test(content);

  if (hasLocalPlaceholder) {
    process.stderr.write("FAIL: Found local image placeholder in submitted content.\n");
    process.exitCode = 1;
    return;
  }

  if (hasDataUrl) {
    process.stderr.write("FAIL: Found data:image URL in submitted content.\n");
    process.exitCode = 1;
    return;
  }

  if (!hasFinalUrl) {
    process.stderr.write("WARN: No final /forum/posts/ URL found. If the post has no image, this is expected.\n");
    return;
  }

  process.stdout.write("PASS: Finalized content has no local placeholders or data URLs.\n");
};

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
