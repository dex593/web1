"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const {
  Manga: MangaDexManga,
  Chapter: MangaDexChapter,
  overrideApiOrigin
} = require("mangadex-full-api");

const fsp = fs.promises;

const MANGADEX_API_BASE_URL = "https://api.mangadex.org";
const MANGADEX_DEFAULT_USER_AGENT = "moetruyen-desktop/1.0 (desktop chapter uploader)";
const BROWSER_USER_AGENT_PATTERN = /\b(mozilla\/|chrome\/|safari\/|firefox\/|edg\/|opera\/)\b/i;
const MANGADEX_REFERER = String(process.env.MANGADEX_REFERER || "https://mangadex.org/").trim() || "https://mangadex.org/";

const MANGADEX_USER_AGENT = resolveMangaDexUserAgent(process.env.MANGADEX_USER_AGENT);
const MANGADEX_ALLOW_DATASAVER_FALLBACK = toBooleanFlag(process.env.MANGADEX_ALLOW_DATASAVER_FALLBACK, false);

const MANGADEX_FEED_PAGE_SIZE = clampInt(process.env.MANGADEX_FEED_PAGE_SIZE, 32, 1, 500);

const MANGADEX_COVER_BASE_URL = String(process.env.MANGADEX_COVER_BASE_URL || "https://uploads.mangadex.org/covers")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_API_BASE_URL = String(process.env.WEEBDEX_API_BASE_URL || "https://api.weebdex.org")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_NODE_FALLBACK = String(process.env.WEEBDEX_NODE_FALLBACK || "https://srv.weebdex.net")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_COVER_BASE_URL = String(process.env.WEEBDEX_COVER_BASE_URL || "https://srv.weebdex.net/covers")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_ORIGIN = String(process.env.WEEBDEX_ORIGIN || "https://weebdex.org").trim() || "https://weebdex.org";
const WEEBDEX_REFERER = String(process.env.WEEBDEX_REFERER || "https://weebdex.org/").trim() || "https://weebdex.org/";
const WEEBDEX_CHAPTER_PAGE_SIZE = clampInt(process.env.WEEBDEX_CHAPTER_PAGE_SIZE, 100, 1, 100);

const SOURCE_BRIDGE_BASE_URL = String(process.env.SOURCE_BRIDGE_BASE_URL || "https://dex.moetruyen.net")
  .trim()
  .replace(/\/+$/, "");
const SOURCE_BRIDGE_TIMEOUT_MS = clampInt(process.env.SOURCE_BRIDGE_TIMEOUT_MS, 30000, 3000, 120000);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LANGUAGES = ["vi"];

let mangaDexLibraryQueue = Promise.resolve();

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.floor(numeric);
  if (Number.isFinite(min) && normalized < min) return min;
  if (Number.isFinite(max) && normalized > max) return max;
  return normalized;
}

function resolveMangaDexUserAgent(value) {
  const candidate = String(value == null ? "" : value).trim();
  if (!candidate) {
    return MANGADEX_DEFAULT_USER_AGENT;
  }
  if (BROWSER_USER_AGENT_PATTERN.test(candidate)) {
    return MANGADEX_DEFAULT_USER_AGENT;
  }
  return candidate;
}

function normalizeStringList(value) {
  if (value == null) return [];
  const source = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();
  source.forEach((item) => {
    String(item == null ? "" : item)
      .split(",")
      .forEach((part) => {
        const text = String(part == null ? "" : part).trim().toLowerCase();
        if (!text || seen.has(text)) return;
        seen.add(text);
        result.push(text);
      });
  });
  return result;
}

function toBooleanFlag(value, fallback = false) {
  if (value == null) return Boolean(fallback);
  const text = String(value).trim().toLowerCase();
  if (!text) return Boolean(fallback);
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return Boolean(fallback);
}

function pickLocalizedText(localizedObject, preferredLanguages = ["vi", "en", "ja", "ja-ro", "ko"]) {
  if (!localizedObject || typeof localizedObject !== "object") return "";

  const preferred = normalizeStringList(preferredLanguages);
  for (let i = 0; i < preferred.length; i += 1) {
    const lang = preferred[i];
    if (!Object.prototype.hasOwnProperty.call(localizedObject, lang)) continue;
    const value = String(localizedObject[lang] == null ? "" : localizedObject[lang]).trim();
    if (value) return value;
  }

  const keys = Object.keys(localizedObject);
  for (let i = 0; i < keys.length; i += 1) {
    const value = String(localizedObject[keys[i]] == null ? "" : localizedObject[keys[i]]).trim();
    if (value) return value;
  }
  return "";
}

function parseChapterNumber(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  const normalized = raw.replace(/,/g, ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.round(parsed * 1000) / 1000;
}

function formatChapterNumber(number, fallbackText = "Không rõ") {
  const value = Number(number);
  if (!Number.isFinite(value)) return fallbackText;
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function normalizeError(error, fallbackMessage, statusCode = 500) {
  if (error && typeof error === "object") {
    if (error.statusCode == null) {
      error.statusCode = statusCode;
    }
    if (!error.message && fallbackMessage) {
      error.message = fallbackMessage;
    }
    return error;
  }
  const err = new Error(fallbackMessage || "Unknown error");
  err.statusCode = statusCode;
  return err;
}

function extractErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (first && typeof first === "object") {
      if (first.detail) return String(first.detail);
      if (first.title) return String(first.title);
      if (first.error) return String(first.error);
      if (first.message) return String(first.message);
    }
    return String(payload.errors[0]);
  }

  if (payload.error) return String(payload.error);
  if (payload.message) return String(payload.message);
  return fallback;
}

function isRetriableStatus(statusCode) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(statusCode));
}

function buildMangaDexHeaders() {
  return {
    "User-Agent": MANGADEX_USER_AGENT,
    Referer: MANGADEX_REFERER
  };
}

function normalizeRequestHeaders(headers) {
  if (!headers) return {};

  if (typeof headers.forEach === "function") {
    const mapped = {};
    headers.forEach((value, key) => {
      mapped[String(key)] = String(value);
    });
    return mapped;
  }

  if (Array.isArray(headers)) {
    const mapped = {};
    headers.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return;
      mapped[String(entry[0])] = String(entry[1]);
    });
    return mapped;
  }

  if (typeof headers === "object") {
    return Object.keys(headers).reduce((result, key) => {
      result[String(key)] = String(headers[key]);
      return result;
    }, {});
  }

  return {};
}

function applyMangaDexHeaderPolicy(headers) {
  const normalized = normalizeRequestHeaders(headers);

  Object.keys(normalized).forEach((key) => {
    if (String(key).toLowerCase() === "via") {
      delete normalized[key];
    }
  });

  normalized["User-Agent"] = MANGADEX_USER_AGENT;
  normalized.Referer = MANGADEX_REFERER;
  return normalized;
}

function toNodeRequestBody(body) {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
}

