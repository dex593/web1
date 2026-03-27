"use strict";

const DEFAULT_LANG_PREFERENCE = [
  "vi",
  "en",
  "ja",
  "ja-ro",
  "ko",
  "zh",
  "zh-hk",
  "zh-ro"
];

const clampInt = (value, fallback, min, max) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.floor(numeric);
  if (Number.isFinite(min) && normalized < min) return min;
  if (Number.isFinite(max) && normalized > max) return max;
  return normalized;
};

const toBoolean = (value, fallback = false) => {
  if (value === true || value === false) return value;
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "yes", "on", "y"].includes(text)) return true;
  if (["0", "false", "no", "off", "n"].includes(text)) return false;
  return Boolean(fallback);
};

const normalizeStringList = (value) => {
  if (value == null) return [];
  const source = [];
  const rawItems = Array.isArray(value) ? value : [value];
  rawItems.forEach((item) => {
    String(item == null ? "" : item)
      .split(",")
      .forEach((part) => {
        source.push(part);
      });
  });

  const unique = [];
  const seen = new Set();
  source.forEach((item) => {
    const text = String(item == null ? "" : item).trim();
    if (!text) return;
    if (seen.has(text)) return;
    seen.add(text);
    unique.push(text);
  });
  return unique;
};

const pickLocalizedText = (localizedObject, preferredLanguages = DEFAULT_LANG_PREFERENCE) => {
  if (!localizedObject || typeof localizedObject !== "object") return "";

  const keys = Object.keys(localizedObject);
  if (!keys.length) return "";

  const normalizedPreference = normalizeStringList(preferredLanguages);
  for (let i = 0; i < normalizedPreference.length; i += 1) {
    const lang = normalizedPreference[i];
    if (!Object.prototype.hasOwnProperty.call(localizedObject, lang)) continue;
    const value = String(localizedObject[lang] == null ? "" : localizedObject[lang]).trim();
    if (value) return value;
  }

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const value = String(localizedObject[key] == null ? "" : localizedObject[key]).trim();
    if (value) return value;
  }

  return "";
};

const ensureBaseUrl = (value, fallback) => {
  const raw = String(value == null ? "" : value).trim();
  const candidate = raw || String(fallback == null ? "" : fallback).trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
  } catch (_err) {
    return "";
  }
};

const mapWithConcurrency = async (items, concurrency, worker) => {
  const source = Array.isArray(items) ? items : [];
  const safeConcurrency = clampInt(concurrency, 1, 1, 20);
  const results = new Array(source.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(safeConcurrency, source.length) }, () =>
    (async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= source.length) return;
        results[current] = await worker(source[current], current);
      }
    })()
  );

  await Promise.all(runners);
  return results;
};

const safeUrlJoin = (baseUrl, segments) => {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const path = (Array.isArray(segments) ? segments : [])
    .map((segment) => encodeURIComponent(String(segment == null ? "" : segment)))
    .join("/");
  return path ? `${root}/${path}` : root;
};

module.exports = {
  DEFAULT_LANG_PREFERENCE,
  clampInt,
  toBoolean,
  normalizeStringList,
  pickLocalizedText,
  ensureBaseUrl,
  mapWithConcurrency,
  safeUrlJoin
};
