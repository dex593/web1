"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const sourceSvgPath = path.resolve(__dirname, "..", "..", "public", "logobfang.svg");
const assetsDir = path.resolve(__dirname, "..", "assets");
const outputPngPath = path.join(assetsDir, "icon.png");
const outputIcoPath = path.join(assetsDir, "icon.ico");
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const SVG_RENDER_DENSITY_STEPS = [288, 192, 144, 96, 72, 48, 36];

function buildIcoBuffer(entries) {
  const count = entries.length;
  const headerSize = 6 + count * 16;
  const header = Buffer.alloc(headerSize);

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = headerSize;
  const payload = [];

  entries.forEach((entry, index) => {
    const size = Number(entry.size);
    const buffer = entry.buffer;
    const cursor = 6 + index * 16;

    header.writeUInt8(size >= 256 ? 0 : size, cursor + 0);
    header.writeUInt8(size >= 256 ? 0 : size, cursor + 1);
    header.writeUInt8(0, cursor + 2);
    header.writeUInt8(0, cursor + 3);
    header.writeUInt16LE(1, cursor + 4);
    header.writeUInt16LE(32, cursor + 6);
    header.writeUInt32LE(buffer.length, cursor + 8);
    header.writeUInt32LE(offset, cursor + 12);

    payload.push(buffer);
    offset += buffer.length;
  });

  return Buffer.concat([header, ...payload]);
}

async function loadSourceSvgBuffer() {
  const rawSvg = await fs.promises.readFile(sourceSvgPath, "utf8");
  const cleanedSvg = rawSvg
    .replace(/<\?xml[\s\S]*?\?>/i, "")
    .replace(/<!DOCTYPE[\s\S]*?>/i, "")
    .trim();
  return Buffer.from(cleanedSvg, "utf8");
}

async function buildPngBuffer(sourceSvgBuffer, size) {
  let lastError = null;

  for (const density of SVG_RENDER_DENSITY_STEPS) {
    try {
      return await sharp(sourceSvgBuffer, {
        density,
        limitInputPixels: false,
        failOnError: false
      })
        .resize(size, size, {
          fit: "contain",
          withoutEnlargement: true,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
    } catch (err) {
      lastError = err;
      const message = (err && err.message ? String(err.message) : "").toLowerCase();
      if (!message.includes("pixel limit")) {
        throw err;
      }
    }
  }

  throw lastError || new Error("Không thể render icon từ SVG nguồn.");
}

async function run() {
  if (!fs.existsSync(sourceSvgPath)) {
    throw new Error(`Không tìm thấy favicon nguồn: ${sourceSvgPath}`);
  }

  await fs.promises.mkdir(assetsDir, { recursive: true });

  const sourceSvgBuffer = await loadSourceSvgBuffer();

  const iconPng512 = await buildPngBuffer(sourceSvgBuffer, 512);
  await fs.promises.writeFile(outputPngPath, iconPng512);

  const icoEntries = [];
  for (const size of icoSizes) {
    const buffer = await buildPngBuffer(sourceSvgBuffer, size);
    icoEntries.push({ size, buffer });
  }

  const icoBuffer = buildIcoBuffer(icoEntries);
  await fs.promises.writeFile(outputIcoPath, icoBuffer);

  const sourceLabel = path.relative(path.resolve(__dirname, ".."), sourceSvgPath);
  const pngLabel = path.relative(path.resolve(__dirname, ".."), outputPngPath);
  const icoLabel = path.relative(path.resolve(__dirname, ".."), outputIcoPath);
  console.log(`Synced icon from ${sourceLabel} -> ${pngLabel}, ${icoLabel}`);
}

run().catch((err) => {
  console.error((err && err.message) || "Sync icon thất bại.");
  process.exitCode = 1;
});