function shouldRetryWithNodeHttp(error) {
  if (!error) return false;
  if (error.name === "AbortError") return false;
  const code = String(error.code || "").toUpperCase();
  if (["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return true;
  }
  const message = String(error.message || "").toLowerCase();
  if (!message) return false;
  return message.includes("fetch failed") || message.includes("socket") || message.includes("tls") || message.includes("network");
}

async function fetchViaNodeHttp(url, options = {}, redirectDepth = 0) {
  const requestUrl = new URL(String(url));
  const protocol = requestUrl.protocol === "http:" ? "http:" : "https:";
  const transport = protocol === "https:" ? https : http;

  const method = String(options.method || "GET").toUpperCase();
  const requestHeaders = normalizeRequestHeaders(options.headers);
  const bodyBuffer = toNodeRequestBody(options.body);

  if (bodyBuffer && !Object.keys(requestHeaders).some((key) => String(key).toLowerCase() === "content-length")) {
    requestHeaders["Content-Length"] = String(bodyBuffer.length);
  }

  const timeoutMs = clampInt(options.__timeoutMs, 30000, 2000, 180000);

  return new Promise((resolve, reject) => {
    const requestOptions = {
      protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port ? Number(requestUrl.port) : (protocol === "https:" ? 443 : 80),
      method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers: requestHeaders,
      family: 4
    };

    const req = transport.request(requestOptions, (res) => {
      const statusCode = Number(res.statusCode || 0);
      const location = res.headers && res.headers.location ? String(res.headers.location) : "";

      if ([301, 302, 303, 307, 308].includes(statusCode)
        && options.redirect !== "manual"
        && location
        && redirectDepth < 5) {
        const target = new URL(location, requestUrl).toString();
        const redirectMethod = statusCode === 303 ? "GET" : method;
        const nextOptions = {
          ...options,
          method: redirectMethod,
          body: redirectMethod === "GET" ? null : options.body
        };
        res.resume();
        fetchViaNodeHttp(target, nextOptions, redirectDepth + 1).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const responseHeaders = {};
        Object.keys(res.headers || {}).forEach((key) => {
          const value = res.headers[key];
          if (Array.isArray(value)) {
            responseHeaders[key] = value.join(", ");
            return;
          }
          if (value == null) return;
          responseHeaders[key] = String(value);
        });
        resolve(new Response(body, {
          status: statusCode || 502,
          statusText: String(res.statusMessage || ""),
          headers: responseHeaders
        }));
      });
    });

    const abortSignal = options.signal;
    const onAbort = () => {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      req.destroy(abortErr);
    };

    if (abortSignal && typeof abortSignal.addEventListener === "function") {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    req.setTimeout(timeoutMs, () => {
      const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms`);
      timeoutErr.name = "AbortError";
      req.destroy(timeoutErr);
    });

    req.on("error", (err) => {
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", onAbort);
      }
      reject(err);
    });

    req.on("close", () => {
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", onAbort);
      }
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function toDebugText(value, maxLength = 360) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function serializeErrorDetails(error, depth = 0) {
  if (error == null) return null;
  if (depth >= 3) {
    return {
      message: "(truncated)"
    };
  }

  if (typeof error !== "object") {
    return {
      message: toDebugText(error)
    };
  }

  const detail = {
    name: error.name ? String(error.name) : "Error",
    message: error.message ? String(error.message) : ""
  };

  ["code", "errno", "type", "statusCode", "status"].forEach((key) => {
    if (error[key] == null) return;
    detail[key] = error[key];
  });

  if (typeof error.stack === "string" && error.stack.trim()) {
    detail.stack = error.stack.split("\n").slice(0, 8).join("\n");
  }

  if (error.cause) {
    detail.cause = serializeErrorDetails(error.cause, depth + 1);
  }

  return detail;
}

function summarizeHeadersForDebug(headers) {
  const normalized = normalizeRequestHeaders(headers);
  const sensitivePattern = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
  const summary = {};

  Object.keys(normalized).sort().forEach((key) => {
    const value = normalized[key];
    summary[key] = sensitivePattern.test(String(key))
      ? "[masked]"
      : toDebugText(value, 180);
  });

  return summary;
}

function attachDebugInfo(error, debugInfo = {}) {
  const target = normalizeError(error, "Unknown source-ingest error", 500);
  const current = target && target.debugInfo && typeof target.debugInfo === "object"
    ? target.debugInfo
    : {};
  target.debugInfo = {
    ...current,
    ...(debugInfo && typeof debugInfo === "object" ? debugInfo : {})
  };
  return target;
}

function logSourceError(scope, error) {
  const payload = {
    scope: String(scope || "source-ingest"),
    at: new Date().toISOString(),
    error: serializeErrorDetails(error),
    debugInfo: error && error.debugInfo ? error.debugInfo : null
  };
  console.error(`[source-ingest] ${payload.scope}:`, JSON.stringify(payload, null, 2));
}

async function runWithMangaDexLibrary(task) {
  const worker = async () => {
    const originalFetch = global.fetch;
    if (typeof originalFetch !== "function") {
      const err = new Error("Môi trường hiện tại không hỗ trợ fetch để gọi MangaDex.");
      err.statusCode = 500;
      throw err;
    }

    overrideApiOrigin(MANGADEX_API_BASE_URL);

    global.fetch = async (url, options = {}) => {
      const requestUrl = String(url == null ? "" : url);
      const nextOptions = options && typeof options === "object"
        ? { ...options }
        : {};
      nextOptions.headers = applyMangaDexHeaderPolicy(nextOptions.headers);
      const method = String(nextOptions.method || "GET").toUpperCase();

      let primaryError = null;
      try {
        return await originalFetch(url, nextOptions);
      } catch (err) {
        primaryError = err;
      }

      const fallbackAttempted = shouldRetryWithNodeHttp(primaryError);
      let fallbackError = null;
      if (fallbackAttempted) {
        try {
          return await fetchViaNodeHttp(url, {
            ...nextOptions,
            __timeoutMs: 45000
          });
        } catch (err) {
          fallbackError = err;
        }
      }

      const errorWithDebug = attachDebugInfo(primaryError, {
        provider: "mangadex",
        stage: "library-fetch",
        request: {
          url: requestUrl,
          method,
          headers: summarizeHeadersForDebug(nextOptions.headers)
        },
        transportError: serializeErrorDetails(primaryError),
        fallbackAttempted,
        fallbackTransportError: fallbackAttempted
          ? serializeErrorDetails(fallbackError)
          : null
      });
      if (!errorWithDebug.statusCode) {
        errorWithDebug.statusCode = 502;
      }
      throw errorWithDebug;
    };

    try {
      return await task();
    } catch (err) {
      throw attachDebugInfo(err, {
        provider: "mangadex",
        stage: "library-task"
      });
    } finally {
      global.fetch = originalFetch;
      overrideApiOrigin(undefined);
    }
  };

  const execution = mangaDexLibraryQueue.then(worker, worker);
  mangaDexLibraryQueue = execution.catch(() => null);
  return execution;
}

function toIsoStringOrEmpty(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return String(value).trim();
}

function mapMangaDexGroups(groupsInput) {
  return (Array.isArray(groupsInput) ? groupsInput : [])
    .map((relation) => {
      if (!relation || typeof relation !== "object") return null;
      const id = relation.id ? String(relation.id).trim() : "";

      let name = "";
      if (relation.name) {
        name = String(relation.name).trim();
      }
      if (!name && typeof relation.peek === "function") {
        const cached = relation.peek();
        if (cached && cached.name) {
          name = String(cached.name).trim();
        }
      }

      if (!name && relation.attributes && relation.attributes.name) {
        name = String(relation.attributes.name).trim();
      }

      if (!id && !name) return null;
      return { id, name };
    })
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function requestJson(url, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 20000, 2000, 120000);
  const retries = clampInt(options.retries, 2, 0, 5);
  const retryDelayMs = clampInt(options.retryDelayMs, 400, 0, 5000);
  const requestMethod = String(options.method || "GET").toUpperCase();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutToken = setTimeout(() => controller.abort(), timeoutMs);
    let requestHeaders = null;
    try {
      requestHeaders = {
        Accept: "application/json",
        ...(options.headers || {})
      };
      if (Object.prototype.hasOwnProperty.call(requestHeaders, "Via")) {
        delete requestHeaders.Via;
      }
      if (Object.prototype.hasOwnProperty.call(requestHeaders, "via")) {
        delete requestHeaders.via;
      }

      const response = await fetch(url, {
        method: requestMethod,
        headers: requestHeaders,
        body: options.body,
        signal: controller.signal,
        redirect: "follow"
      });

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_err) {
          data = null;
        }
      }

      if (!response.ok) {
        const message = extractErrorMessage(data, `Request failed with status ${response.status}`);
        const err = attachDebugInfo(new Error(message), {
          provider: "mangadex",
          stage: "request-json-response",
          request: {
            url: String(url),
            method: requestMethod,
            headers: summarizeHeadersForDebug(requestHeaders),
            attempt: attempt + 1,
            retries,
            timeoutMs
          },
          response: {
            status: response.status,
            statusText: response.statusText ? String(response.statusText) : "",
            bodyError: extractErrorMessage(data, "")
          }
        });
        err.statusCode = response.status;
        err.payload = data;
        err.url = url;

        if (attempt < retries && isRetriableStatus(response.status)) {
          lastError = err;
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : retryDelayMs * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        throw err;
      }

      return {
        statusCode: response.status,
        data,
        rawText: text,
        headers: response.headers
      };
    } catch (err) {
      const isAbort = err && err.name === "AbortError";
      const normalized = isAbort
        ? (() => {
            const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms`);
            timeoutErr.statusCode = 504;
            return timeoutErr;
          })()
        : err;

      const withDebug = attachDebugInfo(normalized, {
        stage: "request-json-catch",
        request: {
          url: String(url),
          method: requestMethod,
          headers: summarizeHeadersForDebug(requestHeaders),
          attempt: attempt + 1,
          retries,
          timeoutMs
        },
        transportError: serializeErrorDetails(normalized)
      });

      if (attempt < retries && (!withDebug || !withDebug.statusCode || isRetriableStatus(withDebug.statusCode))) {
        lastError = withDebug;
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      const finalError = attachDebugInfo(normalizeError(withDebug, "Network request failed", 502), {
        stage: "request-json-final"
      });
      throw finalError;
    } finally {
      clearTimeout(timeoutToken);
    }
  }

  throw attachDebugInfo(normalizeError(lastError, "Request failed", 500), {
    stage: "request-json-exhausted",
    request: {
      url: String(url),
      method: requestMethod,
      retries,
      timeoutMs
    }
  });
}

async function requestBuffer(url, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 30000, 3000, 180000);
  const retries = clampInt(options.retries, 2, 0, 4);
  const retryDelayMs = clampInt(options.retryDelayMs, 400, 0, 5000);
  const requestMethod = "GET";
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeoutToken = setTimeout(() => controller.abort(), timeoutMs);
    let requestHeaders = null;
    try {
      requestHeaders = {
        ...(options.headers || {})
      };
      if (Object.prototype.hasOwnProperty.call(requestHeaders, "Via")) {
        delete requestHeaders.Via;
      }
      if (Object.prototype.hasOwnProperty.call(requestHeaders, "via")) {
        delete requestHeaders.via;
      }

      let response = null;
      let primaryFetchError = null;
      let fallbackAttempted = false;
      let fallbackTransportError = null;

      try {
        response = await fetch(url, {
          method: requestMethod,
          headers: requestHeaders,
          signal: controller.signal,
          redirect: "follow"
        });
      } catch (err) {
        primaryFetchError = err;
      }

      if (!response && primaryFetchError) {
        fallbackAttempted = shouldRetryWithNodeHttp(primaryFetchError);
        if (fallbackAttempted) {
          try {
            response = await fetchViaNodeHttp(url, {
              method: requestMethod,
              headers: requestHeaders,
              signal: controller.signal,
              redirect: "follow",
              __timeoutMs: timeoutMs
            });
          } catch (err) {
            fallbackTransportError = err;
          }
        }

        if (!response) {
          const transportError = attachDebugInfo(primaryFetchError, {
            stage: "request-buffer-fetch",
            request: {
              url: String(url),
              method: requestMethod,
              headers: summarizeHeadersForDebug(requestHeaders),
              attempt: attempt + 1,
              retries,
              timeoutMs
            },
            transportError: serializeErrorDetails(primaryFetchError),
            fallbackAttempted,
            fallbackTransportError: fallbackAttempted
              ? serializeErrorDetails(fallbackTransportError)
              : null
          });

          if (!transportError.statusCode) {
            transportError.statusCode = 502;
          }
          throw transportError;
        }
      }

      if (!response.ok) {
        const err = attachDebugInfo(new Error(`Image request failed with status ${response.status}`), {
          stage: "request-buffer-response",
          request: {
            url: String(url),
            method: requestMethod,
            headers: summarizeHeadersForDebug(requestHeaders),
            attempt: attempt + 1,
            retries,
            timeoutMs
          },
          response: {
            status: response.status,
            statusText: response.statusText ? String(response.statusText) : ""
          }
        });
        err.statusCode = response.status;
        if (attempt < retries && isRetriableStatus(response.status)) {
          lastError = err;
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw err;
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: String(response.headers.get("content-type") || "").toLowerCase()
      };
    } catch (err) {
      const normalized = err && err.name === "AbortError"
        ? (() => {
            const timeoutErr = new Error(`Image request timeout after ${timeoutMs}ms`);
            timeoutErr.statusCode = 504;
            return timeoutErr;
          })()
        : err;

      const withDebug = attachDebugInfo(normalized, {
        stage: "request-buffer-catch",
        request: {
          url: String(url),
          method: requestMethod,
          headers: summarizeHeadersForDebug(requestHeaders),
          attempt: attempt + 1,
          retries,
          timeoutMs
        },
        transportError: serializeErrorDetails(normalized)
      });

      if (attempt < retries && (!withDebug || !withDebug.statusCode || isRetriableStatus(withDebug.statusCode))) {
        lastError = withDebug;
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      const finalError = attachDebugInfo(normalizeError(withDebug, "Failed to download image", 502), {
        stage: "request-buffer-final"
      });
      throw finalError;
    } finally {
      clearTimeout(timeoutToken);
    }
  }

  throw attachDebugInfo(normalizeError(lastError, "Failed to download image", 502), {
    stage: "request-buffer-exhausted",
    request: {
      url: String(url),
      method: requestMethod,
      retries,
      timeoutMs
    }
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const source = Array.isArray(items) ? items : [];
  const safeConcurrency = clampInt(concurrency, 1, 1, 12);
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
}

function extractMangaDexId(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) {
    const err = new Error("Bạn chưa nhập link hoặc id MangaDex.");
    err.statusCode = 400;
    throw err;
  }

  if (UUID_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const segments = url.pathname.split("/").map((item) => item.trim()).filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      if (UUID_PATTERN.test(segments[i])) {
        return segments[i].toLowerCase();
      }
    }
  } catch (_err) {
    // ignore
  }

  const err = new Error("Không tách được MangaDex manga id từ link đã nhập.");
  err.statusCode = 400;
  throw err;
}

function extractWeebDexId(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) {
    const err = new Error("Bạn chưa nhập link hoặc id WeebDex.");
    err.statusCode = 400;
    throw err;
  }

  if (!/[\/:]/.test(raw) && raw.length >= 6) {
    return raw;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const segments = url.pathname.split("/").map((item) => item.trim()).filter(Boolean);
    const markerIndex = segments.findIndex((item) => ["title", "titles", "manga", "series"].includes(item.toLowerCase()));
    if (markerIndex >= 0 && segments[markerIndex + 1]) {
      return segments[markerIndex + 1];
    }
    if (segments.length) {
      return segments[segments.length - 1];
    }
  } catch (_err) {
    // ignore
  }

  const err = new Error("Không tách được WeebDex manga id từ link đã nhập.");
  err.statusCode = 400;
  throw err;
}

function extractMangaDexChapterId(input, allowLooseId = false) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";

  if (allowLooseId && UUID_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const segments = url.pathname.split("/").map((item) => item.trim()).filter(Boolean);
    const markerIndex = segments.findIndex((item) => ["chapter", "chapters"].includes(item.toLowerCase()));
    if (markerIndex >= 0) {
      for (let i = markerIndex + 1; i < segments.length; i += 1) {
        if (UUID_PATTERN.test(segments[i])) {
          return segments[i].toLowerCase();
        }
      }
    }
    if (allowLooseId) {
      for (let i = 0; i < segments.length; i += 1) {
        if (UUID_PATTERN.test(segments[i])) {
          return segments[i].toLowerCase();
        }
      }
    }
  } catch (_err) {
    // ignore
  }

  return "";
}

function extractWeebDexChapterId(input, allowLooseId = false) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";

  if (allowLooseId && !/[\/:]/.test(raw) && raw.length >= 6) {
    return raw;
  }

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const segments = url.pathname.split("/").map((item) => item.trim()).filter(Boolean);
    const markerIndex = segments.findIndex((item) => ["chapter", "chapters"].includes(item.toLowerCase()));
    if (markerIndex >= 0) {
      const trailing = segments.slice(markerIndex + 1);
      const strictMatch = trailing.find((item) => /^[a-z0-9]{10}$/i.test(item));
      if (strictMatch) {
        return strictMatch;
      }
      const looseMatch = trailing.find((item) => /^[a-z0-9]{6,}$/i.test(item));
      if (looseMatch) {
        return looseMatch;
      }
    }
  } catch (_err) {
    // ignore
  }

  return "";
}

function isLikelyRawSourceId(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return false;
  if (UUID_PATTERN.test(raw)) return true;
  if (/^[a-z0-9_-]{6,}$/i.test(raw)) return true;

  try {
    // valid URL => not raw id
    new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return false;
  } catch (_err) {
    return true;
  }
}

function createSourceResolveError({
  provider,
  targetId,
  sourceInput,
  languages,
  stage,
  err
}) {
  const statusCode = Number(err && err.statusCode);
  const safeId = String(targetId || sourceInput || "").trim() || "?";
  const wrapped = new Error(`Không thể lấy dữ liệu từ id \`${safeId}\``);
  wrapped.statusCode = Number.isFinite(statusCode) && statusCode > 0 ? statusCode : 502;
  attachDebugInfo(wrapped, {
    provider,
    stage,
    request: {
      sourceBridgeBaseUrl: SOURCE_BRIDGE_BASE_URL,
      targetId: safeId,
      sourceInput,
      languages
    },
    cause: serializeErrorDetails(err),
    nestedDebugInfo: err && err.debugInfo ? err.debugInfo : null,
    providerPayload: err && err.payload ? err.payload : null,
    providerUrl: err && err.url ? String(err.url) : ""
  });
  return wrapped;
}

function mapMangaDexManga(payload) {
  if (payload && typeof payload === "object" && payload.id && payload.title && payload.description) {
    const mangaId = String(payload.id || "").trim();

    let coverUrl = "";
    const mainCover = payload.mainCover && typeof payload.mainCover === "object" ? payload.mainCover : null;
    const cachedCover = mainCover && typeof mainCover.peek === "function" ? mainCover.peek() : null;
    if (cachedCover && cachedCover.url) {
      coverUrl = String(cachedCover.url).trim();
    } else {
      const coverFileName = cachedCover && cachedCover.fileName
        ? String(cachedCover.fileName).trim()
        : "";
      if (mangaId && coverFileName) {
        coverUrl = `${MANGADEX_COVER_BASE_URL}/${encodeURIComponent(mangaId)}/${encodeURIComponent(coverFileName)}`;
      }
    }

    return {
      id: mangaId,
      title: payload.localTitle || pickLocalizedText(payload.title),
      description: payload.localDescription || pickLocalizedText(payload.description),
      coverUrl,
      sourceUrl: mangaId ? `https://mangadex.org/title/${mangaId}` : ""
    };
  }

  const entity = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const attributes = entity && entity.attributes && typeof entity.attributes === "object" ? entity.attributes : {};
  const relationships = Array.isArray(entity.relationships) ? entity.relationships : [];
  const coverRelation = relationships.find((item) => item && item.type === "cover_art");
  const coverFileName = coverRelation
    && coverRelation.attributes
    && coverRelation.attributes.fileName
    ? String(coverRelation.attributes.fileName).trim()
    : "";
  const mangaId = entity && entity.id ? String(entity.id).trim() : "";
  const coverUrl = mangaId && coverFileName
    ? `${MANGADEX_COVER_BASE_URL}/${encodeURIComponent(mangaId)}/${encodeURIComponent(coverFileName)}`
    : "";

  return {
    id: mangaId,
    title: pickLocalizedText(attributes.title),
    description: pickLocalizedText(attributes.description),
    coverUrl,
    sourceUrl: mangaId ? `https://mangadex.org/title/${mangaId}` : ""
  };
}

function mapMangaDexRelease(item) {
  if (item && typeof item === "object" && !item.attributes && "chapter" in item) {
    const groups = mapMangaDexGroups(item.groups);
    const chapterRaw = item.chapter == null ? "" : String(item.chapter);
    const chapterNumber = parseChapterNumber(chapterRaw);

    return {
      id: item.id ? String(item.id) : "",
      chapterRaw,
      chapterNumber,
      chapterNumberText: chapterRaw || formatChapterNumber(chapterNumber),
      volume: item.volume == null ? "" : String(item.volume),
      title: item.title ? String(item.title).trim() : "",
      translatedLanguage: item.translatedLanguage ? String(item.translatedLanguage).toLowerCase() : "",
      publishAt: toIsoStringOrEmpty(item.publishAt),
      pages: Number(item.pages) > 0 ? Number(item.pages) : 0,
      externalUrl: item.externalUrl ? String(item.externalUrl) : "",
      isUnavailable: Boolean(item.isUnavailable || item.isExternal),
      groups,
      groupLabel: groups.length
        ? groups.map((group) => group.name || group.id).join(", ")
        : "Không rõ nhóm"
    };
  }

  const attributes = item && item.attributes && typeof item.attributes === "object" ? item.attributes : {};
  const relationships = Array.isArray(item && item.relationships) ? item.relationships : [];
  const groups = relationships
    .filter((relation) => relation && relation.type === "scanlation_group")
    .map((relation) => ({
      id: relation && relation.id ? String(relation.id) : "",
      name: relation && relation.attributes && relation.attributes.name
        ? String(relation.attributes.name).trim()
        : ""
    }))
    .filter((group) => group.id || group.name);

  const chapterRaw = attributes.chapter == null ? "" : String(attributes.chapter);
  const chapterNumber = parseChapterNumber(chapterRaw);

  return {
    id: item && item.id ? String(item.id) : "",
    chapterRaw,
    chapterNumber,
    chapterNumberText: chapterRaw || formatChapterNumber(chapterNumber),
    volume: attributes.volume == null ? "" : String(attributes.volume),
    title: attributes.title ? String(attributes.title).trim() : "",
    translatedLanguage: attributes.translatedLanguage ? String(attributes.translatedLanguage).toLowerCase() : "",
    publishAt: attributes.publishAt ? String(attributes.publishAt) : "",
    pages: Number(attributes.pages) > 0 ? Number(attributes.pages) : 0,
    externalUrl: attributes.externalUrl ? String(attributes.externalUrl) : "",
    isUnavailable: Boolean(attributes.isUnavailable),
    groups,
    groupLabel: groups.length
      ? groups.map((group) => group.name || group.id).join(", ")
      : "Không rõ nhóm"
  };
}

function mapWeebDexManga(payload) {
  const manga = payload && typeof payload === "object" ? payload : {};
  const relationships = manga && manga.relationships && typeof manga.relationships === "object"
    ? manga.relationships
    : {};
  const cover = relationships.cover && typeof relationships.cover === "object" ? relationships.cover : null;
  const coverId = cover && cover.id ? String(cover.id).trim() : "";
  const coverExtRaw = cover && cover.ext ? String(cover.ext).trim() : "";
  const coverExt = coverExtRaw ? coverExtRaw.replace(/^\./, "") : "";
  const mangaId = manga && manga.id ? String(manga.id).trim() : "";

  return {
    id: mangaId,
    title: manga.title ? String(manga.title) : "",
    description: manga.description ? String(manga.description) : "",
    coverUrl: mangaId && coverId && coverExt
      ? `${WEEBDEX_COVER_BASE_URL}/${encodeURIComponent(mangaId)}/${encodeURIComponent(coverId)}.${encodeURIComponent(coverExt)}`
      : "",
    sourceUrl: mangaId ? `https://weebdex.org/title/${mangaId}` : ""
  };
}

function mapWeebDexRelease(item) {
  const chapter = item && typeof item === "object" ? item : {};
  const relationships = chapter && chapter.relationships && typeof chapter.relationships === "object"
    ? chapter.relationships
    : {};

  const groups = Array.isArray(relationships.groups)
    ? relationships.groups
        .map((group) => ({
          id: group && group.id ? String(group.id) : "",
          name: group && group.name ? String(group.name) : ""
        }))
        .filter((group) => group.id || group.name)
    : [];

  const uploader = relationships.uploader && typeof relationships.uploader === "object"
    ? {
        id: relationships.uploader.id ? String(relationships.uploader.id) : "",
        username: relationships.uploader.username ? String(relationships.uploader.username) : ""
      }
    : null;

  const chapterRaw = chapter.chapter == null ? "" : String(chapter.chapter);
  const chapterNumber = parseChapterNumber(chapterRaw);
  const rawData = Array.isArray(chapter.data) ? chapter.data : [];
  const rawDataOptimized = Array.isArray(chapter.data_optimized) ? chapter.data_optimized : [];

  return {
    id: chapter.id ? String(chapter.id) : "",
    chapterRaw,
    chapterNumber,
    chapterNumberText: chapterRaw || formatChapterNumber(chapterNumber),
    volume: chapter.volume == null ? "" : String(chapter.volume),
    title: chapter.title ? String(chapter.title) : "",
    translatedLanguage: chapter.language ? String(chapter.language).toLowerCase() : "",
    publishAt: chapter.published_at ? String(chapter.published_at) : "",
    pages: rawData.length || rawDataOptimized.length,
    isUnavailable: Boolean(chapter.is_unavailable),
    node: chapter.node ? String(chapter.node) : "",
    groups,
    uploader,
    groupLabel: groups.length
      ? groups.map((group) => group.name || group.id).join(", ")
      : uploader && uploader.username
        ? `Uploader: ${uploader.username}`
        : "Không rõ nhóm"
  };
}

function buildChapterEntries(releases) {
  const map = new Map();

  const sortedReleases = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && release.id)
    .slice()
    .sort((a, b) => {
      const aNum = Number.isFinite(a.chapterNumber) ? a.chapterNumber : Number.NEGATIVE_INFINITY;
      const bNum = Number.isFinite(b.chapterNumber) ? b.chapterNumber : Number.NEGATIVE_INFINITY;
      if (Math.abs(aNum - bNum) > 1e-9) return bNum - aNum;

      const aDate = a.publishAt ? Date.parse(a.publishAt) : 0;
      const bDate = b.publishAt ? Date.parse(b.publishAt) : 0;
      if (aDate !== bDate) return bDate - aDate;

      return String(a.id).localeCompare(String(b.id));
    });

  sortedReleases.forEach((release) => {
    const normalizedChapterKey = Number.isFinite(release.chapterNumber)
      ? `num:${Number(release.chapterNumber).toFixed(3)}`
      : "";
    const chapterKey = String(release.chapterRaw || "").trim() || `id:${release.id}`;
    const volumeKey = String(release.volume || "").trim();
    const key = normalizedChapterKey || `${chapterKey}::${volumeKey}`;
    if (!map.has(key)) {
      map.set(key, {
        id: key,
        chapterNumber: Number.isFinite(release.chapterNumber) ? release.chapterNumber : null,
        chapterNumberText: release.chapterNumberText || "Không rõ",
        volumeText: volumeKey,
        selectedReleaseId: release.id,
        title: release.title || "",
        releases: []
      });
    }
    map.get(key).releases.push(release);
  });

  return Array.from(map.values()).map((entry) => ({
    ...entry,
    releases: entry.releases.slice().sort((a, b) => {
      const aDate = a.publishAt ? Date.parse(a.publishAt) : 0;
      const bDate = b.publishAt ? Date.parse(b.publishAt) : 0;
      if (aDate !== bDate) return bDate - aDate;
      return String(a.groupLabel || "").localeCompare(String(b.groupLabel || ""), "vi", { sensitivity: "base" });
    })
  }));
}

function buildWeebDexApiUrl(pathname, queryEntries = []) {
  const url = new URL(`${WEEBDEX_API_BASE_URL}${pathname}`);
  (Array.isArray(queryEntries) ? queryEntries : []).forEach(([key, value]) => {
    if (!key || value == null || value === "") return;
    url.searchParams.append(String(key), String(value));
  });
  return url.toString();
}

function buildMangaDexApiUrl(pathname, queryEntries = []) {
  const url = new URL(`${MANGADEX_API_BASE_URL}${pathname}`);
  (Array.isArray(queryEntries) ? queryEntries : []).forEach(([key, value]) => {
    if (!key || value == null || value === "") return;
    url.searchParams.append(String(key), String(value));
  });
  return url.toString();
}

function buildSourceBridgeUrl(pathname, queryEntries = []) {
  const safeBaseUrl = SOURCE_BRIDGE_BASE_URL || "https://dex.moetruyen.net";
  const safePath = String(pathname == null ? "" : pathname).startsWith("/")
    ? String(pathname)
    : `/${String(pathname == null ? "" : pathname)}`;
  const url = new URL(`${safeBaseUrl}${safePath}`);
  (Array.isArray(queryEntries) ? queryEntries : []).forEach(([key, value]) => {
    if (!key || value == null || value === "") return;
    url.searchParams.append(String(key), String(value));
  });
  return url.toString();
}

async function requestSourceBridgeJson(pathname, queryEntries = []) {
  const targetUrl = buildSourceBridgeUrl(pathname, queryEntries);
  const response = await requestJson(targetUrl, {
    timeoutMs: SOURCE_BRIDGE_TIMEOUT_MS,
    retries: 2,
    retryDelayMs: 450,
    headers: {
      Accept: "application/json",
      "User-Agent": MANGADEX_USER_AGENT
    }
  });

  const payload = response && response.data && typeof response.data === "object"
    ? response.data
    : {};

  if (!payload || payload.ok !== true) {
    const message = payload && payload.error
      ? String(payload.error)
      : "Source bridge trả dữ liệu không hợp lệ.";
    const err = new Error(message);
    err.statusCode = Number(payload && payload.statusCode) || 502;
    err.payload = payload;
    err.url = targetUrl;
    throw err;
  }

  return payload;
}

function mapSourceBridgeManga(provider, mangaPayload) {
  const manga = mangaPayload && typeof mangaPayload === "object" ? mangaPayload : {};
  const id = manga.id ? String(manga.id).trim() : "";
  const sourceUrl = provider === "weebdex"
    ? (id ? `https://weebdex.org/title/${id}` : "")
    : (id ? `https://mangadex.org/title/${id}` : "");

  return {
    id,
    title: manga.title ? String(manga.title) : "",
    description: manga.description ? String(manga.description) : "",
    coverUrl: manga.coverUrl ? String(manga.coverUrl) : "",
    sourceUrl
  };
}

function mapSourceBridgeRelease(item) {
  const chapter = item && typeof item === "object" ? item : {};
  const chapterRaw = chapter.chapterNumber == null ? "" : String(chapter.chapterNumber).trim();
  const chapterNumber = parseChapterNumber(chapterRaw);
  const groups = (Array.isArray(chapter.groups) ? chapter.groups : [])
    .map((group) => ({
      id: group && group.id ? String(group.id) : "",
      name: group && group.name ? String(group.name).trim() : ""
    }))
    .filter((group) => group.id || group.name);

  const fallbackGroupLabel = groups.length
    ? groups.map((group) => group.name || group.id).join(", ")
    : "Không rõ nhóm";

  return {
    id: chapter.chapterId ? String(chapter.chapterId) : "",
    chapterRaw,
    chapterNumber,
    chapterNumberText: chapterRaw || formatChapterNumber(chapterNumber),
    volume: chapter.volume == null ? "" : String(chapter.volume),
    title: chapter.chapterTitle ? String(chapter.chapterTitle).trim() : "",
    translatedLanguage: chapter.translatedLanguage ? String(chapter.translatedLanguage).toLowerCase() : "",
    publishAt: chapter.publishAt ? String(chapter.publishAt) : "",
    pages: Number(chapter.pages) > 0 ? Number(chapter.pages) : 0,
    externalUrl: "",
    isUnavailable: false,
    groups,
    groupLabel: chapter.groupLabel ? String(chapter.groupLabel) : fallbackGroupLabel
  };
}

async function resolveSourceMangaViaBridge(provider, mangaId, languages) {
  const normalizedLanguages = normalizeStringList(languages);
  const baseQuery = [
    ["order", "desc"]
  ];

  if (normalizedLanguages.length) {
    baseQuery.push(["translatedLanguage", normalizedLanguages.join(",")]);
  }

  const primaryPayload = await requestSourceBridgeJson(`/web/${encodeURIComponent(provider)}/manga/${encodeURIComponent(mangaId)}`, baseQuery);

  let releases = (Array.isArray(primaryPayload && primaryPayload.chapters) ? primaryPayload.chapters : [])
    .map((item) => mapSourceBridgeRelease(item))
    .filter((release) => release && release.id);

  let languageFallbackUsed = false;
  if (!releases.length && normalizedLanguages.length) {
    const fallbackPayload = await requestSourceBridgeJson(
      `/web/${encodeURIComponent(provider)}/manga/${encodeURIComponent(mangaId)}`,
      [["order", "desc"], ["allLanguages", "1"]]
    );

    releases = (Array.isArray(fallbackPayload && fallbackPayload.chapters) ? fallbackPayload.chapters : [])
      .map((item) => mapSourceBridgeRelease(item))
      .filter((release) => release && release.id);

    languageFallbackUsed = releases.length > 0;
  }

  return {
    provider,
    manga: mapSourceBridgeManga(provider, primaryPayload && primaryPayload.manga),
    chapters: buildChapterEntries(releases),
    requestedLanguages: normalizedLanguages,
    languageFallbackUsed
  };
}

async function resolveMangaDexChapterViaBridge(chapterId) {
  const bridgePayload = await requestSourceBridgeJson(
    `/web/mangadex/chapter/${encodeURIComponent(chapterId)}`,
    [["includeDataSaver", "1"], ["preferDataSaver", "0"], ["info", "true"]]
  );

  const safeChapterId = bridgePayload && bridgePayload.chapterId
    ? String(bridgePayload.chapterId).trim()
    : String(chapterId || "").trim();
  const imageCount = Number(bridgePayload && bridgePayload.imageCount);
  const info = bridgePayload && bridgePayload.info && typeof bridgePayload.info === "object"
    ? bridgePayload.info
    : {};

  const chapterRaw = info && info.chapterNumber != null ? String(info.chapterNumber).trim() : "";
  const chapterNumber = parseChapterNumber(chapterRaw);
  const chapterTitle = info && info.chapterTitle ? String(info.chapterTitle).trim() : "";
  const volume = info && info.volume != null ? String(info.volume) : "";
  const translatedLanguage = info && info.translatedLanguage ? String(info.translatedLanguage).toLowerCase() : "";
  const publishAt = info && info.publishAt ? String(info.publishAt) : "";
  const groups = (Array.isArray(info && info.groups) ? info.groups : [])
    .map((group) => ({
      id: group && group.id ? String(group.id) : "",
      name: group && group.name ? String(group.name).trim() : ""
    }))
    .filter((group) => group.id || group.name);
  const groupLabel = info && info.groupLabel
    ? String(info.groupLabel)
    : (groups.length
        ? groups.map((group) => group.name || group.id).join(", ")
        : "Không rõ nhóm");

  const release = {
    id: safeChapterId,
    chapterRaw,
    chapterNumber,
    chapterNumberText: chapterRaw || formatChapterNumber(chapterNumber),
    volume,
    title: chapterTitle,
    translatedLanguage,
    publishAt,
    pages: Number.isFinite(imageCount) && imageCount > 0 ? imageCount : 0,
    externalUrl: safeChapterId ? `https://mangadex.org/chapter/${safeChapterId}` : "",
    isUnavailable: false,
    groups,
    groupLabel
  };

  const chapters = buildChapterEntries([release]).map((entry) => ({
    ...entry,
    requiresManualChapterNumber: !Number.isFinite(chapterNumber)
  }));

  return {
    provider: "mangadex",
    manga: {
      id: "",
      title: "MangaDex (chapter link)",
      description: "",
      coverUrl: "",
      sourceUrl: release.externalUrl
    },
    chapters,
    requestedLanguages: [],
    languageFallbackUsed: false,
    fromChapterInput: true,
    resolvedVia: "bridge"
  };
}

async function resolveMangaDexChapterViaApi(chapterId) {
  const response = await requestJson(
    buildMangaDexApiUrl(`/chapter/${encodeURIComponent(chapterId)}`, [
      ["includes[]", "scanlation_group"],
      ["includes[]", "manga"]
    ]),
    {
      timeoutMs: 30000,
      retries: 2,
      retryDelayMs: 450,
      headers: buildMangaDexHeaders()
    }
  );

  const payload = response && response.data && typeof response.data === "object"
    ? response.data
    : {};
  const chapterEntity = payload && payload.data && typeof payload.data === "object"
    ? payload.data
    : null;

  if (!chapterEntity || !chapterEntity.id) {
    const err = new Error("Không tìm thấy chapter MangaDex.");
    err.statusCode = 404;
    throw err;
  }

  const release = mapMangaDexRelease(chapterEntity);
  if (!release.id) {
    release.id = chapterId;
  }

  const relationships = Array.isArray(chapterEntity.relationships) ? chapterEntity.relationships : [];
  const mangaRelation = relationships.find((relation) => relation && relation.type === "manga");
  const mangaAttributes = mangaRelation && mangaRelation.attributes && typeof mangaRelation.attributes === "object"
    ? mangaRelation.attributes
    : {};

  const chapters = buildChapterEntries([release]);
  if (!chapters.length) {
    const err = new Error("Không thể dựng dữ liệu chapter MangaDex.");
    err.statusCode = 502;
    throw err;
  }

  return {
    provider: "mangadex",
    manga: mapSourceBridgeManga("mangadex", {
      id: mangaRelation && mangaRelation.id ? String(mangaRelation.id).trim() : "",
      title: pickLocalizedText(mangaAttributes.title),
      description: pickLocalizedText(mangaAttributes.description),
      coverUrl: ""
    }),
    chapters,
    requestedLanguages: [],
    languageFallbackUsed: false,
    fromChapterInput: true
  };
}

async function resolveWeebDexChapterViaApi(chapterId) {
  const response = await requestJson(
    buildWeebDexApiUrl(`/chapter/${encodeURIComponent(chapterId)}`),
    {
      timeoutMs: 30000,
      retries: 2,
      retryDelayMs: 450,
      headers: {
        Origin: WEEBDEX_ORIGIN,
        Referer: WEEBDEX_REFERER,
        "User-Agent": "moetruyen-desktop/1.0"
      }
    }
  );

  const detailData = response ? response.data : null;
  const chapterPayload = detailData && typeof detailData === "object" && !Array.isArray(detailData)
    ? detailData
    : null;

  if (!chapterPayload) {
    const err = new Error("Không tìm thấy chapter WeebDex.");
    err.statusCode = 404;
    throw err;
  }

  const release = mapWeebDexRelease(chapterPayload);
  if (!release.id) {
    release.id = chapterId;
  }

  const relationships = chapterPayload && chapterPayload.relationships && typeof chapterPayload.relationships === "object"
    ? chapterPayload.relationships
    : {};
  const mangaRelation = relationships && relationships.manga && typeof relationships.manga === "object"
    ? relationships.manga
    : {};

  const chapters = buildChapterEntries([release]);
  if (!chapters.length) {
    const err = new Error("Không thể dựng dữ liệu chapter WeebDex.");
    err.statusCode = 502;
    throw err;
  }

  return {
    provider: "weebdex",
    manga: mapSourceBridgeManga("weebdex", {
      id: mangaRelation.id ? String(mangaRelation.id).trim() : "",
      title: mangaRelation.title ? String(mangaRelation.title).trim() : "",
      description: mangaRelation.description ? String(mangaRelation.description).trim() : "",
      coverUrl: ""
    }),
    chapters,
    requestedLanguages: [],
    languageFallbackUsed: false,
    fromChapterInput: true
  };
}

async function resolveSourceChapter(provider, chapterId) {
  if (provider === "mangadex") {
    let bridgeResolved = null;
    let bridgeError = null;

    try {
      bridgeResolved = await resolveMangaDexChapterViaBridge(chapterId);
    } catch (err) {
      bridgeError = err;
    }

    try {
      const apiResolved = await resolveMangaDexChapterViaApi(chapterId);
      return {
        ...apiResolved,
        fromChapterInput: true,
        resolvedVia: bridgeResolved ? "bridge+api" : "api"
      };
    } catch (apiErr) {
      if (bridgeResolved) {
        return bridgeResolved;
      }
      throw bridgeError || apiErr;
    }
  }
  if (provider === "weebdex") {
    return resolveWeebDexChapterViaApi(chapterId);
  }
  const err = new Error("Nguồn truyện không hợp lệ khi xử lý chapter.");
  err.statusCode = 400;
  throw err;
}

async function fetchMangaDexChapters(mangaInput, translatedLanguages) {
  const chapters = [];
  const langs = normalizeStringList(translatedLanguages);
  const requestPageSize = MANGADEX_FEED_PAGE_SIZE;
  let offset = 0;
  let manga = null;

  if (mangaInput && typeof mangaInput === "object" && mangaInput.id && typeof mangaInput.getFeed === "function") {
    manga = mangaInput;
  } else {
    const mangaId = String(mangaInput == null ? "" : mangaInput).trim();
    manga = await runWithMangaDexLibrary(() => MangaDexManga.get(mangaId));
  }

  while (true) {
    const query = {
      limit: requestPageSize,
      offset,
      order: {
        volume: "desc",
        chapter: "desc"
      },
      includes: ["scanlation_group", "user"],
      includeUnavailable: "0",
      includeExternalUrl: 0,
      contentRating: ["safe", "suggestive", "erotica", "pornographic"]
    };

    if (langs.length) {
      query.translatedLanguage = langs;
    }

    const list = await runWithMangaDexLibrary(() => manga.getFeed(query));
    if (!list.length) break;

    list.forEach((item) => {
      chapters.push(mapMangaDexRelease(item));
    });

    offset += list.length;
    if (list.length < requestPageSize) break;
  }

  return chapters;
}

async function fetchWeebDexChapters(mangaId, translatedLanguages) {
  const chapters = [];
  const langs = normalizeStringList(translatedLanguages);
  let page = 1;
  let total = null;
  let lastLimit = WEEBDEX_CHAPTER_PAGE_SIZE;

  while (true) {
    const query = [
      ["limit", WEEBDEX_CHAPTER_PAGE_SIZE],
      ["page", page],
      ["order", "desc"],
      ["sort", "name"]
    ];
    if (langs.length) {
      query.push(["tlang", langs.join(",")]);
    }

    const response = await requestJson(
      buildWeebDexApiUrl(`/manga/${encodeURIComponent(mangaId)}/chapters`, query),
      {
        timeoutMs: 30000,
        retries: 2,
        retryDelayMs: 450,
        headers: {
          Origin: WEEBDEX_ORIGIN,
          Referer: WEEBDEX_REFERER,
          "User-Agent": "moetruyen-desktop/1.0"
        }
      }
    );

    const payload = response && response.data && typeof response.data === "object" ? response.data : {};
    const list = Array.isArray(payload.data) ? payload.data : [];
    const payloadTotal = Number(payload.total);
    if (Number.isFinite(payloadTotal) && payloadTotal >= 0) {
      total = payloadTotal;
    }
    const parsedLimit = Number(payload.limit);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      lastLimit = clampInt(parsedLimit, WEEBDEX_CHAPTER_PAGE_SIZE, 1, 100);
    }
    if (!list.length) break;

    list.forEach((item) => {
      chapters.push(mapWeebDexRelease(item));
    });

    if (Number.isFinite(total) && total != null && chapters.length >= total) break;
    if (list.length < lastLimit) break;
    page += 1;
  }

  return chapters;
}

async function getMangaDexChapterImages(chapterId) {
  return runWithMangaDexLibrary(async () => {
    const chapter = await MangaDexChapter.get(chapterId);
    const imageUrls = await chapter.getReadablePages(false);
    const imageUrlsDataSaver = await chapter.getReadablePages(true);

    return {
      imageUrls: (Array.isArray(imageUrls) ? imageUrls : []).map((url) => String(url).trim()).filter(Boolean),
      imageUrlsDataSaver: (Array.isArray(imageUrlsDataSaver) ? imageUrlsDataSaver : [])
        .map((url) => String(url).trim())
        .filter(Boolean)
    };
  });
}

function normalizeWeebDexPageItems(pages) {
  return (Array.isArray(pages) ? pages : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const name = item.name ? String(item.name).trim() : "";
      if (!name) return null;
      return {
        name,
        dimensions: Array.isArray(item.dimensions)
          ? item.dimensions.map((value) => Number(value) || 0)
          : []
      };
    })
    .filter(Boolean);
}

async function getWeebDexChapterImages(chapterId) {
  const detailResponse = await requestJson(
    buildWeebDexApiUrl(`/chapter/${encodeURIComponent(chapterId)}`),
    {
      timeoutMs: 30000,
      retries: 2,
      retryDelayMs: 450,
      headers: {
        Origin: WEEBDEX_ORIGIN,
        Referer: WEEBDEX_REFERER,
        "User-Agent": "moetruyen-desktop/1.0"
      }
    }
  );

  const detailData = detailResponse ? detailResponse.data : null;
  let node = WEEBDEX_NODE_FALLBACK;
  let pages = [];
  let pagesOptimized = [];

  if (Array.isArray(detailData)) {
    pages = normalizeWeebDexPageItems(detailData);
  } else {
    const detailPayload = detailData && typeof detailData === "object" ? detailData : {};
    node = detailPayload.node ? String(detailPayload.node).trim().replace(/\/+$/, "") : WEEBDEX_NODE_FALLBACK;
    pages = normalizeWeebDexPageItems(detailPayload.data);
    pagesOptimized = normalizeWeebDexPageItems(detailPayload.data_optimized);
  }

  const buildUrls = (items) => {
    const base = String(node || "").trim().replace(/\/+$/, "") || WEEBDEX_NODE_FALLBACK;
    return items.map((page) => `${base}/data/${encodeURIComponent(String(chapterId))}/${encodeURIComponent(page.name)}`);
  };

  return {
    imageUrls: buildUrls(pages),
    imageUrlsOptimized: buildUrls(pagesOptimized)
  };
}

function guessFileExtension(url, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("image/webp")) return ".webp";
  if (ct.includes("image/png")) return ".png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return ".jpg";
  if (ct.includes("image/avif")) return ".avif";
  if (ct.includes("image/gif")) return ".gif";

  try {
    const pathname = new URL(url).pathname || "";
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length <= 6) return ext;
  } catch (_err) {
    // ignore
  }
  return ".jpg";
}

function sanitizeFilenamePart(value) {
  return String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "chapter";
}

async function resolveSourceManga(input = {}) {
  const provider = String(input.provider || "").trim().toLowerCase();
  const sourceInput = String(input.input || "").trim();
  const languages = normalizeStringList(input.translatedLanguages).length
    ? normalizeStringList(input.translatedLanguages)
    : DEFAULT_LANGUAGES;

  if (!provider || !["mangadex", "weebdex"].includes(provider)) {
    const err = new Error("Nguồn truyện không hợp lệ. Chỉ hỗ trợ MangaDex hoặc WeebDex.");
    err.statusCode = 400;
    throw err;
  }

  if (!sourceInput) {
    const err = new Error("Vui lòng paste link hoặc id truyện/chapter.");
    err.statusCode = 400;
    throw err;
  }

  const chapterIdFromLink = provider === "mangadex"
    ? extractMangaDexChapterId(sourceInput, false)
    : extractWeebDexChapterId(sourceInput, false);

  if (chapterIdFromLink) {
    try {
      return await resolveSourceChapter(provider, chapterIdFromLink);
    } catch (err) {
      const wrapped = createSourceResolveError({
        provider,
        targetId: chapterIdFromLink,
        sourceInput,
        languages,
        stage: "resolve-source-chapter-input",
        err
      });
      logSourceError(`resolveSourceManga:${provider}:chapter`, wrapped);
      throw wrapped;
    }
  }

  const mangaId = provider === "mangadex"
    ? extractMangaDexId(sourceInput)
    : extractWeebDexId(sourceInput);

  try {
    return await resolveSourceMangaViaBridge(provider, mangaId, languages);
  } catch (err) {
    const sourceHasChapterMarker = /(?:^|\/)chapters?(?:\/|$)/i.test(sourceInput);
    const fallbackChapterId = provider === "mangadex"
      ? extractMangaDexChapterId(sourceInput, true)
      : extractWeebDexChapterId(sourceInput, true);
    const shouldTryChapterFallback = !!fallbackChapterId
      && (sourceHasChapterMarker || isLikelyRawSourceId(sourceInput));

    if (shouldTryChapterFallback) {
      try {
        return await resolveSourceChapter(provider, fallbackChapterId);
      } catch (chapterErr) {
        const wrapped = createSourceResolveError({
          provider,
          targetId: fallbackChapterId,
          sourceInput,
          languages,
          stage: "resolve-source-chapter-fallback",
          err: chapterErr
        });
        logSourceError(`resolveSourceManga:${provider}:chapter-fallback`, wrapped);
        throw wrapped;
      }
    }

    const wrapped = createSourceResolveError({
      provider,
      targetId: mangaId,
      sourceInput,
      languages,
      stage: "resolve-source-manga-via-bridge",
      err
    });
    logSourceError(`resolveSourceManga:${provider}:bridge`, wrapped);
    throw wrapped;
  }
}

async function downloadSourceChapter(payload = {}) {
  const provider = String(payload.provider || "").trim().toLowerCase();
  const chapterId = String(payload.chapterId || "").trim();
  const preferDataSaver = Boolean(payload.preferDataSaver);
  const chapterNumberText = String(payload.chapterNumberText || "").trim();
  const chapterTitle = String(payload.chapterTitle || "").trim();

  if (!provider || !["mangadex", "weebdex"].includes(provider)) {
    const err = new Error("Nguồn truyện không hợp lệ khi tải chapter.");
    err.statusCode = 400;
    throw err;
  }
  if (!chapterId) {
    const err = new Error("Thiếu chapter id để tải ảnh.");
    err.statusCode = 400;
    throw err;
  }

  let imageUrls = [];
  let imageUrlsOriginal = [];
  let imageUrlsRuntime = [];
  let imageUrlsDataSaver = [];
  let imageDownloadTargets = [];
  try {
    const bridgeQuery = provider === "mangadex"
      ? [["includeDataSaver", "1"], ["preferDataSaver", "0"]]
      : [["preferOptimizedImages", "0"]];

    const bridgePayload = await requestSourceBridgeJson(
      `/web/${encodeURIComponent(provider)}/chapter/${encodeURIComponent(chapterId)}`,
      bridgeQuery
    );

    if (provider === "mangadex") {
      const original = Array.isArray(bridgePayload && bridgePayload.imageUrlsOriginal)
        ? bridgePayload.imageUrlsOriginal
        : [];
      const runtime = Array.isArray(bridgePayload && bridgePayload.imageUrlsRuntime)
        ? bridgePayload.imageUrlsRuntime
        : (Array.isArray(bridgePayload && bridgePayload.imageUrls)
            ? bridgePayload.imageUrls
            : []);
      const dataSaver = Array.isArray(bridgePayload && bridgePayload.imageUrlsDataSaver)
        ? bridgePayload.imageUrlsDataSaver
        : [];

      imageUrlsOriginal = original.map((item) => String(item).trim()).filter(Boolean);
      imageUrlsRuntime = runtime.map((item) => String(item).trim()).filter(Boolean);
      imageUrlsDataSaver = dataSaver.map((item) => String(item).trim()).filter(Boolean);

      imageUrls = imageUrlsOriginal.slice();
      if (!imageUrls.length) {
        imageUrls = imageUrlsRuntime.slice();
      }
      if (!imageUrls.length && MANGADEX_ALLOW_DATASAVER_FALLBACK) {
        imageUrls = imageUrlsDataSaver.slice();
      }

      const maxTargets = Math.max(
        imageUrls.length,
        imageUrlsRuntime.length,
        MANGADEX_ALLOW_DATASAVER_FALLBACK ? imageUrlsDataSaver.length : 0
      );
      for (let index = 0; index < maxTargets; index += 1) {
        const candidates = [];
        const primaryUrl = imageUrls[index] ? String(imageUrls[index]).trim() : "";
        const runtimeUrl = imageUrlsRuntime[index] ? String(imageUrlsRuntime[index]).trim() : "";
        const dataSaverUrl = imageUrlsDataSaver[index] ? String(imageUrlsDataSaver[index]).trim() : "";
        if (primaryUrl) {
          candidates.push(primaryUrl);
        }
        if (runtimeUrl && !candidates.includes(runtimeUrl)) {
          candidates.push(runtimeUrl);
        }
        if (MANGADEX_ALLOW_DATASAVER_FALLBACK && dataSaverUrl && !candidates.includes(dataSaverUrl)) {
          candidates.push(dataSaverUrl);
        }
        if (candidates.length) {
          imageDownloadTargets.push(candidates);
        }
      }
    }

    if (provider === "weebdex") {
      const original = Array.isArray(bridgePayload && bridgePayload.imageUrlsOriginal)
        ? bridgePayload.imageUrlsOriginal
        : [];
      const optimized = Array.isArray(bridgePayload && bridgePayload.imageUrlsOptimized)
        ? bridgePayload.imageUrlsOptimized
        : [];

      imageUrlsOriginal = original.map((item) => String(item).trim()).filter(Boolean);
      const imageUrlsOptimized = optimized.map((item) => String(item).trim()).filter(Boolean);

      imageUrls = imageUrlsOriginal.slice();
      if (!imageUrls.length) {
        imageUrls = imageUrlsOptimized.slice();
      }

      const maxTargets = Math.max(imageUrlsOriginal.length, imageUrlsOptimized.length, imageUrls.length);
      for (let index = 0; index < maxTargets; index += 1) {
        const candidates = [];
        const originalUrl = imageUrlsOriginal[index] ? String(imageUrlsOriginal[index]).trim() : "";
        const optimizedUrl = imageUrlsOptimized[index] ? String(imageUrlsOptimized[index]).trim() : "";
        if (originalUrl) {
          candidates.push(originalUrl);
        }
        if (optimizedUrl && !candidates.includes(optimizedUrl)) {
          candidates.push(optimizedUrl);
        }
        if (candidates.length) {
          imageDownloadTargets.push(candidates);
        }
      }
    }

    if (!imageDownloadTargets.length) {
      imageDownloadTargets = imageUrls.map((item) => [String(item)]);
    }
  } catch (err) {
    const debugErr = attachDebugInfo(err, {
      provider,
      stage: "download-source-chapter-via-bridge",
      request: {
        sourceBridgeBaseUrl: SOURCE_BRIDGE_BASE_URL,
        chapterId,
        preferDataSaver
      },
      cause: serializeErrorDetails(err),
      nestedDebugInfo: err && err.debugInfo ? err.debugInfo : null,
      providerPayload: err && err.payload ? err.payload : null,
      providerUrl: err && err.url ? String(err.url) : ""
    });
    logSourceError(`downloadSourceChapter:${provider}:bridge`, debugErr);
    throw debugErr;
  }

  if (!Array.isArray(imageUrls) || !imageUrls.length || !Array.isArray(imageDownloadTargets) || !imageDownloadTargets.length) {
    const err = new Error("Không tìm thấy ảnh cho chapter đã chọn.");
    err.statusCode = 404;
    throw err;
  }

  const folderToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chapterPart = sanitizeFilenamePart(chapterNumberText || chapterId);
  const titlePart = sanitizeFilenamePart(chapterTitle || "chapter");
  const tempDir = path.join(os.tmpdir(), "moetruyen-source-cache", provider, `${chapterPart}-${titlePart}-${folderToken}`);
  await fsp.mkdir(tempDir, { recursive: true });

  const imagePaths = new Array(imageDownloadTargets.length);
  const imageRequestTimeoutMs = provider === "mangadex" ? 25000 : 45000;
  const imageRequestRetries = provider === "mangadex" ? 0 : 2;
  const normalizedOriginalSet = new Set();
  const normalizedRuntimeSet = new Set();
  const normalizedDataSaverSet = new Set();

  if (provider === "mangadex") {
    imageUrlsOriginal.forEach((urlValue) => {
      normalizedOriginalSet.add(String(urlValue).trim());
    });
    imageUrlsRuntime.forEach((urlValue) => {
      normalizedRuntimeSet.add(String(urlValue).trim());
    });
    imageUrlsDataSaver.forEach((urlValue) => {
      normalizedDataSaverSet.add(String(urlValue).trim());
    });
  }

  let originalUsedCount = 0;
  let runtimeUsedCount = 0;
  let dataSaverUsedCount = 0;
  try {
    await mapWithConcurrency(imageDownloadTargets, 4, async (targetUrls, index) => {
      const candidates = (Array.isArray(targetUrls) ? targetUrls : [targetUrls])
        .map((item) => String(item == null ? "" : item).trim())
        .filter(Boolean);

      let selectedUrl = "";
      let selectedDownload = null;
      let candidateError = null;

      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidateUrl = candidates[candidateIndex];
        try {
          const download = await requestBuffer(candidateUrl, {
            timeoutMs: imageRequestTimeoutMs,
            retries: imageRequestRetries,
            retryDelayMs: 500,
            headers: provider === "weebdex"
              ? {
                  Origin: WEEBDEX_ORIGIN,
                  Referer: WEEBDEX_REFERER,
                  "User-Agent": "moetruyen-desktop/1.0"
                }
              : buildMangaDexHeaders()
          });
          selectedUrl = candidateUrl;
          selectedDownload = download;
          candidateError = null;

          if (provider === "mangadex") {
            if (normalizedDataSaverSet.has(selectedUrl)) {
              dataSaverUsedCount += 1;
            } else if (normalizedOriginalSet.has(selectedUrl)) {
              originalUsedCount += 1;
            } else if (normalizedRuntimeSet.has(selectedUrl)) {
              runtimeUsedCount += 1;
            }
          }

          break;
        } catch (err) {
          candidateError = err;
        }
      }

      if (!selectedDownload || !selectedUrl) {
        const finalCandidateError = attachDebugInfo(
          normalizeError(candidateError, "Failed to download image from all source candidates", 502),
          {
            stage: "download-source-candidate-exhausted",
            request: {
              provider,
              chapterId,
              pageIndex: index + 1,
              candidates,
              timeoutMs: imageRequestTimeoutMs,
              retries: imageRequestRetries
            }
          }
        );
        throw finalCandidateError;
      }

      const ext = guessFileExtension(selectedUrl, selectedDownload.contentType);
      const filename = `${String(index + 1).padStart(3, "0")}${ext}`;
      const targetPath = path.join(tempDir, filename);
      await fsp.writeFile(targetPath, selectedDownload.buffer);
      imagePaths[index] = targetPath;
    });
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => null);
    throw err;
  }

  return {
    provider,
    chapterId,
    imageCount: imagePaths.length,
    tempDir,
    imagePaths,
    imageSourceStats: provider === "mangadex"
      ? {
          originalUsedCount,
          runtimeUsedCount,
          dataSaverUsedCount,
          dataSaverFallbackEnabled: MANGADEX_ALLOW_DATASAVER_FALLBACK
        }
      : null
  };
}

module.exports = {
  resolveSourceManga,
  downloadSourceChapter,
  parseChapterNumber,
  formatChapterNumber
};
