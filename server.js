const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const compression = require("compression");
const CleanCSS = require("clean-css");
const { minify: minifyJs } = require("terser");
const { Pool, types } = require("pg");
const session = require("express-session");
const multer = require("multer");
const sharp = require("sharp");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  CopyObjectCommand
} = require("@aws-sdk/client-s3");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const appEnv = (process.env.APP_ENV || process.env.NODE_ENV || "development")
  .toString()
  .trim()
  .toLowerCase();
const isProductionApp = appEnv === "production" || appEnv === "prod";
const serverAssetVersion = Date.now();
const cssMinifier = new CleanCSS({ level: 1 });

const parseEnvBoolean = (value, defaultValue = false) => {
  if (value == null) return Boolean(defaultValue);
  const raw = String(value).trim().toLowerCase();
  if (!raw) return Boolean(defaultValue);
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return Boolean(defaultValue);
};

const isTruthyInput = (value) => {
  const raw = (value == null ? "" : String(value)).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const safeCompareText = (leftValue, rightValue) => {
  const left = Buffer.from((leftValue == null ? "" : String(leftValue)).trim());
  const right = Buffer.from((rightValue == null ? "" : String(rightValue)).trim());
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

const SEO_SITE_NAME = "BFANG Team";
const SEO_DEFAULT_DESCRIPTION = "BFANG Team - nhóm dịch truyện tranh";
const SEO_ROBOTS_INDEX = "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";
const SEO_ROBOTS_NOINDEX =
  "noindex,nofollow,noarchive,nosnippet,noimageindex,max-snippet:0,max-image-preview:none,max-video-preview:0";

const normalizeSiteOriginFromEnv = (value) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    return "";
  }
};

const appDomainFromEnv = (process.env.APP_DOMAIN || "").toString().trim();
const appDomainOrigin = normalizeSiteOriginFromEnv(
  appDomainFromEnv
    ? /^https?:\/\//i.test(appDomainFromEnv)
      ? appDomainFromEnv
      : `${isProductionApp ? "https" : "http"}://${appDomainFromEnv}`
    : ""
);

const configuredPublicOrigin = normalizeSiteOriginFromEnv(
  process.env.SITE_URL || process.env.PUBLIC_SITE_URL || appDomainOrigin
);
const localDevOrigin = `http://localhost:${PORT}`;

const normalizeSeoText = (value, maxLength) => {
  const cleaned = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const safeMax = Number.isFinite(Number(maxLength)) ? Math.max(16, Math.floor(Number(maxLength))) : 0;
  if (!safeMax || cleaned.length <= safeMax) return cleaned;
  return `${cleaned.slice(0, safeMax - 1).trim()}...`;
};

const getPublicOriginFromRequest = (req) => {
  if (configuredPublicOrigin) return configuredPublicOrigin;
  if (!req) return isProductionApp ? "" : localDevOrigin;

  const forwardedHost = (req.get("x-forwarded-host") || "").toString().split(",")[0].trim();
  const host = forwardedHost || (req.get("host") || "").toString().split(",")[0].trim();
  if (!host) return "";

  const forwardedProto = (req.get("x-forwarded-proto") || "").toString().split(",")[0].trim();
  const protocol = (forwardedProto || req.protocol || "http").toLowerCase() === "https" ? "https" : "http";
  return `${protocol}://${host}`;
};

const ensureLeadingSlash = (value) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
};

const toAbsolutePublicUrl = (req, value) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;

  const withSlash = ensureLeadingSlash(raw);
  const origin = getPublicOriginFromRequest(req);
  return origin ? `${origin}${withSlash}` : withSlash;
};

const escapeXml = (value) =>
  (value == null ? "" : String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");

const toIsoDate = (value) => {
  if (value == null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value > 1e12 ? value : value * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
};

const buildSeoPayload = (req, options = {}) => {
  const pathValue = ensureLeadingSlash(options.canonicalPath || req.path || "/");
  const canonical = toAbsolutePublicUrl(req, options.canonical || pathValue);
  const title = normalizeSeoText(options.title || "", 140);
  const description = normalizeSeoText(options.description || SEO_DEFAULT_DESCRIPTION, 190);
  const robots = normalizeSeoText(options.robots || SEO_ROBOTS_INDEX, 220) || SEO_ROBOTS_INDEX;
  const ogType = normalizeSeoText(options.ogType || "website", 30) || "website";
  const image = toAbsolutePublicUrl(req, options.image || "");
  const twitterCard = image ? "summary_large_image" : "summary";
  const jsonLdList = Array.isArray(options.jsonLd)
    ? options.jsonLd.filter((item) => item && typeof item === "object")
    : [];

  return {
    siteName: SEO_SITE_NAME,
    title,
    description,
    canonical,
    robots,
    ogType,
    image,
    twitterCard,
    jsonLd: jsonLdList
  };
};

const trustProxy = parseEnvBoolean(process.env.TRUST_PROXY, false);
if (trustProxy) {
  app.set("trust proxy", 1);
}
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), gyroscope=(), magnetometer=()"
  );
  res.set("Cross-Origin-Opener-Policy", "same-origin");
  next();
});
const uploadDir = path.join(__dirname, "uploads");
const coversDir = path.join(uploadDir, "covers");
const coversTmpDir = path.join(coversDir, "tmp");
const avatarsDir = path.join(uploadDir, "avatars");
const publicDir = path.join(__dirname, "public");
const stickersDir = path.join(publicDir, "stickers");

const DATABASE_URL = (process.env.DATABASE_URL || "").toString().trim();
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL chưa được cấu hình trong .env");
}

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

if (!fs.existsSync(coversDir)) {
  fs.mkdirSync(coversDir, { recursive: true });
}

if (!fs.existsSync(coversTmpDir)) {
  fs.mkdirSync(coversTmpDir, { recursive: true });
}

if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

// pg: by default it returns int8/numeric as strings. We parse them into numbers for
// compatibility with the existing SQLite-based code.
types.setTypeParser(20, (value) => (value == null ? null : Number.parseInt(value, 10))); // int8
types.setTypeParser(1700, (value) => (value == null ? null : Number.parseFloat(value))); // numeric

const pgPool = new Pool({
  connectionString: DATABASE_URL
});

const toPgQuery = (sql, params) => {
  const text = (sql || "").toString();
  if (!Array.isArray(params) || params.length === 0) {
    return { text, values: [] };
  }

  let index = 0;
  const converted = text.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text: converted, values: params };
};

const maybeAddReturningId = (sql) => {
  const text = (sql || "").toString();
  const trimmed = text.trim();
  const compact = trimmed.replace(/\s+/g, " ");
  if (!/^insert\s+into\s+(manga|chapters|genres|comments)\b/i.test(compact)) {
    return { sql: text, wantsId: false };
  }
  if (/\breturning\b/i.test(compact)) {
    return { sql: text, wantsId: true };
  }
  const withoutSemi = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  return { sql: `${withoutSemi} RETURNING id`, wantsId: true };
};

const dbQuery = async (sql, params = [], client = null) => {
  const payload = toPgQuery(sql, params);
  const executor = client || pgPool;
  return executor.query(payload.text, payload.values);
};

const dbRun = async (sql, params = [], client = null) => {
  const { sql: finalSql, wantsId } = maybeAddReturningId(sql);
  const result = await dbQuery(finalSql, params, client);
  const changes = typeof result.rowCount === "number" ? result.rowCount : 0;
  const lastID = wantsId && result.rows && result.rows[0] ? result.rows[0].id : undefined;
  return { changes, lastID, rows: result.rows || [] };
};

const dbGet = async (sql, params = [], client = null) => {
  const rows = await dbAll(sql, params, client);
  return rows && rows.length ? rows[0] : null;
};

const dbAll = async (sql, params = [], client = null) => {
  const result = await dbQuery(sql, params, client);
  return result.rows || [];
};

const withTransaction = async (fn) => {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const api = {
      dbRun: (sql, params) => dbRun(sql, params, client),
      dbGet: (sql, params) => dbGet(sql, params, client),
      dbAll: (sql, params) => dbAll(sql, params, client)
    };
    const result = await fn(api);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackErr) {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
};

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Chỉ hỗ trợ ảnh JPG (.jpg), PNG (.png), WebP (.webp)."));
    }
    return cb(null, true);
  }
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Chỉ hỗ trợ ảnh JPG (.jpg), PNG (.png), WebP (.webp)."));
    }
    return cb(null, true);
  }
});

const chapterPagesUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 220
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Chỉ hỗ trợ ảnh JPG (.jpg), PNG (.png), WebP (.webp)."));
    }
    return cb(null, true);
  }
});

const uploadCover = (req, res, next) => {
  coverUpload.single("cover")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).send("Ảnh bìa tối đa 5MB.");
      }
      return res.status(400).send("Upload ảnh bìa thất bại.");
    }
    return res.status(400).send(err.message || "Upload ảnh bìa thất bại.");
  });
};

const uploadAvatar = (req, res, next) => {
  avatarUpload.single("avatar")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(400)
          .json({ ok: false, error: "Avatar tối đa 2MB." });
      }
      return res.status(400).json({ ok: false, error: "Upload avatar thất bại." });
    }
    return res
      .status(400)
      .json({ ok: false, error: err.message || "Upload avatar thất bại." });
  });
};

const uploadChapterPages = (req, res, next) => {
  chapterPagesUpload.array("pages", 220)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).send("Ảnh trang tối đa 12MB mỗi file.");
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).send("Số lượng ảnh trang quá nhiều.");
      }
      return res.status(400).send("Upload ảnh trang thất bại.");
    }
    return res.status(400).send(err.message || "Upload ảnh trang thất bại.");
  });
};

const uploadChapterPage = (req, res, next) => {
  chapterPagesUpload.single("page")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).send("Ảnh trang tối đa 12MB mỗi file.");
      }
      return res.status(400).send("Upload ảnh trang thất bại.");
    }
    return res.status(400).send(err.message || "Upload ảnh trang thất bại.");
  });
};

const formatDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleDateString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
};

const formatDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
};

const formatTimeAgo = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(Math.floor(diffMs / 1000), 0);

  if (diffSeconds < 60) return "Vừa xong";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} phút trước`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} ngày trước`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} tháng trước`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} năm trước`;
};

const cacheBust = (url, token) => {
  if (!url) return "";
  const separator = url.includes("?") ? "&" : "?";
  const value = token == null || token === "" ? Date.now() : token;
  return `${url}${separator}t=${encodeURIComponent(String(value))}`;
};

const parseChapterNumberInput = (value) => {
  const raw = value == null ? "" : String(value);
  const text = raw.trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, ".");
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return number;
};

const toBooleanFlag = (value) => {
  if (value === true || value === false) return value;
  if (typeof value === "number") return value !== 0;
  const text = (value == null ? "" : String(value)).trim().toLowerCase();
  if (!text) return false;
  return text === "1" || text === "true" || text === "t" || text === "yes" || text === "y" || text === "on";
};

const COMMENT_MAX_LENGTH = 500;
const COMMENT_MENTION_FETCH_LIMIT = 3;
const COMMENT_POST_COOLDOWN_MS = 10 * 1000;
const COMMENT_DUPLICATE_CONTENT_WINDOW_MS = 30 * 1000;
const COMMENT_REQUEST_ID_MAX_LENGTH = 80;
const COMMENT_LINK_LABEL_FETCH_LIMIT = 40;
const COMMENT_BOT_SIGNAL_WINDOW_MS = 2 * 60 * 1000;
const COMMENT_BOT_SIGNAL_THRESHOLD = 3;
const COMMENT_BOT_CHALLENGE_TTL_MS = 15 * 60 * 1000;
const NOTIFICATION_TYPE_MENTION = "mention";
const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_CLEANUP_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const ADMIN_MEMBERS_PER_PAGE = 16;
const FORBIDDEN_WORD_MAX_LENGTH = 80;
const READING_HISTORY_MAX_ITEMS = 10;
const ONESHOT_GENRE_NAME = "Oneshot";

const formatChapterNumberValue = (value) => {
  const chapterNumber = Number(value);
  if (!Number.isFinite(chapterNumber)) return "";

  const normalized = Math.abs(chapterNumber) < 1e-9 ? 0 : chapterNumber;
  if (Math.abs(normalized - Math.round(normalized)) < 1e-9) {
    return String(Math.round(normalized));
  }
  return normalized.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
};

const buildCommentChapterContext = ({ chapterNumber, chapterTitle, chapterIsOneshot }) => {
  const chapterValue = chapterNumber == null ? NaN : Number(chapterNumber);
  if (!Number.isFinite(chapterValue)) {
    return {
      chapterNumber: null,
      chapterNumberText: "",
      chapterTitle: "",
      chapterIsOneshot: false,
      chapterLabel: ""
    };
  }

  const chapterNumberText = formatChapterNumberValue(chapterValue);
  const title = (chapterTitle || "").toString().replace(/\s+/g, " ").trim();
  const isOneshot = toBooleanFlag(chapterIsOneshot);
  const baseLabel = isOneshot ? "Oneshot" : chapterNumberText ? `Chương ${chapterNumberText}` : "Chương";

  return {
    chapterNumber: chapterValue,
    chapterNumberText,
    chapterTitle: title,
    chapterIsOneshot: isOneshot,
    chapterLabel: title ? `${baseLabel} - ${title}` : baseLabel
  };
};

const commentRequestIdPattern = /^[a-z0-9][a-z0-9._:-]{7,79}$/i;

const readCommentRequestId = (req) => {
  const headerValue = (req.get("idempotency-key") || req.get("x-comment-request-id") || "")
    .toString()
    .trim();
  const bodyValue = (req && req.body && req.body.requestId != null ? req.body.requestId : "")
    .toString()
    .trim();
  const candidate = headerValue || bodyValue;
  if (!candidate) return "";
  if (candidate.length > COMMENT_REQUEST_ID_MAX_LENGTH) return "";
  if (!commentRequestIdPattern.test(candidate)) return "";
  return candidate;
};

const sendCommentRequestIdInvalidResponse = (req, res) => {
  const message = "Yêu cầu bình luận không hợp lệ. Vui lòng tải lại trang rồi thử lại.";
  if (wantsJson(req)) {
    return res.status(400).json({
      error: message,
      code: "COMMENT_REQUEST_ID_INVALID"
    });
  }
  return res.status(400).send(message);
};

const isDuplicateCommentRequestError = (error) => {
  if (!error || error.code !== "23505") return false;
  const constraint = (error.constraint || "").toString().trim().toLowerCase();
  if (constraint === "idx_comments_author_request_id") {
    return true;
  }

  const message = (error.message || "").toString().toLowerCase();
  return message.includes("idx_comments_author_request_id") || message.includes("author_user_id, client_request_id");
};

const sendDuplicateCommentRequestResponse = (req, res) => {
  const message = "Yêu cầu này đã được gửi trước đó. Vui lòng không gửi lặp lại.";
  if (wantsJson(req)) {
    return res.status(409).json({
      error: message,
      code: "COMMENT_REQUEST_REPLAYED"
    });
  }
  return res.status(409).send(message);
};

const commentBotSignalStore = new Map();

const isCommentTurnstileEnabled = () =>
  Boolean(turnstileConfig && turnstileConfig.siteKey && turnstileConfig.secretKey);

const parseCommentCreatedAtMs = (value) => {
  if (value == null || value === "") return NaN;
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
};

const calculateRetryAfterSecondsForWindow = ({ lastCreatedAt, nowMs, windowMs }) => {
  const lastCreatedAtMs = parseCommentCreatedAtMs(lastCreatedAt);
  const safeNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const ttlMs = Math.max(1000, Number(windowMs) || 0);
  if (!Number.isFinite(lastCreatedAtMs) || !ttlMs) return 0;

  const retryAfterMs = ttlMs - (safeNowMs - lastCreatedAtMs);
  if (retryAfterMs <= 0) return 0;
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
};

const calculateCommentRetryAfterSeconds = ({ lastCreatedAt, nowMs }) =>
  calculateRetryAfterSecondsForWindow({
    lastCreatedAt,
    nowMs,
    windowMs: COMMENT_POST_COOLDOWN_MS
  });

const normalizeCommentContentForDuplicateCheck = (value) =>
  (value == null ? "" : String(value))
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const buildCommentCooldownMessage = (retryAfterSeconds) => {
  const seconds = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  return `Bạn bình luận quá nhanh. Vui lòng chờ ${seconds} giây rồi thử lại.`;
};

const sendCommentCooldownResponse = (req, res, retryAfterSeconds) => {
  const retryAfter = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  const message = buildCommentCooldownMessage(retryAfter);

  res.set("Retry-After", String(retryAfter));
  if (wantsJson(req)) {
    return res.status(429).json({
      error: message,
      code: "COMMENT_RATE_LIMITED",
      retryAfter
    });
  }

  return res.status(429).send(message);
};

const createCommentCooldownError = (retryAfterSeconds) => {
  const error = new Error("COMMENT_RATE_LIMITED");
  error.code = "COMMENT_RATE_LIMITED";
  error.retryAfterSeconds = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  return error;
};

const buildCommentDuplicateContentMessage = (retryAfterSeconds) => {
  const seconds = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  return `Bạn vừa gửi nội dung trùng. Vui lòng chờ ${seconds} giây hoặc chỉnh sửa nội dung rồi thử lại.`;
};

const sendCommentDuplicateContentResponse = (req, res, retryAfterSeconds) => {
  const retryAfter = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  const message = buildCommentDuplicateContentMessage(retryAfter);

  res.set("Retry-After", String(retryAfter));
  if (wantsJson(req)) {
    return res.status(429).json({
      error: message,
      code: "COMMENT_DUPLICATE_CONTENT",
      retryAfter
    });
  }

  return res.status(429).send(message);
};

const createCommentDuplicateContentError = (retryAfterSeconds) => {
  const error = new Error("COMMENT_DUPLICATE_CONTENT");
  error.code = "COMMENT_DUPLICATE_CONTENT";
  error.retryAfterSeconds = Number.isFinite(Number(retryAfterSeconds))
    ? Math.max(1, Math.floor(Number(retryAfterSeconds)))
    : 1;
  return error;
};

const ensureCommentPostCooldown = async ({ userId, nowMs, dbGet, dbRun }) => {
  const normalizedUserId = (userId || "").toString().trim();
  if (!normalizedUserId) return;

  if (typeof dbRun === "function") {
    await dbRun("SELECT pg_advisory_xact_lock(hashtext(?), 0)", [`comment-post:${normalizedUserId}`]);
  }

  const readOne = typeof dbGet === "function" ? dbGet : null;
  if (!readOne) return;

  const latestComment = await readOne(
    "SELECT created_at FROM comments WHERE author_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    [normalizedUserId]
  );

  const retryAfterSeconds = calculateCommentRetryAfterSeconds({
    lastCreatedAt: latestComment && latestComment.created_at ? latestComment.created_at : null,
    nowMs
  });
  if (retryAfterSeconds > 0) {
    throw createCommentCooldownError(retryAfterSeconds);
  }
};

const ensureCommentNotDuplicateRecently = async ({ userId, content, nowMs, dbAll }) => {
  const normalizedUserId = (userId || "").toString().trim();
  if (!normalizedUserId) return;

  const normalizedContent = normalizeCommentContentForDuplicateCheck(content);
  if (!normalizedContent) return;

  const safeNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const windowStartIso = new Date(safeNowMs - COMMENT_DUPLICATE_CONTENT_WINDOW_MS).toISOString();
  const readMany = typeof dbAll === "function" ? dbAll : null;
  if (!readMany) return;

  const recentRows = await readMany(
    `
      SELECT created_at, content
      FROM comments
      WHERE author_user_id = ?
        AND created_at >= ?
      ORDER BY created_at DESC, id DESC
      LIMIT 12
    `,
    [normalizedUserId, windowStartIso]
  );

  for (const row of recentRows || []) {
    const previousContent = normalizeCommentContentForDuplicateCheck(row && row.content ? row.content : "");
    if (!previousContent || previousContent !== normalizedContent) continue;

    const retryAfterSeconds = calculateRetryAfterSecondsForWindow({
      lastCreatedAt: row && row.created_at ? row.created_at : null,
      nowMs: safeNowMs,
      windowMs: COMMENT_DUPLICATE_CONTENT_WINDOW_MS
    });
    throw createCommentDuplicateContentError(Math.max(1, retryAfterSeconds || 1));
  }
};

const pruneCommentBotSignalStore = (nowMs) => {
  const safeNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  for (const [userId, entry] of commentBotSignalStore.entries()) {
    const timestamps = Array.isArray(entry && entry.timestamps)
      ? entry.timestamps.filter(
        (value) => Number.isFinite(value) && safeNowMs - value <= COMMENT_BOT_SIGNAL_WINDOW_MS
      )
      : [];
    const challengeUntil = Number.isFinite(entry && entry.challengeUntil)
      ? Math.floor(entry.challengeUntil)
      : 0;
    if (!timestamps.length && safeNowMs >= challengeUntil) {
      commentBotSignalStore.delete(userId);
      continue;
    }
    commentBotSignalStore.set(userId, {
      timestamps,
      challengeUntil
    });
  }
};

const registerCommentBotSignal = ({ userId, nowMs }) => {
  if (!isCommentTurnstileEnabled()) return;

  const normalizedUserId = (userId || "").toString().trim();
  if (!normalizedUserId) return;

  const safeNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  if (commentBotSignalStore.size > 5000) {
    pruneCommentBotSignalStore(safeNowMs);
  }

  const existing = commentBotSignalStore.get(normalizedUserId);
  const timestamps = Array.isArray(existing && existing.timestamps)
    ? existing.timestamps.filter(
      (value) => Number.isFinite(value) && safeNowMs - value <= COMMENT_BOT_SIGNAL_WINDOW_MS
    )
    : [];
  timestamps.push(safeNowMs);

  let challengeUntil = Number.isFinite(existing && existing.challengeUntil)
    ? Math.floor(existing.challengeUntil)
    : 0;
  if (timestamps.length >= COMMENT_BOT_SIGNAL_THRESHOLD) {
    challengeUntil = Math.max(challengeUntil, safeNowMs + COMMENT_BOT_CHALLENGE_TTL_MS);
    timestamps.length = 0;
  }

  commentBotSignalStore.set(normalizedUserId, {
    timestamps,
    challengeUntil
  });
};

const shouldRequireCommentTurnstile = ({ userId, nowMs }) => {
  if (!isCommentTurnstileEnabled()) return false;

  const normalizedUserId = (userId || "").toString().trim();
  if (!normalizedUserId) return false;

  const safeNowMs = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const existing = commentBotSignalStore.get(normalizedUserId);
  if (!existing) return false;

  const challengeUntil = Number.isFinite(existing.challengeUntil) ? Math.floor(existing.challengeUntil) : 0;
  if (safeNowMs < challengeUntil) {
    return true;
  }

  commentBotSignalStore.delete(normalizedUserId);
  return false;
};

const clearCommentBotSignals = (userId) => {
  const normalizedUserId = (userId || "").toString().trim();
  if (!normalizedUserId) return;
  commentBotSignalStore.delete(normalizedUserId);
};

const readCommentTurnstileToken = (req) => {
  const bodyToken = (req && req.body && req.body.turnstileToken != null ? req.body.turnstileToken : "")
    .toString()
    .trim();
  const fallbackBodyToken =
    (req && req.body && req.body["cf-turnstile-response"] != null
      ? req.body["cf-turnstile-response"]
      : "")
      .toString()
      .trim();
  const headerToken = (req.get("cf-turnstile-response") || "").toString().trim();
  const token = bodyToken || fallbackBodyToken || headerToken;
  if (!token) return "";
  if (token.length > 4096) return "";
  if (/\s/.test(token)) return "";
  return token;
};

const buildCommentTurnstileMessage = () =>
  "Hệ thống cần xác minh bạn không phải robot trước khi tiếp tục bình luận.";

const sendCommentTurnstileRequiredResponse = (req, res, message) => {
  const text = (message || buildCommentTurnstileMessage()).toString().trim() || buildCommentTurnstileMessage();
  if (wantsJson(req)) {
    return res.status(403).json({
      error: text,
      code: "TURNSTILE_REQUIRED",
      turnstileSiteKey: turnstilePublicConfig.siteKey
    });
  }
  return res.status(403).send(text);
};

const verifyCommentTurnstileToken = async ({ token, remoteIp, requestId }) => {
  if (!isCommentTurnstileEnabled()) {
    return { success: true, errorCodes: [] };
  }

  const responseToken = (token || "").toString().trim();
  if (!responseToken) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const params = new URLSearchParams();
  params.set("secret", turnstileConfig.secretKey);
  params.set("response", responseToken);
  const remoteIpText = (remoteIp || "").toString().trim();
  if (remoteIpText) {
    params.set("remoteip", remoteIpText);
  }
  const safeRequestId = (requestId || "").toString().trim();
  if (safeRequestId) {
    params.set("idempotency_key", safeRequestId);
  }

  try {
    const response = await fetch(turnstileConfig.verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: params
    });

    const payload = await response.json().catch(() => null);
    const success = Boolean(response.ok && payload && payload.success === true);
    const errorCodes = Array.isArray(payload && payload["error-codes"])
      ? payload["error-codes"].map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    return { success, errorCodes };
  } catch (error) {
    console.warn("Turnstile verification request failed", error);
    return { success: false, errorCodes: ["internal-error"] };
  }
};

const ensureCommentTurnstileIfSuspicious = async ({ req, res, userId, nowMs, requestId }) => {
  if (!shouldRequireCommentTurnstile({ userId, nowMs })) {
    return true;
  }

  const token = readCommentTurnstileToken(req);
  if (!token) {
    sendCommentTurnstileRequiredResponse(req, res);
    return false;
  }

  const verification = await verifyCommentTurnstileToken({
    token,
    remoteIp: req.ip || req.socket?.remoteAddress || "",
    requestId
  });
  if (!verification.success) {
    registerCommentBotSignal({ userId, nowMs });
    sendCommentTurnstileRequiredResponse(req, res, "Xác minh bảo mật thất bại. Vui lòng thử lại.");
    return false;
  }

  clearCommentBotSignals(userId);
  return true;
};

const buildChapterTimestampIso = (dateInput) => {
  const now = new Date();
  const raw = dateInput == null ? "" : String(dateInput).trim();
  if (!raw) {
    return now.toISOString();
  }

  // Accept full ISO inputs as-is.
  if (raw.includes("T")) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return now.toISOString();
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return now.toISOString();
  }

  const local = new Date(
    year,
    monthIndex,
    day,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds()
  );
  if (Number.isNaN(local.getTime())) {
    return now.toISOString();
  }
  return local.toISOString();
};

const slugify = (value) => {
  if (!value) return "";
  return value
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
};

const buildMangaSlug = (mangaId, title) => {
  const id = Number(mangaId);
  const base = slugify(title) || "manga";
  if (!Number.isFinite(id) || id <= 0) return base;
  return `${Math.floor(id)}-${base}`;
};

const coversUrlPrefix = "/uploads/covers/";

const extractLocalCoverFilename = (coverUrl) => {
  if (!coverUrl || typeof coverUrl !== "string") return "";
  if (!coverUrl.startsWith(coversUrlPrefix)) return "";
  return coverUrl.slice(coversUrlPrefix.length).split("?")[0].split("#")[0].trim();
};

const deleteFileIfExists = async (filePath) => {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
};

const buildCoverFilename = (mangaId, title) => `${buildMangaSlug(mangaId, title)}.webp`;

const saveCoverBuffer = async (filename, buffer) => {
  if (!filename || !buffer) return;
  const filePath = path.join(coversDir, filename);
  await deleteFileIfExists(filePath);
  await fs.promises.writeFile(filePath, buffer);
};

const coverTempTokenPattern = /^[a-f0-9]{32}$/;

const createCoverTempToken = () => crypto.randomBytes(16).toString("hex");

const getCoverTempFilePath = (token) => path.join(coversTmpDir, `${token}.webp`);

const isCoverTempTokenValid = (token) => coverTempTokenPattern.test(token || "");

const saveCoverTempBuffer = async (token, buffer) => {
  if (!isCoverTempTokenValid(token) || !buffer) return;
  const filePath = getCoverTempFilePath(token);
  await deleteFileIfExists(filePath);
  await fs.promises.writeFile(filePath, buffer);
};

const loadCoverTempBuffer = async (token) => {
  if (!isCoverTempTokenValid(token)) return null;
  const filePath = getCoverTempFilePath(token);
  try {
    return await fs.promises.readFile(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
};

const deleteCoverTemp = async (token) => {
  if (!isCoverTempTokenValid(token)) return;
  await deleteFileIfExists(getCoverTempFilePath(token));
};

const coverTempTtlMs = 3 * 60 * 60 * 1000;
const coverTempCleanupIntervalMs = 30 * 60 * 1000;

const cleanupCoverTemps = async () => {
  let entries = [];
  try {
    entries = await fs.promises.readdir(coversTmpDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return 0;
    throw err;
  }

  const now = Date.now();
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".webp")) continue;
    const token = entry.name.slice(0, -5);
    if (!isCoverTempTokenValid(token)) continue;

    const filePath = path.join(coversTmpDir, entry.name);
    let stat = null;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }

    const ageMs = now - Number(stat.mtimeMs || 0);
    if (ageMs <= coverTempTtlMs) continue;
    await deleteFileIfExists(filePath);
    deleted += 1;
  }

  return deleted;
};

const scheduleCoverTempCleanup = () => {
  const run = async () => {
    try {
      await cleanupCoverTemps();
    } catch (err) {
      console.warn("Cover temp cleanup failed", err);
    }
  };

  run();
  const timer = setInterval(run, coverTempCleanupIntervalMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

const coverMaxBytes = 300 * 1024;

const convertCoverToWebp = async (inputBuffer) => {
  if (!inputBuffer) return null;

  const qualitySteps = [82, 76, 70, 64, 58, 52, 46, 40, 34, 28, 22, 16];
  const maxEdgeSteps = [1600, 1400, 1200, 1000, 850, 700, 600, 520, 450, 380];

  for (const maxEdge of maxEdgeSteps) {
    for (const quality of qualitySteps) {
      const output = await sharp(inputBuffer)
        .rotate()
        .resize({
          width: maxEdge,
          height: maxEdge,
          fit: "inside",
          withoutEnlargement: true
        })
        .webp({ quality, effort: 6 })
        .toBuffer();

      if (output.length <= coverMaxBytes) {
        return output;
      }
    }
  }

  throw new Error("Ảnh bìa sau khi nén vẫn vượt quá 300KB. Vui lòng chọn ảnh nhỏ hơn.");
};

const normalizeBaseUrl = (value) => {
  const trimmed = (value || "").toString().trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
};

const normalizeAbsoluteHttpUrl = (value) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    const pathname = parsed.pathname || "/";
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search || ""}${parsed.hash || ""}`;
  } catch (_err) {
    return "";
  }
};

const normalizePathPrefix = (value) =>
  (value || "").toString().trim().replace(/^\/+/, "").replace(/\/+$/, "");

const supabasePublicConfig = {
  url: normalizeBaseUrl((process.env.SUPABASE_URL || "").trim()),
  anonKey: (process.env.SUPABASE_ANON_KEY || "").trim(),
  redirectTo: normalizeAbsoluteHttpUrl(
    (process.env.SUPABASE_AUTH_REDIRECT_TO || process.env.SUPABASE_REDIRECT_TO || "").trim()
  )
};

const resolveSupabaseRedirectTo = (req) => {
  const explicit = normalizeAbsoluteHttpUrl(supabasePublicConfig.redirectTo || "");
  if (explicit) return explicit;

  const origin = getPublicOriginFromRequest(req);
  if (!origin) return "";
  return `${origin}/auth/callback`;
};

const getSupabasePublicConfigForRequest = (req) => ({
  ...supabasePublicConfig,
  redirectTo: resolveSupabaseRedirectTo(req)
});

app.locals.supabasePublicConfig = getSupabasePublicConfigForRequest(null);

const turnstileConfig = {
  siteKey: (process.env.TURNSTILE_SITE_KEY || "").trim(),
  secretKey: (process.env.TURNSTILE_SECRET_KEY || "").trim(),
  verifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify"
};

const turnstilePublicConfig = {
  siteKey: turnstileConfig.siteKey
};

app.locals.turnstilePublicConfig = turnstilePublicConfig;

const getB2Config = () => {
  const bucketId = (
    process.env.S3_BUCKET || process.env.BUCKET || process.env.B2_BUCKET || process.env.B2_BUCKET_ID || ""
  ).trim();
  const keyId = (
    process.env.S3_ACCESS_KEY_ID ||
    process.env.S3_ACCESS_KEY ||
    process.env.ACCESS_KEY ||
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.B2_KEY_ID ||
    ""
  ).trim();
  const applicationKey = (
    process.env.S3_SECRET_ACCESS_KEY ||
    process.env.S3_SECRET_KEY ||
    process.env.SECRET_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.B2_APPLICATION_KEY ||
    ""
  ).trim();
  const region = (
    process.env.S3_REGION || process.env.REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
  ).trim() || "us-east-1";
  const endpoint = normalizeBaseUrl((process.env.S3_ENDPOINT || process.env.ENDPOINT || process.env.B2_ENDPOINT || "").trim());
  const forcePathStyle = parseEnvBoolean(process.env.S3_FORCE_PATH_STYLE, true);
  const cdnBaseUrl = normalizeBaseUrl((process.env.CHAPTER_CDN_BASE_URL || endpoint || "").trim());
  const chapterPrefix =
    normalizePathPrefix(process.env.S3_CHAPTER_PREFIX || process.env.B2_CHAPTER_PREFIX || "chapters") ||
    "chapters";

  return {
    bucketId,
    keyId,
    applicationKey,
    region,
    endpoint,
    forcePathStyle,
    cdnBaseUrl,
    chapterPrefix
  };
};

let storageClientCache = null;

const getStorageClient = () => {
  const config = getB2Config();
  if (!config.bucketId || !config.keyId || !config.applicationKey) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const cacheKey = [
    config.endpoint || "",
    config.region || "",
    config.bucketId,
    config.keyId,
    config.forcePathStyle ? "1" : "0"
  ].join("|");

  if (storageClientCache && storageClientCache.cacheKey === cacheKey) {
    return storageClientCache.client;
  }

  const options = {
    region: config.region || "us-east-1",
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey
    }
  };
  if (config.endpoint) {
    options.endpoint = config.endpoint;
  }

  const client = new S3Client(options);
  storageClientCache = {
    cacheKey,
    client
  };
  return client;
};

const b2UploadBuffer = async ({ fileName, buffer, contentType }) => {
  const config = getB2Config();
  const key = (fileName || "").toString().trim().replace(/^\/+/, "");
  if (!isB2Ready(config) || !key || !buffer) {
    throw new Error("Upload ảnh thất bại.");
  }

  const s3 = getStorageClient();
  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucketId,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream"
    })
  );

  return {
    fileName: key,
    fileId: key,
    uploadTimestamp: Date.now()
  };
};

const normalizeB2FileKey = (value) => (value || "").toString().trim().replace(/^\/+/, "");

const buildB2DirPrefix = (value) => {
  const trimmed = normalizeB2FileKey(value).replace(/\/+$/, "");
  if (!trimmed) return "";
  return `${trimmed}/`;
};

const parseChapterPageNumberFromFileName = (prefixDir, fileName) => {
  if (!prefixDir || !fileName) return null;
  if (!fileName.startsWith(prefixDir)) return null;
  const tail = fileName.slice(prefixDir.length);
  const match = tail.match(/^(\d{1,6})\.[a-z0-9]+$/i);
  if (!match) return null;
  const page = Number(match[1]);
  if (!Number.isFinite(page) || page <= 0) return null;
  return Math.floor(page);
};

const isB2Ready = (config) => Boolean(config && config.bucketId && config.keyId && config.applicationKey);

const isStorageVersionListingUnsupported = (err) => {
  const code = (err && (err.Code || err.code || err.name) ? String(err.Code || err.code || err.name) : "")
    .trim()
    .toLowerCase();
  const status = Number(err && err.$metadata ? err.$metadata.httpStatusCode : NaN);
  return (
    code === "notimplemented" ||
    code === "notsupported" ||
    code === "methodnotallowed" ||
    status === 405 ||
    status === 501
  );
};

const b2ListFileVersionsByPrefix = async (prefix) => {
  const config = getB2Config();
  if (!config.bucketId) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const prefixKey = normalizeB2FileKey(prefix);
  if (!prefixKey) return [];

  const s3 = getStorageClient();
  const versions = [];
  let keyMarker = "";
  let versionIdMarker = "";

  const readVersions = async () => {
    while (true) {
      const payload = {
        Bucket: config.bucketId,
        Prefix: prefixKey,
        MaxKeys: 1000
      };
      if (keyMarker) {
        payload.KeyMarker = keyMarker;
      }
      if (versionIdMarker) {
        payload.VersionIdMarker = versionIdMarker;
      }

      const data = await s3.send(new ListObjectVersionsCommand(payload));
      const versionRows = Array.isArray(data && data.Versions) ? data.Versions : [];
      const markerRows = Array.isArray(data && data.DeleteMarkers) ? data.DeleteMarkers : [];
      const rows = versionRows.concat(markerRows);
      rows.forEach((file) => {
        const fileName = file && typeof file.Key === "string" ? file.Key : "";
        const versionId = file && file.VersionId != null ? String(file.VersionId) : "";
        const modifiedRaw = file && file.LastModified ? new Date(file.LastModified).getTime() : 0;
        const uploadTimestamp = Number.isFinite(modifiedRaw) ? modifiedRaw : 0;
        if (!fileName || !fileName.startsWith(prefixKey)) return;
        versions.push({ fileName, fileId: fileName, versionId, uploadTimestamp });
      });

      const nextKey = data && typeof data.NextKeyMarker === "string" ? data.NextKeyMarker : "";
      const nextVersionId =
        data && data.NextVersionIdMarker != null ? String(data.NextVersionIdMarker) : "";
      const isTruncated = Boolean(data && data.IsTruncated);
      if (!isTruncated || !nextKey) break;
      if (nextKey === keyMarker && nextVersionId === versionIdMarker) break;
      keyMarker = nextKey;
      versionIdMarker = nextVersionId;
    }
  };

  try {
    await readVersions();
    return versions;
  } catch (err) {
    if (!isStorageVersionListingUnsupported(err)) {
      throw new Error("Không đọc được danh sách ảnh lưu trữ.");
    }
  }

  const files = await b2ListFileNamesByPrefix(prefixKey);
  return files.map((file) => ({
    fileName: file.fileName,
    fileId: file.fileId,
    versionId: "",
    uploadTimestamp: file.uploadTimestamp
  }));
};

const b2DeleteFileVersions = async (versions) => {
  if (!Array.isArray(versions) || versions.length === 0) return 0;

  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const s3 = getStorageClient();

  let deleted = 0;
  for (const version of versions) {
    const fileName = version && typeof version.fileName === "string" ? version.fileName : "";
    if (!fileName) continue;

    const versionId = version && version.versionId != null ? String(version.versionId).trim() : "";
    const payload = {
      Bucket: config.bucketId,
      Key: fileName
    };
    if (versionId) {
      payload.VersionId = versionId;
    }

    await s3.send(new DeleteObjectCommand(payload));
    deleted += 1;
  }
  return deleted;
};

const b2DeleteAllByPrefix = async (prefix) => {
  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const prefixDir = buildB2DirPrefix(prefix);
  if (!prefixDir) return 0;
  const versions = await b2ListFileVersionsByPrefix(prefixDir);
  return b2DeleteFileVersions(versions);
};

const b2DeleteChapterExtraPages = async ({ prefix, keepPages }) => {
  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const prefixDir = buildB2DirPrefix(prefix);
  if (!prefixDir) return 0;

  const keep = Math.max(0, Math.floor(Number(keepPages) || 0));
  const versions = await b2ListFileVersionsByPrefix(prefixDir);
  const toDelete = versions.filter((version) => {
    const fileName = version && typeof version.fileName === "string" ? version.fileName : "";
    const page = parseChapterPageNumberFromFileName(prefixDir, fileName);
    return page != null && page > keep;
  });

  return b2DeleteFileVersions(toDelete);
};

const b2ListFileNamesByPrefix = async (prefix) => {
  const config = getB2Config();
  if (!config.bucketId) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const prefixKey = normalizeB2FileKey(prefix);
  if (!prefixKey) return [];

  const s3 = getStorageClient();
  const files = [];
  let continuationToken = "";

  while (true) {
    const payload = {
      Bucket: config.bucketId,
      Prefix: prefixKey,
      MaxKeys: 1000
    };
    if (continuationToken) {
      payload.ContinuationToken = continuationToken;
    }

    const data = await s3.send(new ListObjectsV2Command(payload));
    const batch = Array.isArray(data && data.Contents) ? data.Contents : [];
    batch.forEach((file) => {
      const fileName = file && typeof file.Key === "string" ? file.Key : "";
      const modifiedRaw = file && file.LastModified ? new Date(file.LastModified).getTime() : 0;
      const uploadTimestamp = Number.isFinite(modifiedRaw) ? modifiedRaw : 0;
      if (!fileName) return;
      if (!fileName.startsWith(prefixKey)) return;
      files.push({ fileName, fileId: fileName, uploadTimestamp });
    });

    const nextToken = data && typeof data.NextContinuationToken === "string" ? data.NextContinuationToken : "";
    const isTruncated = Boolean(data && data.IsTruncated);
    if (!isTruncated || !nextToken) break;
    if (nextToken === continuationToken) break;
    continuationToken = nextToken;
  }

  return files;
};

const encodeS3CopySource = (bucketName, objectKey) => {
  const safeBucket = (bucketName || "").toString().trim();
  const safeKey = normalizeB2FileKey(objectKey);
  if (!safeBucket || !safeKey) return "";
  const encodedKey = safeKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/${encodeURIComponent(safeBucket)}/${encodedKey}`;
};

const b2CopyFile = async ({ sourceFileId, destinationFileName }) => {
  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const sourceKey = normalizeB2FileKey(sourceFileId);
  const destinationKey = normalizeB2FileKey(destinationFileName);
  if (!sourceKey || !destinationKey) {
    throw new Error("Thiếu thông tin copy ảnh.");
  }

  if (sourceKey === destinationKey) {
    return {
      fileName: destinationKey,
      fileId: destinationKey
    };
  }

  const copySource = encodeS3CopySource(config.bucketId, sourceKey);
  if (!copySource) {
    throw new Error("Thiếu thông tin copy ảnh.");
  }

  const s3 = getStorageClient();
  await s3.send(
    new CopyObjectCommand({
      Bucket: config.bucketId,
      Key: destinationKey,
      CopySource: copySource
    })
  );

  return {
    fileName: destinationKey,
    fileId: destinationKey
  };
};

const chapterDraftTokenPattern = /^[a-f0-9]{32}$/;
const chapterDraftPageIdPattern = /^[a-f0-9]{24}$/;

const createChapterDraftToken = () => crypto.randomBytes(16).toString("hex");

const isChapterDraftTokenValid = (token) => chapterDraftTokenPattern.test(token || "");

const isChapterDraftPageIdValid = (value) => chapterDraftPageIdPattern.test(value || "");

const buildChapterExistingPageId = (chapterId, pageNumber) => {
  const id = Number(chapterId);
  const page = Number(pageNumber);
  if (!Number.isFinite(id) || id <= 0) return "";
  if (!Number.isFinite(page) || page <= 0) return "";
  const key = `chapter:${Math.floor(id)}:page:${Math.floor(page)}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 24);
};

const buildChapterDraftPrefix = (mangaId, token) => {
  const config = getB2Config();
  const id = Number(mangaId);
  if (!Number.isFinite(id) || id <= 0) return "";
  if (!isChapterDraftTokenValid(token)) return "";
  const base = normalizeB2FileKey(config.chapterPrefix || "chapters");
  const safeBase = base || "chapters";
  return `${safeBase}/tmp/manga-${Math.floor(id)}/draft-${token}`;
};

const createChapterDraft = async (mangaId) => {
  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const id = Number(mangaId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Không tìm thấy truyện");
  }

  const token = createChapterDraftToken();
  const prefix = buildChapterDraftPrefix(id, token);
  if (!prefix) {
    throw new Error("Không tạo được draft chương.");
  }

  const now = Date.now();
  await dbRun(
    "INSERT INTO chapter_drafts (token, manga_id, pages_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [token, Math.floor(id), prefix, now, now]
  );

  return { token, prefix, createdAt: now, updatedAt: now };
};

const getChapterDraft = async (token) => {
  if (!isChapterDraftTokenValid(token)) return null;
  return dbGet("SELECT * FROM chapter_drafts WHERE token = ?", [token]);
};

const touchChapterDraft = async (token) => {
  if (!isChapterDraftTokenValid(token)) return;
  await dbRun("UPDATE chapter_drafts SET updated_at = ? WHERE token = ?", [Date.now(), token]);
};

const deleteChapterDraftRow = async (token) => {
  if (!isChapterDraftTokenValid(token)) return;
  await dbRun("DELETE FROM chapter_drafts WHERE token = ?", [token]);
};

const chapterDraftTtlMs = 3 * 60 * 60 * 1000;
const chapterDraftCleanupIntervalMs = 30 * 60 * 1000;

const cleanupChapterDrafts = async () => {
  const config = getB2Config();
  if (!isB2Ready(config)) return 0;

  const cutoff = Date.now() - chapterDraftTtlMs;
  const rows = await dbAll(
    `
    SELECT token, pages_prefix
    FROM chapter_drafts
    WHERE updated_at < ?
      AND token NOT IN (
        SELECT processing_draft_token
        FROM chapters
        WHERE processing_state = 'processing'
          AND processing_draft_token IS NOT NULL
          AND TRIM(processing_draft_token) <> ''
      )
    ORDER BY updated_at ASC
    LIMIT 40
  `,
    [cutoff]
  );

  let cleaned = 0;
  for (const row of rows) {
    const token = row && typeof row.token === "string" ? row.token : "";
    const prefix = row && typeof row.pages_prefix === "string" ? row.pages_prefix : "";
    if (!isChapterDraftTokenValid(token) || !prefix) {
      continue;
    }

    try {
      await b2DeleteAllByPrefix(prefix);
    } catch (err) {
      console.warn("Chapter draft cleanup failed", err);
      continue;
    }

    try {
      await deleteChapterDraftRow(token);
    } catch (err) {
      console.warn("Chapter draft cleanup DB delete failed", err);
      continue;
    }

    cleaned += 1;
  }

  return cleaned;
};

const scheduleChapterDraftCleanup = () => {
  const run = async () => {
    try {
      await cleanupChapterDrafts();
    } catch (err) {
      console.warn("Chapter draft cleanup crashed", err);
    }
  };

  run();
  const timer = setInterval(run, chapterDraftCleanupIntervalMs);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

const normalizeJsonString = (value) => (value == null ? "" : String(value)).trim();

const parseJsonArrayOfStrings = (value) => {
  const text = normalizeJsonString(value);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter(Boolean);
};

const chapterProcessingQueue = [];
const chapterProcessingQueued = new Set();
let chapterProcessingRunning = false;

const adminJobs = new Map();
const adminJobsQueue = [];
let adminJobsRunning = false;

const createAdminJobId = () => crypto.randomBytes(16).toString("hex");

const pruneAdminJobs = () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of adminJobs.entries()) {
    if (!job) {
      adminJobs.delete(id);
      continue;
    }
    const updatedAt = Number(job.updatedAt) || 0;
    if ((job.state === "done" || job.state === "failed") && updatedAt && updatedAt < cutoff) {
      adminJobs.delete(id);
    }
  }
};

const normalizeAdminJobError = (err) => {
  const message = (err && err.message ? String(err.message) : "").trim();
  if (!message) return "Thao tác thất bại. Vui lòng thử lại.";
  if (message.length > 160) return "Thao tác thất bại. Vui lòng thử lại.";
  if (/\bb2\b|backblaze|\bs3\b|aws|signaturedoesnotmatch|invalidaccesskeyid/i.test(message)) {
    return "Thao tác thất bại. Vui lòng thử lại.";
  }
  return message;
};

const runAdminJobsQueue = async () => {
  if (adminJobsRunning) return;
  adminJobsRunning = true;
  try {
    while (adminJobsQueue.length) {
      const nextId = adminJobsQueue.shift();
      const job = adminJobs.get(nextId);
      if (!job || job.state !== "queued") continue;

      job.state = "running";
      job.startedAt = Date.now();
      job.updatedAt = job.startedAt;

      try {
        await job.run();
        job.state = "done";
        job.error = "";
      } catch (err) {
        console.warn("Admin job failed", { id: job.id, type: job.type, message: err && err.message });
        job.state = "failed";
        job.error = normalizeAdminJobError(err);
      }

      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
    }
  } finally {
    adminJobsRunning = false;
  }
};

const createAdminJob = ({ type, run }) => {
  pruneAdminJobs();
  const id = createAdminJobId();
  const now = Date.now();
  const safeType = (type || "").toString().trim() || "job";
  adminJobs.set(id, {
    id,
    type: safeType,
    state: "queued",
    error: "",
    createdAt: now,
    startedAt: 0,
    finishedAt: 0,
    updatedAt: now,
    run
  });
  adminJobsQueue.push(id);
  runAdminJobsQueue().catch((err) => {
    console.warn("Admin job queue crashed", err);
  });
  return id;
};

const deleteChapterAndCleanupStorage = async (chapterId) => {
  const id = Number(chapterId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Không tìm thấy chương");
  }

  const chapterRow = await dbGet(
    "SELECT id, manga_id, number, pages_prefix, processing_draft_token FROM chapters WHERE id = ?",
    [Math.floor(id)]
  );
  if (!chapterRow) {
    throw new Error("Không tìm thấy chương");
  }

  const storedPrefix = (chapterRow.pages_prefix || "").toString().trim();
  const processingToken = (chapterRow.processing_draft_token || "").toString().trim();
  const hasProcessing = processingToken && isChapterDraftTokenValid(processingToken);

  if (storedPrefix || hasProcessing) {
    const config = getB2Config();
    if (!isB2Ready(config)) {
      throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const prefixesToDelete = new Set();
    if (storedPrefix) {
      prefixesToDelete.add(storedPrefix);
    }

    const finalPrefix = `${config.chapterPrefix}/manga-${chapterRow.manga_id}/ch-${String(
      chapterRow.number
    )}`;
    if (finalPrefix) {
      prefixesToDelete.add(finalPrefix);
    }

    if (hasProcessing) {
      let draftPrefix = "";
      const draft = await getChapterDraft(processingToken);
      if (draft && draft.pages_prefix) {
        draftPrefix = String(draft.pages_prefix).trim();
      }
      if (!draftPrefix) {
        draftPrefix = buildChapterDraftPrefix(chapterRow.manga_id, processingToken);
      }
      if (draftPrefix) {
        prefixesToDelete.add(draftPrefix);
      }
    }

    for (const prefix of prefixesToDelete) {
      if (!prefix) continue;
      await b2DeleteAllByPrefix(prefix);
    }
  }

  if (hasProcessing) {
    try {
      await deleteChapterDraftRow(processingToken);
    } catch (err) {
      console.warn("Failed to delete chapter draft row", err);
    }
  }

  await dbRun("DELETE FROM chapters WHERE id = ?", [chapterRow.id]);
  await refreshMangaUpdatedAt(chapterRow.manga_id);
  return { mangaId: chapterRow.manga_id };
};

const deleteMangaAndCleanupStorage = async (mangaId) => {
  const id = Number(mangaId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Không tìm thấy truyện");
  }
  const safeMangaId = Math.floor(id);

  const mangaRow = await dbGet("SELECT id FROM manga WHERE id = ?", [safeMangaId]);
  if (!mangaRow) {
    throw new Error("Không tìm thấy truyện");
  }

  const config = getB2Config();
  if (!isB2Ready(config)) {
    throw new Error("Thiếu cấu hình lưu trữ ảnh trong .env");
  }

  const rootPrefix = `${config.chapterPrefix}/manga-${safeMangaId}`;
  const tmpPrefix = `${config.chapterPrefix}/tmp/manga-${safeMangaId}`;

  const prefixesToDelete = new Set([rootPrefix, tmpPrefix]);

  const storedPrefixes = await dbAll(
    "SELECT DISTINCT pages_prefix FROM chapters WHERE manga_id = ? AND pages_prefix IS NOT NULL AND TRIM(pages_prefix) <> ''",
    [safeMangaId]
  );
  storedPrefixes.forEach((row) => {
    const prefix = row && row.pages_prefix != null ? String(row.pages_prefix).trim() : "";
    if (!prefix) return;
    if (rootPrefix && prefix.startsWith(rootPrefix)) return;
    if (tmpPrefix && prefix.startsWith(tmpPrefix)) return;
    prefixesToDelete.add(prefix);
  });

  const draftPrefixes = await dbAll(
    "SELECT DISTINCT pages_prefix FROM chapter_drafts WHERE manga_id = ? AND pages_prefix IS NOT NULL AND TRIM(pages_prefix) <> ''",
    [safeMangaId]
  );
  draftPrefixes.forEach((row) => {
    const prefix = row && row.pages_prefix != null ? String(row.pages_prefix).trim() : "";
    if (!prefix) return;
    if (rootPrefix && prefix.startsWith(rootPrefix)) return;
    if (tmpPrefix && prefix.startsWith(tmpPrefix)) return;
    prefixesToDelete.add(prefix);
  });

  for (const prefix of prefixesToDelete) {
    if (!prefix) continue;
    await b2DeleteAllByPrefix(prefix);
  }

  await dbRun("DELETE FROM manga WHERE id = ?", [safeMangaId]);
};

const updateChapterProcessing = async ({ chapterId, state, error }) => {
  const id = Number(chapterId);
  if (!Number.isFinite(id) || id <= 0) return;
  const safeState = (state || "").toString().trim();
  const safeError = (error || "").toString().trim();
  await dbRun(
    "UPDATE chapters SET processing_state = ?, processing_error = ?, processing_updated_at = ? WHERE id = ?",
    [safeState, safeError, Date.now(), Math.floor(id)]
  );
};

const clearChapterProcessing = async (chapterId) => {
  const id = Number(chapterId);
  if (!Number.isFinite(id) || id <= 0) return;
  await dbRun(
    `
    UPDATE chapters
    SET
      processing_state = NULL,
      processing_error = NULL,
      processing_draft_token = NULL,
      processing_pages_json = NULL,
      processing_updated_at = ?
    WHERE id = ?
  `,
    [Date.now(), Math.floor(id)]
  );
};

const runChapterProcessingJob = async (chapterId) => {
  const id = Number(chapterId);
  if (!Number.isFinite(id) || id <= 0) return;

  const chapterRow = await dbGet(
    `
    SELECT
      id,
      manga_id,
      number,
      pages,
      pages_prefix,
      processing_state,
      processing_draft_token,
      processing_pages_json
    FROM chapters
    WHERE id = ?
  `,
    [Math.floor(id)]
  );
  if (!chapterRow) return;

  const state = normalizeJsonString(chapterRow.processing_state);
  if (state !== "processing") return;

  const token = normalizeJsonString(chapterRow.processing_draft_token);
  const pageIds = parseJsonArrayOfStrings(chapterRow.processing_pages_json);
  const hasPayload = isChapterDraftTokenValid(token) && pageIds.length > 0;

  if (chapterRow.pages_prefix && String(chapterRow.pages_prefix).trim() && !hasPayload) {
    await clearChapterProcessing(chapterRow.id);
    return;
  }

  const config = getB2Config();
  if (!isB2Ready(config)) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Thiếu cấu hình lưu trữ ảnh trong .env"
    });
    return;
  }

  if (!isChapterDraftTokenValid(token)) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Draft chương không hợp lệ hoặc đã hết hạn."
    });
    return;
  }

  if (!pageIds.length) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Danh sách ảnh trang không hợp lệ."
    });
    return;
  }

  if (pageIds.length > 220) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Số lượng ảnh trang quá nhiều."
    });
    return;
  }

  if (pageIds.some((value) => !isChapterDraftPageIdValid(value))) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Danh sách ảnh trang không hợp lệ."
    });
    return;
  }

  const uniquePageIds = Array.from(new Set(pageIds));
  if (uniquePageIds.length !== pageIds.length) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Danh sách ảnh trang bị trùng."
    });
    return;
  }

  const draft = await getChapterDraft(token);
  if (!draft || Number(draft.manga_id) !== Number(chapterRow.manga_id)) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Draft chương không tồn tại hoặc đã hết hạn."
    });
    return;
  }

  const draftPrefix = normalizeJsonString(draft.pages_prefix);
  if (!draftPrefix) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Draft chương không hợp lệ."
    });
    return;
  }

  await updateChapterProcessing({ chapterId: chapterRow.id, state: "processing", error: "" });
  await touchChapterDraft(token);

  const chapterNumberKey = String(chapterRow.number);
  const finalPrefix = `${config.chapterPrefix}/manga-${chapterRow.manga_id}/ch-${chapterNumberKey}`;
  const padLength = Math.max(3, Math.min(6, String(pageIds.length).length));

  let available = [];
  try {
    available = await b2ListFileNamesByPrefix(buildB2DirPrefix(draftPrefix));
  } catch (err) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: "Không đọc được ảnh tạm."
    });
    return;
  }

  const availableMap = new Map(available.map((file) => [file.fileName, file]));

  const existingSourceById = new Map();
  const existingPrefix = normalizeJsonString(chapterRow.pages_prefix);
  const existingPrefixDir = existingPrefix ? buildB2DirPrefix(existingPrefix) : "";
  if (existingPrefixDir) {
    let existingFiles = [];
    try {
      existingFiles = await b2ListFileNamesByPrefix(existingPrefixDir);
    } catch (err) {
      await updateChapterProcessing({
        chapterId: chapterRow.id,
        state: "failed",
        error: "Không đọc được ảnh chương."
      });
      return;
    }

    const latestByPage = new Map();
    existingFiles.forEach((file) => {
      const fileName = file && typeof file.fileName === "string" ? file.fileName : "";
      const page = parseChapterPageNumberFromFileName(existingPrefixDir, fileName);
      if (page == null) return;

      const prev = latestByPage.get(page);
      const ts = file && file.uploadTimestamp != null ? Number(file.uploadTimestamp) : 0;
      const prevTs = prev && prev.uploadTimestamp != null ? Number(prev.uploadTimestamp) : 0;
      if (!prev || ts >= prevTs) {
        latestByPage.set(page, file);
      }
    });

    latestByPage.forEach((file, page) => {
      const id = buildChapterExistingPageId(chapterRow.id, page);
      if (!id) return;
      existingSourceById.set(id, file);
    });
  }

  try {
    for (let index = 0; index < pageIds.length; index += 1) {
      if (index > 0 && index % 10 === 0) {
        const still = await dbGet(
          "SELECT 1 FROM chapters WHERE id = ? AND processing_state = 'processing'",
          [chapterRow.id]
        );
        if (!still) {
          return;
        }
        await touchChapterDraft(token);
        await dbRun("UPDATE chapters SET processing_updated_at = ? WHERE id = ?", [
          Date.now(),
          chapterRow.id
        ]);
      }

      const pageId = pageIds[index];
      const draftName = `${draftPrefix}/${pageId}.webp`;
      const draftSource = availableMap.get(draftName);
      let sourceFileId = draftSource && draftSource.fileId ? String(draftSource.fileId) : "";
      if (!sourceFileId) {
        const existingSource = existingSourceById.get(pageId);
        sourceFileId = existingSource && existingSource.fileId ? String(existingSource.fileId) : "";
      }
      if (!sourceFileId) {
        throw new Error(
          `Thiếu ảnh cho trang ${index + 1} (có thể draft đã hết hạn). Vui lòng mở Sửa và upload lại.`
        );
      }

      const pageName = String(index + 1).padStart(padLength, "0");
      const destinationName = `${finalPrefix}/${pageName}.webp`;
      await b2CopyFile({ sourceFileId, destinationFileName: destinationName });
    }
  } catch (err) {
    await updateChapterProcessing({
      chapterId: chapterRow.id,
      state: "failed",
      error: (err && err.message) || "Xử lý ảnh chương thất bại."
    });
    return;
  }

  const doneAt = Date.now();
  const doneDate = new Date(doneAt).toISOString();
  await dbRun(
    `
    UPDATE chapters
    SET
      pages = ?,
      pages_prefix = ?,
      pages_ext = ?,
      pages_updated_at = ?,
      date = ?,
      processing_state = NULL,
      processing_error = NULL,
      processing_draft_token = NULL,
      processing_pages_json = NULL,
      processing_updated_at = ?
    WHERE id = ?
  `,
    [pageIds.length, finalPrefix, "webp", doneAt, doneDate, doneAt, chapterRow.id]
  );
  await refreshMangaUpdatedAt(chapterRow.manga_id);

  // Cleanup any leftover pages from previous uploads/edits.
  try {
    await b2DeleteChapterExtraPages({ prefix: finalPrefix, keepPages: pageIds.length });
  } catch (err) {
    console.warn("Chapter extra page cleanup failed", err);
  }

  const previousPrefix = normalizeJsonString(chapterRow.pages_prefix);
  if (previousPrefix && previousPrefix !== finalPrefix) {
    try {
      await b2DeleteAllByPrefix(previousPrefix);
    } catch (err) {
      console.warn("Failed to delete old chapter prefix", err);
    }
  }

  let draftCleared = false;
  try {
    await b2DeleteAllByPrefix(draftPrefix);
    draftCleared = true;
  } catch (err) {
    console.warn("Failed to delete chapter draft prefix", err);
  }

  if (draftCleared) {
    try {
      await deleteChapterDraftRow(token);
    } catch (err) {
      console.warn("Failed to delete chapter draft row", err);
    }
  } else {
    try {
      await touchChapterDraft(token);
    } catch (err) {
      console.warn("Failed to touch chapter draft row", err);
    }
  }
};

const runChapterProcessingQueue = async () => {
  if (chapterProcessingRunning) return;
  chapterProcessingRunning = true;
  try {
    while (chapterProcessingQueue.length) {
      const nextId = chapterProcessingQueue.shift();
      try {
        await runChapterProcessingJob(nextId);
      } catch (err) {
        console.warn("Chapter processing job crashed", err);
      } finally {
        chapterProcessingQueued.delete(nextId);
      }
    }
  } finally {
    chapterProcessingRunning = false;
  }
};

const enqueueChapterProcessing = (chapterId) => {
  const id = Number(chapterId);
  if (!Number.isFinite(id) || id <= 0) return;
  const safeId = Math.floor(id);
  if (chapterProcessingQueued.has(safeId)) return;
  chapterProcessingQueued.add(safeId);
  chapterProcessingQueue.push(safeId);
  runChapterProcessingQueue();
};

const resumeChapterProcessingJobs = async () => {
  const rows = await dbAll(
    "SELECT id FROM chapters WHERE processing_state = 'processing' ORDER BY id ASC LIMIT 60"
  );
  rows.forEach((row) => {
    const id = row ? Number(row.id) : 0;
    if (Number.isFinite(id) && id > 0) {
      enqueueChapterProcessing(Math.floor(id));
    }
  });
};

const chapterPageMaxWidth = 1200;
const chapterPageWebpQuality = 77;

const convertChapterPageToWebp = async (inputBuffer) => {
  if (!inputBuffer) return null;
  return sharp(inputBuffer)
    .rotate()
    .resize({
      width: chapterPageMaxWidth,
      withoutEnlargement: true
    })
    .webp({ quality: chapterPageWebpQuality, effort: 6 })
    .toBuffer();
};

const parseGenres = (value) =>
  value
    ? value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    : [];

const normalizeGenreName = (value) => {
  const collapsed = (value || "").toString().replace(/\s+/g, " ").trim();
  if (!collapsed) return "";

  return collapsed
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((segment) => {
          if (!segment) return segment;
          if (/^[A-Z0-9+]{2,}$/.test(segment)) return segment;
          const lower = segment.toLowerCase();
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join("-")
    )
    .join(" ");
};

const normalizeGenreList = (list) => {
  const seen = new Set();
  const result = [];

  (list || []).forEach((genre) => {
    const normalized = normalizeGenreName(genre);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(normalized);
  });

  return result;
};

const normalizeGenresString = (value) =>
  normalizeGenreList(parseGenres(value)).join(", ");

const getGenreStats = async () =>
  dbAll(
    `
    SELECT
      g.id,
      g.name,
      COUNT(mg.manga_id) as count
    FROM genres g
    LEFT JOIN manga_genres mg ON mg.genre_id = g.id
    GROUP BY g.id
    ORDER BY lower(g.name) ASC, g.id ASC
  `
  );

const findGenreRowByNormalizedName = async (normalizedName) => {
  if (!normalizedName) return null;
  const rows = await dbAll("SELECT id, name FROM genres");
  return rows.find((row) => normalizeGenreName(row.name) === normalizedName) || null;
};

const getOrCreateGenreId = async (name) => {
  const normalized = normalizeGenreName(name);
  if (!normalized) return null;

  const direct = await dbGet("SELECT id, name FROM genres WHERE name = ?", [normalized]);
  if (direct) {
    if (direct.name !== normalized) {
      await dbRun("UPDATE genres SET name = ? WHERE id = ?", [normalized, direct.id]);
    }
    return direct.id;
  }

  const normalizedMatch = await findGenreRowByNormalizedName(normalized);
  if (normalizedMatch) {
    if (normalizedMatch.name !== normalized) {
      await dbRun("UPDATE genres SET name = ? WHERE id = ?", [normalized, normalizedMatch.id]);
    }
    return normalizedMatch.id;
  }

  const result = await dbRun("INSERT INTO genres (name) VALUES (?)", [normalized]);
  return result ? result.lastID : null;
};

const getOneshotGenreId = async () => getOrCreateGenreId(ONESHOT_GENRE_NAME);

const setMangaGenresByNames = async (mangaId, input) => {
  const list = Array.isArray(input) ? input : parseGenres(input);
  const names = normalizeGenreList(list);
  await dbRun("DELETE FROM manga_genres WHERE manga_id = ?", [mangaId]);
  for (const name of names) {
    const genreId = await getOrCreateGenreId(name);
    if (!genreId) continue;
    await dbRun("INSERT INTO manga_genres (manga_id, genre_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [
      mangaId,
      genreId
    ]);
  }
};

const normalizeIdList = (input) => {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = Number(value);
    if (!Number.isFinite(id) || id <= 0) return;
    const normalized = Math.floor(id);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ids.push(normalized);
  };

  if (Array.isArray(input)) {
    input.forEach(add);
    return ids;
  }
  if (input != null) {
    add(input);
  }
  return ids;
};

const escapeRegexPattern = (value) =>
  (value == null ? "" : String(value)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeForbiddenWord = (value) => {
  const compact = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.slice(0, FORBIDDEN_WORD_MAX_LENGTH);
};

const normalizeForbiddenWordList = (value) => {
  const list = [];
  const seen = new Set();

  const append = (rawItem) => {
    const normalized = normalizeForbiddenWord(rawItem);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(normalized);
  };

  if (Array.isArray(value)) {
    value.forEach(append);
    return list;
  }

  const rawText = (value == null ? "" : String(value)).replace(/\r\n/g, "\n");
  if (!rawText.trim()) return list;

  rawText
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach(append);

  return list;
};

const getForbiddenWords = async () => {
  return dbAll(
    "SELECT id, word, created_at FROM forbidden_words ORDER BY lower(word) ASC, id ASC"
  );
};

const censorCommentContentByForbiddenWords = async (value) => {
  const raw = value == null ? "" : String(value);
  const compact = raw.trim();
  if (!compact) return "";

  const wordsRows = await getForbiddenWords();
  const words = normalizeForbiddenWordList(wordsRows.map((row) => (row && row.word ? row.word : ""))).sort(
    (left, right) => right.length - left.length
  );
  if (!words.length) return compact;

  let output = compact;
  words.forEach((word) => {
    const pattern = escapeRegexPattern(word);
    if (!pattern) return;
    output = output.replace(new RegExp(pattern, "gi"), "***");
  });

  return output;
};

const setMangaGenresByIds = async (mangaId, ids) => {
  const genreIds = normalizeIdList(ids);
  await dbRun("DELETE FROM manga_genres WHERE manga_id = ?", [mangaId]);
  for (const genreId of genreIds) {
    await dbRun("INSERT INTO manga_genres (manga_id, genre_id) VALUES (?, ?) ON CONFLICT DO NOTHING", [
      mangaId,
      genreId
    ]);
  }
  return genreIds;
};

const getGenresStringByIds = async (ids) => {
  const genreIds = normalizeIdList(ids);
  if (!genreIds.length) return "";
  const placeholders = genreIds.map(() => "?").join(",");
  const rows = await dbAll(
    `
      SELECT id, name
      FROM genres
      WHERE id IN (${placeholders})
      ORDER BY lower(name) ASC, id ASC
    `,
    genreIds
  );
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  const names = genreIds.map((id) => nameById.get(id)).filter(Boolean);
  return names.join(", ");
};

const migrateLegacyGenres = async () => {
  const joinCountRow = await dbGet("SELECT COUNT(*) as count FROM manga_genres");
  if (joinCountRow && joinCountRow.count > 0) return;

  const legacyRows = await dbAll(
    "SELECT id, genres FROM manga WHERE genres IS NOT NULL AND TRIM(genres) <> ''"
  );
  if (!legacyRows.length) return;

  for (const row of legacyRows) {
    const names = normalizeGenreList(parseGenres(row.genres));
    if (!names.length) continue;
    for (const name of names) {
      const genreId = await getOrCreateGenreId(name);
      if (!genreId) continue;
      await dbRun(
        "INSERT INTO manga_genres (manga_id, genre_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        [row.id, genreId]
      );
    }
  }
};

const migrateMangaSlugs = async () => {
  const rows = await dbAll("SELECT id, title, slug FROM manga");
  for (const row of rows) {
    const desired = buildMangaSlug(row.id, row.title);
    if (desired && row.slug !== desired) {
      await dbRun("UPDATE manga SET slug = ? WHERE id = ?", [desired, row.id]);
    }
  }
};

const migrateMangaStatuses = async () => {
  await dbRun(
    `
      UPDATE manga
      SET status = ?
      WHERE status IS NOT NULL AND TRIM(status) = ?
    `,
    ["Còn tiếp", "Đang ra"]
  );
};

const refreshMangaUpdatedAt = async (mangaId) => {
  const id = Number(mangaId);
  if (!Number.isFinite(id) || id <= 0) return;

  const latestRow = await dbGet(
    "SELECT MAX(date) as latest FROM chapters WHERE manga_id = ?",
    [Math.floor(id)]
  );
  const latest = latestRow && latestRow.latest ? String(latestRow.latest).trim() : "";
  if (latest) {
    await dbRun("UPDATE manga SET updated_at = ? WHERE id = ?", [latest, Math.floor(id)]);
    return;
  }

  const mangaRow = await dbGet("SELECT created_at FROM manga WHERE id = ?", [Math.floor(id)]);
  const fallback = mangaRow && mangaRow.created_at ? String(mangaRow.created_at).trim() : "";
  if (fallback) {
    await dbRun("UPDATE manga SET updated_at = ? WHERE id = ?", [fallback, Math.floor(id)]);
  }
};

const mapCommentRow = (row, session) => {
  const liked = Boolean(row && row.liked_by_me);
  const reported = Boolean(row && row.reported_by_me);
  const avatarUrl = normalizeAvatarUrl(row && row.author_avatar_url ? row.author_avatar_url : "");
  const authorUserId = row && row.author_user_id ? String(row.author_user_id).trim() : "";

  const rawBadges = row && row.author_badges_json != null ? row.author_badges_json : null;
  let badges = [];
  if (Array.isArray(rawBadges)) {
    badges = rawBadges;
  } else if (typeof rawBadges === "string") {
    try {
      const parsed = JSON.parse(rawBadges);
      if (Array.isArray(parsed)) {
        badges = parsed;
      }
    } catch (_err) {
      badges = [];
    }
  }

  const safeBadges = Array.isArray(badges)
    ? badges
      .map((item) => {
        const label = item && item.label != null ? String(item.label).trim() : "";
        if (!label) return null;
        const code = item && item.code != null ? normalizeBadgeCode(item.code) : "";
        const color = item && item.color != null ? normalizeHexColor(item.color) : "";
        const priorityRaw = item && item.priority != null ? Number(item.priority) : 0;
        const priority = Number.isFinite(priorityRaw) ? Math.floor(priorityRaw) : 0;
        return {
          code: code || "badge",
          label,
          color: color || "#f8f8f2",
          priority
        };
      })
      .filter(Boolean)
    : [];

  const rawMentions = row && row.mention_json != null ? row.mention_json : null;
  let mentions = [];
  if (Array.isArray(rawMentions)) {
    mentions = rawMentions;
  } else if (typeof rawMentions === "string") {
    try {
      const parsed = JSON.parse(rawMentions);
      if (Array.isArray(parsed)) {
        mentions = parsed;
      }
    } catch (_err) {
      mentions = [];
    }
  }

  const safeMentions = Array.isArray(mentions)
    ? mentions
      .map((item) => {
        const username = item && item.username ? String(item.username).trim().toLowerCase() : "";
        if (!/^[a-z0-9_]{1,24}$/.test(username)) return null;
        const userId = item && item.userId ? String(item.userId).trim() : "";
        const rawName = item && item.name ? String(item.name).replace(/\s+/g, " ").trim() : "";
        const name = rawName || `@${username}`;
        const color = item && item.userColor ? normalizeHexColor(item.userColor) : "";
        return {
          userId,
          username,
          name,
          userColor: color || ""
        };
      })
      .filter(Boolean)
    : [];

  const userColorRaw = row && row.author_color != null ? String(row.author_color).trim() : "";
  let userColor = normalizeHexColor(userColorRaw);
  if (!userColor && safeBadges.length) {
    userColor = normalizeHexColor(safeBadges[0].color);
  }
  if (!authorUserId) {
    userColor = "";
  }

  const finalBadges = authorUserId
    ? safeBadges.length
      ? safeBadges
      : [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }]
    : [];

  const chapterContext = buildCommentChapterContext({
    chapterNumber: row && row.chapter_number != null ? row.chapter_number : null,
    chapterTitle: row && row.chapter_title ? row.chapter_title : "",
    chapterIsOneshot: row && row.chapter_is_oneshot
  });

  return {
    id: row.id,
    author: row.author,
    authorUserId,
    badges: finalBadges,
    userColor,
    avatarUrl,
    content: row.content,
    mentions: safeMentions,
    createdAt: row.created_at,
    parentId: row.parent_id,
    likeCount: row.like_count || 0,
    reportCount: row.report_count || 0,
    liked: Boolean(liked),
    reported: Boolean(reported),
    chapterNumber: chapterContext.chapterNumber,
    chapterNumberText: chapterContext.chapterNumberText,
    chapterTitle: chapterContext.chapterTitle,
    chapterIsOneshot: chapterContext.chapterIsOneshot,
    chapterLabel: chapterContext.chapterLabel,
    replies: []
  };
};

const buildCommentTree = (rows, session) => {
  const map = new Map();
  const roots = [];

  rows.forEach((row) => {
    map.set(row.id, mapCommentRow(row, session));
  });

  map.forEach((comment) => {
    if (comment.parentId && map.has(comment.parentId)) {
      map.get(comment.parentId).replies.push(comment);
    } else {
      roots.push(comment);
    }
  });

  return { comments: roots, count: rows.length };
};

const compareCommentCreatedAtAsc = (left, right) => {
  const leftTime = left && left.createdAt ? Date.parse(left.createdAt) : NaN;
  const rightTime = right && right.createdAt ? Date.parse(right.createdAt) : NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftCreated = left && left.createdAt ? String(left.createdAt) : "";
  const rightCreated = right && right.createdAt ? String(right.createdAt) : "";
  if (leftCreated && rightCreated && leftCreated !== rightCreated) {
    return leftCreated.localeCompare(rightCreated);
  }

  const leftId = left && Number.isFinite(Number(left.id)) ? Math.floor(Number(left.id)) : 0;
  const rightId = right && Number.isFinite(Number(right.id)) ? Math.floor(Number(right.id)) : 0;
  return leftId - rightId;
};

const compareCommentCreatedAtDesc = (left, right) => compareCommentCreatedAtAsc(right, left);

const sortReplyTreeOldestFirst = (comments) => {
  if (!Array.isArray(comments) || !comments.length) return;
  comments.forEach((comment) => {
    if (!comment || !Array.isArray(comment.replies) || !comment.replies.length) return;
    comment.replies.sort(compareCommentCreatedAtAsc);
    sortReplyTreeOldestFirst(comment.replies);
  });
};

const deleteCommentCascade = async (commentId) => {
  const id = Number(commentId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const safeId = Math.floor(id);
  const result = await dbRun(
    `
    WITH RECURSIVE subtree AS (
      SELECT id
      FROM comments
      WHERE id = ?
      UNION ALL
      SELECT c.id
      FROM comments c
      JOIN subtree s ON c.parent_id = s.id
    )
    DELETE FROM comments
    WHERE id IN (SELECT id FROM subtree)
  `,
    [safeId]
  );
  return result && result.changes ? result.changes : 0;
};

const resolveCommentScope = ({ mangaId, chapterNumber }) => {
  const mangaValue = Number(mangaId);
  if (!Number.isFinite(mangaValue) || mangaValue <= 0) return null;

  const safeMangaId = Math.floor(mangaValue);
  const chapterValue = chapterNumber == null ? null : Number(chapterNumber);
  const hasChapterScope = Number.isFinite(chapterValue);

  if (hasChapterScope) {
    return {
      mangaId: safeMangaId,
      chapterNumber: chapterValue,
      hasChapterScope: true,
      whereWithoutStatus: "manga_id = ? AND chapter_number = ?",
      whereVisible: "manga_id = ? AND chapter_number = ? AND status = 'visible'",
      params: [safeMangaId, chapterValue]
    };
  }

  return {
    mangaId: safeMangaId,
    chapterNumber: null,
    hasChapterScope: false,
    whereWithoutStatus: "manga_id = ?",
    whereVisible: "manga_id = ? AND status = 'visible'",
    params: [safeMangaId]
  };
};

const getVisibleCommentCount = async ({ mangaId, chapterNumber }) => {
  const scope = resolveCommentScope({ mangaId, chapterNumber });
  if (!scope) return 0;

  const row = await dbGet(`SELECT COUNT(*) as count FROM comments WHERE ${scope.whereVisible}`, scope.params);
  return row ? row.count : 0;
};

const attachAuthorBadgesToCommentRows = async (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  const userIds = Array.from(
    new Set(
      list
        .map((row) => (row && row.author_user_id ? String(row.author_user_id).trim() : ""))
        .filter(Boolean)
    )
  );

  if (!userIds.length) {
    return list.map((row) => ({
      ...row,
      author_badges_json: [],
      author_color: "",
      liked_by_me: false,
      reported_by_me: false
    }));
  }

  const placeholders = userIds.map(() => "?").join(",");
  const badgeRows = await dbAll(
    `
    SELECT
      ub.user_id,
      COALESCE(
        json_agg(
          json_build_object(
            'id', b.id,
            'code', b.code,
            'label', b.label,
            'color', b.color,
            'priority', b.priority
          )
          ORDER BY b.priority DESC, b.id ASC
        ),
        '[]'::json
      ) as badges,
      (array_agg(b.color ORDER BY b.priority DESC, b.id ASC))[1] as user_color
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id IN (${placeholders})
    GROUP BY ub.user_id
  `,
    userIds
  );

  const badgeMap = new Map();
  badgeRows.forEach((row) => {
    const key = row && row.user_id ? String(row.user_id).trim() : "";
    if (!key) return;
    const badges = Array.isArray(row.badges) ? row.badges : [];
    const userColor = row && row.user_color ? String(row.user_color).trim() : "";
    badgeMap.set(key, { badges, userColor });
  });

  return list.map((row) => {
    const userId = row && row.author_user_id ? String(row.author_user_id).trim() : "";
    const context = userId ? badgeMap.get(userId) : null;
    return {
      ...row,
      author_badges_json: context && Array.isArray(context.badges) ? context.badges : [],
      author_color: context && context.userColor ? context.userColor : "",
      liked_by_me: false,
      reported_by_me: false
    };
  });
};

const attachMentionProfilesToCommentRows = async ({ rows, mangaId }) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  const mentionUsernames = Array.from(
    new Set(
      list
        .flatMap((row) => extractMentionUsernamesFromContent(row && row.content ? row.content : ""))
        .map((value) => (value == null ? "" : String(value)).trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (!mentionUsernames.length) {
    return list.map((row) => ({
      ...row,
      mention_json: []
    }));
  }

  const mentionProfileMap = await getMentionProfileMapForManga({
    mangaId,
    usernames: mentionUsernames
  });

  return list.map((row) => ({
    ...row,
    mention_json: buildCommentMentionsForContent({
      content: row && row.content ? row.content : "",
      mentionProfileMap
    })
  }));
};

const getPaginatedCommentTree = async ({ mangaId, chapterNumber, page, perPage, session }) => {
  const scope = resolveCommentScope({ mangaId, chapterNumber });
  if (!scope) {
    return {
      comments: [],
      count: 0,
      pagination: {
        page: 1,
        perPage: 20,
        totalPages: 1,
        totalTopLevel: 0,
        hasPrev: false,
        hasNext: false,
        prevPage: 1,
        nextPage: 1
      }
    };
  }

  const perPageValue = Number(perPage);
  const safePerPage = Number.isFinite(perPageValue)
    ? Math.max(1, Math.min(50, Math.floor(perPageValue)))
    : 20;
  const requestedPage = Number.isFinite(Number(page)) ? Math.max(1, Math.floor(page)) : 1;

  const totalCountRow = await dbGet(
    `SELECT COUNT(*) as count FROM comments WHERE ${scope.whereVisible}`,
    scope.params
  );
  const totalCount = totalCountRow ? Number(totalCountRow.count) || 0 : 0;

  const totalPages = Math.max(1, Math.ceil(totalCount / safePerPage));
  const currentPage = Math.min(requestedPage, totalPages);

  if (totalCount <= 0) {
    return {
      comments: [],
      count: 0,
      pagination: {
        page: currentPage,
        perPage: safePerPage,
        totalPages,
        totalTopLevel: 0,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages,
        prevPage: Math.max(1, currentPage - 1),
        nextPage: Math.min(totalPages, currentPage + 1)
      }
    };
  }

  const rootStats = await dbAll(
    `
    WITH RECURSIVE branch AS (
      SELECT
        c.id,
        c.parent_id,
        c.id as root_id
      FROM comments c
      WHERE ${scope.whereVisible}
        AND c.parent_id IS NULL
      UNION ALL
      SELECT
        child.id,
        child.parent_id,
        branch.root_id
      FROM comments child
      JOIN branch ON child.parent_id = branch.id
      WHERE child.status = 'visible'
    )
    SELECT
      branch.root_id,
      COUNT(*) as subtree_count,
      root.created_at as root_created_at
    FROM branch
    JOIN comments root ON root.id = branch.root_id
    GROUP BY branch.root_id, root.created_at
    ORDER BY root_created_at DESC, branch.root_id DESC
  `,
    scope.params
  );

  const totalTopLevel = rootStats.length;
  const startIndex = (currentPage - 1) * safePerPage;
  const endIndexExclusive = startIndex + safePerPage;

  let cursor = 0;
  const rootIds = [];
  for (const row of rootStats) {
    const rootIdValue = Number(row.root_id);
    if (!Number.isFinite(rootIdValue) || rootIdValue <= 0) continue;
    const branchCountValue = Number(row.subtree_count);
    const branchCount =
      Number.isFinite(branchCountValue) && branchCountValue > 0 ? Math.floor(branchCountValue) : 1;

    const nextCursor = cursor + branchCount;
    if (nextCursor > startIndex && cursor < endIndexExclusive) {
      rootIds.push(Math.floor(rootIdValue));
    }
    cursor = nextCursor;
    if (cursor >= endIndexExclusive && rootIds.length) {
      break;
    }
  }

  if (!rootIds.length) {
    return {
      comments: [],
      count: totalCount,
      pagination: {
        page: currentPage,
        perPage: safePerPage,
        totalPages,
        totalTopLevel,
        hasPrev: currentPage > 1,
        hasNext: currentPage < totalPages,
        prevPage: Math.max(1, currentPage - 1),
        nextPage: Math.min(totalPages, currentPage + 1)
      }
    };
  }

  const placeholders = rootIds.map(() => "?").join(",");
  const branchRows = await dbAll(
    `
    WITH RECURSIVE branch AS (
      SELECT
        c.id,
        c.author,
        c.author_user_id,
        c.author_avatar_url,
        c.content,
        c.created_at,
        c.parent_id,
        c.like_count,
        c.report_count,
        c.chapter_number,
        COALESCE(ch.title, '') as chapter_title,
        COALESCE(ch.is_oneshot, false) as chapter_is_oneshot
      FROM comments c
      LEFT JOIN chapters ch ON ch.manga_id = c.manga_id AND ch.number = c.chapter_number
      WHERE c.id IN (${placeholders})
      UNION ALL
      SELECT
        child.id,
        child.author,
        child.author_user_id,
        child.author_avatar_url,
        child.content,
        child.created_at,
        child.parent_id,
        child.like_count,
        child.report_count,
        child.chapter_number,
        COALESCE(ch_child.title, '') as chapter_title,
        COALESCE(ch_child.is_oneshot, false) as chapter_is_oneshot
      FROM comments child
      LEFT JOIN chapters ch_child ON ch_child.manga_id = child.manga_id AND ch_child.number = child.chapter_number
      JOIN branch b ON child.parent_id = b.id
      WHERE child.status = 'visible'
    )
    SELECT *
    FROM branch
    ORDER BY created_at ASC, id ASC
  `,
    rootIds
  );

  const decoratedRows = await attachAuthorBadgesToCommentRows(branchRows);
  const mentionReadyRows = await attachMentionProfilesToCommentRows({
    rows: decoratedRows,
    mangaId: scope.mangaId
  });
  const tree = buildCommentTree(mentionReadyRows, session);
  tree.comments.sort(compareCommentCreatedAtDesc);
  sortReplyTreeOldestFirst(tree.comments);

  return {
    comments: tree.comments,
    count: totalCount,
    pagination: {
      page: currentPage,
      perPage: safePerPage,
      totalPages,
      totalTopLevel,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      prevPage: Math.max(1, currentPage - 1),
      nextPage: Math.min(totalPages, currentPage + 1)
    }
  };
};

const team = {
  name: "BFANG Team",
  tagline: "Nền tảng chỉ dành cho manga. Không tạp. Không lẫn thể loại khác."
};

const homepageDefaults = {
  noticeTitle1: "Lịch phát hành",
  noticeBody1: "Thông báo phát hành và lịch cập nhật sẽ hiển thị tại đây.",
  noticeTitle2: "Nội dung ưu tiên",
  noticeBody2: "Ưu tiên nội dung nội bộ, không lẫn thể loại khác."
};

const pickValue = (value, fallback) => (value == null ? fallback : value);

const parseFeaturedIds = (value) =>
  value
    ? value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isFinite(id) && id > 0)
    : [];

const normalizeHomepageRow = (row) => ({
  noticeTitle1: pickValue(
    row ? row.notice_title_1 : null,
    homepageDefaults.noticeTitle1
  ),
  noticeBody1: pickValue(
    row ? row.notice_body_1 : null,
    homepageDefaults.noticeBody1
  ),
  noticeTitle2: pickValue(
    row ? row.notice_title_2 : null,
    homepageDefaults.noticeTitle2
  ),
  noticeBody2: pickValue(
    row ? row.notice_body_2 : null,
    homepageDefaults.noticeBody2
  ),
  featuredIds: parseFeaturedIds(row ? row.featured_ids : "")
});

const buildHomepageNotices = (homepageData) => {
  const notices = [];
  const addNotice = (title, body) => {
    const trimmedTitle = (title || "").trim();
    const trimmedBody = (body || "").trim();
    if (!trimmedTitle && !trimmedBody) return;
    notices.push({
      title: trimmedTitle,
      body: trimmedBody
    });
  };

  addNotice(homepageData.noticeTitle1, homepageData.noticeBody1);
  addNotice(homepageData.noticeTitle2, homepageData.noticeBody2);
  return notices;
};

const getDefaultFeaturedIds = async () => {
  const rows = await dbAll(
    "SELECT id FROM manga WHERE COALESCE(is_hidden, 0) = 0 ORDER BY updated_at DESC, id DESC LIMIT 3"
  );
  return rows.map((row) => row.id);
};

const ensureHomepageDefaults = async () => {
  const homepageRow = await dbGet("SELECT id FROM homepage WHERE id = 1");
  if (homepageRow) return;
  const featuredIds = await getDefaultFeaturedIds();
  const now = new Date().toISOString();
  await dbRun(
    `
    INSERT INTO homepage (id, notice_title_1, notice_body_1, notice_title_2, notice_body_2, featured_ids, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `,
    [
      homepageDefaults.noticeTitle1,
      homepageDefaults.noticeBody1,
      homepageDefaults.noticeTitle2,
      homepageDefaults.noticeBody2,
      featuredIds.join(","),
      now
    ]
  );
};

const rawSessionSecret = (process.env.SESSION_SECRET || "").toString().trim();
let resolvedSessionSecret = rawSessionSecret;

if (!resolvedSessionSecret) {
  if (isProductionApp) {
    throw new Error("SESSION_SECRET là bắt buộc khi APP_ENV=production");
  }
  resolvedSessionSecret = crypto.randomBytes(48).toString("hex");
  console.warn("SESSION_SECRET chưa được cấu hình; đang dùng secret tạm cho development.");
}

if (resolvedSessionSecret.length < 32) {
  const message = "SESSION_SECRET nên dài tối thiểu 32 ký tự.";
  if (isProductionApp) {
    throw new Error(message);
  }
  console.warn(message);
}

const adminConfig = {
  user: process.env.ADMIN_USER || "",
  pass: process.env.ADMIN_PASS || "",
  sessionSecret: resolvedSessionSecret
};

const isPasswordAdminEnabled = parseEnvBoolean(process.env.ADMIN_PASSWORD_LOGIN_ENABLED, true);

if (isPasswordAdminEnabled && (!adminConfig.user || !adminConfig.pass)) {
  console.warn("ADMIN_USER/ADMIN_PASS chưa được cấu hình trong .env");
}

if (!isPasswordAdminEnabled) {
  console.warn("ADMIN_PASSWORD_LOGIN_ENABLED đang tắt; chỉ cho phép đăng nhập admin bằng huy hiệu.");
}

const mapMangaRow = (row) => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  author: row.author,
  groupName: row.group_name,
  otherNames: row.other_names,
  genres: parseGenres(row.genres),
  status: row.status,
  description: row.description,
  updatedAt: row.updated_at,
  cover: row.cover,
  coverUpdatedAt: Number(row.cover_updated_at) || 0,
  archive: row.archive,
  isHidden: Boolean(row.is_hidden),
  isOneshot: toBooleanFlag(row && row.is_oneshot),
  oneshotLocked: toBooleanFlag(row && row.oneshot_locked)
});

const mapMangaListRow = (row) => ({
  ...mapMangaRow(row),
  chapterCount: row.chapter_count || 0,
  latestChapterNumber: row.latest_chapter_number || 0,
  latestChapterIsOneshot: toBooleanFlag(row.latest_chapter_is_oneshot)
});

const mapReadingHistoryRow = (row) => {
  const mangaSlug = row && row.manga_slug ? String(row.manga_slug).trim() : "";
  const chapterNumber = row && row.chapter_number != null ? Number(row.chapter_number) : NaN;
  const latestChapterNumber =
    row && row.latest_chapter_number != null ? Number(row.latest_chapter_number) : NaN;
  const chapterIsOneshot = toBooleanFlag(row && row.chapter_is_oneshot);
  const latestChapterIsOneshot = toBooleanFlag(row && row.latest_chapter_is_oneshot);
  const chapterNumberText = Number.isFinite(chapterNumber) ? formatChapterNumberValue(chapterNumber) : "";
  const latestChapterNumberText = Number.isFinite(latestChapterNumber)
    ? formatChapterNumberValue(latestChapterNumber)
    : "";
  const chapterLabel = chapterIsOneshot
    ? "Oneshot"
    : chapterNumberText
      ? `Ch ${chapterNumberText}`
      : "";
  const isUnfinished =
    Number.isFinite(chapterNumber) &&
    Number.isFinite(latestChapterNumber) &&
    latestChapterNumber - chapterNumber > 1e-9;
  const chapterUrl =
    mangaSlug && chapterNumberText
      ? `/manga/${encodeURIComponent(mangaSlug)}/chapters/${encodeURIComponent(chapterNumberText)}`
      : "";
  const updatedAtValue = row && row.updated_at != null ? Number(row.updated_at) : NaN;

  return {
    mangaId: row && row.manga_id != null ? Number(row.manga_id) : 0,
    mangaTitle: row && row.manga_title ? String(row.manga_title).trim() : "",
    mangaSlug,
    mangaUrl: mangaSlug ? `/manga/${encodeURIComponent(mangaSlug)}` : "",
    mangaCover: row && row.manga_cover ? String(row.manga_cover) : "",
    mangaCoverUpdatedAt: Number(row && row.manga_cover_updated_at) || 0,
    mangaAuthor: row && row.manga_author ? String(row.manga_author).trim() : "",
    mangaGroupName: row && row.manga_group_name ? String(row.manga_group_name).trim() : "",
    mangaGenres: parseGenres(row && row.manga_genres ? row.manga_genres : ""),
    mangaStatus: row && row.manga_status ? String(row.manga_status).trim() : "",
    chapterNumber: Number.isFinite(chapterNumber) ? chapterNumber : null,
    chapterNumberText,
    chapterTitle: row && row.chapter_title ? String(row.chapter_title).trim() : "",
    chapterIsOneshot,
    chapterLabel,
    chapterUrl,
    latestChapterNumber: Number.isFinite(latestChapterNumber) ? latestChapterNumber : null,
    latestChapterNumberText,
    latestChapterIsOneshot,
    isUnfinished,
    updatedAt: Number.isFinite(updatedAtValue) ? updatedAtValue : null,
    updatedAtText: Number.isFinite(updatedAtValue) ? formatTimeAgo(updatedAtValue) : ""
  };
};

const ensureUniqueSlug = async (base) => {
  const baseSlug = base || `manga-${Date.now()}`;
  let slug = baseSlug;
  let index = 2;
  while (true) {
    const existing = await dbGet("SELECT 1 FROM manga WHERE slug = ?", [slug]);
    if (!existing) return slug;
    slug = `${baseSlug}-${index}`;
    index += 1;
  }
};

const initDb = async () => {
  await dbGet("SELECT 1 as ok");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS manga (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      author TEXT NOT NULL,
      genres TEXT,
      status TEXT,
      description TEXT,
      cover TEXT,
      archive TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      group_name TEXT,
      other_names TEXT,
      cover_updated_at BIGINT,
      is_oneshot BOOLEAN NOT NULL DEFAULT false,
      oneshot_locked BOOLEAN NOT NULL DEFAULT false
    )
  `
  );

  // Safety migrations for older schemas.
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS group_name TEXT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS other_names TEXT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS cover_updated_at BIGINT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS is_oneshot BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS oneshot_locked BOOLEAN NOT NULL DEFAULT false");

  await dbRun(
    `
    UPDATE manga
    SET group_name = author
    WHERE (group_name IS NULL OR TRIM(group_name) = '')
      AND author IS NOT NULL
      AND TRIM(author) <> ''
  `
  );

  const coverStamp = Date.now();
  await dbRun(
    "UPDATE manga SET cover_updated_at = ? WHERE cover IS NOT NULL AND TRIM(cover) <> '' AND cover_updated_at IS NULL",
    [coverStamp]
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      number NUMERIC(10, 3) NOT NULL,
      title TEXT NOT NULL,
      pages INTEGER NOT NULL,
      date TEXT NOT NULL,
      group_name TEXT,
      pages_prefix TEXT,
      pages_ext TEXT,
      pages_updated_at BIGINT,
      is_oneshot BOOLEAN NOT NULL DEFAULT false,
      processing_state TEXT,
      processing_error TEXT,
      processing_draft_token TEXT,
      processing_pages_json TEXT,
      processing_updated_at BIGINT
    )
  `
  );

  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS group_name TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_prefix TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_ext TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_updated_at BIGINT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS is_oneshot BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_state TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_error TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_draft_token TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_pages_json TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_updated_at BIGINT");

  await dbRun(
    `
    UPDATE manga
    SET is_oneshot = true
    WHERE COALESCE(is_oneshot, false) = false
      AND id IN (
        SELECT c.manga_id
        FROM chapters c
        GROUP BY c.manga_id
        HAVING COUNT(*) = 1
           AND SUM(CASE WHEN COALESCE(c.is_oneshot, false) THEN 1 ELSE 0 END) = 1
      )
  `
  );

  // Enforce unique chapter number per manga.
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_manga_number ON chapters (manga_id, number)"
  );

  await dbRun(
    `
    UPDATE chapters
    SET group_name = (
      SELECT COALESCE(NULLIF(TRIM(m.group_name), ''), NULLIF(TRIM(m.author), ''), ?)
      FROM manga m
      WHERE m.id = chapters.manga_id
    )
    WHERE (group_name IS NULL OR TRIM(group_name) = '')
  `,
    [team.name]
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chapter_drafts (
      token TEXT PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      pages_prefix TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_chapter_drafts_updated_at ON chapter_drafts(updated_at)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_chapter_drafts_manga_id ON chapter_drafts(manga_id)"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      chapter_number NUMERIC(10, 3),
      parent_id INTEGER,
      author TEXT NOT NULL,
      author_user_id TEXT,
      author_email TEXT,
      author_avatar_url TEXT,
      client_request_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'visible',
      like_count INTEGER NOT NULL DEFAULT 0,
      report_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `
  );

  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS report_count INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_user_id TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_email TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_avatar_url TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS client_request_id TEXT");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_comments_manga_chapter_status_created ON comments (manga_id, chapter_number, status, created_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comments_author_user_id ON comments(author_user_id)");
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_author_request_id ON comments(author_user_id, client_request_id) WHERE client_request_id IS NOT NULL AND author_user_id IS NOT NULL"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS forbidden_words (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      word TEXT NOT NULL,
      normalized_word TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS word TEXT");
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS normalized_word TEXT");
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("UPDATE forbidden_words SET word = '' WHERE word IS NULL");
  await dbRun("UPDATE forbidden_words SET normalized_word = lower(regexp_replace(trim(word), '\\s+', ' ', 'g'))");
  await dbRun("UPDATE forbidden_words SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("DELETE FROM forbidden_words WHERE TRIM(word) = ''");
  await dbRun(
    "DELETE FROM forbidden_words fw USING forbidden_words other WHERE fw.id > other.id AND fw.normalized_word = other.normalized_word"
  );
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN word SET NOT NULL");
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN normalized_word SET NOT NULL");
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN created_at SET NOT NULL");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_forbidden_words_normalized ON forbidden_words(normalized_word)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      facebook_url TEXT,
      discord_handle TEXT,
      bio TEXT,
      badge TEXT NOT NULL DEFAULT 'Member',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_url TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_handle TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS badge TEXT");
  await dbRun("UPDATE users SET badge = 'Member' WHERE badge IS NULL OR TRIM(badge) = ''");
  await dbRun("ALTER TABLE users ALTER COLUMN badge SET DEFAULT 'Member'");
  await dbRun("ALTER TABLE users ALTER COLUMN badge SET NOT NULL");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users ((lower(email)))");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS reading_history (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      chapter_number NUMERIC(10, 3) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, manga_id)
    )
  `
  );
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS user_id TEXT");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS manga_id INTEGER");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS chapter_number NUMERIC(10, 3)");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("DELETE FROM reading_history WHERE user_id IS NULL OR TRIM(user_id) = ''");
  await dbRun("DELETE FROM reading_history WHERE manga_id IS NULL");
  await dbRun("DELETE FROM reading_history WHERE chapter_number IS NULL");
  await dbRun("UPDATE reading_history SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
  await dbRun("ALTER TABLE reading_history ALTER COLUMN user_id SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN manga_id SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN chapter_number SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN updated_at SET NOT NULL");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_reading_history_user_updated ON reading_history(user_id, updated_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_reading_history_manga_id ON reading_history(manga_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE comment_likes ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_likes_user_id ON comment_likes(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comment_reports (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE comment_reports ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_reports_user_id ON comment_reports(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_reports_comment_id ON comment_reports(comment_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_user_id TEXT,
      manga_id INTEGER REFERENCES manga(id) ON DELETE CASCADE,
      chapter_number NUMERIC(10, 3),
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      content_preview TEXT,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL,
      read_at BIGINT
    )
  `
  );
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_user_id TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS manga_id INTEGER");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS chapter_number NUMERIC(10, 3)");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id INTEGER");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS content_preview TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at BIGINT");
  await dbRun("DELETE FROM notifications WHERE user_id IS NULL OR TRIM(user_id) = ''");
  await dbRun("UPDATE notifications SET type = 'mention' WHERE type IS NULL OR TRIM(type) = ''");
  await dbRun("UPDATE notifications SET is_read = false WHERE is_read IS NULL");
  await dbRun("UPDATE notifications SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("ALTER TABLE notifications ALTER COLUMN user_id SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN type SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN created_at SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN is_read SET DEFAULT false");
  await dbRun("ALTER TABLE notifications ALTER COLUMN is_read SET NOT NULL");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)");
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_comment_type ON notifications(user_id, comment_id, type)"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      can_access_admin BOOLEAN NOT NULL DEFAULT false,
      can_delete_any_comment BOOLEAN NOT NULL DEFAULT false,
      can_comment BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS code TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS label TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS color TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS priority INTEGER");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_access_admin BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_delete_any_comment BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_comment BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("UPDATE badges SET priority = 0 WHERE priority IS NULL");
  await dbRun("UPDATE badges SET can_access_admin = false WHERE can_access_admin IS NULL");
  await dbRun("UPDATE badges SET can_delete_any_comment = false WHERE can_delete_any_comment IS NULL");
  await dbRun("UPDATE badges SET can_comment = true WHERE can_comment IS NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN priority SET DEFAULT 0");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_access_admin SET DEFAULT false");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_delete_any_comment SET DEFAULT false");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_comment SET DEFAULT true");
  await dbRun("ALTER TABLE badges ALTER COLUMN priority SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_access_admin SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_delete_any_comment SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_comment SET NOT NULL");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_badges_code_lower ON badges ((lower(code)))");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, badge_id)
    )
  `
  );
  await dbRun("ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_user_badges_badge_id ON user_badges(badge_id)");

  const badgeCountRow = await dbGet("SELECT COUNT(*) as count FROM badges");
  if (!badgeCountRow || Number(badgeCountRow.count) === 0) {
    const now = Date.now();
    const defaults = [
      {
        code: "admin",
        label: "Admin",
        color: "#ff6b6b",
        priority: 500,
        canAccessAdmin: true,
        canDeleteAnyComment: true,
        canComment: true
      },
      {
        code: "mod",
        label: "Mod",
        color: "#33d17a",
        priority: 400,
        canAccessAdmin: false,
        canDeleteAnyComment: true,
        canComment: true
      },
      {
        code: "translator",
        label: "Translator",
        color: "#5aa7ff",
        priority: 300,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "editor",
        label: "Editor",
        color: "#d79a4a",
        priority: 200,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "vip",
        label: "VIP",
        color: "#f7d154",
        priority: 150,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "member",
        label: "Member",
        color: "#f8f8f2",
        priority: 100,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "banned",
        label: "Banned",
        color: "#8f95a3",
        priority: 10,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: false
      }
    ];

    for (const badge of defaults) {
      await dbRun(
        "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          badge.code,
          badge.label,
          badge.color,
          badge.priority,
          Boolean(badge.canAccessAdmin),
          Boolean(badge.canDeleteAnyComment),
          badge.canComment !== false,
          now,
          now
        ]
      );
    }
  }

  const ensuredMemberBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  if (!ensuredMemberBadgeRow) {
    const now = Date.now();
    await dbRun(
      "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["member", "Member", "#f8f8f2", 100, false, false, true, now, now]
    );
    cachedMemberBadgeId = 0;
    cachedMemberBadgeCheckedAt = 0;
  }

  const ensuredBannedBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'banned' LIMIT 1");
  if (!ensuredBannedBadgeRow) {
    const now = Date.now();
    await dbRun(
      "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["banned", "Banned", "#8f95a3", 10, false, false, false, now, now]
    );
  } else {
    await dbRun("UPDATE badges SET can_comment = false WHERE lower(code) = 'banned' AND can_comment <> false");
  }

  // Migrate legacy single-badge users.badge -> user_badges (best-effort).
  const badgeMigrationNow = Date.now();
  await dbRun(
    `
    INSERT INTO user_badges (user_id, badge_id, created_at)
    SELECT u.id, b.id, ?
    FROM users u
    JOIN badges b ON lower(b.label) = lower(u.badge)
    WHERE u.badge IS NOT NULL AND TRIM(u.badge) <> ''
    ON CONFLICT DO NOTHING
  `,
    [badgeMigrationNow]
  );

  // Ensure every user has at least Member.
  const memberBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  if (memberBadgeRow && memberBadgeRow.id) {
    await dbRun(
      `
      INSERT INTO user_badges (user_id, badge_id, created_at)
      SELECT u.id, ?, ?
      FROM users u
      WHERE u.id IS NOT NULL AND TRIM(u.id) <> ''
      ON CONFLICT DO NOTHING
    `,
      [memberBadgeRow.id, Date.now()]
    );
  }

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS homepage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      notice_title_1 TEXT,
      notice_body_1 TEXT,
      notice_title_2 TEXT,
      notice_body_2 TEXT,
      featured_ids TEXT,
      updated_at TEXT NOT NULL
    )
  `
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS genres (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL
    )
  `
  );
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_genres_name_lower ON genres ((lower(name)))"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS manga_genres (
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
      PRIMARY KEY (manga_id, genre_id)
    )
  `
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_manga_genres_genre_id ON manga_genres(genre_id)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_manga_genres_manga_id ON manga_genres(manga_id)"
  );

  const oneshotGenreRow = await dbGet(
    "SELECT id FROM genres WHERE lower(name) = lower(?) LIMIT 1",
    [ONESHOT_GENRE_NAME]
  );
  const oneshotGenreId = oneshotGenreRow && oneshotGenreRow.id ? Number(oneshotGenreRow.id) : 0;
  if (Number.isFinite(oneshotGenreId) && oneshotGenreId > 0) {
    await dbRun(
      `
      INSERT INTO manga_genres (manga_id, genre_id)
      SELECT id, ?
      FROM manga
      WHERE COALESCE(is_oneshot, false) = true
      ON CONFLICT DO NOTHING
    `,
      [oneshotGenreId]
    );
  }
  await migrateLegacyGenres();
  await ensureHomepageDefaults();
  await migrateMangaStatuses();
  await migrateMangaSlugs();
};

const listQueryBase = `
  SELECT
    m.id,
    m.title,
    m.slug,
    m.author,
    m.group_name,
    m.other_names,
    (
      SELECT string_agg(g.name, ', ' ORDER BY lower(g.name) ASC, g.id ASC)
      FROM manga_genres mg
      JOIN genres g ON g.id = mg.genre_id
      WHERE mg.manga_id = m.id
    ) as genres,
    COALESCE(m.is_hidden, 0) as is_hidden,
    COALESCE(m.is_oneshot, false) as is_oneshot,
    COALESCE(m.oneshot_locked, false) as oneshot_locked,
    m.status,
    m.description,
    m.cover,
    COALESCE(m.cover_updated_at, 0) as cover_updated_at,
    m.archive,
    m.updated_at,
    m.created_at,
    (SELECT COUNT(*) FROM chapters c WHERE c.manga_id = m.id) as chapter_count,
    (SELECT number FROM chapters c WHERE c.manga_id = m.id ORDER BY number DESC LIMIT 1)
      as latest_chapter_number,
    (SELECT COALESCE(is_oneshot, false) FROM chapters c WHERE c.manga_id = m.id ORDER BY number DESC LIMIT 1)
      as latest_chapter_is_oneshot
  FROM manga m
`;

const listQueryOrder = "ORDER BY m.updated_at DESC, m.id DESC";

const listQuery = `${listQueryBase} ${listQueryOrder}`;

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const wantsJson = (req) => {
  const queryFormat =
    req && req.query && typeof req.query.format === "string"
      ? req.query.format.toString().trim().toLowerCase()
      : "";
  const requestedWith = (req.get("x-requested-with") || "").toString().trim().toLowerCase();
  if (requestedWith === "xmlhttprequest") {
    return true;
  }

  const accept = (req.headers.accept || "").toString().trim().toLowerCase();
  const acceptsHtml = accept.includes("text/html") || accept.includes("application/xhtml+xml");
  const acceptsJson = accept.includes("application/json");

  if (queryFormat === "json") {
    return !acceptsHtml;
  }

  if (acceptsJson && !acceptsHtml) {
    return true;
  }

  return false;
};

const sameOriginMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const readOriginFromUrl = (value) => {
  const text = (value || "").toString().trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    return (parsed.origin || "").toLowerCase();
  } catch (_err) {
    return "";
  }
};

const uniqueList = (items) => {
  const set = new Set();
  const result = [];
  (items || []).forEach((item) => {
    const value = (item || "").toString().trim();
    if (!value || set.has(value)) return;
    set.add(value);
    result.push(value);
  });
  return result;
};

const buildContentSecurityPolicy = (nonce) => {
  const safeNonce = (nonce || "").toString().trim();
  const nonceToken = safeNonce ? `'nonce-${safeNonce}'` : "";

  const supabaseOrigin = readOriginFromUrl(supabasePublicConfig && supabasePublicConfig.url);
  const chapterCdnOrigin = readOriginFromUrl(process.env.CHAPTER_CDN_BASE_URL || "");
  const turnstileOrigin = readOriginFromUrl("https://challenges.cloudflare.com");

  const scriptSrc = uniqueList(["'self'", nonceToken, "https://cdn.jsdelivr.net", turnstileOrigin]);
  const connectSrc = uniqueList(["'self'", supabaseOrigin, turnstileOrigin]);
  const imgSrc = uniqueList(["'self'", "data:", "blob:", "https:", chapterCdnOrigin]);
  const frameSrc = uniqueList(["'self'", turnstileOrigin]);
  const styleSrc = uniqueList([
    "'self'",
    "'unsafe-inline'",
    "https://fonts.googleapis.com",
    "https://cdn.jsdelivr.net"
  ]);
  const fontSrc = uniqueList(["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"]);

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    `img-src ${imgSrc.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    `font-src ${fontSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ];

  if (isProductionApp) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
};

const rejectForbiddenRequest = (req, res, message) => {
  if (wantsJson(req)) {
    return res.status(403).json({ ok: false, error: message });
  }
  return res.status(403).send(message);
};

const requireSameOriginForAdminWrites = (req, res, next) => {
  const method = (req.method || "GET").toString().toUpperCase();
  if (sameOriginMethods.has(method)) return next();

  const requestPath = (req.path || "").toString();
  if (!requestPath.startsWith("/admin")) return next();

  const host = (req.get("host") || "").toString().trim().toLowerCase();
  if (!host) return next();

  const expectedOrigin = `${req.protocol}://${host}`.toLowerCase();
  const originHeader = (req.get("origin") || "").toString().trim();
  const refererHeader = (req.get("referer") || "").toString().trim();
  const actualOrigin = readOriginFromUrl(originHeader || refererHeader);

  if (!actualOrigin) {
    const fetchSite = (req.get("sec-fetch-site") || "").toString().trim().toLowerCase();
    if (fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none") {
      return next();
    }
    return rejectForbiddenRequest(req, res, "Yêu cầu không hợp lệ (thiếu Origin/Referer).");
  }

  if (actualOrigin !== expectedOrigin) {
    return rejectForbiddenRequest(req, res, "Origin không hợp lệ.");
  }

  return next();
};

const createRateLimiter = ({ windowMs, max, keyPrefix }) => {
  const store = new Map();
  const ttl = Math.max(1000, Number(windowMs) || 60 * 1000);
  const limit = Math.max(1, Number(max) || 20);
  const prefix = (keyPrefix || "global").toString().trim() || "global";

  return (req, res, next) => {
    const now = Date.now();
    const ip = (req.ip || req.socket?.remoteAddress || "unknown").toString().trim() || "unknown";
    const key = `${prefix}:${ip}`;

    if (store.size > 5000) {
      for (const [entryKey, entry] of store.entries()) {
        if (!entry || now >= entry.resetAt) {
          store.delete(entryKey);
        }
      }
    }

    const existing = store.get(key);
    if (!existing || now >= existing.resetAt) {
      store.set(key, { count: 1, resetAt: now + ttl });
      return next();
    }

    existing.count += 1;
    if (existing.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      if (wantsJson(req)) {
        return res.status(429).json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." });
      }
      return res.status(429).send("Quá nhiều yêu cầu, vui lòng thử lại sau.");
    }

    store.set(key, existing);
    return next();
  };
};

const adminLoginRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: isProductionApp ? 20 : 80,
  keyPrefix: "admin-login"
});

const adminSsoRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: isProductionApp ? 40 : 140,
  keyPrefix: "admin-sso"
});

const isSupabasePublicReady = () =>
  Boolean(supabasePublicConfig && supabasePublicConfig.url && supabasePublicConfig.anonKey);

const readBearerToken = (req) => {
  const header = (req && req.headers && req.headers.authorization
    ? req.headers.authorization
    : ""
  ).toString();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
};

const fetchSupabaseUser = async (accessToken) => {
  const token = (accessToken || "").toString().trim();
  if (!token) return null;
  if (!isSupabasePublicReady()) return null;

  const response = await fetch(`${supabasePublicConfig.url}/auth/v1/user`, {
    headers: {
      apikey: supabasePublicConfig.anonKey,
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return null;
  }

  return data;
};

const isSafeAvatarUrl = (value) => {
  const url = value == null ? "" : String(value).trim();
  if (!url) return false;
  if (url.length > 500) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("/uploads/avatars/")) return true;
  return false;
};

const normalizeAvatarUrl = (value) => (isSafeAvatarUrl(value) ? String(value).trim() : "");

const badgeCodePattern = /^[a-z0-9_]{1,32}$/;

const normalizeBadgeCode = (value) => {
  const raw = (value || "")
    .toString()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  const code = cleaned.slice(0, 32);
  return badgeCodePattern.test(code) ? code : "";
};

const buildAutoBadgeCode = async ({ label, excludeBadgeId }) => {
  const base = normalizeBadgeCode(label);
  if (!base) return "";

  const excludeRaw = Number(excludeBadgeId);
  const excludeId = Number.isFinite(excludeRaw) && excludeRaw > 0 ? Math.floor(excludeRaw) : 0;

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    const headMax = Math.max(1, 32 - suffix.length);
    const candidate = normalizeBadgeCode(`${base.slice(0, headMax)}${suffix}`);
    if (!candidate) continue;

    const conflict = excludeId
      ? await dbGet("SELECT id FROM badges WHERE lower(code) = lower(?) AND id <> ?", [candidate, excludeId])
      : await dbGet("SELECT id FROM badges WHERE lower(code) = lower(?)", [candidate]);
    if (!conflict) {
      return candidate;
    }
  }

  return "";
};

const hexColorPattern = /^#[0-9a-f]{6}$/i;
const shortHexColorPattern = /^#[0-9a-f]{3}$/i;

const normalizeHexColor = (value) => {
  const raw = (value || "").toString().trim();
  if (hexColorPattern.test(raw)) return raw.toLowerCase();
  if (shortHexColorPattern.test(raw)) {
    const hex = raw.slice(1);
    return `#${hex
      .split("")
      .map((c) => `${c}${c}`)
      .join("")}`.toLowerCase();
  }
  return "";
};

let cachedMemberBadgeId = 0;
let cachedMemberBadgeCheckedAt = 0;
const memberBadgeCacheTtlMs = 5 * 60 * 1000;

const getMemberBadgeId = async () => {
  const now = Date.now();
  if (cachedMemberBadgeId && now - cachedMemberBadgeCheckedAt < memberBadgeCacheTtlMs) {
    return cachedMemberBadgeId;
  }
  cachedMemberBadgeCheckedAt = now;

  const row = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  const id = row && row.id != null ? Number(row.id) : 0;
  cachedMemberBadgeId = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
  return cachedMemberBadgeId;
};

const ensureMemberBadgeForUser = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return;
  let memberId = 0;
  try {
    memberId = await getMemberBadgeId();
  } catch (_err) {
    memberId = 0;
  }
  if (!memberId) return;
  await dbRun(
    "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [id, memberId, Date.now()]
  );
};

const mapBadgeRow = (row) => {
  if (!row) return null;
  const code = normalizeBadgeCode(row.code);
  const label = (row.label || "").toString().trim();
  const color = normalizeHexColor(row.color) || "";
  const priority = Number(row.priority);
  const canComment = row && row.can_comment != null ? Boolean(row.can_comment) : true;
  return {
    id: row.id,
    code: code || "badge",
    label: label || code || "Badge",
    color: color || "#f8f8f2",
    priority: Number.isFinite(priority) ? Math.floor(priority) : 0,
    canAccessAdmin: Boolean(row.can_access_admin),
    canDeleteAnyComment: Boolean(row.can_delete_any_comment),
    canComment
  };
};

const getUserBadges = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return [];
  const rows = await dbAll(
    `
    SELECT
      b.id,
      b.code,
      b.label,
      b.color,
      b.priority,
      b.can_access_admin,
      b.can_delete_any_comment,
      b.can_comment
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ?
    ORDER BY b.priority DESC, b.id ASC
  `,
    [id]
  );
  return rows.map(mapBadgeRow).filter(Boolean);
};

const getUserBadgeContext = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) {
    return {
      badges: [],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
  }

  const badges = await getUserBadges(id);
  const sorted = Array.isArray(badges) ? badges.slice() : [];
  sorted.sort((a, b) => {
    const diff = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (diff) return diff;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const permissions = {
    canAccessAdmin: sorted.some((badge) => Boolean(badge.canAccessAdmin)),
    canDeleteAnyComment: sorted.some((badge) => Boolean(badge.canDeleteAnyComment)),
    canComment: sorted.length ? !sorted.some((badge) => badge.canComment === false) : true
  };

  let safeBadges = sorted.map((badge) => ({
    code: badge.code,
    label: badge.label,
    color: normalizeHexColor(badge.color) || badge.color,
    priority: badge.priority
  }));

  if (safeBadges.length === 0) {
    safeBadges = [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }];
  }

  const top = safeBadges[0];
  const userColor = top && top.color ? normalizeHexColor(top.color) || "" : "";

  return {
    badges: safeBadges,
    userColor,
    permissions
  };
};

const buildCommentAuthorFromSupabaseUser = (user) => {
  const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;

  const normalize = (value) => (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
  const clamp = (value, max) => {
    const text = normalize(value);
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (!limit) return "";
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3)}...`;
  };

  const customName = meta && meta.display_name ? clamp(meta.display_name, 30) : "";
  const name = meta && meta.full_name ? normalize(meta.full_name) : "";
  const fallbackName = meta && meta.name ? normalize(meta.name) : "";
  const email = user && user.email ? normalize(user.email) : "";

  const candidate = normalize(customName || name || fallbackName || email || "Người dùng");
  return clamp(candidate, 30) || "Người dùng";
};

const buildAvatarUrlFromSupabaseUser = (user) => {
  const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;
  const raw =
    (meta && meta.avatar_url_custom ? meta.avatar_url_custom : "") ||
    (meta && meta.avatar_url ? meta.avatar_url : "") ||
    (meta && meta.picture ? meta.picture : "") ||
    "";
  return normalizeAvatarUrl(raw);
};

const hasOwnObjectKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const normalizeProfileSocialUrl = ({ value, allowedHosts, canonicalHost, maxLength }) => {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";

  const safeMax = Math.max(1, Math.floor(Number(maxLength) || 0));
  if (safeMax && raw.length > safeMax) return "";

  const safeHosts = Array.isArray(allowedHosts)
    ? allowedHosts
      .map((item) => (item == null ? "" : String(item)).trim().toLowerCase())
      .filter(Boolean)
    : [];
  const preferredHost = (canonicalHost || safeHosts[0] || "").toString().trim().toLowerCase();
  if (!safeHosts.length || !preferredHost) return "";

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }

  let parsed = null;
  try {
    parsed = new URL(candidate);
  } catch (_err) {
    return "";
  }

  const protocol = (parsed.protocol || "").toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") return "";

  const host = (parsed.hostname || "").toLowerCase();
  if (!safeHosts.includes(host)) return "";

  const pathname = (parsed.pathname || "").replace(/\/+$/, "");
  if (!pathname || pathname === "/") return "";

  const search = parsed.search || "";
  return `https://${preferredHost}${pathname}${search}`;
};

const normalizeProfileFacebook = (value) => {
  return normalizeProfileSocialUrl({
    value,
    allowedHosts: ["facebook.com", "www.facebook.com", "m.facebook.com"],
    canonicalHost: "facebook.com",
    maxLength: 180
  });
};

const normalizeProfileDiscord = (value) => {
  return normalizeProfileSocialUrl({
    value,
    allowedHosts: ["discord.gg", "www.discord.gg"],
    canonicalHost: "discord.gg",
    maxLength: 80
  });
};

const normalizeProfileBio = (value) => {
  const raw = value == null ? "" : String(value);
  const compact = raw.replace(/\r\n/g, "\n").trim();
  if (!compact) return "";
  return compact.length <= 300 ? compact : compact.slice(0, 300).trim();
};

const normalizeProfileDisplayName = (value) => {
  const raw = value == null ? "" : String(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= 30) return compact;
  return `${compact.slice(0, 27)}...`;
};

const readUserProfileExtrasFromSupabaseUser = (user, currentRow) => {
  const meta = user && typeof user.user_metadata === "object" && user.user_metadata ? user.user_metadata : {};
  const row = currentRow && typeof currentRow === "object" ? currentRow : {};

  const getValueFromMeta = (keys) => {
    for (const key of keys) {
      if (hasOwnObjectKey(meta, key)) {
        return { hasValue: true, value: meta[key] };
      }
    }
    return { hasValue: false, value: null };
  };

  const facebookFromMeta = getValueFromMeta(["facebook_url", "facebook", "facebookUrl", "facebook_link"]);
  const discordFromMeta = getValueFromMeta([
    "discord_handle",
    "discord_url",
    "discord",
    "discordHandle",
    "discordUrl"
  ]);
  const bioFromMeta = getValueFromMeta(["bio", "about", "about_me"]);

  return {
    facebookUrl: facebookFromMeta.hasValue
      ? normalizeProfileFacebook(facebookFromMeta.value)
      : normalizeProfileFacebook(row.facebook_url),
    discordHandle: discordFromMeta.hasValue
      ? normalizeProfileDiscord(discordFromMeta.value)
      : normalizeProfileDiscord(row.discord_handle),
    bio: bioFromMeta.hasValue ? normalizeProfileBio(bioFromMeta.value) : normalizeProfileBio(row.bio)
  };
};

const requireSupabaseUserForComments = async (req, res) => {
  if (!isSupabasePublicReady()) {
    const message = "Hệ thống đăng nhập chưa được cấu hình.";
    if (wantsJson(req)) {
      res.status(500).json({ error: message });
      return null;
    }
    res.status(500).send(message);
    return null;
  }

  const token = readBearerToken(req);
  if (!token) {
    const message = "Vui lòng đăng nhập bằng Google.";
    if (wantsJson(req)) {
      res.status(401).json({ error: message });
      return null;
    }
    res.status(401).send(message);
    return null;
  }

  let user = null;
  try {
    user = await fetchSupabaseUser(token);
  } catch (err) {
    console.warn("Supabase user verification failed", err);
    const message = "Không thể xác thực đăng nhập. Vui lòng thử lại.";
    if (wantsJson(req)) {
      res.status(503).json({ error: message });
      return null;
    }
    res.status(503).send(message);
    return null;
  }

  if (!user || !user.id) {
    const message = "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.";
    if (wantsJson(req)) {
      res.status(401).json({ error: message });
      return null;
    }
    res.status(401).send(message);
    return null;
  }

  return user;
};

const normalizeUsernameBase = (value) => {
  const raw = (value || "").toString().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  const trimmed = cleaned.slice(0, 24);
  return trimmed || "user";
};

const buildUsernameCandidate = (base, suffix) => {
  const rawBase = (base || "").toString().trim();
  const safeBase = normalizeUsernameBase(rawBase);
  const suffixText = suffix == null ? "" : String(suffix);
  const max = 24;
  const head = safeBase.slice(0, Math.max(1, max - suffixText.length));
  const candidate = `${head}${suffixText}`;
  return normalizeUsernameBase(candidate);
};

const ensureUserRowFromSupabaseUser = async (user) => {
  const id = user && user.id ? String(user.id).trim() : "";
  const email = user && user.email ? String(user.email).trim() : null;
  if (!id) {
    throw new Error("Không xác định được người dùng.");
  }

  const existing = await dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
  if (existing) {
    try {
      await ensureMemberBadgeForUser(id);
    } catch (err) {
      console.warn("Failed to ensure member badge", err);
    }
    return existing;
  }

  const emailText = email ? String(email) : "";
  const localPart = emailText && emailText.includes("@") ? emailText.split("@")[0] : emailText;
  const base = normalizeUsernameBase(localPart);
  const now = Date.now();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(attempt);
    const username = buildUsernameCandidate(base, suffix);
    try {
      await dbRun(
        "INSERT INTO users (id, email, username, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, email, username, "", "", now, now]
      );
      break;
    } catch (err) {
      if (err && err.code === "23505") {
        const row = await dbGet(
          "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
          [id]
        );
        if (row) {
          try {
            await ensureMemberBadgeForUser(id);
          } catch (ensureErr) {
            console.warn("Failed to ensure member badge", ensureErr);
          }
          return row;
        }
        continue;
      }
      throw err;
    }
  }

  const created = await dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
  if (!created) {
    throw new Error("Không tạo được tài khoản.");
  }
  try {
    await ensureMemberBadgeForUser(id);
  } catch (err) {
    console.warn("Failed to ensure member badge", err);
  }
  return created;
};

const upsertUserProfileFromSupabaseUser = async (user) => {
  const row = await ensureUserRowFromSupabaseUser(user);
  const id = String(row.id).trim();
  const email = user && user.email ? String(user.email).trim() : row.email || null;
  const userMeta = user && typeof user.user_metadata === "object" && user.user_metadata ? user.user_metadata : {};
  const displayNameFromAuth = normalizeProfileDisplayName(buildCommentAuthorFromSupabaseUser(user));
  const currentDisplayName = normalizeProfileDisplayName(row && row.display_name ? row.display_name : "");
  const displayName = hasOwnObjectKey(userMeta, "display_name")
    ? displayNameFromAuth
    : currentDisplayName || displayNameFromAuth;
  const avatarUrl = buildAvatarUrlFromSupabaseUser(user);
  const extras = readUserProfileExtrasFromSupabaseUser(user, row);
  const now = Date.now();

  await dbRun(
    "UPDATE users SET email = ?, display_name = ?, avatar_url = ?, facebook_url = ?, discord_handle = ?, bio = ?, updated_at = ? WHERE id = ?",
    [
      email,
      displayName,
      avatarUrl,
      extras.facebookUrl,
      extras.discordHandle,
      extras.bio,
      now,
      id
    ]
  );

  return dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
};

const mapPublicUserRow = (row) => {
  if (!row) return null;
  const createdAt = row.created_at == null ? null : row.created_at;
  const createdAtDate = createdAt == null || createdAt === "" ? null : new Date(createdAt);
  const joinedAtText =
    createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? formatDate(createdAtDate) : "";
  return {
    id: row.id,
    email: row.email || "",
    username: row.username || "",
    displayName: row.display_name || "",
    avatarUrl: normalizeAvatarUrl(row.avatar_url || ""),
    joinedAtText,
    facebookUrl: normalizeProfileFacebook(row.facebook_url),
    discordUrl: normalizeProfileDiscord(row.discord_handle),
    discordHandle: normalizeProfileDiscord(row.discord_handle),
    bio: normalizeProfileBio(row.bio)
  };
};

const normalizeMentionSearchQuery = (value) => {
  const raw = (value || "").toString().trim().replace(/^@+/, "");
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").slice(0, 40);
};

const getCommentMentionRegex = () => /(^|[^a-z0-9_])@([a-z0-9_]{1,24})/gi;

const extractMentionUsernamesFromContent = (content) => {
  const text = (content || "").toString();
  if (!text) return [];

  const regex = getCommentMentionRegex();
  const names = [];
  const seen = new Set();
  let match = regex.exec(text);
  while (match) {
    const username = match && match[2] ? String(match[2]).trim().toLowerCase() : "";
    if (username && !seen.has(username)) {
      seen.add(username);
      names.push(username);
      if (names.length >= 20) break;
    }
    match = regex.exec(text);
  }

  return names;
};

const buildCommentNotificationPreview = (value) => {
  const raw = (value || "").toString();
  if (!raw) return "";

  const compact = raw.replace(/\[sticker:[a-z0-9_-]+\]/gi, " [sticker] ").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177)}...`;
};

const buildCommentPermalink = ({ mangaSlug, chapterNumber, commentId, commentPage }) => {
  const slug = (mangaSlug || "").toString().trim();
  if (!slug) return "/";

  const safeSlug = encodeURIComponent(slug);
  const commentIdValue = Number(commentId);
  const anchor =
    Number.isFinite(commentIdValue) && commentIdValue > 0
      ? `#comment-${Math.floor(commentIdValue)}`
      : "#comments";

  const chapterValue = chapterNumber == null ? null : Number(chapterNumber);
  const pageValue = Number(commentPage);
  const query = Number.isFinite(pageValue) && pageValue > 1 ? `?commentPage=${Math.floor(pageValue)}` : "";
  if (Number.isFinite(chapterValue)) {
    return `/manga/${safeSlug}/chapters/${chapterValue}${query}${anchor}`;
  }

  return `/manga/${safeSlug}${query}${anchor}`;
};

const getMentionCandidatesForManga = async ({ mangaId, currentUserId, query, limit }) => {
  const mangaValue = Number(mangaId);
  if (!Number.isFinite(mangaValue) || mangaValue <= 0) return [];

  const safeMangaId = Math.floor(mangaValue);
  const safeCurrentUserId = (currentUserId || "").toString().trim();
  const safeQuery = normalizeMentionSearchQuery(query).toLowerCase();
  const limitValue = Number(limit);
  const safeLimit = Number.isFinite(limitValue)
    ? Math.max(1, Math.min(COMMENT_MENTION_FETCH_LIMIT, Math.floor(limitValue)))
    : COMMENT_MENTION_FETCH_LIMIT;

  const params = [safeMangaId, safeMangaId];
  let excludeClause = "";
  if (safeCurrentUserId) {
    excludeClause = "AND u.id <> ?";
    params.push(safeCurrentUserId);
  }

  let searchClause = "";
  let orderClause = "";
  if (safeQuery) {
    const containsValue = `%${safeQuery}%`;
    const prefixValue = `${safeQuery}%`;
    searchClause =
      "AND (lower(u.username) LIKE ? OR lower(COALESCE(u.display_name, '')) LIKE ?)";
    params.push(containsValue, containsValue);
    orderClause = `
      ORDER BY
        CASE
          WHEN lower(u.username) = ? THEN 0
          WHEN lower(COALESCE(u.display_name, '')) = ? THEN 1
          WHEN lower(u.username) LIKE ? THEN 2
          WHEN lower(COALESCE(u.display_name, '')) LIKE ? THEN 3
          WHEN lower(u.username) LIKE ? THEN 4
          WHEN lower(COALESCE(u.display_name, '')) LIKE ? THEN 5
          ELSE 6
        END ASC,
        COALESCE(cs.last_commented_at, '') DESC,
        COALESCE(bf.is_admin, 0) DESC,
        COALESCE(bf.is_mod, 0) DESC,
        lower(COALESCE(u.display_name, '')) ASC,
        lower(u.username) ASC
    `;
    params.push(safeQuery, safeQuery, prefixValue, prefixValue, containsValue, containsValue);
  } else {
    orderClause = `
      ORDER BY
        COALESCE(cs.last_commented_at, '') DESC,
        COALESCE(bf.is_admin, 0) DESC,
        COALESCE(bf.is_mod, 0) DESC,
        lower(COALESCE(u.display_name, '')) ASC,
        lower(u.username) ASC
    `;
  }

  params.push(safeLimit);

  return dbAll(
    `
      WITH commenter_users AS (
        SELECT DISTINCT c.author_user_id as user_id
        FROM comments c
        WHERE c.manga_id = ?
          AND c.status = 'visible'
          AND c.author_user_id IS NOT NULL
          AND TRIM(c.author_user_id) <> ''
      ),
      role_users AS (
        SELECT DISTINCT ub.user_id
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE lower(b.code) IN ('admin', 'mod')
      ),
      allowed_users AS (
        SELECT user_id FROM commenter_users
        UNION
        SELECT user_id FROM role_users
      ),
      badge_flags AS (
        SELECT
          ub.user_id,
          MAX(CASE WHEN lower(b.code) = 'admin' THEN 1 ELSE 0 END) as is_admin,
          MAX(CASE WHEN lower(b.code) = 'mod' THEN 1 ELSE 0 END) as is_mod
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        GROUP BY ub.user_id
      ),
      commenter_stats AS (
        SELECT
          c.author_user_id as user_id,
          MAX(c.created_at) as last_commented_at
        FROM comments c
        WHERE c.manga_id = ?
          AND c.status = 'visible'
          AND c.author_user_id IS NOT NULL
          AND TRIM(c.author_user_id) <> ''
        GROUP BY c.author_user_id
      )
      SELECT
        u.id,
        u.username,
        u.display_name,
        u.avatar_url,
        COALESCE(bf.is_admin, 0) as is_admin,
        COALESCE(bf.is_mod, 0) as is_mod,
        CASE WHEN cs.user_id IS NULL THEN false ELSE true END as has_commented,
        cs.last_commented_at
      FROM allowed_users au
      JOIN users u ON u.id = au.user_id
      LEFT JOIN badge_flags bf ON bf.user_id = u.id
      LEFT JOIN commenter_stats cs ON cs.user_id = u.id
      WHERE u.username IS NOT NULL
        AND TRIM(u.username) <> ''
        ${excludeClause}
        ${searchClause}
      ${orderClause}
      LIMIT ?
    `,
    params
  );
};

const getMentionProfileMapForManga = async ({ mangaId, usernames }) => {
  const mangaValue = Number(mangaId);
  if (!Number.isFinite(mangaValue) || mangaValue <= 0) return new Map();

  const safeMangaId = Math.floor(mangaValue);
  const safeUsernames = Array.from(
    new Set(
      (Array.isArray(usernames) ? usernames : [])
        .map((value) => (value == null ? "" : String(value)).trim().toLowerCase())
        .filter((value) => /^[a-z0-9_]{1,24}$/.test(value))
    )
  ).slice(0, 20);
  if (!safeUsernames.length) return new Map();

  const placeholders = safeUsernames.map(() => "?").join(",");
  const rows = await dbAll(
    `
      WITH commenter_users AS (
        SELECT DISTINCT c.author_user_id as user_id
        FROM comments c
        WHERE c.manga_id = ?
          AND c.status = 'visible'
          AND c.author_user_id IS NOT NULL
          AND TRIM(c.author_user_id) <> ''
      ),
      role_users AS (
        SELECT DISTINCT ub.user_id
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE lower(b.code) IN ('admin', 'mod')
      ),
      allowed_users AS (
        SELECT user_id FROM commenter_users
        UNION
        SELECT user_id FROM role_users
      ),
      badge_colors AS (
        SELECT
          ub.user_id,
          (array_agg(b.color ORDER BY b.priority DESC, b.id ASC))[1] as user_color
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        GROUP BY ub.user_id
      )
      SELECT
        u.id,
        lower(u.username) as username,
        u.display_name,
        bc.user_color
      FROM allowed_users au
      JOIN users u ON u.id = au.user_id
      LEFT JOIN badge_colors bc ON bc.user_id = u.id
      WHERE lower(COALESCE(u.username, '')) IN (${placeholders})
    `,
    [safeMangaId, ...safeUsernames]
  );

  const map = new Map();
  rows.forEach((row) => {
    const username = row && row.username ? String(row.username).trim().toLowerCase() : "";
    if (!username) return;
    const id = row && row.id ? String(row.id).trim() : "";
    if (!id) return;

    const displayName =
      row && row.display_name ? String(row.display_name).replace(/\s+/g, " ").trim() : "";
    const colorRaw = row && row.user_color ? String(row.user_color).trim() : "";
    const color = normalizeHexColor(colorRaw);

    map.set(username, {
      id,
      username,
      name: displayName || `@${username}`,
      userColor: color || ""
    });
  });
  return map;
};

const buildCommentMentionsForContent = ({ content, mentionProfileMap }) => {
  const usernames = extractMentionUsernamesFromContent(content);
  if (!usernames.length) return [];

  const map = mentionProfileMap instanceof Map ? mentionProfileMap : new Map();
  const mentions = [];
  const seenUserIds = new Set();

  usernames.forEach((username) => {
    const key = (username || "").toString().trim().toLowerCase();
    if (!key) return;
    const profile = map.get(key);
    if (!profile || !profile.id) return;
    if (seenUserIds.has(profile.id)) return;
    seenUserIds.add(profile.id);

    mentions.push({
      userId: profile.id,
      username: profile.username,
      name: profile.name,
      userColor: profile.userColor || ""
    });
  });

  return mentions;
};

const findMentionTargetsForComment = async ({ mangaId, usernames, authorUserId }) => {
  const mentionMap = await getMentionProfileMapForManga({ mangaId, usernames });
  if (!mentionMap.size) return [];

  const authorId = (authorUserId || "").toString().trim();
  return Array.from(mentionMap.values())
    .filter((profile) => {
      const id = profile && profile.id ? String(profile.id).trim() : "";
      if (!id) return false;
      if (authorId && id === authorId) return false;
      return true;
    })
    .map((profile) => ({
      id: profile.id,
      username: profile.username
    }));
};

const createMentionNotificationsForComment = async ({
  mangaId,
  chapterNumber,
  commentId,
  content,
  authorUserId
}) => {
  const commentValue = Number(commentId);
  if (!Number.isFinite(commentValue) || commentValue <= 0) return 0;

  const mentionUsernames = extractMentionUsernamesFromContent(content);
  if (!mentionUsernames.length) return 0;

  const targets = await findMentionTargetsForComment({
    mangaId,
    usernames: mentionUsernames,
    authorUserId
  });
  if (!targets.length) return 0;

  const safeMangaId = Math.floor(Number(mangaId));
  const safeCommentId = Math.floor(commentValue);
  const chapterValue = chapterNumber == null ? null : Number(chapterNumber);
  const safeChapterNumber = Number.isFinite(chapterValue) ? chapterValue : null;
  const safeAuthorUserId = (authorUserId || "").toString().trim();
  const preview = buildCommentNotificationPreview(content);
  const createdAt = Date.now();

  let createdCount = 0;
  for (const target of targets) {
    const targetUserId = target && target.id ? String(target.id).trim() : "";
    if (!targetUserId) continue;

    const result = await dbRun(
      `
        INSERT INTO notifications (
          user_id,
          type,
          actor_user_id,
          manga_id,
          chapter_number,
          comment_id,
          content_preview,
          is_read,
          created_at,
          read_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, false, ?, NULL)
        ON CONFLICT DO NOTHING
      `,
      [
        targetUserId,
        NOTIFICATION_TYPE_MENTION,
        safeAuthorUserId || null,
        safeMangaId,
        safeChapterNumber,
        safeCommentId,
        preview,
        createdAt
      ]
    );

    if (result && result.changes) {
      createdCount += result.changes;
    }
  }

  return createdCount;
};

const getUnreadNotificationCount = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return 0;

  const row = await dbGet(
    "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = false",
    [id]
  );
  return row ? Number(row.count) || 0 : 0;
};

const cleanupOldNotifications = async () => {
  const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
  const result = await dbRun("DELETE FROM notifications WHERE created_at < ?", [cutoff]);
  return result && result.changes ? result.changes : 0;
};

const scheduleNotificationCleanup = () => {
  const run = async () => {
    try {
      await cleanupOldNotifications();
    } catch (err) {
      console.warn("Notification cleanup failed", err);
    }
  };

  run();
  const timer = setInterval(run, NOTIFICATION_CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

const getCommentRootId = async (commentId) => {
  const idValue = Number(commentId);
  if (!Number.isFinite(idValue) || idValue <= 0) return 0;

  const row = await dbGet(
    `
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id
        FROM comments
        WHERE id = ?
        UNION ALL
        SELECT c.id, c.parent_id
        FROM comments c
        JOIN ancestors a ON c.id = a.parent_id
      )
      SELECT id
      FROM ancestors
      WHERE parent_id IS NULL
      ORDER BY id ASC
      LIMIT 1
    `,
    [Math.floor(idValue)]
  );

  const rootId = row && row.id != null ? Number(row.id) : NaN;
  return Number.isFinite(rootId) && rootId > 0 ? Math.floor(rootId) : 0;
};

const getCommentPageForRoot = async ({ mangaId, chapterNumber, rootId, perPage }) => {
  const rootValue = Number(rootId);
  if (!Number.isFinite(rootValue) || rootValue <= 0) return 1;

  const scope = resolveCommentScope({ mangaId, chapterNumber });
  if (!scope) return 1;

  const safePerPageValue = Number(perPage);
  const safePerPage = Number.isFinite(safePerPageValue)
    ? Math.max(1, Math.min(50, Math.floor(safePerPageValue)))
    : 20;

  const row = await dbGet(
    `
      WITH RECURSIVE branch AS (
        SELECT
          c.id,
          c.parent_id,
          c.id as root_id
        FROM comments c
        WHERE ${scope.whereVisible}
          AND c.parent_id IS NULL
        UNION ALL
        SELECT
          child.id,
          child.parent_id,
          branch.root_id
        FROM comments child
        JOIN branch ON child.parent_id = branch.id
        WHERE child.status = 'visible'
      ),
      root_stats AS (
        SELECT
          branch.root_id,
          COUNT(*) as subtree_count,
          root.created_at as root_created_at
        FROM branch
        JOIN comments root ON root.id = branch.root_id
        GROUP BY branch.root_id, root.created_at
      ),
      ordered AS (
        SELECT
          root_id,
          COALESCE(
            SUM(subtree_count) OVER (
              ORDER BY root_created_at DESC, root_id DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ),
            0
          ) as comments_before
        FROM root_stats
      )
      SELECT comments_before
      FROM ordered
      WHERE root_id = ?
      LIMIT 1
    `,
    [...scope.params, Math.floor(rootValue)]
  );

  const commentsBefore = row && row.comments_before != null ? Number(row.comments_before) : 0;
  if (!Number.isFinite(commentsBefore) || commentsBefore <= 0) return 1;
  return Math.max(1, Math.floor(commentsBefore / safePerPage) + 1);
};

const resolveCommentPermalinkForNotification = async ({
  mangaSlug,
  mangaId,
  chapterNumber,
  commentId,
  perPage
}) => {
  const commentValue = Number(commentId);
  if (!Number.isFinite(commentValue) || commentValue <= 0) {
    return buildCommentPermalink({ mangaSlug, chapterNumber, commentId: null });
  }

  const rootId = await getCommentRootId(commentValue);
  if (!rootId) {
    return buildCommentPermalink({
      mangaSlug,
      chapterNumber,
      commentId: Math.floor(commentValue)
    });
  }

  const page = await getCommentPageForRoot({
    mangaId,
    chapterNumber,
    rootId,
    perPage
  });

  return buildCommentPermalink({
    mangaSlug,
    chapterNumber,
    commentId: Math.floor(commentValue),
    commentPage: page
  });
};

const mapNotificationRow = (row, options = {}) => {
  const settings = options && typeof options === "object" ? options : {};
  const resolvedUrl = settings.url ? String(settings.url).trim() : "";
  const actorName =
    (row && row.actor_display_name ? String(row.actor_display_name).replace(/\s+/g, " ").trim() : "") ||
    (row && row.actor_username ? `@${String(row.actor_username).trim()}` : "Một thành viên");
  const mangaTitle = row && row.manga_title ? String(row.manga_title).trim() : "Truyện";
  const chapterValue = row && row.chapter_number != null ? Number(row.chapter_number) : NaN;
  const hasChapter = Number.isFinite(chapterValue);
  const chapterLabel = hasChapter ? `Ch. ${chapterValue}` : "Trang truyện";
  const preview = row && row.content_preview ? String(row.content_preview).trim() : "";
  const createdAt = row && row.created_at != null ? Number(row.created_at) : NaN;

  return {
    id: row.id,
    type: row.type,
    isRead: Boolean(row.is_read),
    actorName,
    actorAvatarUrl: normalizeAvatarUrl(row && row.actor_avatar_url ? row.actor_avatar_url : ""),
    mangaTitle,
    chapterLabel,
    preview,
    message: `${actorName} đã nhắc bạn trong bình luận.`,
    createdAtText: Number.isFinite(createdAt) ? formatTimeAgo(createdAt) : "",
    url:
      resolvedUrl ||
      buildCommentPermalink({
        mangaSlug: row && row.manga_slug ? row.manga_slug : "",
        chapterNumber: hasChapter ? chapterValue : null,
        commentId: row && row.comment_id != null ? row.comment_id : null
      })
  };
};

const isAdminConfigured = () => Boolean(isPasswordAdminEnabled && adminConfig.user && adminConfig.pass);

const denyAdminAccess = (req, res) => {
  if (wantsJson(req)) {
    return res.status(401).json({ ok: false, error: "Vui lòng đăng nhập admin." });
  }
  return res.redirect("/admin/login");
};

const regenerateSession = (req) =>
  new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== "function") {
      resolve();
      return;
    }
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

const requireAdmin = (req, res, next) => {
  Promise.resolve()
    .then(async () => {
      if (!req.session || !req.session.isAdmin) {
        return denyAdminAccess(req, res);
      }

      const mode = (req.session.adminAuth || "password").toString().trim().toLowerCase();
      if (mode !== "badge") {
        return next();
      }

      const adminUserId = (req.session.adminUserId || "").toString().trim();
      if (!adminUserId) {
        req.session.isAdmin = false;
        delete req.session.adminAuth;
        delete req.session.adminUserId;
        return denyAdminAccess(req, res);
      }

      const badgeContext = await getUserBadgeContext(adminUserId);
      const canAccessAdmin = Boolean(
        badgeContext && badgeContext.permissions && badgeContext.permissions.canAccessAdmin
      );
      if (!canAccessAdmin) {
        req.session.isAdmin = false;
        delete req.session.adminAuth;
        delete req.session.adminUserId;
        return denyAdminAccess(req, res);
      }

      return next();
    })
    .catch(next);
};

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  compression({
    threshold: 1024
  })
);

const forceSecureCookie = parseEnvBoolean(process.env.SESSION_COOKIE_SECURE, isProductionApp);
const enableCsp = parseEnvBoolean(process.env.CSP_ENABLED, true);
const cspReportOnly = parseEnvBoolean(process.env.CSP_REPORT_ONLY, false);
if (isProductionApp && forceSecureCookie && !trustProxy) {
  console.warn("APP_ENV=production + SESSION_COOKIE_SECURE=true; nếu chạy sau reverse proxy, hãy đặt TRUST_PROXY=1.");
}

app.use((req, res, next) => {
  const nonce = crypto.randomBytes(18).toString("base64");
  res.locals.cspNonce = nonce;

  if (enableCsp) {
    const policy = buildContentSecurityPolicy(nonce);
    if (cspReportOnly) {
      res.set("Content-Security-Policy-Report-Only", policy);
    } else {
      res.set("Content-Security-Policy", policy);
    }
  }

  if (isProductionApp && req.secure) {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
});

app.use((req, res, next) => {
  const pathValue = ensureLeadingSlash(req.path || "/");
  const isAdminPath = pathValue === "/admin" || pathValue.startsWith("/admin/");
  const isAccountPath = pathValue === "/account" || pathValue.startsWith("/account/");
  const isAuthCallbackPath = pathValue === "/auth/callback";
  const isPrivatePath = isAdminPath || isAccountPath || isAuthCallbackPath;
  const robotsValue = isPrivatePath ? SEO_ROBOTS_NOINDEX : SEO_ROBOTS_INDEX;

  res.locals.supabasePublicConfig = getSupabasePublicConfigForRequest(req);
  res.locals.assetVersion = app.locals.assetVersion;

  res.locals.seo = buildSeoPayload(req, {
    canonicalPath: pathValue,
    robots: robotsValue,
    ogType: pathValue === "/" ? "website" : "article"
  });
  res.locals.requestPath = pathValue;
  res.locals.isAdminPath = isAdminPath;

  if (isPrivatePath) {
    res.set("X-Robots-Tag", SEO_ROBOTS_NOINDEX);
  }

  next();
});

app.use(
  session({
    name: "bfang.sid",
    secret: adminConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: trustProxy,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: forceSecureCookie,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);
app.use(requireSameOriginForAdminWrites);
app.use("/vendor/emoji-mart", express.static(path.join(__dirname, "node_modules", "emoji-mart")));
app.use(
  "/vendor/emoji-mart-data",
  express.static(path.join(__dirname, "node_modules", "@emoji-mart", "data"))
);
const stickerManifestFilePattern = /^([a-z0-9_-]+)\.(png|webp|gif|jpe?g|avif)$/i;

const buildStickerLabel = (code) => {
  const raw = (code || "").toString().trim();
  if (!raw) return "Sticker";

  return raw
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) {
        return part.padStart(2, "0");
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
};

const readStickerManifest = async () => {
  let entries = [];
  try {
    entries = await fs.promises.readdir(stickersDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => {
      const fileName = (entry.name || "").toString().trim();
      const matched = stickerManifestFilePattern.exec(fileName);
      if (!matched) return null;
      const code = matched[1].toLowerCase();
      return {
        code,
        label: buildStickerLabel(code),
        src: `/stickers/${fileName}`
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.code.localeCompare(right.code, "en", { numeric: true, sensitivity: "base" }));
};

app.get(
  "/stickers/manifest.json",
  asyncHandler(async (req, res) => {
    try {
      const stickers = await readStickerManifest();
      const payload = { stickers };
      const payloadText = JSON.stringify(payload);
      const etag = `"${crypto.createHash("sha1").update(payloadText).digest("hex")}"`;
      const requestEtag = (req.get("if-none-match") || "").toString();

      res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      res.set("ETag", etag);

      if (requestEtag.includes(etag)) {
        return res.status(304).end();
      }

      return res.json(payload);
    } catch (error) {
      console.warn("Cannot build sticker manifest.", error);
      return res.status(500).json({
        error: "Không thể tải danh sách sticker."
      });
    }
  })
);

app.use(
  "/stickers",
  express.static(stickersDir, {
    maxAge: "365d",
    immutable: true
  })
);

const getMinifiedStylesheetPayload = (() => {
  const stylesheetPath = path.join(publicDir, "styles.css");
  let cachedMtimeMs = -1;
  let cachedPayload = null;

  return () => {
    const stat = fs.statSync(stylesheetPath);
    const mtimeMs = Number(stat.mtimeMs || 0);
    if (cachedPayload && cachedMtimeMs === mtimeMs) {
      return cachedPayload;
    }

    const sourceCss = fs.readFileSync(stylesheetPath, "utf8");
    const result = cssMinifier.minify(sourceCss);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error(result.errors.join("; "));
    }

    const minifiedCss = (result.styles || "").toString() || sourceCss;
    const etag = `"${crypto.createHash("sha1").update(minifiedCss).digest("hex")}"`;
    const lastModified = stat.mtime.toUTCString();
    cachedMtimeMs = mtimeMs;
    cachedPayload = {
      css: minifiedCss,
      etag,
      lastModified
    };
    return cachedPayload;
  };
})();

const getMinifiedScriptPayload = (() => {
  const scriptCache = new Map();

  return async (scriptName) => {
    const safeScriptName = (scriptName || "").toString().trim();
    if (!/^[a-z0-9_-]+$/i.test(safeScriptName)) {
      throw new Error("Invalid script name.");
    }

    const scriptPath = path.join(publicDir, `${safeScriptName}.js`);
    const stat = fs.statSync(scriptPath);
    if (!stat.isFile()) {
      throw new Error("Script file unavailable.");
    }

    const mtimeMs = Number(stat.mtimeMs || 0);
    const cached = scriptCache.get(safeScriptName);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.payload;
    }

    const sourceJs = fs.readFileSync(scriptPath, "utf8");
    const result = await minifyJs(sourceJs, {
      compress: {
        passes: 2
      },
      mangle: true,
      format: {
        comments: false
      }
    });

    const minifiedJs = ((result && result.code) || "").toString().trim() || sourceJs;
    const payload = {
      content: minifiedJs,
      etag: `"${crypto.createHash("sha1").update(minifiedJs).digest("hex")}"`,
      lastModified: stat.mtime.toUTCString()
    };

    scriptCache.set(safeScriptName, {
      mtimeMs,
      payload
    });
    return payload;
  };
})();

if (isProductionApp) {
  app.get(/^\/([a-z0-9_-]+)\.js$/i, (req, res, next) => {
    const scriptName = req && req.params && req.params[0] ? String(req.params[0]).trim() : "";
    if (!scriptName) {
      return next();
    }

    return getMinifiedScriptPayload(scriptName)
      .then((payload) => {
        const requestEtag = (req.get("if-none-match") || "").toString();
        const requestModifiedSince = (req.get("if-modified-since") || "").toString();

        res.type("application/javascript; charset=utf-8");
        res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
        res.set("ETag", payload.etag);
        res.set("Last-Modified", payload.lastModified);
        res.set("X-Asset-Minified", "1");

        if (requestEtag.includes(payload.etag) || requestModifiedSince === payload.lastModified) {
          return res.status(304).end();
        }

        return res.send(payload.content);
      })
      .catch((error) => {
        if (error && error.code === "ENOENT") {
          return next();
        }
        console.warn(`Cannot serve minified /${scriptName}.js in production.`, error);
        return next();
      });
  });

  app.get("/styles.css", (req, res, next) => {
    try {
      const payload = getMinifiedStylesheetPayload();
      const requestEtag = (req.get("if-none-match") || "").toString();
      const requestModifiedSince = (req.get("if-modified-since") || "").toString();

      res.type("text/css; charset=utf-8");
      res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.set("ETag", payload.etag);
      res.set("Last-Modified", payload.lastModified);
      res.set("X-Asset-Minified", "1");

      if (requestEtag.includes(payload.etag) || requestModifiedSince === payload.lastModified) {
        return res.status(304).end();
      }

      return res.send(payload.css);
    } catch (error) {
      console.warn("Cannot serve minified /styles.css in production.", error);
      return next();
    }
  });
}

app.use(express.static(publicDir));
app.use("/uploads", express.static(uploadDir));

app.locals.formatDate = formatDate;
app.locals.formatDateTime = formatDateTime;
app.locals.formatTimeAgo = formatTimeAgo;
app.locals.cacheBust = cacheBust;
app.locals.assetVersion = serverAssetVersion;

app.get("/auth/callback", (req, res) => {
  res.render("auth-callback", {
    title: "Đang đăng nhập...",
    team,
    headScripts: {
      auth: false,
      confirm: false,
      readingHistory: false,
      notifications: false,
      comments: false,
      mangaDetail: false,
      filters: false,
      reader: false,
      admin: false
    },
    seo: buildSeoPayload(req, {
      title: "Đang đăng nhập",
      description: "Đang xác thực đăng nhập Google.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: "/auth/callback"
    })
  });
});

app.get("/account", (req, res) => {
  res.render("account", {
    title: "Tài khoản",
    team,
    seo: buildSeoPayload(req, {
      title: "Tài khoản",
      description: "Quản lý thông tin hồ sơ và cài đặt tài khoản BFANG Team.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: "/account",
      ogType: "profile"
    })
  });
});

app.get("/account/history", (req, res) => {
  res.render("reading-history", {
    title: "Lịch sử đọc",
    team,
    seo: buildSeoPayload(req, {
      title: "Lịch sử đọc",
      description: "Theo dõi truyện đang đọc dở và mở nhanh chương đang đọc.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: "/account/history",
      ogType: "profile"
    })
  });
});

app.get("/robots.txt", (req, res) => {
  const origin = getPublicOriginFromRequest(req);
  const sitemapUrl = origin ? `${origin}/sitemap.xml` : "/sitemap.xml";

  res.type("text/plain; charset=utf-8");
  return res.send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /admin/",
      "Disallow: /account",
      "Disallow: /auth/callback",
      "",
      `Sitemap: ${sitemapUrl}`
    ].join("\n")
  );
});

app.get(
  "/sitemap.xml",
  asyncHandler(async (req, res) => {
    const baseUrls = [
      {
        loc: toAbsolutePublicUrl(req, "/"),
        changefreq: "daily",
        priority: "1.0"
      },
      {
        loc: toAbsolutePublicUrl(req, "/manga"),
        changefreq: "daily",
        priority: "0.9"
      }
    ];

    const mangaRows = await dbAll(
      "SELECT slug, updated_at FROM manga WHERE COALESCE(is_hidden, 0) = 0 ORDER BY updated_at DESC, id DESC"
    );
    const chapterRows = await dbAll(
      `
        SELECT
          m.slug,
          c.number,
          COALESCE(NULLIF(TRIM(c.date), ''), m.updated_at) as updated_at
        FROM chapters c
        JOIN manga m ON m.id = c.manga_id
        WHERE COALESCE(m.is_hidden, 0) = 0
        ORDER BY m.id ASC, c.number DESC
      `
    );

    const urlEntries = baseUrls.slice();

    mangaRows.forEach((row) => {
      const slug = row && row.slug ? String(row.slug).trim() : "";
      if (!slug) return;

      urlEntries.push({
        loc: toAbsolutePublicUrl(req, `/manga/${encodeURIComponent(slug)}`),
        lastmod: toIsoDate(row.updated_at),
        changefreq: "daily",
        priority: "0.8"
      });
    });

    chapterRows.forEach((row) => {
      const slug = row && row.slug ? String(row.slug).trim() : "";
      const chapterNumber = row && row.number != null ? String(row.number).trim() : "";
      if (!slug || !chapterNumber) return;

      urlEntries.push({
        loc: toAbsolutePublicUrl(
          req,
          `/manga/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapterNumber)}`
        ),
        lastmod: toIsoDate(row.updated_at),
        changefreq: "weekly",
        priority: "0.7"
      });
    });

    const xmlBody = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...urlEntries.map((item) => {
        const loc = escapeXml(item.loc || "");
        const lastmod = item.lastmod ? `<lastmod>${escapeXml(item.lastmod)}</lastmod>` : "";
        const changefreq = item.changefreq ? `<changefreq>${escapeXml(item.changefreq)}</changefreq>` : "";
        const priority = item.priority ? `<priority>${escapeXml(item.priority)}</priority>` : "";
        return `<url><loc>${loc}</loc>${lastmod}${changefreq}${priority}</url>`;
      }),
      "</urlset>"
    ].join("");

    res.type("application/xml");
    return res.send(xmlBody);
  })
);

app.get(
  "/account/me",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const profileRow = await upsertUserProfileFromSupabaseUser(user);
    const badgeContext = await getUserBadgeContext(profileRow && profileRow.id ? profileRow.id : "");
    return res.json({
      ok: true,
      profile: {
        ...mapPublicUserRow(profileRow),
        badges: badgeContext.badges,
        userColor: badgeContext.userColor,
        permissions: badgeContext.permissions
      }
    });
  })
);

app.get(
  "/account/reading-history",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromSupabaseUser(user);
    } catch (err) {
      console.warn("Failed to ensure user row for reading history", err);
    }

    const rows = await dbAll(
      `
      SELECT
        rh.user_id,
        rh.manga_id,
        rh.chapter_number,
        rh.updated_at,
        m.title as manga_title,
        m.slug as manga_slug,
        m.author as manga_author,
        m.group_name as manga_group_name,
        m.genres as manga_genres,
        m.cover as manga_cover,
        COALESCE(m.cover_updated_at, 0) as manga_cover_updated_at,
        m.status as manga_status,
        COALESCE(c.title, '') as chapter_title,
        COALESCE(c.is_oneshot, false) as chapter_is_oneshot,
        (SELECT number FROM chapters c2 WHERE c2.manga_id = m.id ORDER BY number DESC LIMIT 1)
          as latest_chapter_number,
        (SELECT COALESCE(c2.is_oneshot, false) FROM chapters c2 WHERE c2.manga_id = m.id ORDER BY number DESC LIMIT 1)
          as latest_chapter_is_oneshot
      FROM reading_history rh
      JOIN manga m ON m.id = rh.manga_id
      LEFT JOIN chapters c ON c.manga_id = rh.manga_id AND c.number = rh.chapter_number
      WHERE rh.user_id = ?
        AND COALESCE(m.is_hidden, 0) = 0
      ORDER BY rh.updated_at DESC, rh.manga_id DESC
      LIMIT ?
    `,
      [userId, READING_HISTORY_MAX_ITEMS]
    );

    const history = rows.map(mapReadingHistoryRow);
    return res.json({ ok: true, history });
  })
);

app.post(
  "/account/reading-history",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromSupabaseUser(user);
    } catch (err) {
      console.warn("Failed to ensure user row for reading history upsert", err);
    }

    const mangaSlug = (req.body && req.body.mangaSlug ? String(req.body.mangaSlug) : "").trim();
    const chapterNumber = parseChapterNumberInput(req.body ? req.body.chapterNumber : null);
    if (!mangaSlug || chapterNumber == null || chapterNumber < 0) {
      return res.status(400).json({ ok: false, error: "Thiếu thông tin lịch sử đọc." });
    }

    const mangaRow = await dbGet(
      "SELECT id, slug FROM manga WHERE slug = ? AND COALESCE(is_hidden, 0) = 0",
      [mangaSlug]
    );
    if (!mangaRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy truyện." });
    }

    const chapterRow = await dbGet(
      "SELECT number FROM chapters WHERE manga_id = ? AND number = ? LIMIT 1",
      [mangaRow.id, chapterNumber]
    );
    if (!chapterRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy chương." });
    }

    const stamp = Date.now();
    await withTransaction(async ({ dbRun: txRun }) => {
      await txRun(
        `
        INSERT INTO reading_history (user_id, manga_id, chapter_number, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, manga_id)
        DO UPDATE SET
          chapter_number = EXCLUDED.chapter_number,
          updated_at = EXCLUDED.updated_at
      `,
        [userId, mangaRow.id, chapterNumber, stamp]
      );

      await txRun(
        `
        WITH keep AS (
          SELECT manga_id
          FROM reading_history
          WHERE user_id = ?
          ORDER BY updated_at DESC, manga_id DESC
          LIMIT ?
        )
        DELETE FROM reading_history
        WHERE user_id = ?
          AND manga_id NOT IN (SELECT manga_id FROM keep)
      `,
        [userId, READING_HISTORY_MAX_ITEMS, userId]
      );
    });

    return res.json({ ok: true });
  })
);

app.post(
  "/account/avatar/upload",
  uploadAvatar,
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "Chưa chọn ảnh avatar." });
    }

    let output = null;
    try {
      output = await sharp(req.file.buffer)
        .rotate()
        .resize({ width: 256, height: 256, fit: "cover" })
        .webp({ quality: 76, effort: 6 })
        .toBuffer();
    } catch (_err) {
      return res.status(400).json({ ok: false, error: "Ảnh avatar không hợp lệ." });
    }

    const userId = String(user.id || "").trim();
    const safeId = userId.replace(/[^a-z0-9_-]+/gi, "").slice(0, 80) || "user";
    const fileName = `u-${safeId}.webp`;
    const filePath = path.join(avatarsDir, fileName);
    const stamp = Date.now();

    await fs.promises.writeFile(filePath, output);
    const avatarUrl = `/uploads/avatars/${fileName}?v=${stamp}`;

    try {
      await ensureUserRowFromSupabaseUser(user);
      await dbRun("UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?", [
        avatarUrl,
        stamp,
        userId
      ]);
    } catch (err) {
      console.warn("Failed to update user avatar", err);
    }

    return res.json({ ok: true, avatarUrl });
  })
);

app.post(
  "/account/profile/sync",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromSupabaseUser(user);
    const authorEmail = user.email ? String(user.email).trim() : "";
    const authorAvatarUrl = buildAvatarUrlFromSupabaseUser(user);
    const authorUserId = String(user.id || "").trim();
    if (!authorUserId) {
      return res.status(400).json({ ok: false, error: "Không xác định được người dùng." });
    }

    let profileRow = null;
    try {
      profileRow = await upsertUserProfileFromSupabaseUser(user);
    } catch (err) {
      console.warn("Failed to sync user profile", err);
    }

    const badgeContext = await getUserBadgeContext(authorUserId);

    const result = await dbRun(
      "UPDATE comments SET author = ?, author_email = ?, author_avatar_url = ? WHERE author_user_id = ?",
      [author, authorEmail, authorAvatarUrl, authorUserId]
    );

    return res.json({
      ok: true,
      updated: result && result.changes ? result.changes : 0,
      profile: profileRow
        ? {
          ...mapPublicUserRow(profileRow),
          badges: badgeContext.badges,
          userColor: badgeContext.userColor,
          permissions: badgeContext.permissions
        }
        : null
    });
  })
);

app.get(
  "/",
  asyncHandler(async (req, res) => {
    const homepageRow = await dbGet("SELECT * FROM homepage WHERE id = 1");
    const homepageData = normalizeHomepageRow(homepageRow);
    const notices = buildHomepageNotices(homepageData);
    const featuredIds = homepageData.featuredIds;
    let featuredRows = [];

    if (featuredIds.length > 0) {
      const placeholders = featuredIds.map(() => "?").join(",");
      const rows = await dbAll(
        `${listQueryBase} WHERE m.id IN (${placeholders}) AND COALESCE(m.is_hidden, 0) = 0`,
        featuredIds
      );
      const rowMap = new Map(rows.map((row) => [row.id, row]));
      featuredRows = featuredIds.map((id) => rowMap.get(id)).filter(Boolean);
    }

    if (featuredRows.length === 0) {
      featuredRows = await dbAll(
        `${listQueryBase} WHERE COALESCE(m.is_hidden, 0) = 0 ${listQueryOrder} LIMIT 3`
      );
    }
    const latestRows = await dbAll(
      `${listQueryBase} WHERE COALESCE(m.is_hidden, 0) = 0 ${listQueryOrder} LIMIT 12`
    );
    const totalSeriesRow = await dbGet(
      "SELECT COUNT(*) as count FROM manga WHERE COALESCE(is_hidden, 0) = 0"
    );
    const totalsRow = await dbGet(
      `
      SELECT COUNT(*) as total_chapters
      FROM chapters c
      JOIN manga m ON m.id = c.manga_id
      WHERE COALESCE(m.is_hidden, 0) = 0
    `
    );

    const mappedFeatured = featuredRows.map(mapMangaListRow);
    const mappedLatest = latestRows.map(mapMangaListRow);
    const seoImage = mappedFeatured.length && mappedFeatured[0].cover ? mappedFeatured[0].cover : "";

    res.render("index", {
      title: "Trang chủ",
      team,
      featured: mappedFeatured,
      latest: mappedLatest,
      homepage: {
        notices
      },
      stats: {
        totalSeries: totalSeriesRow ? totalSeriesRow.count : 0,
        totalChapters: totalsRow
          ? Number(totalsRow.total_chapters ?? totalsRow.totalchapters ?? totalsRow.totalChapters) || 0
          : 0
      },
      seo: buildSeoPayload(req, {
        title: "BFANG Team - nhóm dịch truyện tranh",
        description: "BFANG Team - nhóm dịch truyện tranh",
        canonicalPath: "/",
        image: seoImage,
        ogType: "website",
        jsonLd: [
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: SEO_SITE_NAME,
            url: toAbsolutePublicUrl(req, "/"),
            inLanguage: "vi-VN"
          }
        ]
      })
    });
  })
);

app.get(
  "/manga",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rawInclude = req.query.include;
    const rawExclude = req.query.exclude;
    const legacyGenre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";
    const include = [];
    const exclude = [];

    const genreStats = await getGenreStats();
    const genreIdByName = new Map(
      genreStats.map((genre) => [genre.name.toLowerCase(), genre.id])
    );

    const addFilter = (target, value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      let resolvedId = null;
      if (/^\d+$/.test(trimmed)) {
        resolvedId = Number(trimmed);
      } else {
        resolvedId = genreIdByName.get(trimmed.toLowerCase()) || null;
      }

      if (!Number.isFinite(resolvedId) || resolvedId <= 0) return;
      const id = Math.floor(resolvedId);
      if (!target.includes(id)) target.push(id);
    };

    const collectFilters = (input, target) => {
      if (Array.isArray(input)) {
        input.forEach((value) => {
          if (typeof value === "string") {
            addFilter(target, value);
          }
        });
        return;
      }
      if (typeof input === "string") {
        addFilter(target, input);
      }
    };

    collectFilters(rawInclude, include);
    collectFilters(rawExclude, exclude);
    if (legacyGenre) {
      addFilter(include, legacyGenre);
    }

    const includeSet = new Set(include);
    const filteredExclude = exclude.filter((id) => !includeSet.has(id));

    const conditions = [];
    const params = [];

    conditions.push("COALESCE(m.is_hidden, 0) = 0");

    const qNormalized = q.replace(/^#/, "").trim();
    const qId = /^\d+$/.test(qNormalized) ? Number(qNormalized) : null;
    if (qNormalized) {
      const likeValue = `%${qNormalized}%`;
      if (qId) {
        conditions.push(
          `(
            m.id = ?
            OR m.title ILIKE ?
            OR m.author ILIKE ?
            OR COALESCE(m.group_name, '') ILIKE ?
            OR COALESCE(m.other_names, '') ILIKE ?
            OR EXISTS (
              SELECT 1
              FROM manga_genres mg
              JOIN genres g ON g.id = mg.genre_id
              WHERE mg.manga_id = m.id AND g.name ILIKE ?
            )
          )`
        );
        params.push(qId, likeValue, likeValue, likeValue, likeValue, likeValue);
      } else {
        conditions.push(
          `(
            m.title ILIKE ?
            OR m.author ILIKE ?
            OR COALESCE(m.group_name, '') ILIKE ?
            OR COALESCE(m.other_names, '') ILIKE ?
            OR EXISTS (
              SELECT 1
              FROM manga_genres mg
              JOIN genres g ON g.id = mg.genre_id
              WHERE mg.manga_id = m.id AND g.name ILIKE ?
            )
          )`
        );
        params.push(likeValue, likeValue, likeValue, likeValue, likeValue);
      }
    }

    include.forEach((genre) => {
      conditions.push(
        `EXISTS (
          SELECT 1
          FROM manga_genres mg
          WHERE mg.manga_id = m.id AND mg.genre_id = ?
        )`
      );
      params.push(genre);
    });

    filteredExclude.forEach((genre) => {
      conditions.push(
        `NOT EXISTS (
          SELECT 1
          FROM manga_genres mg
          WHERE mg.manga_id = m.id AND mg.genre_id = ?
        )`
      );
      params.push(genre);
    });

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `${listQueryBase} ${whereClause} ${listQueryOrder}`;
    const mangaRows = await dbAll(query, params);
    const mangaLibrary = mangaRows.map(mapMangaListRow);
    const hasFilters = Boolean(q || include.length || filteredExclude.length);
    const seoTitleQuery = normalizeSeoText(q, 55);
    const seoTitle = seoTitleQuery
      ? `Tìm manga: ${seoTitleQuery}`
      : hasFilters
        ? "Lọc manga BFANG Team"
        : "Toàn bộ manga";
    const seoDescription = hasFilters
      ? "Kết quả tìm kiếm và lọc manga trên BFANG Team. Mở bộ lọc để xem toàn bộ thư viện truyện."
      : "Thư viện manga đầy đủ của BFANG Team, cập nhật liên tục theo nhóm dịch và thể loại.";

    res.render("manga", {
      title: "Toàn bộ truyện",
      team,
      mangaLibrary,
      genres: genreStats,
      filters: {
        q,
        include,
        exclude: filteredExclude
      },
      resultCount: mangaRows.length,
      seo: buildSeoPayload(req, {
        title: seoTitle,
        description: seoDescription,
        canonicalPath: "/manga",
        robots: hasFilters ? SEO_ROBOTS_NOINDEX : SEO_ROBOTS_INDEX,
        image: mangaLibrary.length && mangaLibrary[0].cover ? mangaLibrary[0].cover : "",
        ogType: "website"
      })
    });
  })
);

app.get(
  "/manga/:slug",
  asyncHandler(async (req, res) => {
    const requestedSlug = (req.params.slug || "").trim();
    let mangaRow = await dbGet(
      `${listQueryBase} WHERE m.slug = ? AND COALESCE(m.is_hidden, 0) = 0`,
      [requestedSlug]
    );
    if (!mangaRow) {
      const fallbackRows = await dbAll(
        `${listQueryBase} WHERE m.slug LIKE ? AND COALESCE(m.is_hidden, 0) = 0`,
        [`%-${requestedSlug}`]
      );
      if (fallbackRows.length === 1) {
        return res.redirect(301, `/manga/${fallbackRows[0].slug}`);
      }
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team,
        seo: buildSeoPayload(req, {
          title: "Không tìm thấy",
          description: "Trang bạn yêu cầu không tồn tại trên BFANG Team.",
          robots: SEO_ROBOTS_NOINDEX,
          canonicalPath: ensureLeadingSlash(req.path || "/")
        })
      });
    }

    const chapterRows = await dbAll(
      "SELECT number, title, pages, date, group_name, COALESCE(is_oneshot, false) as is_oneshot FROM chapters WHERE manga_id = ? ORDER BY number DESC",
      [mangaRow.id]
    );
    const chapters = chapterRows.map((chapter) => ({
      ...chapter,
      is_oneshot: toBooleanFlag(chapter && chapter.is_oneshot)
    }));

    const commentPageRaw = Number(req.query.commentPage);
    const commentPage =
      Number.isFinite(commentPageRaw) && commentPageRaw > 0 ? Math.floor(commentPageRaw) : 1;

    const commentData = await getPaginatedCommentTree({
      mangaId: mangaRow.id,
      chapterNumber: null,
      page: commentPage,
      perPage: 20,
      session: req.session
    });

    const mappedManga = mapMangaRow(mangaRow);
    const mangaDescription = normalizeSeoText(
      mangaRow.description || `Đọc manga ${mangaRow.title} tại BFANG Team.`,
      180
    );
    const canonicalPath = `/manga/${encodeURIComponent(mangaRow.slug)}`;
    const primaryAuthor = normalizeSeoText(
      (mangaRow.group_name || mangaRow.author || "").toString().split(",")[0],
      60
    );

    return res.render("manga-detail", {
      title: mangaRow.title,
      team,
      manga: {
        ...mappedManga,
        chapters
      },
      comments: commentData.comments,
      commentCount: commentData.count,
      commentPagination: commentData.pagination,
      seo: buildSeoPayload(req, {
        title: `${mangaRow.title} | Đọc manga`,
        description: mangaDescription,
        canonicalPath,
        image: mappedManga.cover || "",
        ogType: "article",
        jsonLd: [
          {
            "@context": "https://schema.org",
            "@type": "Book",
            name: mangaRow.title,
            author: primaryAuthor || SEO_SITE_NAME,
            url: toAbsolutePublicUrl(req, canonicalPath),
            inLanguage: "vi-VN",
            image: toAbsolutePublicUrl(req, mappedManga.cover || "") || undefined,
            description: mangaDescription
          }
        ]
      })
    });
  })
);

app.get(
  "/manga/:slug/chapters/:number",
  asyncHandler(async (req, res) => {
    const chapterNumber = Number(req.params.number);
    if (!Number.isFinite(chapterNumber)) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team,
        seo: buildSeoPayload(req, {
          title: "Không tìm thấy",
          description: "Trang bạn yêu cầu không tồn tại trên BFANG Team.",
          robots: SEO_ROBOTS_NOINDEX,
          canonicalPath: ensureLeadingSlash(req.path || "/")
        })
      });
    }

    const requestedSlug = (req.params.slug || "").trim();
    let mangaRow = await dbGet(
      `${listQueryBase} WHERE m.slug = ? AND COALESCE(m.is_hidden, 0) = 0`,
      [requestedSlug]
    );
    if (!mangaRow) {
      const fallbackRows = await dbAll(
        `${listQueryBase} WHERE m.slug LIKE ? AND COALESCE(m.is_hidden, 0) = 0`,
        [`%-${requestedSlug}`]
      );
      if (fallbackRows.length === 1) {
        return res.redirect(301, `/manga/${fallbackRows[0].slug}/chapters/${chapterNumber}`);
      }
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team,
        seo: buildSeoPayload(req, {
          title: "Không tìm thấy",
          description: "Trang bạn yêu cầu không tồn tại trên BFANG Team.",
          robots: SEO_ROBOTS_NOINDEX,
          canonicalPath: ensureLeadingSlash(req.path || "/")
        })
      });
    }

    const chapterRow = await dbGet(
      "SELECT number, title, pages, date, pages_prefix, pages_ext, pages_updated_at, processing_state, processing_error, COALESCE(is_oneshot, false) as is_oneshot FROM chapters WHERE manga_id = ? AND number = ?",
      [mangaRow.id, chapterNumber]
    );

    if (!chapterRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team,
        seo: buildSeoPayload(req, {
          title: "Không tìm thấy",
          description: "Trang bạn yêu cầu không tồn tại trên BFANG Team.",
          robots: SEO_ROBOTS_NOINDEX,
          canonicalPath: ensureLeadingSlash(req.path || "/")
        })
      });
    }

    const chapterListRows = await dbAll(
      "SELECT number, title, COALESCE(is_oneshot, false) as is_oneshot FROM chapters WHERE manga_id = ? ORDER BY number DESC",
      [mangaRow.id]
    );
    const chapterList = chapterListRows.map((item) => ({
      ...item,
      is_oneshot: toBooleanFlag(item && item.is_oneshot)
    }));

    const currentIndex = chapterList.findIndex(
      (chapter) => Number(chapter.number) === chapterNumber
    );
    const prevChapter =
      currentIndex >= 0 && currentIndex < chapterList.length - 1
        ? chapterList[currentIndex + 1]
        : null;
    const nextChapter = currentIndex > 0 ? chapterList[currentIndex - 1] : null;
    const pageCount = Math.max(Number(chapterRow.pages) || 0, 0);
    const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
    const isOneshotChapter = toBooleanFlag(mangaRow.is_oneshot) && toBooleanFlag(chapterRow.is_oneshot);

    const cdnBaseUrl = getB2Config().cdnBaseUrl;
    const processingState = (chapterRow.processing_state || "").toString().trim();
    const isProcessing = processingState === "processing";
    const canRenderPages = Boolean(
      !isProcessing && cdnBaseUrl && chapterRow.pages_prefix && chapterRow.pages_ext
    );
    const padLength = Math.max(3, String(pageCount).length);
    const pageUrls = canRenderPages
      ? pages.map((page) => {
        const pageName = String(page).padStart(padLength, "0");
        const rawUrl = `${cdnBaseUrl}/${chapterRow.pages_prefix}/${pageName}.${chapterRow.pages_ext}`;
        return cacheBust(rawUrl, chapterRow.pages_updated_at);
      })
      : [];

    let nextChapterPrefetchUrls = [];
    if (nextChapter && cdnBaseUrl) {
      const nextChapterNumber = Number(nextChapter.number);
      if (Number.isFinite(nextChapterNumber)) {
        const nextChapterRow = await dbGet(
          "SELECT pages, pages_prefix, pages_ext, pages_updated_at, processing_state FROM chapters WHERE manga_id = ? AND number = ?",
          [mangaRow.id, nextChapterNumber]
        );

        const nextProcessingState =
          nextChapterRow && nextChapterRow.processing_state
            ? String(nextChapterRow.processing_state).trim()
            : "";
        const canPrefetchNextChapter = Boolean(
          nextChapterRow &&
            nextProcessingState !== "processing" &&
            nextChapterRow.pages_prefix &&
            nextChapterRow.pages_ext
        );

        if (canPrefetchNextChapter) {
          const nextPageCount = Math.max(Number(nextChapterRow.pages) || 0, 0);
          const prefetchCount = nextPageCount;
          const nextPadLength = Math.max(3, String(nextPageCount).length);

          nextChapterPrefetchUrls = Array.from({ length: prefetchCount }, (_, idx) => {
            const page = idx + 1;
            const pageName = String(page).padStart(nextPadLength, "0");
            const rawUrl = `${cdnBaseUrl}/${nextChapterRow.pages_prefix}/${pageName}.${nextChapterRow.pages_ext}`;
            return cacheBust(rawUrl, nextChapterRow.pages_updated_at);
          });
        }
      }
    }

    const commentPageRaw = Number(req.query.commentPage);
    const commentPage =
      Number.isFinite(commentPageRaw) && commentPageRaw > 0 ? Math.floor(commentPageRaw) : 1;

    const commentData = await getPaginatedCommentTree({
      mangaId: mangaRow.id,
      chapterNumber: isOneshotChapter ? null : chapterNumber,
      page: commentPage,
      perPage: 20,
      session: req.session
    });

    const mappedManga = mapMangaRow(mangaRow);
    const chapterTitle = (chapterRow.title || "").toString().trim();
    const chapterBaseLabel = isOneshotChapter ? "Oneshot" : `Chương ${chapterRow.number}`;
    const chapterLabel = chapterTitle ? `${chapterBaseLabel} - ${chapterTitle}` : chapterBaseLabel;
    const chapterDescription = normalizeSeoText(
      `Đọc ${chapterLabel} của ${mangaRow.title} trên BFANG Team. Trang đọc tối ưu cho di động và máy tính.`,
      180
    );
    const chapterPath = `/manga/${encodeURIComponent(mangaRow.slug)}/chapters/${encodeURIComponent(
      String(chapterRow.number)
    )}`;

    return res.render("chapter", {
      title: `${chapterBaseLabel} — ${mangaRow.title}`,
      team,
      manga: mappedManga,
      chapter: {
        ...chapterRow,
        is_oneshot: isOneshotChapter
      },
      prevChapter,
      nextChapter,
      chapterList,
      pages,
      pageUrls,
      nextChapterPrefetchUrls,
      comments: commentData.comments,
      commentCount: commentData.count,
      commentPagination: commentData.pagination,
      seo: buildSeoPayload(req, {
        title: `${chapterLabel} | ${mangaRow.title}`,
        description: chapterDescription,
        canonicalPath: chapterPath,
        image: mappedManga.cover || "",
        ogType: "article"
      })
    });
  })
);

app.get(
  "/manga/:slug/comment-mentions",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const mangaRow = await dbGet(
      "SELECT id, slug FROM manga WHERE slug = ? AND COALESCE(is_hidden, 0) = 0",
      [req.params.slug]
    );
    if (!mangaRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy truyện." });
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromSupabaseUser(user);
    } catch (err) {
      console.warn("Failed to ensure user row for mention candidates", err);
    }

    const query = typeof req.query.q === "string" ? req.query.q : "";
    const limit = req.query.limit;
    const rows = await getMentionCandidatesForManga({
      mangaId: mangaRow.id,
      currentUserId: userId,
      query,
      limit
    });

    const users = rows
      .map((row) => {
        const username = row && row.username ? String(row.username).trim() : "";
        if (!username) return null;
        const displayName =
          row && row.display_name ? String(row.display_name).replace(/\s+/g, " ").trim() : "";
        const isAdmin = Boolean(Number(row && row.is_admin));
        const isMod = Boolean(Number(row && row.is_mod));
        const hasCommented = Boolean(row && row.has_commented);
        return {
          id: row.id,
          username,
          name: displayName || `@${username}`,
          avatarUrl: normalizeAvatarUrl(row && row.avatar_url ? row.avatar_url : ""),
          roleLabel: isAdmin ? "Admin" : isMod ? "Mod" : hasCommented ? "Đã bình luận" : ""
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, users });
  })
);

const commentLinkLabelSlugPattern = /^[a-z0-9][a-z0-9_-]{0,199}$/;

app.post(
  "/comments/link-labels",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).json({ ok: false, error: "Yêu cầu JSON." });
    }

    const rawItems = req.body && Array.isArray(req.body.items) ? req.body.items : [];
    const normalizedItems = [];
    const seenKeys = new Set();

    rawItems.slice(0, COMMENT_LINK_LABEL_FETCH_LIMIT).forEach((rawItem) => {
      const item = rawItem && typeof rawItem === "object" ? rawItem : null;
      if (!item) return;

      const type = (item.type || "").toString().trim().toLowerCase();
      if (type !== "manga" && type !== "chapter") return;

      const slug = (item.slug || "").toString().trim().toLowerCase();
      if (!commentLinkLabelSlugPattern.test(slug)) return;

      let chapterNumberText = "";
      if (type === "chapter") {
        const chapterValue = parseChapterNumberInput(item.chapterNumberText);
        chapterNumberText = formatChapterNumberValue(chapterValue);
        if (!chapterNumberText) return;
      }

      const key = type === "chapter" ? `chapter:${slug}:${chapterNumberText}` : `manga:${slug}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      normalizedItems.push({
        key,
        type,
        slug,
        chapterNumberText
      });
    });

    if (!normalizedItems.length) {
      return res.json({ ok: true, labels: {} });
    }

    const slugs = Array.from(new Set(normalizedItems.map((item) => item.slug)));
    const labels = {};

    if (slugs.length) {
      const placeholders = slugs.map(() => "?").join(",");
      const rows = await dbAll(
        `
          SELECT slug, title
          FROM manga
          WHERE COALESCE(is_hidden, 0) = 0
            AND slug IN (${placeholders})
        `,
        slugs
      );

      const titleBySlug = new Map();
      rows.forEach((row) => {
        const slugValue = row && row.slug ? String(row.slug).trim().toLowerCase() : "";
        const titleValue = row && row.title ? String(row.title).replace(/\s+/g, " ").trim() : "";
        if (!slugValue || !titleValue) return;
        titleBySlug.set(slugValue, titleValue);
      });

      normalizedItems.forEach((item) => {
        const title = titleBySlug.get(item.slug);
        if (!title) return;
        labels[item.key] =
          item.type === "chapter" ? `${title} - Ch. ${item.chapterNumberText}` : title;
      });
    }

    return res.json({ ok: true, labels });
  })
);

app.post(
  "/manga/:slug/comments",
  asyncHandler(async (req, res) => {
    const mangaRow = await dbGet(
      `
      SELECT id, slug, COALESCE(is_oneshot, false) as is_oneshot
      FROM manga
      WHERE slug = ? AND COALESCE(is_hidden, 0) = 0
    `,
      [req.params.slug]
    );
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const commentScope = resolveCommentScope({ mangaId: mangaRow.id, chapterNumber: null });
    if (!commentScope) {
      return res.status(500).send("Không thể tải phạm vi bình luận.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromSupabaseUser(user);
    const authorUserId = String(user.id || "").trim();
    const authorEmail = user.email ? String(user.email).trim() : "";
    const authorAvatarUrl = buildAvatarUrlFromSupabaseUser(user);

    let badgeContext = {
      badges: [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
    try {
      await ensureUserRowFromSupabaseUser(user);
      badgeContext = await getUserBadgeContext(authorUserId);
    } catch (err) {
      console.warn("Failed to load user badge context", err);
    }

    if (!badgeContext.permissions || badgeContext.permissions.canComment === false) {
      const message = "Tài khoản của bạn hiện không có quyền tương tác.";
      if (wantsJson(req)) {
        return res.status(403).json({ error: message });
      }
      return res.status(403).send(message);
    }

    const content = await censorCommentContentByForbiddenWords(req.body.content);
    const mangaCommentContext = buildCommentChapterContext({
      chapterNumber: commentScope.chapterNumber,
      chapterTitle: "",
      chapterIsOneshot: false
    });

    let parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    let parentAuthorUserId = "";
    if (parentId && Number.isFinite(parentId)) {
      const parentRow = await dbGet(
        `
          SELECT
            c.id,
            c.parent_id,
            c.author_user_id
          FROM comments c
          WHERE c.id = ?
            AND ${commentScope.whereWithoutStatus}
        `,
        [parentId, ...commentScope.params]
      );
      if (!parentRow || parentRow.parent_id) {
        parentId = null;
        parentAuthorUserId = "";
      } else {
        parentAuthorUserId = parentRow.author_user_id
          ? String(parentRow.author_user_id).trim()
          : "";
      }
    } else {
      parentId = null;
    }

    if (!content) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: "Nội dung bình luận không được để trống." });
      }
      return res.status(400).send("Nội dung bình luận không được để trống.");
    }

    if (content.length > COMMENT_MAX_LENGTH) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: `Bình luận tối đa ${COMMENT_MAX_LENGTH} ký tự.` });
      }
      return res.status(400).send(`Bình luận tối đa ${COMMENT_MAX_LENGTH} ký tự.`);
    }

    const commentRequestId = readCommentRequestId(req);
    if (!commentRequestId) {
      return sendCommentRequestIdInvalidResponse(req, res);
    }

    const createdAtDate = new Date();
    const createdAt = createdAtDate.toISOString();
    const nowMs = createdAtDate.getTime();

    const canContinueAfterChallenge = await ensureCommentTurnstileIfSuspicious({
      req,
      res,
      userId: authorUserId,
      nowMs,
      requestId: commentRequestId
    });
    if (!canContinueAfterChallenge) {
      return;
    }

    let result = null;

    try {
      result = await withTransaction(async ({ dbGet: txGet, dbRun: txRun, dbAll: txAll }) => {
        await ensureCommentPostCooldown({
          userId: authorUserId,
          nowMs,
          dbGet: txGet,
          dbRun: txRun
        });

        await ensureCommentNotDuplicateRecently({
          userId: authorUserId,
          content,
          nowMs,
          dbAll: txAll
        });

        return txRun(
          `
          INSERT INTO comments (
            manga_id,
            chapter_number,
            parent_id,
            author,
            author_user_id,
            author_email,
            author_avatar_url,
            client_request_id,
            content,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            mangaRow.id,
            commentScope.chapterNumber,
            parentId,
            author,
            authorUserId,
            authorEmail,
            authorAvatarUrl,
            commentRequestId,
            content,
            createdAt
          ]
        );
      });
    } catch (error) {
      if (error && error.code === "COMMENT_RATE_LIMITED") {
        registerCommentBotSignal({ userId: authorUserId, nowMs });
        return sendCommentCooldownResponse(req, res, error.retryAfterSeconds);
      }
      if (error && error.code === "COMMENT_DUPLICATE_CONTENT") {
        registerCommentBotSignal({ userId: authorUserId, nowMs });
        return sendCommentDuplicateContentResponse(req, res, error.retryAfterSeconds);
      }
      if (isDuplicateCommentRequestError(error)) {
        return sendDuplicateCommentRequestResponse(req, res);
      }
      throw error;
    }

    const mentionUsernames = extractMentionUsernamesFromContent(content);
    const mentionProfileMap = await getMentionProfileMapForManga({
      mangaId: mangaRow.id,
      usernames: mentionUsernames
    }).catch(() => new Map());
    const commentMentions = buildCommentMentionsForContent({
      content,
      mentionProfileMap
    });

    try {
      await createMentionNotificationsForComment({
        mangaId: mangaRow.id,
        chapterNumber: commentScope.chapterNumber,
        commentId: result.lastID,
        content,
        authorUserId
      });
    } catch (err) {
      console.warn("Failed to create mention notifications", err);
    }

    if (wantsJson(req)) {
      const countRow = await dbGet(
        `SELECT COUNT(*) as count FROM comments WHERE ${commentScope.whereVisible}`,
        commentScope.params
      );
      return res.json({
        comment: {
          id: result.lastID,
          author,
          authorUserId,
          badges: badgeContext.badges,
          userColor: badgeContext.userColor,
          avatarUrl: authorAvatarUrl,
          content,
          mentions: commentMentions,
          createdAt,
          timeAgo: formatTimeAgo(createdAt),
          parentId,
          parentAuthorUserId,
          chapterNumber: mangaCommentContext.chapterNumber,
          chapterNumberText: mangaCommentContext.chapterNumberText,
          chapterTitle: mangaCommentContext.chapterTitle,
          chapterIsOneshot: mangaCommentContext.chapterIsOneshot,
          chapterLabel: mangaCommentContext.chapterLabel,
          likeCount: 0,
          reportCount: 0,
          liked: false,
          reported: false
        },
        commentCount: countRow ? countRow.count : 0
      });
    }

    return res.redirect(`/manga/${mangaRow.slug}#comments`);
  })
);

app.post(
  "/manga/:slug/chapters/:number/comments",
  asyncHandler(async (req, res) => {
    const chapterNumber = Number(req.params.number);
    if (!Number.isFinite(chapterNumber)) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const mangaRow = await dbGet(
      `
      SELECT id, slug, COALESCE(is_oneshot, false) as is_oneshot
      FROM manga
      WHERE slug = ? AND COALESCE(is_hidden, 0) = 0
    `,
      [req.params.slug]
    );
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const chapterRow = await dbGet(
      "SELECT number, title, COALESCE(is_oneshot, false) as is_oneshot FROM chapters WHERE manga_id = ? AND number = ?",
      [mangaRow.id, chapterNumber]
    );
    if (!chapterRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const commentScope = resolveCommentScope({
      mangaId: mangaRow.id,
      chapterNumber:
        toBooleanFlag(mangaRow.is_oneshot) && toBooleanFlag(chapterRow.is_oneshot)
          ? null
          : chapterNumber
    });
    if (!commentScope) {
      return res.status(500).send("Không thể tải phạm vi bình luận.");
    }

    const chapterCommentContext = buildCommentChapterContext({
      chapterNumber: commentScope.chapterNumber,
      chapterTitle: chapterRow.title,
      chapterIsOneshot: chapterRow.is_oneshot
    });

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromSupabaseUser(user);
    const authorUserId = String(user.id || "").trim();
    const authorEmail = user.email ? String(user.email).trim() : "";
    const authorAvatarUrl = buildAvatarUrlFromSupabaseUser(user);

    let badgeContext = {
      badges: [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
    try {
      await ensureUserRowFromSupabaseUser(user);
      badgeContext = await getUserBadgeContext(authorUserId);
    } catch (err) {
      console.warn("Failed to load user badge context", err);
    }

    if (!badgeContext.permissions || badgeContext.permissions.canComment === false) {
      const message = "Tài khoản của bạn hiện không có quyền tương tác.";
      if (wantsJson(req)) {
        return res.status(403).json({ error: message });
      }
      return res.status(403).send(message);
    }

    const content = await censorCommentContentByForbiddenWords(req.body.content);
    let parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    let parentAuthorUserId = "";
    if (parentId && Number.isFinite(parentId)) {
      const parentRow = await dbGet(
        `SELECT id, parent_id, author_user_id FROM comments WHERE id = ? AND ${commentScope.whereWithoutStatus}`,
        [parentId, ...commentScope.params]
      );
      if (!parentRow || parentRow.parent_id) {
        parentId = null;
        parentAuthorUserId = "";
      } else {
        parentAuthorUserId = parentRow.author_user_id
          ? String(parentRow.author_user_id).trim()
          : "";
      }
    } else {
      parentId = null;
      parentAuthorUserId = "";
    }

    if (!content) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: "Nội dung bình luận không được để trống." });
      }
      return res.status(400).send("Nội dung bình luận không được để trống.");
    }

    if (content.length > COMMENT_MAX_LENGTH) {
      if (wantsJson(req)) {
        return res.status(400).json({ error: `Bình luận tối đa ${COMMENT_MAX_LENGTH} ký tự.` });
      }
      return res.status(400).send(`Bình luận tối đa ${COMMENT_MAX_LENGTH} ký tự.`);
    }

    const commentRequestId = readCommentRequestId(req);
    if (!commentRequestId) {
      return sendCommentRequestIdInvalidResponse(req, res);
    }

    const createdAtDate = new Date();
    const createdAt = createdAtDate.toISOString();
    const nowMs = createdAtDate.getTime();

    const canContinueAfterChallenge = await ensureCommentTurnstileIfSuspicious({
      req,
      res,
      userId: authorUserId,
      nowMs,
      requestId: commentRequestId
    });
    if (!canContinueAfterChallenge) {
      return;
    }

    let result = null;

    try {
      result = await withTransaction(async ({ dbGet: txGet, dbRun: txRun, dbAll: txAll }) => {
        await ensureCommentPostCooldown({
          userId: authorUserId,
          nowMs,
          dbGet: txGet,
          dbRun: txRun
        });

        await ensureCommentNotDuplicateRecently({
          userId: authorUserId,
          content,
          nowMs,
          dbAll: txAll
        });

        return txRun(
          `
          INSERT INTO comments (
            manga_id,
            chapter_number,
            parent_id,
            author,
            author_user_id,
            author_email,
            author_avatar_url,
            client_request_id,
            content,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            mangaRow.id,
            commentScope.chapterNumber,
            parentId,
            author,
            authorUserId,
            authorEmail,
            authorAvatarUrl,
            commentRequestId,
            content,
            createdAt
          ]
        );
      });
    } catch (error) {
      if (error && error.code === "COMMENT_RATE_LIMITED") {
        registerCommentBotSignal({ userId: authorUserId, nowMs });
        return sendCommentCooldownResponse(req, res, error.retryAfterSeconds);
      }
      if (error && error.code === "COMMENT_DUPLICATE_CONTENT") {
        registerCommentBotSignal({ userId: authorUserId, nowMs });
        return sendCommentDuplicateContentResponse(req, res, error.retryAfterSeconds);
      }
      if (isDuplicateCommentRequestError(error)) {
        return sendDuplicateCommentRequestResponse(req, res);
      }
      throw error;
    }

    const mentionUsernames = extractMentionUsernamesFromContent(content);
    const mentionProfileMap = await getMentionProfileMapForManga({
      mangaId: mangaRow.id,
      usernames: mentionUsernames
    }).catch(() => new Map());
    const commentMentions = buildCommentMentionsForContent({
      content,
      mentionProfileMap
    });

    try {
      await createMentionNotificationsForComment({
        mangaId: mangaRow.id,
        chapterNumber: commentScope.chapterNumber,
        commentId: result.lastID,
        content,
        authorUserId
      });
    } catch (err) {
      console.warn("Failed to create mention notifications", err);
    }

    if (wantsJson(req)) {
      const countRow = await dbGet(
        `SELECT COUNT(*) as count FROM comments WHERE ${commentScope.whereVisible}`,
        commentScope.params
      );
      return res.json({
        comment: {
          id: result.lastID,
          author,
          authorUserId,
          badges: badgeContext.badges,
          userColor: badgeContext.userColor,
          avatarUrl: authorAvatarUrl,
          content,
          mentions: commentMentions,
          createdAt,
          timeAgo: formatTimeAgo(createdAt),
          parentId,
          parentAuthorUserId,
          chapterNumber: chapterCommentContext.chapterNumber,
          chapterNumberText: chapterCommentContext.chapterNumberText,
          chapterTitle: chapterCommentContext.chapterTitle,
          chapterIsOneshot: chapterCommentContext.chapterIsOneshot,
          chapterLabel: chapterCommentContext.chapterLabel,
          likeCount: 0,
          reportCount: 0,
          liked: false,
          reported: false
        },
        commentCount: countRow ? countRow.count : 0
      });
    }

    return res.redirect(`/manga/${mangaRow.slug}/chapters/${chapterNumber}#comments`);
  })
);

app.get("/admin/login", (req, res) => {
  if (req.session && req.session.isAdmin) {
    return res.redirect("/admin");
  }
  const passwordEnabled = isAdminConfigured();
  return res.render("admin/login", {
    title: "Admin Login",
    error: null,
    passwordEnabled,
    passwordDisabledReason: isPasswordAdminEnabled
      ? "Chưa cấu hình ADMIN_USER/ADMIN_PASS trong .env."
      : "Đăng nhập mật khẩu đã bị tắt bằng ADMIN_PASSWORD_LOGIN_ENABLED."
  });
});

app.post(
  "/admin/login",
  adminLoginRateLimiter,
  asyncHandler(async (req, res) => {
    if (!isPasswordAdminEnabled) {
      return res.status(403).render("admin/login", {
        title: "Admin Login",
        error: "Đăng nhập mật khẩu đã bị tắt. Hãy dùng đăng nhập Google với huy hiệu Admin.",
        passwordEnabled: false,
        passwordDisabledReason: "Đăng nhập mật khẩu đã bị tắt bằng ADMIN_PASSWORD_LOGIN_ENABLED."
      });
    }

    if (!isAdminConfigured()) {
      return res.status(500).render("admin/login", {
        title: "Admin Login",
        error: "Thiếu cấu hình ADMIN_USER/ADMIN_PASS trong .env.",
        passwordEnabled: false,
        passwordDisabledReason: "Chưa cấu hình ADMIN_USER/ADMIN_PASS trong .env."
      });
    }

    const username = (req.body.username || "").trim();
    const password = (req.body.password || "").trim();

    if (safeCompareText(username, adminConfig.user) && safeCompareText(password, adminConfig.pass)) {
      await regenerateSession(req);
      req.session.isAdmin = true;
      req.session.adminAuth = "password";
      delete req.session.adminUserId;
      return res.redirect("/admin");
    }

    return res.status(401).render("admin/login", {
      title: "Admin Login",
      error: "Sai tài khoản hoặc mật khẩu.",
      passwordEnabled: true,
      passwordDisabledReason: ""
    });
  })
);

app.post(
  "/admin/sso",
  adminSsoRateLimiter,
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromSupabaseUser(user);
    } catch (err) {
      console.warn("Failed to ensure user row for admin sso", err);
    }

    const badgeContext = await getUserBadgeContext(userId).catch(() => null);
    const canAccessAdmin = Boolean(
      badgeContext && badgeContext.permissions && badgeContext.permissions.canAccessAdmin
    );
    if (!canAccessAdmin) {
      return res.status(403).json({ ok: false, error: "Tài khoản này không có quyền Admin." });
    }

    await regenerateSession(req);
    req.session.isAdmin = true;
    req.session.adminAuth = "badge";
    req.session.adminUserId = userId;
    return res.json({ ok: true });
  })
);

app.post("/admin/logout", requireAdmin, (req, res) => {
  const adminAuthMode = (req.session && req.session.adminAuth ? req.session.adminAuth : "password")
    .toString()
    .trim()
    .toLowerCase();
  const adminUserId = (req.session && req.session.adminUserId ? req.session.adminUserId : "")
    .toString()
    .trim();

  req.session.destroy(() => {
    if (adminAuthMode === "badge" && adminUserId) {
      const params = new URLSearchParams();
      params.set("logout_scope", "web");
      params.set("logout_user", adminUserId);
      return res.redirect(`/admin/login?${params.toString()}`);
    }
    return res.redirect("/admin/login");
  });
});

app.post(
  "/admin/covers/temp",
  requireAdmin,
  uploadCover,
  asyncHandler(async (req, res) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "Chưa chọn ảnh bìa." });
    }

    let coverBuffer = null;
    try {
      coverBuffer = await convertCoverToWebp(req.file.buffer);
    } catch (err) {
      const message =
        err && err.message && err.message.startsWith("Ảnh bìa")
          ? err.message
          : "Ảnh bìa không hợp lệ hoặc quá lớn.";
      return res.status(400).json({ error: message });
    }

    const token = createCoverTempToken();
    await saveCoverTempBuffer(token, coverBuffer);
    const updatedAt = Date.now();
    const url = cacheBust(`${coversUrlPrefix}tmp/${token}.webp`, updatedAt);
    return res.json({ token, url, updatedAt });
  })
);

app.get(
  "/admin",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaCountRow = await dbGet("SELECT COUNT(*) as count FROM manga");
    const chapterCountRow = await dbGet("SELECT COUNT(*) as count FROM chapters");
    const commentCountRow = await dbGet("SELECT COUNT(*) as count FROM comments");
    const latestMangaRows = await dbAll(`${listQuery} LIMIT 5`);
    const latestComments = await dbAll(
      `
      SELECT c.*, m.title as manga_title
      FROM comments c
      JOIN manga m ON m.id = c.manga_id
      ORDER BY c.created_at DESC
      LIMIT 5
    `
    );

    res.render("admin/dashboard", {
      title: "Admin Dashboard",
      adminUser: adminConfig.user,
      stats: {
        totalSeries: mangaCountRow ? mangaCountRow.count : 0,
        totalChapters: chapterCountRow ? chapterCountRow.count : 0,
        totalComments: commentCountRow ? commentCountRow.count : 0
      },
      latestManga: latestMangaRows.map(mapMangaListRow),
      latestComments
    });
  })
);

app.get(
  "/admin/homepage",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await ensureHomepageDefaults();
    const homepageRow = await dbGet("SELECT * FROM homepage WHERE id = 1");
    const homepageData = normalizeHomepageRow(homepageRow);
    const featuredIds = homepageData.featuredIds.length
      ? homepageData.featuredIds
      : await getDefaultFeaturedIds();
    const mangaRows = await dbAll(listQuery);

    res.render("admin/homepage", {
      title: "Trang chủ",
      adminUser: adminConfig.user,
      homepage: homepageData,
      featuredIds,
      mangaLibrary: mangaRows.map(mapMangaListRow),
      status: typeof req.query.status === "string" ? req.query.status : ""
    });
  })
);

app.post(
  "/admin/homepage",
  requireAdmin,
  asyncHandler(async (req, res) => {
    await ensureHomepageDefaults();
    const noticeTitle1 = (req.body.notice_title_1 || "").trim();
    const noticeBody1 = (req.body.notice_body_1 || "").trim();
    const noticeTitle2 = (req.body.notice_title_2 || "").trim();
    const noticeBody2 = (req.body.notice_body_2 || "").trim();
    const rawFeatured = [req.body.featured_1, req.body.featured_2, req.body.featured_3];
    const featuredIds = [];
    const seen = new Set();

    rawFeatured.forEach((value) => {
      const id = Number(value);
      if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
        featuredIds.push(id);
        seen.add(id);
      }
    });

    const now = new Date().toISOString();
    await dbRun(
      `
      UPDATE homepage
      SET notice_title_1 = ?, notice_body_1 = ?, notice_title_2 = ?, notice_body_2 = ?, featured_ids = ?, updated_at = ?
      WHERE id = 1
    `,
      [
        noticeTitle1,
        noticeBody1,
        noticeTitle2,
        noticeBody2,
        featuredIds.join(","),
        now
      ]
    );

    return res.redirect("/admin/homepage?status=saved");
  })
);

app.get(
  "/admin/manga",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rawInclude = req.query.include;
    const rawExclude = req.query.exclude;
    const legacyGenre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";

    const genreStats = await getGenreStats();
    const genreIdByName = new Map(
      genreStats.map((genre) => [genre.name.toLowerCase(), genre.id])
    );

    const include = [];
    const exclude = [];
    const conditions = [];
    const params = [];

    const addFilter = (target, value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      let resolvedId = null;
      if (/^\d+$/.test(trimmed)) {
        resolvedId = Number(trimmed);
      } else {
        resolvedId = genreIdByName.get(trimmed.toLowerCase()) || null;
      }

      if (!Number.isFinite(resolvedId) || resolvedId <= 0) return;
      const id = Math.floor(resolvedId);
      if (!target.includes(id)) {
        target.push(id);
      }
    };

    const collectFilters = (input, target) => {
      if (Array.isArray(input)) {
        input.forEach((value) => {
          if (typeof value === "string") {
            addFilter(target, value);
          }
        });
        return;
      }
      if (typeof input === "string") {
        addFilter(target, input);
      }
    };

    collectFilters(rawInclude, include);
    collectFilters(rawExclude, exclude);
    if (legacyGenre) {
      addFilter(include, legacyGenre);
    }

    const includeSet = new Set(include);
    const filteredExclude = exclude.filter((id) => !includeSet.has(id));

    const qNormalized = q.replace(/^#/, "").trim();
    const qId = /^\d+$/.test(qNormalized) ? Number(qNormalized) : null;
    if (qNormalized) {
      const likeValue = `%${qNormalized}%`;
      if (qId) {
        conditions.push(
          `(
            m.id = ?
            OR m.title ILIKE ?
            OR m.author ILIKE ?
            OR COALESCE(m.group_name, '') ILIKE ?
            OR COALESCE(m.other_names, '') ILIKE ?
            OR EXISTS (
              SELECT 1
              FROM manga_genres mg
              JOIN genres g ON g.id = mg.genre_id
              WHERE mg.manga_id = m.id AND g.name ILIKE ?
            )
          )`
        );
        params.push(qId, likeValue, likeValue, likeValue, likeValue, likeValue);
      } else {
        conditions.push(
          `(
            m.title ILIKE ?
            OR m.author ILIKE ?
            OR COALESCE(m.group_name, '') ILIKE ?
            OR COALESCE(m.other_names, '') ILIKE ?
            OR EXISTS (
              SELECT 1
              FROM manga_genres mg
              JOIN genres g ON g.id = mg.genre_id
              WHERE mg.manga_id = m.id AND g.name ILIKE ?
            )
          )`
        );
        params.push(likeValue, likeValue, likeValue, likeValue, likeValue);
      }
    }

    include.forEach((genreId) => {
      conditions.push(
        "EXISTS (SELECT 1 FROM manga_genres mg WHERE mg.manga_id = m.id AND mg.genre_id = ?)"
      );
      params.push(genreId);
    });

    filteredExclude.forEach((genreId) => {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM manga_genres mg WHERE mg.manga_id = m.id AND mg.genre_id = ?)"
      );
      params.push(genreId);
    });

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `${listQueryBase} ${whereClause} ${listQueryOrder}`;
    const mangaRows = await dbAll(query, params);

    if (wantsJson(req)) {
      return res.json({
        manga: mangaRows.map((row) => ({
          id: row.id,
          title: row.title,
          author: row.author,
          groupName: row.group_name,
          status: row.status,
          updatedAt: row.updated_at,
          updatedAtFormatted: formatDate(row.updated_at),
          chapterCount: row.chapter_count || 0,
          isHidden: Boolean(row.is_hidden)
        })),
        resultCount: mangaRows.length,
        filters: {
          q,
          include,
          exclude: filteredExclude
        }
      });
    }

    res.render("admin/manga-list", {
      title: "Quản lý truyện",
      adminUser: adminConfig.user,
      mangaLibrary: mangaRows.map(mapMangaListRow),
      genres: genreStats,
      filters: {
        q,
        include,
        exclude: filteredExclude
      },
      resultCount: mangaRows.length
    });
  })
);

app.get(
  "/admin/manga/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const oneshotGenreId = await getOneshotGenreId();
    const genres = await getGenreStats();
    res.render("admin/manga-form", {
      title: "Thêm truyện",
      adminUser: adminConfig.user,
      formAction: "/admin/manga/new",
      isEdit: false,
      genres,
      oneshotGenreId,
      selectedGenreIds: [],
      manga: {
        id: 0,
        title: "",
        otherNames: "",
        author: "",
        groupName: team.name,
        status: "Còn tiếp",
        description: "",
        cover: "",
        coverUpdatedAt: 0,
        slug: "",
        isOneshot: false,
        oneshotLocked: false,
        chapterCount: 0,
        canToggleOneshot: true,
        oneshotToggleDisabledReason: ""
      }
    });
  })
);

app.post(
  "/admin/manga/new",
  requireAdmin,
  uploadCover,
  asyncHandler(async (req, res) => {
    const title = (req.body.title || "").trim();
    if (!title) {
      return res.status(400).send("Thiếu tên truyện");
    }

    const otherNames = (req.body.other_names || "").trim();
    const author = (req.body.author || "").trim();
    const groupName = (req.body.group_name || team.name).trim();
    if (!groupName) {
      return res.status(400).send("Thiếu nhóm dịch");
    }
    const status = (req.body.status || "Còn tiếp").trim();
    const description = (req.body.description || "").trim();
    let genreIds = normalizeIdList(req.body.genre_ids);
    const requestOneshot = String(req.body.is_oneshot || "").trim() === "1";
    if (requestOneshot) {
      const oneshotGenreId = await getOneshotGenreId();
      if (oneshotGenreId) {
        genreIds = normalizeIdList([...genreIds, oneshotGenreId]);
      }
    }
    const genres = await getGenresStringByIds(genreIds);
    const now = new Date().toISOString().slice(0, 10);
    let coverBuffer = null;
    let coverTempUsed = "";
    if (req.file && req.file.buffer) {
      try {
        coverBuffer = await convertCoverToWebp(req.file.buffer);
      } catch (err) {
        const message =
          err && err.message && err.message.startsWith("Ảnh bìa")
            ? err.message
            : "Ảnh bìa không hợp lệ hoặc quá lớn.";
        return res.status(400).send(message);
      }
    }

    const coverTempToken = typeof req.body.cover_temp === "string" ? req.body.cover_temp.trim() : "";
    if (!coverBuffer && coverTempToken) {
      const tempBuffer = await loadCoverTempBuffer(coverTempToken);
      if (!tempBuffer) {
        return res.status(400).send("Ảnh bìa tạm không tồn tại hoặc đã hết hạn.");
      }
      coverBuffer = tempBuffer;
      coverTempUsed = coverTempToken;
    }
    const draftSlug = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const result = await dbRun(
      `
      INSERT INTO manga (
        title,
        slug,
        author,
        group_name,
        other_names,
        genres,
        status,
        description,
        cover,
        cover_updated_at,
        updated_at,
        created_at,
        is_oneshot,
        oneshot_locked
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        title,
        draftSlug,
        author,
        groupName,
        otherNames,
        genres,
        status,
        description,
        null,
        null,
        now,
        now,
        requestOneshot,
        false
      ]
    );

    const slug = buildMangaSlug(result.lastID, title);
    await dbRun("UPDATE manga SET slug = ? WHERE id = ?", [slug, result.lastID]);
    await setMangaGenresByIds(result.lastID, genreIds);

    if (coverBuffer) {
      const coverFilename = `${slug}.webp`;
      await saveCoverBuffer(coverFilename, coverBuffer);
      const coverUrl = `${coversUrlPrefix}${coverFilename}`;
      const coverUpdatedAt = Date.now();
      await dbRun("UPDATE manga SET cover = ?, cover_updated_at = ? WHERE id = ?", [
        coverUrl,
        coverUpdatedAt,
        result.lastID
      ]);
      if (coverTempUsed) {
        await deleteCoverTemp(coverTempUsed);
      }
    }

    return res.redirect("/admin/manga");
  })
);

app.get(
  "/admin/manga/:id/edit",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaId = Number(req.params.id);
    if (!Number.isFinite(mangaId) || mangaId <= 0) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const mangaRow = await dbGet("SELECT * FROM manga WHERE id = ?", [Math.floor(mangaId)]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const oneshotGenreId = await getOneshotGenreId();
    const genres = await getGenreStats();
    const selectedRows = await dbAll(
      "SELECT genre_id FROM manga_genres WHERE manga_id = ? ORDER BY genre_id ASC",
      [mangaRow.id]
    );
    let selectedGenreIds = selectedRows
      .map((row) => Number(row.genre_id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
    const isOneshot = toBooleanFlag(mangaRow.is_oneshot);
    const oneshotLocked = toBooleanFlag(mangaRow.oneshot_locked);
    const chapterCountRow = await dbGet("SELECT COUNT(*) as count FROM chapters WHERE manga_id = ?", [
      mangaRow.id
    ]);
    const chapterCount = chapterCountRow ? Number(chapterCountRow.count) || 0 : 0;
    const hasExistingChapters = chapterCount > 0;
    const canEnableOneshotByChapterCount = isOneshot || !hasExistingChapters;
    const canToggleOneshot = !(oneshotLocked && !isOneshot) && canEnableOneshotByChapterCount;
    let oneshotToggleDisabledReason = "";
    if (oneshotLocked && !isOneshot) {
      oneshotToggleDisabledReason = "Truyện này đã tắt Oneshot trước đó nên không thể bật lại.";
    } else if (!isOneshot && hasExistingChapters) {
      oneshotToggleDisabledReason = "Chỉ có thể bật Oneshot khi truyện chưa có chương nào.";
    }

    if (isOneshot && oneshotGenreId && !selectedGenreIds.includes(oneshotGenreId)) {
      selectedGenreIds = [...selectedGenreIds, oneshotGenreId];
    }

    res.render("admin/manga-form", {
      title: "Chỉnh sửa truyện",
      adminUser: adminConfig.user,
      formAction: `/admin/manga/${mangaRow.id}/edit`,
      isEdit: true,
      genres,
      oneshotGenreId,
      selectedGenreIds,
      manga: {
        id: mangaRow.id,
        title: mangaRow.title || "",
        otherNames: mangaRow.other_names || "",
        author: mangaRow.author || "",
        groupName: mangaRow.group_name || mangaRow.author || "",
        status: mangaRow.status || "Còn tiếp",
        description: mangaRow.description || "",
        cover: mangaRow.cover || "",
        coverUpdatedAt: Number(mangaRow.cover_updated_at) || 0,
        slug: mangaRow.slug || "",
        isOneshot,
        oneshotLocked,
        chapterCount,
        canToggleOneshot,
        oneshotToggleDisabledReason
      }
    });
  })
);

app.post(
  "/admin/manga/:id/edit",
  requireAdmin,
  uploadCover,
  asyncHandler(async (req, res) => {
    const mangaId = Number(req.params.id);
    if (!Number.isFinite(mangaId) || mangaId <= 0) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const mangaRow = await dbGet(
      "SELECT id, cover, cover_updated_at, COALESCE(is_oneshot, false) as is_oneshot, COALESCE(oneshot_locked, false) as oneshot_locked FROM manga WHERE id = ?",
      [Math.floor(mangaId)]
    );
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const title = (req.body.title || "").trim();
    if (!title) {
      return res.status(400).send("Thiếu tên truyện");
    }

    const otherNames = (req.body.other_names || "").trim();
    const author = (req.body.author || "").trim();
    const groupName = (req.body.group_name || team.name).trim();
    if (!groupName) {
      return res.status(400).send("Thiếu nhóm dịch");
    }
    let genreIds = normalizeIdList(req.body.genre_ids);
    const requestOneshot = String(req.body.is_oneshot || "").trim() === "1";
    const currentIsOneshot = toBooleanFlag(mangaRow.is_oneshot);
    const currentOneshotLocked = toBooleanFlag(mangaRow.oneshot_locked);
    const chapterCountRow = await dbGet("SELECT COUNT(*) as count FROM chapters WHERE manga_id = ?", [
      mangaRow.id
    ]);
    const chapterCount = chapterCountRow ? Number(chapterCountRow.count) || 0 : 0;

    if (requestOneshot && currentOneshotLocked && !currentIsOneshot) {
      return res.status(400).send("Truyện đã tắt Oneshot trước đó và không thể bật lại.");
    }

    let nextIsOneshot = currentIsOneshot;
    let nextOneshotLocked = currentOneshotLocked;

    if (requestOneshot && !currentIsOneshot) {
      if (chapterCount > 0) {
        return res.status(400).send("Chỉ có thể bật Oneshot khi truyện chưa có chương nào.");
      }
      nextIsOneshot = true;
    }

    if (!requestOneshot && currentIsOneshot) {
      nextIsOneshot = false;
      nextOneshotLocked = true;
    }

    if (nextIsOneshot) {
      const oneshotGenreId = await getOneshotGenreId();
      if (oneshotGenreId) {
        genreIds = normalizeIdList([...genreIds, oneshotGenreId]);
      }
    }

    const genres = await getGenresStringByIds(genreIds);
    const status = (req.body.status || "Còn tiếp").trim();
    const description = (req.body.description || "").trim();
    const slug = buildMangaSlug(mangaRow.id, title);

    let cover = mangaRow.cover || null;
    let coverUpdatedAt = Number(mangaRow.cover_updated_at) || 0;
    const coverTempToken = typeof req.body.cover_temp === "string" ? req.body.cover_temp.trim() : "";
    let nextCoverBuffer = null;
    let coverTempUsed = "";

    if (req.file && req.file.buffer) {
      try {
        nextCoverBuffer = await convertCoverToWebp(req.file.buffer);
      } catch (err) {
        const message =
          err && err.message && err.message.startsWith("Ảnh bìa")
            ? err.message
            : "Ảnh bìa không hợp lệ hoặc quá lớn.";
        return res.status(400).send(message);
      }
    } else if (coverTempToken) {
      const tempBuffer = await loadCoverTempBuffer(coverTempToken);
      if (!tempBuffer) {
        return res.status(400).send("Ảnh bìa tạm không tồn tại hoặc đã hết hạn.");
      }
      nextCoverBuffer = tempBuffer;
      coverTempUsed = coverTempToken;
    }

    if (nextCoverBuffer) {
      const coverFilename = `${slug}.webp`;
      await saveCoverBuffer(coverFilename, nextCoverBuffer);
      const coverUrl = `${coversUrlPrefix}${coverFilename}`;

      const oldFilename = extractLocalCoverFilename(cover);
      if (oldFilename && oldFilename !== coverFilename) {
        await deleteFileIfExists(path.join(coversDir, oldFilename));
      }

      cover = coverUrl;
      coverUpdatedAt = Date.now();

      if (coverTempUsed) {
        await deleteCoverTemp(coverTempUsed);
      }
    }

    if (currentIsOneshot && !nextIsOneshot) {
      const chapterRows = await dbAll(
        "SELECT id, number, COALESCE(is_oneshot, false) as is_oneshot FROM chapters WHERE manga_id = ? ORDER BY number ASC, id ASC",
        [mangaRow.id]
      );
      const explicitOneshot = chapterRows.find((row) => toBooleanFlag(row && row.is_oneshot));
      const fallbackSingle = chapterRows.length === 1 ? chapterRows[0] : null;
      const targetChapter = explicitOneshot || fallbackSingle || null;

      if (targetChapter) {
        const oldNumber = Number(targetChapter.number);
        const hasOldNumber = Number.isFinite(oldNumber);
        const duplicateZero = chapterRows.some(
          (row) => Number(row.id) !== Number(targetChapter.id) && Number(row.number) === 0
        );
        if (duplicateZero) {
          return res.status(400).send("Không thể tắt Oneshot vì đã tồn tại chương 0.");
        }

        if (hasOldNumber && Math.abs(oldNumber) > 1e-9) {
          await dbRun("UPDATE comments SET chapter_number = ? WHERE manga_id = ? AND chapter_number = ?", [
            0,
            mangaRow.id,
            oldNumber
          ]);
        }

        await dbRun("UPDATE chapters SET number = ?, is_oneshot = false WHERE id = ?", [
          0,
          targetChapter.id
        ]);
      } else {
        await dbRun("UPDATE chapters SET is_oneshot = false WHERE manga_id = ?", [mangaRow.id]);
      }
    }

    await dbRun(
      `
      UPDATE manga
      SET
        title = ?,
        slug = ?,
        author = ?,
        group_name = ?,
        other_names = ?,
        genres = ?,
        status = ?,
        description = ?,
        cover = ?,
        cover_updated_at = ?,
        is_oneshot = ?,
        oneshot_locked = ?
      WHERE id = ?
    `,
      [
        title,
        slug,
        author,
        groupName,
        otherNames,
        genres,
        status,
        description,
        cover,
        coverUpdatedAt,
        nextIsOneshot,
        nextOneshotLocked,
        mangaRow.id
      ]
    );

    await setMangaGenresByIds(mangaRow.id, genreIds);

    return res.redirect("/admin/manga");
  })
);

app.post(
  "/admin/manga/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const referer = req.get("referer") || "/admin/manga";
    const mangaId = Number(req.params.id);
    if (!Number.isFinite(mangaId) || mangaId <= 0) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy truyện" });
      }
      return res.redirect(referer);
    }

    const safeMangaId = Math.floor(mangaId);
    if (wantsJson(req)) {
      const jobId = createAdminJob({
        type: "delete-manga",
        run: async () => {
          await deleteMangaAndCleanupStorage(safeMangaId);
        }
      });
      return res.json({ ok: true, jobId });
    }

    try {
      await deleteMangaAndCleanupStorage(safeMangaId);
    } catch (err) {
      return res.status(500).send(normalizeAdminJobError(err));
    }
    return res.redirect(referer);
  })
);

app.post(
  "/admin/manga/:id/visibility",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const referer = req.get("referer") || "/admin/manga";
    const mangaId = Number(req.params.id);
    if (!Number.isFinite(mangaId) || mangaId <= 0) {
      return res.redirect(referer);
    }

    const rawHidden = typeof req.body.hidden === "string" ? req.body.hidden.trim() : "";
    const hidden = rawHidden === "1" ? 1 : rawHidden === "0" ? 0 : null;
    if (hidden === null) {
      return res.redirect(referer);
    }

    await dbRun("UPDATE manga SET is_hidden = ? WHERE id = ?", [hidden, Math.floor(mangaId)]);
    return res.redirect(referer);
  })
);

app.get(
  "/admin/manga/:id/chapters",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const deleted = Number(req.query.deleted);
    const mangaRow = await dbGet("SELECT * FROM manga WHERE id = ?", [req.params.id]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const chapterRows = await dbAll(
      "SELECT id, number, title, pages, date, group_name, COALESCE(is_oneshot, false) as is_oneshot, processing_state, processing_error FROM chapters WHERE manga_id = ? ORDER BY number DESC",
      [mangaRow.id]
    );
    const chapters = chapterRows.map((chapter) => ({
      ...chapter,
      is_oneshot: toBooleanFlag(chapter && chapter.is_oneshot)
    }));
    const isOneshotManga = toBooleanFlag(mangaRow.is_oneshot);
    const canCreateChapter = !isOneshotManga || chapters.length === 0;
    const createChapterLabel = isOneshotManga ? "Thêm Oneshot" : "Thêm chương mới";
    const currentMax = chapters.length ? Number(chapters[0].number) : 0;
    const nextNumber = Number.isFinite(currentMax) ? Math.floor(currentMax) + 1 : 1;
    const today = new Date().toISOString().slice(0, 10);

    res.render("admin/chapters", {
      title: "Quản lý chương",
      adminUser: adminConfig.user,
      manga: mangaRow,
      chapters,
      canCreateChapter,
      createChapterLabel,
      nextNumber,
      today,
      status,
      deleted: Number.isFinite(deleted) ? Math.max(0, Math.floor(deleted)) : 0
    });
  })
);

app.post(
  "/admin/manga/:id/chapters/bulk-delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaRow = await dbGet("SELECT id FROM manga WHERE id = ?", [req.params.id]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const rawIds = Array.isArray(req.body.chapter_ids)
      ? req.body.chapter_ids
      : req.body.chapter_ids != null
        ? [req.body.chapter_ids]
        : [];

    const chapterIds = Array.from(
      new Set(
        rawIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    );

    const buildRedirectUrl = (nextStatus, nextDeleted) => {
      const params = new URLSearchParams();
      if (nextStatus) params.set("status", nextStatus);
      if (Number.isFinite(nextDeleted) && nextDeleted > 0) {
        params.set("deleted", String(Math.floor(nextDeleted)));
      }
      return `/admin/manga/${mangaRow.id}/chapters${params.toString() ? `?${params.toString()}` : ""}`;
    };

    if (!chapterIds.length) {
      return res.redirect(buildRedirectUrl("bulk_missing"));
    }

    const placeholders = chapterIds.map(() => "?").join(",");
    const chapterRows = await dbAll(
      `SELECT id FROM chapters WHERE manga_id = ? AND id IN (${placeholders})`,
      [mangaRow.id, ...chapterIds]
    );
    const validIds = chapterRows
      .map((row) => Number(row && row.id))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.floor(value));

    if (!validIds.length) {
      return res.redirect(buildRedirectUrl("bulk_missing"));
    }

    let deletedCount = 0;
    try {
      for (const chapterId of validIds) {
        const result = await deleteChapterAndCleanupStorage(chapterId);
        if (result && result.mangaId) {
          deletedCount += 1;
        }
      }
    } catch (err) {
      return res.status(500).send(normalizeAdminJobError(err));
    }

    if (!deletedCount) {
      return res.redirect(buildRedirectUrl("bulk_missing"));
    }
    return res.redirect(buildRedirectUrl("bulk_deleted", deletedCount));
  })
);

app.get(
  "/admin/jobs/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const id = (req.params.id || "").toString().trim();
    if (!id) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy tiến trình." });
    }

    const job = adminJobs.get(id);
    if (!job) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy tiến trình." });
    }

    const state = (job.state || "").toString();
    return res.json({
      ok: true,
      id: job.id,
      type: job.type,
      state,
      error: state === "failed" ? String(job.error || "").trim() : ""
    });
  })
);

app.get(
  "/admin/chapters/processing/status",
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const rawIds = typeof req.query.ids === "string" ? req.query.ids.trim() : "";
    if (!rawIds) {
      return res.json({ ok: true, chapters: [] });
    }

    const ids = Array.from(
      new Set(
        rawIds
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    ).slice(0, 80);

    if (!ids.length) {
      return res.json({ ok: true, chapters: [] });
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = await dbAll(
      `
      SELECT id, processing_state, processing_error
      FROM chapters
      WHERE id IN (${placeholders})
    `,
      ids
    );

    return res.json({
      ok: true,
      chapters: rows.map((row) => ({
        id: row.id,
        processingState: (row.processing_state || "").toString(),
        processingError: (row.processing_error || "").toString()
      }))
    });
  })
);

app.get(
  "/admin/manga/:id/chapters/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaRow = await dbGet("SELECT * FROM manga WHERE id = ?", [req.params.id]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const chapterNumberRows = await dbAll(
      "SELECT number FROM chapters WHERE manga_id = ? ORDER BY number ASC",
      [mangaRow.id]
    );
    const chapterNumbers = chapterNumberRows
      .map((row) => (row ? Number(row.number) : NaN))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const isOneshotManga = toBooleanFlag(mangaRow.is_oneshot);

    if (isOneshotManga && chapterNumbers.length > 0) {
      return res.redirect(`/admin/manga/${mangaRow.id}/chapters?status=oneshot_exists`);
    }

    const maxNumber = chapterNumbers.length ? Math.max(...chapterNumbers) : 0;
    const nextNumber = isOneshotManga
      ? 0
      : Number.isFinite(maxNumber)
        ? Math.floor(maxNumber) + 1
        : 1;
    const today = new Date().toISOString().slice(0, 10);

    const config = getB2Config();
    const b2Ready = isB2Ready(config);
    let draft = null;
    if (b2Ready) {
      try {
        draft = await createChapterDraft(mangaRow.id);
      } catch (err) {
        console.warn("Failed to create chapter draft", err);
        draft = null;
      }
    }

    const draftTtlMinutes = Math.round(chapterDraftTtlMs / 60000) || 180;
    const draftTtlLabel =
      draftTtlMinutes >= 60 && draftTtlMinutes % 60 === 0
        ? `${Math.round(draftTtlMinutes / 60)} giờ`
        : `${draftTtlMinutes} phút`;

    return res.render("admin/chapter-new", {
      title: isOneshotManga ? "Thêm Oneshot" : "Thêm chương mới",
      adminUser: adminConfig.user,
      manga: mangaRow,
      chapterNumbers,
      isOneshotManga,
      nextNumber,
      today,
      b2Ready,
      draftToken: draft ? draft.token : "",
      draftTtlMinutes,
      draftTtlLabel
    });
  })
);

app.post(
  "/admin/chapter-drafts/:token/touch",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const token = (req.params.token || "").toString().trim();
    if (!isChapterDraftTokenValid(token)) {
      return res.status(404).json({ ok: false, error: "Draft không hợp lệ." });
    }

    const draft = await getChapterDraft(token);
    if (!draft) {
      return res.status(404).json({ ok: false, error: "Draft không tồn tại hoặc đã hết hạn." });
    }

    await touchChapterDraft(token);
    return res.json({ ok: true });
  })
);

app.post(
  "/admin/chapter-drafts/:token/pages/upload",
  requireAdmin,
  uploadChapterPage,
  asyncHandler(async (req, res) => {
    const token = (req.params.token || "").toString().trim();
    if (!isChapterDraftTokenValid(token)) {
      return res.status(404).send("Không tìm thấy draft chương.");
    }

    const config = getB2Config();
    if (!isB2Ready(config)) {
      return res.status(500).send("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const draft = await getChapterDraft(token);
    if (!draft) {
      return res.status(404).send("Draft chương không tồn tại hoặc đã hết hạn.");
    }

    const pageId = (req.query.id || req.body.id || "").toString().trim();
    if (!isChapterDraftPageIdValid(pageId)) {
      return res.status(400).send("ID ảnh trang không hợp lệ.");
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).send("Chưa chọn ảnh trang.");
    }

    let webpBuffer = null;
    try {
      webpBuffer = await convertChapterPageToWebp(req.file.buffer);
    } catch (_err) {
      return res.status(400).send("Ảnh trang không hợp lệ.");
    }

    const prefix = (draft.pages_prefix || "").toString().trim();
    if (!prefix) {
      return res.status(500).send("Draft chương không hợp lệ.");
    }

    const fileName = `${prefix}/${pageId}.webp`;
    try {
      await b2UploadBuffer({
        fileName,
        buffer: webpBuffer,
        contentType: "image/webp"
      });
    } catch (err) {
      console.warn("Draft page upload failed", err);
      return res.status(500).send("Upload ảnh thất bại.");
    }

    await touchChapterDraft(token);
    const url = `${config.cdnBaseUrl}/${fileName}`;
    if (wantsJson(req)) {
      return res.json({ ok: true, id: pageId, fileName, url });
    }
    return res.send("OK");
  })
);

app.post(
  "/admin/chapter-drafts/:token/pages/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const token = (req.params.token || "").toString().trim();
    if (!isChapterDraftTokenValid(token)) {
      return res.status(404).json({ ok: false, error: "Draft không hợp lệ." });
    }

    const config = getB2Config();
    if (!isB2Ready(config)) {
      return res.status(500).json({ ok: false, error: "Thiếu cấu hình lưu trữ ảnh trong .env" });
    }

    const draft = await getChapterDraft(token);
    if (!draft) {
      return res.status(404).json({ ok: false, error: "Draft không tồn tại hoặc đã hết hạn." });
    }

    const pageId = (req.body && req.body.id ? req.body.id : "").toString().trim();
    if (!isChapterDraftPageIdValid(pageId)) {
      return res.status(400).json({ ok: false, error: "ID ảnh trang không hợp lệ." });
    }

    const prefix = (draft.pages_prefix || "").toString().trim();
    if (!prefix) {
      return res.status(500).json({ ok: false, error: "Draft chương không hợp lệ." });
    }

    const target = `${prefix}/${pageId}.webp`;
    let deleted = 0;
    try {
      const versions = await b2ListFileVersionsByPrefix(target);
      deleted = await b2DeleteFileVersions(versions);
    } catch (err) {
      console.warn("Draft page delete failed", err);
      return res.status(500).json({ ok: false, error: "Xóa ảnh thất bại." });
    }

    await touchChapterDraft(token);
    return res.json({ ok: true, deleted });
  })
);

app.post(
  "/admin/manga/:id/chapters/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaRow = await dbGet("SELECT * FROM manga WHERE id = ?", [req.params.id]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const config = getB2Config();
    if (!isB2Ready(config)) {
      return res.status(500).send("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const isOneshotManga = toBooleanFlag(mangaRow.is_oneshot);
    const chapterCountRow = await dbGet("SELECT COUNT(*) as count FROM chapters WHERE manga_id = ?", [
      mangaRow.id
    ]);
    const chapterCount = chapterCountRow ? Number(chapterCountRow.count) || 0 : 0;
    if (isOneshotManga && chapterCount > 0) {
      return res.status(400).send("Truyện Oneshot chỉ có thể có một chương.");
    }

    const parsedNumber = parseChapterNumberInput(req.body.number);
    const number = isOneshotManga ? 0 : parsedNumber;
    if (number == null || number < 0) {
      return res.status(400).send("Số chương không hợp lệ.");
    }
    const isChapterOneshot = isOneshotManga;

    const token = (req.body.draft_token || "").toString().trim();
    if (!isChapterDraftTokenValid(token)) {
      return res.status(400).send("Draft chương không hợp lệ hoặc đã hết hạn.");
    }

    const draft = await getChapterDraft(token);
    if (!draft || Number(draft.manga_id) !== Number(mangaRow.id)) {
      return res.status(400).send("Draft chương không hợp lệ hoặc đã hết hạn.");
    }

    let pageIds = [];
    const rawPageIds = (req.body.draft_pages || "").toString().trim();
    if (rawPageIds) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawPageIds);
      } catch (_err) {
        return res.status(400).send("Danh sách ảnh trang không hợp lệ.");
      }
      if (Array.isArray(parsed)) {
        pageIds = parsed.map((value) => (value == null ? "" : String(value).trim())).filter(Boolean);
      }
    }

    pageIds = Array.from(new Set(pageIds));
    if (!pageIds.length) {
      return res.status(400).send("Chưa có ảnh trang nào được upload.");
    }
    if (pageIds.length > 220) {
      return res.status(400).send("Số lượng ảnh trang quá nhiều.");
    }
    if (pageIds.some((id) => !isChapterDraftPageIdValid(id))) {
      return res.status(400).send("Danh sách ảnh trang không hợp lệ.");
    }

    const existing = await dbGet(
      "SELECT 1 FROM chapters WHERE manga_id = ? AND number = ?",
      [mangaRow.id, number]
    );
    if (existing) {
      return res.status(400).send("Chương đã tồn tại");
    }

    const title = (req.body.title || "").toString().trim();
    const groupName = (req.body.group_name || team.name).toString().trim() || team.name;
    const date = buildChapterTimestampIso();

    const prefix = (draft.pages_prefix || "").toString().trim();
    if (!prefix) {
      return res.status(500).send("Draft chương không hợp lệ.");
    }

    const processingPagesJson = JSON.stringify(pageIds);
    const processingStamp = Date.now();

    const result = await dbRun(
      `
      INSERT INTO chapters (
        manga_id,
        number,
        title,
        pages,
        date,
        group_name,
        is_oneshot,
        processing_state,
        processing_error,
        processing_draft_token,
        processing_pages_json,
        processing_updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        mangaRow.id,
        number,
        title,
        pageIds.length,
        date,
        groupName,
        isChapterOneshot,
        "processing",
        "",
        token,
        processingPagesJson,
        processingStamp
      ]
    );

    enqueueChapterProcessing(result.lastID);
    return res.redirect(`/admin/manga/${mangaRow.id}/chapters?status=processing`);
  })
);

app.post(
  "/admin/manga/:id/chapters",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const mangaRow = await dbGet("SELECT * FROM manga WHERE id = ?", [req.params.id]);
    if (!mangaRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const isOneshotManga = toBooleanFlag(mangaRow.is_oneshot);
    const chapterCountRow = await dbGet("SELECT COUNT(*) as count FROM chapters WHERE manga_id = ?", [
      mangaRow.id
    ]);
    const chapterCount = chapterCountRow ? Number(chapterCountRow.count) || 0 : 0;
    if (isOneshotManga && chapterCount > 0) {
      return res.status(400).send("Truyện Oneshot chỉ có thể có một chương.");
    }

    const parsedNumber = parseChapterNumberInput(req.body.number);
    const number = isOneshotManga ? 0 : parsedNumber;
    const isChapterOneshot = isOneshotManga;
    const title = (req.body.title || "").trim();
    const groupName = (req.body.group_name || team.name).trim() || team.name;
    const pages = Math.max(Number(req.body.pages) || 0, 1);
    const date = buildChapterTimestampIso(req.body.date);

    if (number == null || number < 0 || !groupName || !date) {
      return res.status(400).send("Thiếu thông tin chương");
    }

    const existing = await dbGet(
      "SELECT 1 FROM chapters WHERE manga_id = ? AND number = ?",
      [mangaRow.id, number]
    );
    if (existing) {
      return res.status(400).send("Chương đã tồn tại");
    }

    await dbRun(
      `
      INSERT INTO chapters (manga_id, number, title, pages, date, group_name, is_oneshot)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [mangaRow.id, number, title, pages, date, groupName, isChapterOneshot]
    );

    await refreshMangaUpdatedAt(mangaRow.id);
    return res.redirect(`/admin/manga/${mangaRow.id}/chapters`);
  })
);

app.get(
  "/admin/chapters/:id/edit",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const chapterRow = await dbGet(
      `
      SELECT
        c.id,
        c.manga_id,
        c.number,
        c.title,
        c.pages,
        c.pages_prefix,
        c.pages_ext,
        c.pages_updated_at,
        c.is_oneshot,
        c.date,
        c.group_name,
        m.title as manga_title,
        m.slug as manga_slug
      FROM chapters c
      JOIN manga m ON m.id = c.manga_id
      WHERE c.id = ?
    `,
      [Math.floor(chapterId)]
    );

    if (!chapterRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const config = getB2Config();
    const b2Ready = isB2Ready(config);
    let draft = null;
    if (b2Ready) {
      try {
        draft = await createChapterDraft(chapterRow.manga_id);
      } catch (err) {
        console.warn("Failed to create chapter draft", err);
        draft = null;
      }
    }

    const draftTtlMinutes = Math.round(chapterDraftTtlMs / 60000) || 180;
    const draftTtlLabel =
      draftTtlMinutes >= 60 && draftTtlMinutes % 60 === 0
        ? `${Math.round(draftTtlMinutes / 60)} giờ`
        : `${draftTtlMinutes} phút`;

    const pagesPrefix = (chapterRow.pages_prefix || "").toString().trim();
    const pagesExt = (chapterRow.pages_ext || "").toString().trim() || "webp";
    const pagesUpdatedAt = Number(chapterRow.pages_updated_at) || 0;
    const pageCount = Math.max(Number(chapterRow.pages) || 0, 0);
    const padLength = Math.max(3, String(pageCount).length);

    const chapterNumberRows = await dbAll(
      "SELECT number FROM chapters WHERE manga_id = ? ORDER BY number ASC",
      [chapterRow.manga_id]
    );
    const currentNumber = Number(chapterRow.number);
    const chapterNumbers = chapterNumberRows
      .map((row) => (row ? Number(row.number) : NaN))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .filter((value) => (Number.isFinite(currentNumber) ? Math.abs(value - currentNumber) > 1e-9 : true));

    const existingPageIds = [];
    const existingPages = [];
    const initialPages = [];
    if (pageCount > 0 && pagesPrefix && config.cdnBaseUrl) {
      for (let page = 1; page <= pageCount; page += 1) {
        const id = buildChapterExistingPageId(chapterRow.id, page);
        const pageName = String(page).padStart(padLength, "0");
        const rawUrl = `${config.cdnBaseUrl}/${pagesPrefix}/${pageName}.${pagesExt}`;
        const url = cacheBust(rawUrl, pagesUpdatedAt || Date.now());
        existingPageIds.push(id);
        existingPages.push({ id, page });
        initialPages.push({ id, page, url });
      }
    }

    res.render("admin/chapter-form", {
      title: "Chỉnh sửa chương",
      adminUser: adminConfig.user,
      formAction: `/admin/chapters/${chapterRow.id}/edit`,
      b2Ready,
      draftToken: draft ? draft.token : "",
      draftTtlMinutes,
      draftTtlLabel,
      initialPages,
      existingPages,
      existingPageIds,
      chapterNumbers,
      chapter: {
        id: chapterRow.id,
        mangaId: chapterRow.manga_id,
        mangaTitle: chapterRow.manga_title,
        mangaSlug: chapterRow.manga_slug,
        number: chapterRow.number,
        isOneshot: toBooleanFlag(chapterRow.is_oneshot),
        title: chapterRow.title,
        pages: chapterRow.pages,
        date: chapterRow.date,
        groupName: chapterRow.group_name || ""
      }
    });
  })
);

app.post(
  "/admin/chapters/:id/edit",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const chapterRow = await dbGet(
      "SELECT id, manga_id, number, pages, pages_prefix FROM chapters WHERE id = ?",
      [Math.floor(chapterId)]
    );
    if (!chapterRow) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    const mangaMetaRow = await dbGet(
      "SELECT COALESCE(is_oneshot, false) as is_oneshot FROM manga WHERE id = ?",
      [chapterRow.manga_id]
    );
    const isOneshotManga = toBooleanFlag(mangaMetaRow && mangaMetaRow.is_oneshot);

    const parsedNextNumber = parseChapterNumberInput(req.body.number);
    const nextNumber = isOneshotManga ? 0 : parsedNextNumber;
    if (nextNumber == null || nextNumber < 0) {
      return res.status(400).send("Số chương không hợp lệ.");
    }

    const existingNumber = await dbGet(
      "SELECT id FROM chapters WHERE manga_id = ? AND number = ? AND id <> ? LIMIT 1",
      [chapterRow.manga_id, nextNumber, chapterRow.id]
    );
    if (existingNumber) {
      return res.status(400).send("Chương đã tồn tại");
    }

    const currentNumber = Number(chapterRow.number);
    const numberChanged =
      Number.isFinite(currentNumber) ? Math.abs(nextNumber - currentNumber) > 1e-9 : true;

    const title = (req.body.title || "").trim();
    const groupName = (req.body.group_name || "").trim() || team.name;

    if (!groupName) {
      return res.status(400).send("Thiếu thông tin chương");
    }

    const token = (req.body.draft_token || "").toString().trim();
    if (!isChapterDraftTokenValid(token)) {
      return res.status(400).send("Draft chương không hợp lệ hoặc đã hết hạn.");
    }

    let pageIds = [];
    const rawPageIds = (req.body.draft_pages || "").toString().trim();
    if (rawPageIds) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawPageIds);
      } catch (_err) {
        return res.status(400).send("Danh sách ảnh trang không hợp lệ.");
      }
      if (Array.isArray(parsed)) {
        pageIds = parsed.map((value) => (value == null ? "" : String(value).trim())).filter(Boolean);
      }
    }

    pageIds = Array.from(new Set(pageIds));
    if (!pageIds.length) {
      return res.status(400).send("Chưa có ảnh trang nào.");
    }
    if (pageIds.length > 220) {
      return res.status(400).send("Số lượng ảnh trang quá nhiều.");
    }
    if (pageIds.some((id) => !isChapterDraftPageIdValid(id))) {
      return res.status(400).send("Danh sách ảnh trang không hợp lệ.");
    }

    const pagesTouched = String(req.body.pages_touched || "") === "1";
    const currentCount = Math.max(Number(chapterRow.pages) || 0, 0);
    const expectedOrder = Array.from({ length: currentCount }, (_value, index) =>
      buildChapterExistingPageId(chapterRow.id, index + 1)
    );
    const isSameOrder =
      pageIds.length === expectedOrder.length && pageIds.every((value, index) => value === expectedOrder[index]);

    const needsProcessing = pagesTouched || !isSameOrder;
    if (!needsProcessing) {
      if (numberChanged && Number.isFinite(currentNumber)) {
        await dbRun(
          "UPDATE comments SET chapter_number = ? WHERE manga_id = ? AND chapter_number = ?",
          [nextNumber, chapterRow.manga_id, currentNumber]
        );
      }

      await dbRun("UPDATE chapters SET number = ?, title = ?, group_name = ? WHERE id = ?", [
        nextNumber,
        title,
        groupName,
        chapterRow.id
      ]);
      await refreshMangaUpdatedAt(chapterRow.manga_id);
      return res.redirect(`/admin/manga/${chapterRow.manga_id}/chapters`);
    }

    const config = getB2Config();
    if (!isB2Ready(config)) {
      return res.status(500).send("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const draft = await getChapterDraft(token);
    if (!draft || Number(draft.manga_id) !== Number(chapterRow.manga_id)) {
      return res.status(400).send("Draft chương không hợp lệ hoặc đã hết hạn.");
    }

    if (numberChanged && Number.isFinite(currentNumber)) {
      await dbRun(
        "UPDATE comments SET chapter_number = ? WHERE manga_id = ? AND chapter_number = ?",
        [nextNumber, chapterRow.manga_id, currentNumber]
      );
    }

    const processingStamp = Date.now();
    await dbRun(
      `
      UPDATE chapters
      SET
        number = ?,
        title = ?,
        group_name = ?,
        pages = ?,
        processing_state = ?,
        processing_error = ?,
        processing_draft_token = ?,
        processing_pages_json = ?,
        processing_updated_at = ?
      WHERE id = ?
    `,
      [
        nextNumber,
        title,
        groupName,
        pageIds.length,
        "processing",
        "",
        token,
        JSON.stringify(pageIds),
        processingStamp,
        chapterRow.id
      ]
    );

    enqueueChapterProcessing(chapterRow.id);
    return res.redirect(`/admin/manga/${chapterRow.manga_id}/chapters?status=processing`);
  })
);

app.get(
  "/admin/chapters/:id/pages",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).render("not-found", {
        title: "Không tìm thấy",
        team
      });
    }

    return res.redirect(`/admin/chapters/${Math.floor(chapterId)}/edit`);
  })
);

app.post(
  "/admin/chapters/:id/pages",
  requireAdmin,
  uploadChapterPages,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const chapterRow = await dbGet(
      "SELECT id, manga_id, number, pages_prefix, processing_draft_token FROM chapters WHERE id = ?",
      [Math.floor(chapterId)]
    );
    if (!chapterRow) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const config = getB2Config();
    if (!config.bucketId || !config.keyId || !config.applicationKey) {
      return res.status(500).send("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).send("Chưa chọn ảnh trang.");
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    files.sort((a, b) => collator.compare(a.originalname || "", b.originalname || ""));

    const prefix = `${config.chapterPrefix}/manga-${chapterRow.manga_id}/ch-${chapterRow.number}`;
    const padLength = Math.max(3, String(files.length).length);
    const updatedAt = Date.now();
    const chapterDate = new Date(updatedAt).toISOString();

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const pageNumber = index + 1;
        let webpBuffer = null;
        try {
          webpBuffer = await convertChapterPageToWebp(file.buffer);
        } catch (_err) {
          return res.status(400).send("Ảnh trang không hợp lệ.");
        }

        const pageName = String(pageNumber).padStart(padLength, "0");
        const fileName = `${prefix}/${pageName}.webp`;
        await b2UploadBuffer({
          fileName,
          buffer: webpBuffer,
          contentType: "image/webp"
        });
      }
    } catch (err) {
      console.warn("Chapter pages upload failed", err);
      return res.status(500).send("Upload ảnh thất bại.");
    }

    await dbRun(
      `
      UPDATE chapters
      SET
        pages = ?,
        pages_prefix = ?,
        pages_ext = ?,
        pages_updated_at = ?,
        date = ?,
        processing_state = NULL,
        processing_error = NULL,
        processing_draft_token = NULL,
        processing_pages_json = NULL,
        processing_updated_at = ?
      WHERE id = ?
    `,
      [files.length, prefix, "webp", updatedAt, chapterDate, updatedAt, chapterRow.id]
    );
    await refreshMangaUpdatedAt(chapterRow.manga_id);

    const oldPrefix = (chapterRow.pages_prefix || "").trim();
    if (oldPrefix) {
      try {
        if (oldPrefix !== prefix) {
          await b2DeleteAllByPrefix(oldPrefix);
        } else {
          await b2DeleteChapterExtraPages({ prefix, keepPages: files.length });
        }
      } catch (err) {
        console.warn("Chapter page cleanup failed", err);
      }
    }
    return res.redirect(`/admin/chapters/${chapterRow.id}/pages?status=uploaded`);
  })
);

app.post(
  "/admin/chapters/:id/pages/upload",
  requireAdmin,
  uploadChapterPage,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const chapterRow = await dbGet(
      "SELECT id, manga_id, number, pages_prefix, processing_draft_token FROM chapters WHERE id = ?",
      [Math.floor(chapterId)]
    );
    if (!chapterRow) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const config = getB2Config();
    if (!config.bucketId || !config.keyId || !config.applicationKey) {
      return res.status(500).send("Thiếu cấu hình lưu trữ ảnh trong .env");
    }

    const pageNumber = Number(req.query.page);
    const padRaw = Number(req.query.pad);
    const padLength = Number.isFinite(padRaw) ? Math.max(3, Math.min(6, Math.floor(padRaw))) : 3;
    if (!Number.isFinite(pageNumber) || pageNumber <= 0 || pageNumber > 9999) {
      return res.status(400).send("Số trang không hợp lệ.");
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).send("Chưa chọn ảnh trang.");
    }

    let webpBuffer = null;
    try {
      webpBuffer = await convertChapterPageToWebp(req.file.buffer);
    } catch (_err) {
      return res.status(400).send("Ảnh trang không hợp lệ.");
    }

    const prefix = `${config.chapterPrefix}/manga-${chapterRow.manga_id}/ch-${chapterRow.number}`;
    const pageName = String(Math.floor(pageNumber)).padStart(padLength, "0");
    const fileName = `${prefix}/${pageName}.webp`;

    try {
      await b2UploadBuffer({
        fileName,
        buffer: webpBuffer,
        contentType: "image/webp"
      });
    } catch (err) {
      console.warn("Chapter page upload failed", err);
      return res.status(500).send("Upload ảnh thất bại.");
    }

    const url = `${config.cdnBaseUrl}/${prefix}/${pageName}.webp`;
    if (wantsJson(req)) {
      return res.json({ ok: true, page: Math.floor(pageNumber), url });
    }
    return res.send("OK");
  })
);

app.post(
  "/admin/chapters/:id/pages/finalize",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const pages = Math.max(Number(req.body.pages) || 0, 0);
    if (!Number.isFinite(pages) || pages <= 0 || pages > 220) {
      return res.status(400).send("Số trang không hợp lệ.");
    }

    const chapterRow = await dbGet(
      "SELECT id, manga_id, number, pages_prefix FROM chapters WHERE id = ?",
      [Math.floor(chapterId)]
    );
    if (!chapterRow) {
      return res.status(404).send("Không tìm thấy chương");
    }

    const config = getB2Config();
    const prefix = `${config.chapterPrefix}/manga-${chapterRow.manga_id}/ch-${chapterRow.number}`;
    const updatedAt = Date.now();
    const chapterDate = new Date(updatedAt).toISOString();
    await dbRun(
      `
      UPDATE chapters
      SET
        pages = ?,
        pages_prefix = ?,
        pages_ext = ?,
        pages_updated_at = ?,
        date = ?,
        processing_state = NULL,
        processing_error = NULL,
        processing_draft_token = NULL,
        processing_pages_json = NULL,
        processing_updated_at = ?
      WHERE id = ?
    `,
      [pages, prefix, "webp", updatedAt, chapterDate, updatedAt, chapterRow.id]
    );
    await refreshMangaUpdatedAt(chapterRow.manga_id);

    const oldPrefix = (chapterRow.pages_prefix || "").trim();
    if (oldPrefix) {
      if (isB2Ready(config)) {
        try {
          if (oldPrefix !== prefix) {
            await b2DeleteAllByPrefix(oldPrefix);
          } else {
            await b2DeleteChapterExtraPages({ prefix, keepPages: pages });
          }
        } catch (err) {
          console.warn("Chapter page cleanup failed", err);
        }
      } else {
        console.warn("Skip chapter page cleanup: missing storage config");
      }
    }

    if (wantsJson(req)) {
      return res.json({ ok: true, pages, prefix, updatedAt });
    }
    return res.redirect(`/admin/chapters/${chapterRow.id}/pages?status=uploaded`);
  })
);

app.post(
  "/admin/chapters/:id/processing/retry",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const referer = req.get("referer") || "/admin/manga";
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      return res.redirect(referer);
    }

    const chapterRow = await dbGet(
      "SELECT id, manga_id, processing_state, processing_draft_token, processing_pages_json FROM chapters WHERE id = ?",
      [Math.floor(chapterId)]
    );
    if (!chapterRow) {
      return res.redirect(referer);
    }

    const state = (chapterRow.processing_state || "").toString().trim();
    if (state !== "failed") {
      return res.redirect(`/admin/manga/${chapterRow.manga_id}/chapters`);
    }

    const token = (chapterRow.processing_draft_token || "").toString().trim();
    const pagesJson = (chapterRow.processing_pages_json || "").toString().trim();
    if (!isChapterDraftTokenValid(token) || !pagesJson) {
      return res.status(400).send("Không thể thử lại: thiếu dữ liệu xử lý.");
    }

    await updateChapterProcessing({ chapterId: chapterRow.id, state: "processing", error: "" });
    enqueueChapterProcessing(chapterRow.id);
    return res.redirect(`/admin/manga/${chapterRow.manga_id}/chapters?status=processing`);
  })
);

app.post(
  "/admin/chapters/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const chapterId = Number(req.params.id);
    if (!Number.isFinite(chapterId) || chapterId <= 0) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy chương" });
      }
      return res.status(404).send("Không tìm thấy chương");
    }
    if (wantsJson(req)) {
      const safeChapterId = Math.floor(chapterId);
      const jobId = createAdminJob({
        type: "delete-chapter",
        run: async () => {
          await deleteChapterAndCleanupStorage(safeChapterId);
        }
      });
      return res.json({ ok: true, jobId });
    }

    try {
      const result = await deleteChapterAndCleanupStorage(Math.floor(chapterId));
      return res.redirect(`/admin/manga/${result.mangaId}/chapters`);
    } catch (err) {
      const message = normalizeAdminJobError(err);
      if (message === "Không tìm thấy chương") {
        return res.status(404).send(message);
      }
      return res.status(500).send(message);
    }
  })
);

const parseAdminJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }
  return [];
};

const mapAdminMemberBadge = (item) => {
  const idValue = item && item.id != null ? Number(item.id) : NaN;
  const id = Number.isFinite(idValue) && idValue > 0 ? Math.floor(idValue) : 0;
  const code = normalizeBadgeCode(item && item.code != null ? item.code : "");
  const labelRaw = item && item.label != null ? String(item.label).trim() : "";
  const color = normalizeHexColor(item && item.color != null ? item.color : "");
  const priorityValue = item && item.priority != null ? Number(item.priority) : 0;
  const priority = Number.isFinite(priorityValue) ? Math.floor(priorityValue) : 0;
  const canComment = item && item.can_comment != null ? Boolean(item.can_comment) : true;

  if (!id || !labelRaw) return null;
  return {
    id,
    code: code || "badge",
    label: labelRaw,
    color: color || "#f8f8f2",
    priority,
    canComment,
    isDefault: code === "member"
  };
};

const mapAdminMemberRow = (row) => {
  if (!row || !row.id) return null;

  const badgeList = parseAdminJsonArray(row.badges_json)
    .map(mapAdminMemberBadge)
    .filter(Boolean)
    .sort((left, right) => {
      const diff = (Number(right.priority) || 0) - (Number(left.priority) || 0);
      if (diff) return diff;
      return (Number(left.id) || 0) - (Number(right.id) || 0);
    });

  const assignedBadgeIds = badgeList
    .map((badge) => Number(badge.id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id));

  const interactionDisabledFromDb = Boolean(row.interaction_disabled);
  const interactionDisabled =
    interactionDisabledFromDb || badgeList.some((badge) => badge.canComment === false);

  const displayName = normalizeProfileDisplayName(row.display_name);
  const username = row && row.username ? String(row.username).trim() : "";
  const email = row && row.email ? String(row.email).trim() : "";

  const createdAtRaw = row && row.created_at != null ? row.created_at : null;
  const createdAtDate = createdAtRaw == null || createdAtRaw === "" ? null : new Date(createdAtRaw);
  const joinedAtText =
    createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? formatDate(createdAtDate) : "";

  const commentCountValue = row && row.comment_count != null ? Number(row.comment_count) : 0;
  const commentCount = Number.isFinite(commentCountValue) ? Math.max(0, Math.floor(commentCountValue)) : 0;

  const isBanned = badgeList.some((badge) => badge.code === "banned");
  const hasMemberBadge = badgeList.some((badge) => badge.code === "member");
  const badges = badgeList.slice();
  if (!isBanned && !hasMemberBadge) {
    badges.push({
      id: 0,
      code: "member",
      label: "Member",
      color: "#f8f8f2",
      priority: -1000,
      canComment: true,
      isDefault: true
    });
  }

  return {
    id: String(row.id),
    username,
    email,
    displayName,
    avatarUrl: normalizeAvatarUrl(row.avatar_url || ""),
    facebookUrl: normalizeProfileFacebook(row.facebook_url),
    discordUrl: normalizeProfileDiscord(row.discord_handle),
    bio: normalizeProfileBio(row.bio),
    joinedAtText,
    commentCount,
    badges,
    assignedBadgeIds,
    interactionDisabled,
    isBanned
  };
};

const buildAdminMembersWhere = ({ q, interaction }) => {
  const whereParts = [];
  const params = [];

  const qText = typeof q === "string" ? q.trim() : "";
  if (qText) {
    const like = `%${qText}%`;
    whereParts.push(
      `(
        u.id = ?
        OR COALESCE(u.username, '') ILIKE ?
        OR COALESCE(u.email, '') ILIKE ?
        OR COALESCE(u.display_name, '') ILIKE ?
      )`
    );
    params.push(qText, like, like, like);
  }

  const interactionFilter =
    interaction === "disabled" || interaction === "enabled" ? interaction : "all";
  if (interactionFilter === "disabled") {
    whereParts.push(
      `EXISTS (
        SELECT 1
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = u.id
          AND b.can_comment = false
      )`
    );
  } else if (interactionFilter === "enabled") {
    whereParts.push(
      `NOT EXISTS (
        SELECT 1
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = u.id
          AND b.can_comment = false
      )`
    );
  }

  return {
    clause: whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "",
    params,
    q: qText,
    interaction: interactionFilter
  };
};

const getAdminMemberById = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id || id.length > 128) return null;

  const row = await dbGet(
    `
      SELECT
        u.id,
        u.email,
        u.username,
        u.display_name,
        u.avatar_url,
        u.facebook_url,
        u.discord_handle,
        u.bio,
        u.created_at,
        u.updated_at,
        COALESCE(cs.comment_count, 0) as comment_count,
        COALESCE(bctx.badges_json, '[]'::json) as badges_json,
        COALESCE(bctx.interaction_disabled, false) as interaction_disabled
      FROM users u
      LEFT JOIN (
        SELECT author_user_id, COUNT(*) as comment_count
        FROM comments
        WHERE author_user_id IS NOT NULL AND TRIM(author_user_id) <> ''
        GROUP BY author_user_id
      ) cs ON cs.author_user_id = u.id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            json_agg(
              json_build_object(
                'id', b.id,
                'code', b.code,
                'label', b.label,
                'color', b.color,
                'priority', b.priority,
                'can_comment', b.can_comment
              )
              ORDER BY b.priority DESC, b.id ASC
            ),
            '[]'::json
          ) as badges_json,
          COALESCE(bool_or(b.can_comment = false), false) as interaction_disabled
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = u.id
      ) bctx ON true
      WHERE u.id = ?
      LIMIT 1
    `,
    [id]
  );

  if (!row) return null;
  return mapAdminMemberRow(row);
};

app.get(
  "/admin/comments",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const deletedRaw = Number(req.query.deleted);
    const deleted = Number.isFinite(deletedRaw) && deletedRaw > 0 ? Math.floor(deletedRaw) : 0;
    const addedRaw = Number(req.query.added);
    const added = Number.isFinite(addedRaw) && addedRaw > 0 ? Math.floor(addedRaw) : 0;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const reportedRaw = typeof req.query.reported === "string" ? req.query.reported.trim() : "";
    const reported = reportedRaw === "only" || reportedRaw === "none" ? reportedRaw : "all";
    const sortRaw = typeof req.query.sort === "string" ? req.query.sort.trim() : "";
    const sort = ["newest", "oldest", "likes", "reports"].includes(sortRaw) ? sortRaw : "newest";
    const pageRaw = Number(req.query.page);
    const perPage = 20;

    let orderBy = "c.created_at DESC, c.id DESC";
    if (sort === "oldest") {
      orderBy = "c.created_at ASC, c.id ASC";
    } else if (sort === "likes") {
      orderBy = "COALESCE(c.like_count, 0) DESC, c.created_at DESC, c.id DESC";
    } else if (sort === "reports") {
      orderBy = "COALESCE(c.report_count, 0) DESC, c.created_at DESC, c.id DESC";
    }

    const whereParts = [];
    const whereParams = [];

    if (q) {
      const like = `%${q}%`;
      whereParts.push(
        `(
          c.author_user_id = ?
          OR c.author ILIKE ?
          OR c.content ILIKE ?
          OR m.title ILIKE ?
          OR COALESCE(u.username, '') ILIKE ?
          OR COALESCE(u.display_name, '') ILIKE ?
          OR COALESCE(u.email, '') ILIKE ?
        )`
      );
      whereParams.push(q, like, like, like, like, like, like);
    }

    if (reported === "only") {
      whereParts.push("COALESCE(c.report_count, 0) > 0");
    } else if (reported === "none") {
      whereParts.push("COALESCE(c.report_count, 0) = 0");
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const countRow = await dbGet(
      `
      SELECT COUNT(*) as count
      FROM comments c
      JOIN manga m ON m.id = c.manga_id
      LEFT JOIN users u ON u.id = c.author_user_id
      ${whereClause}
    `,
      whereParams
    );

    const totalCount = countRow ? Number(countRow.count) || 0 : 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const page =
      Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(Math.floor(pageRaw), totalPages) : 1;
    const offset = (page - 1) * perPage;

    const comments = await dbAll(
      `
      SELECT
        c.id,
        c.manga_id,
        c.chapter_number,
        c.author,
        c.content,
        c.like_count,
        c.report_count,
        c.created_at,
        m.title as manga_title,
        m.slug as manga_slug,
        COALESCE(u.username, '') as author_username
      FROM comments c
      JOIN manga m ON m.id = c.manga_id
      LEFT JOIN users u ON u.id = c.author_user_id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
      [...whereParams, perPage, offset]
    );

    const pagination = {
      page,
      perPage,
      totalCount,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      prevPage: Math.max(1, page - 1),
      nextPage: Math.min(totalPages, page + 1)
    };

    const forbiddenWords = await getForbiddenWords();

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        comments: comments.map((comment) => ({
          id: comment.id,
          mangaTitle: comment.manga_title || "",
          mangaSlug: comment.manga_slug || "",
          chapterNumber: comment.chapter_number,
          author: comment.author || "",
          authorUsername: comment.author_username || "",
          content: comment.content || "",
          likeCount: Number(comment.like_count) || 0,
          reportCount: Number(comment.report_count) || 0,
          createdAt: comment.created_at,
          createdAtText: formatDateTime(comment.created_at)
        })),
        filters: {
          q,
          reported,
          sort
        },
        pagination
      });
    }

    res.render("admin/comments", {
      title: "Quản lý bình luận",
      adminUser: adminConfig.user,
      comments,
      forbiddenWords,
      status,
      deleted,
      added,
      q,
      reported,
      sort,
      pagination
    });
  })
);

app.post(
  "/admin/comments/bulk-delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = (req.body.q || "").toString().trim();
    const reportedRaw = (req.body.reported || "").toString().trim();
    const reported = reportedRaw === "only" || reportedRaw === "none" ? reportedRaw : "all";
    const sortRaw = (req.body.sort || "").toString().trim();
    const sort = ["newest", "oldest", "likes", "reports"].includes(sortRaw) ? sortRaw : "newest";
    const pageRaw = Number(req.body.page);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

    const rawIds = req.body.comment_ids;
    const asList = Array.isArray(rawIds) ? rawIds : rawIds != null ? [rawIds] : [];
    const ids = Array.from(
      new Set(
        asList
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    );

    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (reported !== "all") params.set("reported", reported);
    if (sort !== "newest") params.set("sort", sort);
    if (page > 1) params.set("page", String(page));

    if (!ids.length) {
      params.set("status", "bulk_missing");
      return res.redirect(`/admin/comments?${params.toString()}`);
    }

    let deletedCount = 0;
    for (const id of ids) {
      deletedCount += await deleteCommentCascade(id);
    }

    params.set("status", "bulk_deleted");
    params.set("deleted", String(deletedCount));
    return res.redirect(`/admin/comments?${params.toString()}`);
  })
);

app.post(
  "/admin/comments/forbidden-words",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const baseOrigin = getPublicOriginFromRequest(req) || localDevOrigin;
    const refererRaw = (req.get("referer") || "").toString().trim();
    let params = new URLSearchParams();
    if (refererRaw) {
      try {
        const refererUrl = new URL(refererRaw, baseOrigin);
        const normalizedPath = (refererUrl.pathname || "").replace(/\/+$/, "") || "/";
        if (normalizedPath === "/admin/comments") {
          params = new URLSearchParams(refererUrl.searchParams);
        }
      } catch (_err) {
        params = new URLSearchParams();
      }
    }

    params.delete("format");
    params.delete("status");
    params.delete("deleted");
    params.delete("added");

    const words = normalizeForbiddenWordList(req.body.words || req.body.word || "");
    if (!words.length) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "Vui lòng nhập ít nhất một từ cấm hợp lệ." });
      }
      params.set("status", "word_invalid");
      return res.redirect(`/admin/comments${params.toString() ? `?${params.toString()}` : ""}`);
    }

    const now = Date.now();
    let added = 0;
    for (const word of words) {
      const normalizedWord = word.toLowerCase();
      const result = await dbRun(
        "INSERT INTO forbidden_words (word, normalized_word, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        [word, normalizedWord, now]
      );
      const changes = result && result.changes ? Number(result.changes) || 0 : 0;
      added += changes;
    }

    if (wantsJson(req)) {
      if (added <= 0) {
        return res.status(409).json({ ok: false, error: "Từ cấm đã tồn tại trong danh sách." });
      }

      const allWords = await getForbiddenWords();

      return res.json({
        ok: true,
        added,
        words: allWords
          .map((row) => ({
            id: row && row.id != null ? Number(row.id) : 0,
            word: row && row.word ? String(row.word).trim() : ""
          }))
          .filter((item) => item.id > 0 && item.word)
      });
    }

    if (added > 0) {
      params.set("status", "word_added");
      params.set("added", String(added));
    } else {
      params.set("status", "word_exists");
    }

    return res.redirect(`/admin/comments${params.toString() ? `?${params.toString()}` : ""}`);
  })
);

app.post(
  "/admin/comments/forbidden-words/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const baseOrigin = getPublicOriginFromRequest(req) || localDevOrigin;
    const refererRaw = (req.get("referer") || "").toString().trim();
    let params = new URLSearchParams();
    if (refererRaw) {
      try {
        const refererUrl = new URL(refererRaw, baseOrigin);
        const normalizedPath = (refererUrl.pathname || "").replace(/\/+$/, "") || "/";
        if (normalizedPath === "/admin/comments") {
          params = new URLSearchParams(refererUrl.searchParams);
        }
      } catch (_err) {
        params = new URLSearchParams();
      }
    }

    params.delete("format");
    params.delete("status");
    params.delete("deleted");
    params.delete("added");

    const wordId = Number(req.params.id);
    if (!Number.isFinite(wordId) || wordId <= 0) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "ID từ cấm không hợp lệ." });
      }
      params.set("status", "word_invalid");
      return res.redirect(`/admin/comments${params.toString() ? `?${params.toString()}` : ""}`);
    }

    const result = await dbRun("DELETE FROM forbidden_words WHERE id = ?", [Math.floor(wordId)]);
    if (result && result.changes) {
      if (wantsJson(req)) {
        return res.json({ ok: true, deleted: true, id: Math.floor(wordId) });
      }
      params.set("status", "word_deleted");
    } else {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy từ cấm cần xóa." });
      }
      params.set("status", "word_notfound");
    }

    return res.redirect(`/admin/comments${params.toString() ? `?${params.toString()}` : ""}`);
  })
);

app.post(
  "/admin/comments/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const deletedCount = await deleteCommentCascade(req.params.id);

    const baseOrigin = getPublicOriginFromRequest(req) || localDevOrigin;
    const refererRaw = (req.get("referer") || "").toString().trim();

    let params = new URLSearchParams();
    if (refererRaw) {
      try {
        const refererUrl = new URL(refererRaw, baseOrigin);
        const normalizedPath = (refererUrl.pathname || "").replace(/\/+$/, "") || "/";
        if (normalizedPath === "/admin/comments") {
          params = new URLSearchParams(refererUrl.searchParams);
        }
      } catch (_err) {
        params = new URLSearchParams();
      }
    }

    params.delete("format");
    params.delete("status");
    params.delete("deleted");
    params.delete("added");

    if (deletedCount > 0) {
      params.set("status", "bulk_deleted");
      params.set("deleted", String(deletedCount));
    }

    const query = params.toString();
    return res.redirect(`/admin/comments${query ? `?${query}` : ""}`);
  })
);

app.get(
  "/admin/members",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const interactionRaw =
      typeof req.query.interaction === "string" ? req.query.interaction.trim() : "";
    const pageRaw = Number(req.query.page);

    const where = buildAdminMembersWhere({ q, interaction: interactionRaw });
    const countRow = await dbGet(`SELECT COUNT(*) as count FROM users u ${where.clause}`, where.params);
    const totalCount = countRow ? Number(countRow.count) || 0 : 0;
    const perPage = ADMIN_MEMBERS_PER_PAGE;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const page =
      Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(Math.floor(pageRaw), totalPages) : 1;
    const offset = (page - 1) * perPage;

    const rows = await dbAll(
      `
      SELECT
        u.id,
        u.email,
        u.username,
        u.display_name,
        u.avatar_url,
        u.facebook_url,
        u.discord_handle,
        u.bio,
        u.created_at,
        u.updated_at,
        COALESCE(cs.comment_count, 0) as comment_count,
        COALESCE(bctx.badges_json, '[]'::json) as badges_json,
        COALESCE(bctx.interaction_disabled, false) as interaction_disabled
      FROM users u
      LEFT JOIN (
        SELECT author_user_id, COUNT(*) as comment_count
        FROM comments
        WHERE author_user_id IS NOT NULL AND TRIM(author_user_id) <> ''
        GROUP BY author_user_id
      ) cs ON cs.author_user_id = u.id
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            json_agg(
              json_build_object(
                'id', b.id,
                'code', b.code,
                'label', b.label,
                'color', b.color,
                'priority', b.priority,
                'can_comment', b.can_comment
              )
              ORDER BY b.priority DESC, b.id ASC
            ),
            '[]'::json
          ) as badges_json,
          COALESCE(bool_or(b.can_comment = false), false) as interaction_disabled
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id = u.id
      ) bctx ON true
      ${where.clause}
      ORDER BY COALESCE(u.updated_at, u.created_at) DESC, u.id ASC
      LIMIT ? OFFSET ?
    `,
      [...where.params, perPage, offset]
    );

    const members = rows.map(mapAdminMemberRow).filter(Boolean);
    const badgeRows = await dbAll(
      "SELECT id, code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment FROM badges ORDER BY priority DESC, id ASC"
    );
    const badges = badgeRows.map(mapBadgeRow).filter(Boolean);

    const pagination = {
      page,
      perPage,
      totalCount,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      prevPage: Math.max(1, page - 1),
      nextPage: Math.min(totalPages, page + 1)
    };

    if (wantsJson(req)) {
      return res.json({
        ok: true,
        members,
        badges,
        filters: {
          q: where.q,
          interaction: where.interaction
        },
        pagination
      });
    }

    return res.render("admin/members", {
      title: "Quản lý thành viên",
      status,
      q: where.q,
      interaction: where.interaction,
      members,
      badges,
      pagination
    });
  })
);

app.get(
  "/admin/members/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const userId = (req.params.id || "").toString().trim();

    if (!userId || userId.length > 128) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const member = await getAdminMemberById(userId);
    if (!member) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    const badgeRows = await dbAll(
      "SELECT id, code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment FROM badges ORDER BY priority DESC, id ASC"
    );
    const badges = badgeRows.map(mapBadgeRow).filter(Boolean);

    if (wants) {
      return res.json({ ok: true, member, badges });
    }

    return res.redirect("/admin/members");
  })
);

app.post(
  "/admin/members/:id/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const userId = (req.params.id || "").toString().trim();
    if (!userId || userId.length > 128) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const existing = await dbGet("SELECT id FROM users WHERE id = ?", [userId]);
    if (!existing) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    const displayName = normalizeProfileDisplayName(req.body.display_name);
    const facebookUrl = normalizeProfileFacebook(req.body.facebook_url);
    const discordUrl = normalizeProfileDiscord(req.body.discord_url || req.body.discord_handle);
    const bio = normalizeProfileBio(req.body.bio);

    const result = await dbRun(
      "UPDATE users SET display_name = ?, facebook_url = ?, discord_handle = ?, bio = ?, updated_at = ? WHERE id = ?",
      [displayName, facebookUrl, discordUrl, bio, Date.now(), userId]
    );

    if (!result || !result.changes) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    if (wants) {
      return res.json({ ok: true, updated: true });
    }
    return res.redirect("/admin/members?status=updated");
  })
);

app.post(
  "/admin/members/:id/ban",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const userId = (req.params.id || "").toString().trim();
    const modeRaw = (req.body.mode || "").toString().trim().toLowerCase();
    const mode = modeRaw === "unban" ? "unban" : "ban";

    if (!userId || userId.length > 128) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const existing = await dbGet("SELECT id FROM users WHERE id = ?", [userId]);
    if (!existing) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    const bannedBadge = await dbGet("SELECT id FROM badges WHERE lower(code) = 'banned' LIMIT 1");
    const bannedBadgeId = bannedBadge && bannedBadge.id != null ? Number(bannedBadge.id) : NaN;
    if (!Number.isFinite(bannedBadgeId) || bannedBadgeId <= 0) {
      if (wants) {
        return res.status(500).json({ ok: false, error: "Không tìm thấy huy hiệu Banned." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    if (mode === "ban") {
      await withTransaction(async ({ dbRun: txRun }) => {
        await txRun("DELETE FROM user_badges WHERE user_id = ?", [userId]);
        await txRun(
          "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [userId, Math.floor(bannedBadgeId), Date.now()]
        );
      });
    } else {
      const memberBadgeId = await getMemberBadgeId();
      if (!memberBadgeId) {
        if (wants) {
          return res.status(500).json({ ok: false, error: "Không tìm thấy huy hiệu Member." });
        }
        return res.redirect("/admin/members?status=notfound");
      }

      await withTransaction(async ({ dbRun: txRun }) => {
        await txRun("DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?", [
          userId,
          Math.floor(bannedBadgeId)
        ]);
        await txRun(
          "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [userId, Math.floor(memberBadgeId), Date.now()]
        );
      });
    }

    if (wants) {
      return res.json({ ok: true, banned: mode === "ban" });
    }
    return res.redirect(`/admin/members?status=${mode === "ban" ? "banned" : "unbanned"}`);
  })
);

app.post(
  "/admin/members/:id/badges/add",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const userId = (req.params.id || "").toString().trim();
    const badgeIdRaw = Number(req.body.badge_id);
    const badgeId = Number.isFinite(badgeIdRaw) && badgeIdRaw > 0 ? Math.floor(badgeIdRaw) : 0;

    if (!userId || userId.length > 128 || !badgeId) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const userRow = await dbGet("SELECT id FROM users WHERE id = ?", [userId]);
    if (!userRow) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
      }
      return res.redirect("/admin/members?status=notfound");
    }
    const badgeRow = await dbGet("SELECT id, code FROM badges WHERE id = ?", [badgeId]);
    if (!badgeRow) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy huy hiệu." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    const badgeCode = normalizeBadgeCode(badgeRow.code);
    if (badgeCode !== "banned") {
      await ensureMemberBadgeForUser(userId);
    }

    await dbRun(
      "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [userId, badgeId, Date.now()]
    );

    if (wants) {
      return res.json({ ok: true, assigned: true });
    }
    return res.redirect("/admin/members?status=assigned");
  })
);

app.post(
  "/admin/members/:id/badges/:badgeId/remove",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const userId = (req.params.id || "").toString().trim();
    const badgeIdValue = Number(req.params.badgeId);
    const badgeId = Number.isFinite(badgeIdValue) && badgeIdValue > 0 ? Math.floor(badgeIdValue) : 0;

    if (!userId || userId.length > 128 || !badgeId) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const badgeRow = await dbGet("SELECT id, code FROM badges WHERE id = ?", [badgeId]);
    if (!badgeRow) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy huy hiệu." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    const badgeCode = normalizeBadgeCode(badgeRow.code);
    if (badgeCode === "member") {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Không thể gỡ huy hiệu Member." });
      }
      return res.redirect("/admin/members?status=invalid");
    }

    const result = await dbRun("DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?", [
      userId,
      badgeId
    ]);
    if (!result || !result.changes) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Thành viên chưa có huy hiệu này." });
      }
      return res.redirect("/admin/members?status=notfound");
    }

    if (wants) {
      return res.json({ ok: true, removed: true });
    }
    return res.redirect("/admin/members?status=revoked");
  })
);

app.get(
  "/admin/badges",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const badgeRows = await dbAll(
      "SELECT id, code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment FROM badges ORDER BY priority DESC, id ASC"
    );
    const badges = badgeRows.map(mapBadgeRow).filter(Boolean);

    return res.render("admin/badges", {
      title: "Quản lý huy hiệu",
      status,
      badges
    });
  })
);

app.post(
  "/admin/badges/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const label = (req.body.label || "").toString().trim();
    const color = normalizeHexColor(req.body.color) || "#f8f8f2";
    const canAccessAdmin = isTruthyInput(req.body.can_access_admin);
    const canDeleteAnyComment = isTruthyInput(req.body.can_delete_any_comment);
    let canComment = isTruthyInput(req.body.can_comment);

    if (!label) {
      return res.redirect("/admin/badges?status=missing");
    }

    const desiredCode = await buildAutoBadgeCode({ label, excludeBadgeId: null });
    if (!desiredCode) {
      return res.redirect("/admin/badges?status=exists");
    }
    if (desiredCode === "banned") {
      canComment = false;
    }

    const topRow = await dbGet("SELECT priority FROM badges ORDER BY priority DESC, id ASC LIMIT 1");
    const topPriority = topRow && topRow.priority != null ? Number(topRow.priority) : 0;
    const nextPriority = Number.isFinite(topPriority) ? Math.floor(topPriority) + 10 : 100;

    const now = Date.now();
    await dbRun(
      "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        desiredCode,
        label,
        color,
        nextPriority,
        canAccessAdmin,
        canDeleteAnyComment,
        canComment,
        now,
        now
      ]
    );

    return res.redirect("/admin/badges?status=created");
  })
);

app.post(
  "/admin/badges/:id/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const badgeId = Number(req.params.id);
    if (!Number.isFinite(badgeId) || badgeId <= 0) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/badges?status=invalid");
    }

    const label = (req.body.label || "").toString().trim();
    const color = normalizeHexColor(req.body.color) || "#f8f8f2";
    const canAccessAdmin = isTruthyInput(req.body.can_access_admin);
    const canDeleteAnyComment = isTruthyInput(req.body.can_delete_any_comment);
    let canComment = isTruthyInput(req.body.can_comment);

    if (!label) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Vui lòng nhập tên huy hiệu." });
      }
      return res.redirect("/admin/badges?status=missing");
    }

    const existingRow = await dbGet("SELECT id, code FROM badges WHERE id = ?", [Math.floor(badgeId)]);
    if (!existingRow) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy huy hiệu." });
      }
      return res.redirect("/admin/badges?status=notfound");
    }

    const currentCode = normalizeBadgeCode(existingRow.code);
    const reservedCodes = new Set(["admin", "mod", "member", "banned"]);
    let desiredCode = await buildAutoBadgeCode({ label, excludeBadgeId: badgeId });
    if (reservedCodes.has(currentCode)) {
      desiredCode = currentCode;
    }
    if (!desiredCode) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Không thể tạo mã huy hiệu tự động." });
      }
      return res.redirect("/admin/badges?status=exists");
    }
    if (desiredCode === "banned") {
      canComment = false;
    }

    const updatedAt = Date.now();
    const result = await dbRun(
      "UPDATE badges SET code = ?, label = ?, color = ?, can_access_admin = ?, can_delete_any_comment = ?, can_comment = ?, updated_at = ? WHERE id = ?",
      [
        desiredCode,
        label,
        color,
        canAccessAdmin,
        canDeleteAnyComment,
        canComment,
        updatedAt,
        Math.floor(badgeId)
      ]
    );

    if (!result || !result.changes) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy huy hiệu." });
      }
      return res.redirect("/admin/badges?status=notfound");
    }

    if (wants) {
      return res.json({ ok: true, updated: true });
    }
    return res.redirect("/admin/badges?status=updated");
  })
);

app.post(
  "/admin/badges/:id/move",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const wants = wantsJson(req);
    const badgeId = Number(req.params.id);
    if (!Number.isFinite(badgeId) || badgeId <= 0) {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
      }
      return res.redirect("/admin/badges?status=invalid");
    }

    const direction = (req.body.direction || "").toString().trim().toLowerCase();
    if (direction !== "up" && direction !== "down") {
      if (wants) {
        return res.status(400).json({ ok: false, error: "Hướng di chuyển không hợp lệ." });
      }
      return res.redirect("/admin/badges?status=invalid");
    }

    const rows = await dbAll("SELECT id, priority FROM badges ORDER BY priority DESC, id ASC");
    const safeRows = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const id = row && row.id != null ? Number(row.id) : NaN;
        const priority = row && row.priority != null ? Number(row.priority) : 0;
        if (!Number.isFinite(id) || id <= 0) return null;
        return {
          id: Math.floor(id),
          priority: Number.isFinite(priority) ? Math.floor(priority) : 0
        };
      })
      .filter(Boolean);

    const currentIndex = safeRows.findIndex((row) => row.id === Math.floor(badgeId));
    if (currentIndex < 0) {
      if (wants) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy huy hiệu." });
      }
      return res.redirect("/admin/badges?status=notfound");
    }

    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= safeRows.length) {
      if (wants) {
        return res.json({ ok: true, moved: false });
      }
      return res.redirect("/admin/badges");
    }

    const reordered = safeRows.slice();
    const temp = reordered[currentIndex];
    reordered[currentIndex] = reordered[targetIndex];
    reordered[targetIndex] = temp;

    const now = Date.now();
    await withTransaction(async ({ dbRun: txRun }) => {
      for (let index = 0; index < reordered.length; index += 1) {
        const row = reordered[index];
        const nextPriority = (reordered.length - index) * 10;
        await txRun("UPDATE badges SET priority = ?, updated_at = ? WHERE id = ?", [
          nextPriority,
          now,
          row.id
        ]);
      }
    });

    if (wants) {
      return res.json({ ok: true, moved: true });
    }
    return res.redirect("/admin/badges?status=moved");
  })
);

app.post(
  "/admin/badges/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const badgeId = Number(req.params.id);
    if (!Number.isFinite(badgeId) || badgeId <= 0) {
      return res.redirect("/admin/badges?status=invalid");
    }

    const result = await dbRun("DELETE FROM badges WHERE id = ?", [Math.floor(badgeId)]);
    if (!result || !result.changes) {
      return res.redirect("/admin/badges?status=notfound");
    }
    return res.redirect("/admin/badges?status=deleted");
  })
);

app.post(
  "/admin/badges/assign",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = (req.body.q || "").toString().trim();
    const userId = (req.body.user_id || "").toString().trim();
    const badgeId = Number(req.body.badge_id);
    if (!userId || !Number.isFinite(badgeId) || badgeId <= 0) {
      return res.redirect(`/admin/badges?status=missing${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    }

    const userRow = await dbGet("SELECT id FROM users WHERE id = ?", [userId]);
    if (!userRow) {
      return res.redirect(
        `/admin/badges?status=user_notfound${q ? `&q=${encodeURIComponent(q)}` : ""}`
      );
    }
    const badgeRow = await dbGet("SELECT id FROM badges WHERE id = ?", [Math.floor(badgeId)]);
    if (!badgeRow) {
      return res.redirect(`/admin/badges?status=notfound${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    }

    await dbRun(
      "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [userId, Math.floor(badgeId), Date.now()]
    );
    return res.redirect(`/admin/badges?status=assigned${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  })
);

app.post(
  "/admin/badges/revoke",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = (req.body.q || "").toString().trim();
    const userId = (req.body.user_id || "").toString().trim();
    const badgeId = Number(req.body.badge_id);
    if (!userId || !Number.isFinite(badgeId) || badgeId <= 0) {
      return res.redirect(`/admin/badges?status=missing${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    }
    const result = await dbRun("DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?", [
      userId,
      Math.floor(badgeId)
    ]);
    if (!result || !result.changes) {
      return res.redirect(`/admin/badges?status=notfound${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    }
    return res.redirect(`/admin/badges?status=revoked${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  })
);

app.get(
  "/comments/users/:id",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const userId = (req.params.id || "").toString().trim();
    if (!userId || userId.length > 128) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy người dùng." });
    }

    const profileRow = await dbGet(
      "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, created_at FROM users WHERE id = ?",
      [userId]
    );

    const countRow = await dbGet(
      "SELECT COUNT(*) as count FROM comments WHERE author_user_id = ? AND status = 'visible'",
      [userId]
    );
    const commentCount = countRow ? Number(countRow.count) || 0 : 0;

    const fallbackCommentRow =
      !profileRow && commentCount > 0
        ? await dbGet(
          "SELECT author, author_avatar_url, created_at FROM comments WHERE author_user_id = ? AND status = 'visible' ORDER BY created_at DESC, id DESC LIMIT 1",
          [userId]
        )
        : null;

    if (!profileRow && !fallbackCommentRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy người dùng." });
    }

    const username = profileRow && profileRow.username ? String(profileRow.username).trim() : "";
    const displayName =
      profileRow && profileRow.display_name ? String(profileRow.display_name).replace(/\s+/g, " ").trim() : "";
    const fallbackName =
      fallbackCommentRow && fallbackCommentRow.author
        ? String(fallbackCommentRow.author).replace(/\s+/g, " ").trim()
        : "";
    const name = displayName || fallbackName || (username ? `@${username}` : "Người dùng");

    const avatarUrl = normalizeAvatarUrl(
      (profileRow && profileRow.avatar_url) ||
      (fallbackCommentRow && fallbackCommentRow.author_avatar_url) ||
      ""
    );

    const joinedAtSource =
      (profileRow && profileRow.created_at != null && profileRow.created_at !== ""
        ? profileRow.created_at
        : null) ||
      (fallbackCommentRow && fallbackCommentRow.created_at != null && fallbackCommentRow.created_at !== ""
        ? fallbackCommentRow.created_at
        : null);
    const joinedAtNumeric = Number(joinedAtSource);
    const joinedAtValue = Number.isFinite(joinedAtNumeric) ? joinedAtNumeric : joinedAtSource;
    let joinedAtText = "";
    if (joinedAtValue) {
      const joinedDate = new Date(joinedAtValue);
      if (!Number.isNaN(joinedDate.getTime())) {
        joinedAtText = formatDate(joinedDate);
      }
    }

    const badgeContext = await getUserBadgeContext(userId);

    return res.json({
      ok: true,
      profile: {
        id: userId,
        name,
        email: profileRow && profileRow.email ? String(profileRow.email).trim() : "",
        avatarUrl,
        username,
        joinedAtText,
        commentCount,
        facebookUrl: normalizeProfileFacebook(profileRow && profileRow.facebook_url),
        discordUrl: normalizeProfileDiscord(profileRow && profileRow.discord_handle),
        bio: normalizeProfileBio(profileRow && profileRow.bio),
        badges: badgeContext.badges,
        userColor: badgeContext.userColor
      }
    });
  })
);

app.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;

    const rows = await dbAll(
      `
        SELECT
          n.id,
          n.type,
          n.actor_user_id,
          n.manga_id,
          n.chapter_number,
          n.comment_id,
          n.content_preview,
          n.is_read,
          n.created_at,
          n.read_at,
          m.slug as manga_slug,
          m.title as manga_title,
          actor.username as actor_username,
          actor.display_name as actor_display_name,
          actor.avatar_url as actor_avatar_url
        FROM notifications n
        LEFT JOIN manga m ON m.id = n.manga_id
        LEFT JOIN users actor ON actor.id = n.actor_user_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ?
      `,
      [userId, limit]
    );

    const notifications = await Promise.all(
      rows.map(async (row) => {
        const chapterValue = row && row.chapter_number != null ? Number(row.chapter_number) : NaN;
        const hasChapter = Number.isFinite(chapterValue);
        const resolvedUrl = await resolveCommentPermalinkForNotification({
          mangaSlug: row && row.manga_slug ? row.manga_slug : "",
          mangaId: row && row.manga_id != null ? row.manga_id : null,
          chapterNumber: hasChapter ? chapterValue : null,
          commentId: row && row.comment_id != null ? row.comment_id : null,
          perPage: 20
        });
        return mapNotificationRow(row, { url: resolvedUrl });
      })
    );

    const unreadCount = await getUnreadNotificationCount(userId);
    return res.json({
      ok: true,
      unreadCount,
      notifications
    });
  })
);

app.post(
  "/notifications/read-all",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const now = Date.now();
    const result = await dbRun(
      "UPDATE notifications SET is_read = true, read_at = ? WHERE user_id = ? AND is_read = false",
      [now, userId]
    );
    return res.json({
      ok: true,
      updated: result && result.changes ? result.changes : 0,
      unreadCount: 0
    });
  })
);

app.post(
  "/notifications/:id/read",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const notificationId = Number(req.params.id);
    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy thông báo." });
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const now = Date.now();
    const result = await dbRun(
      "UPDATE notifications SET is_read = true, read_at = ? WHERE id = ? AND user_id = ? AND is_read = false",
      [now, Math.floor(notificationId), userId]
    );
    const unreadCount = await getUnreadNotificationCount(userId);

    return res.json({
      ok: true,
      updated: result && result.changes ? result.changes : 0,
      unreadCount
    });
  })
);

app.post(
  "/comments/:id/delete",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const commentId = Number(req.params.id);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const commentRow = await dbGet(
      `
      SELECT
        c.id,
        c.manga_id,
        c.chapter_number,
        c.parent_id,
        c.author_user_id,
        c.author_email,
        p.author_user_id as parent_author_user_id,
        p.author_email as parent_author_email
      FROM comments c
      LEFT JOIN comments p ON p.id = c.parent_id
      WHERE c.id = ?
    `,
      [Math.floor(commentId)]
    );
    if (!commentRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    let canDeleteAny = false;
    try {
      await ensureUserRowFromSupabaseUser(user);
      const badgeContext = await getUserBadgeContext(userId);
      canDeleteAny = Boolean(
        badgeContext && badgeContext.permissions && badgeContext.permissions.canDeleteAnyComment
      );
    } catch (err) {
      console.warn("Failed to load delete permissions", err);
    }

    const ownerId = commentRow.author_user_id ? String(commentRow.author_user_id).trim() : "";
    const ownerEmail = commentRow.author_email
      ? String(commentRow.author_email).trim().toLowerCase()
      : "";
    const parentOwnerId = commentRow.parent_author_user_id
      ? String(commentRow.parent_author_user_id).trim()
      : "";
    const parentOwnerEmail = commentRow.parent_author_email
      ? String(commentRow.parent_author_email).trim().toLowerCase()
      : "";
    const userEmail = user.email ? String(user.email).trim().toLowerCase() : "";

    const isOwner = Boolean(ownerId && ownerId === userId);
    const isOwnerByEmail = Boolean(!isOwner && userEmail && ownerEmail && ownerEmail === userEmail);
    const isParentOwner = Boolean(parentOwnerId && parentOwnerId === userId);
    const isParentOwnerByEmail = Boolean(
      !isParentOwner && userEmail && parentOwnerEmail && parentOwnerEmail === userEmail
    );

    let isAncestorOwner = false;
    if (commentRow.parent_id) {
      const ancestorRow = await dbGet(
        `
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_id, author_user_id, author_email
          FROM comments
          WHERE id = ?
          UNION ALL
          SELECT c.id, c.parent_id, c.author_user_id, c.author_email
          FROM comments c
          JOIN ancestors a ON c.id = a.parent_id
        )
        SELECT 1 as ok
        FROM ancestors
        WHERE (author_user_id = ? AND author_user_id IS NOT NULL AND TRIM(author_user_id) <> '')
           OR (? <> '' AND lower(COALESCE(author_email, '')) = ?)
        LIMIT 1
      `,
        [commentRow.parent_id, userId, userEmail, userEmail]
      );
      isAncestorOwner = Boolean(ancestorRow && ancestorRow.ok);
    }

    if (
      !isOwner &&
      !isOwnerByEmail &&
      !isParentOwner &&
      !isParentOwnerByEmail &&
      !isAncestorOwner &&
      !canDeleteAny
    ) {
      return res.status(403).json({ ok: false, error: "Bạn không có quyền xóa bình luận này." });
    }

    const deleted = await deleteCommentCascade(commentRow.id);
    const commentCount = await getVisibleCommentCount({
      mangaId: commentRow.manga_id,
      chapterNumber: commentRow.chapter_number
    });

    return res.json({ ok: true, deleted, commentCount });
  })
);

app.post(
  "/comments/reactions",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    let canInteract = false;
    try {
      await ensureUserRowFromSupabaseUser(user);
      const badgeContext = await getUserBadgeContext(userId);
      canInteract = Boolean(
        badgeContext && badgeContext.permissions && badgeContext.permissions.canComment !== false
      );
    } catch (err) {
      console.warn("Failed to load interaction permissions for reaction sync", err);
    }

    if (!canInteract) {
      return res.json({ ok: true, likedIds: [], reportedIds: [] });
    }

    const rawIds = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    ).slice(0, 320);

    if (!ids.length) {
      return res.json({ ok: true, likedIds: [], reportedIds: [] });
    }

    const placeholders = ids.map(() => "?").join(",");
    const likedRows = await dbAll(
      `
      SELECT cl.comment_id
      FROM comment_likes cl
      JOIN comments c ON c.id = cl.comment_id
      WHERE cl.user_id = ?
        AND cl.comment_id IN (${placeholders})
        AND c.status = 'visible'
    `,
      [userId, ...ids]
    );
    const reportedRows = await dbAll(
      `
      SELECT cr.comment_id
      FROM comment_reports cr
      JOIN comments c ON c.id = cr.comment_id
      WHERE cr.user_id = ?
        AND cr.comment_id IN (${placeholders})
        AND c.status = 'visible'
    `,
      [userId, ...ids]
    );

    const likedIds = likedRows
      .map((row) => Number(row.comment_id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));

    const reportedIds = reportedRows
      .map((row) => Number(row.comment_id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));

    return res.json({ ok: true, likedIds, reportedIds });
  })
);

app.post(
  "/comments/:id/like",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const commentId = Number(req.params.id);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    let canInteract = false;
    try {
      await ensureUserRowFromSupabaseUser(user);
      const badgeContext = await getUserBadgeContext(userId);
      canInteract = Boolean(
        badgeContext && badgeContext.permissions && badgeContext.permissions.canComment !== false
      );
    } catch (err) {
      console.warn("Failed to load interaction permissions for like action", err);
    }

    if (!canInteract) {
      return res.status(403).json({ ok: false, error: "Tài khoản của bạn hiện không có quyền tương tác." });
    }

    const commentRow = await dbGet("SELECT id FROM comments WHERE id = ? AND status = 'visible'", [
      Math.floor(commentId)
    ]);
    if (!commentRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    const result = await withTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      const existing = await txGet(
        "SELECT 1 as ok FROM comment_likes WHERE comment_id = ? AND user_id = ?",
        [Math.floor(commentId), userId]
      );

      let liked = false;
      if (existing) {
        await txRun("DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?", [
          Math.floor(commentId),
          userId
        ]);
        await txRun(
          "UPDATE comments SET like_count = GREATEST(COALESCE(like_count, 0) - 1, 0) WHERE id = ?",
          [Math.floor(commentId)]
        );
        liked = false;
      } else {
        const inserted = await txRun(
          "INSERT INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [Math.floor(commentId), userId, Date.now()]
        );

        if (inserted && inserted.changes) {
          await txRun("UPDATE comments SET like_count = COALESCE(like_count, 0) + 1 WHERE id = ?", [
            Math.floor(commentId)
          ]);
        }
        liked = true;
      }

      const countRow = await txGet("SELECT COALESCE(like_count, 0) as like_count FROM comments WHERE id = ?", [
        Math.floor(commentId)
      ]);
      const likeCount = countRow ? Number(countRow.like_count) || 0 : 0;
      return { liked, likeCount };
    });

    return res.json({ ok: true, liked: result.liked, likeCount: result.likeCount });
  })
);

app.post(
  "/comments/:id/report",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const commentId = Number(req.params.id);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    const user = await requireSupabaseUserForComments(req, res);
    if (!user) return;

    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    let canInteract = false;
    try {
      await ensureUserRowFromSupabaseUser(user);
      const badgeContext = await getUserBadgeContext(userId);
      canInteract = Boolean(
        badgeContext && badgeContext.permissions && badgeContext.permissions.canComment !== false
      );
    } catch (err) {
      console.warn("Failed to load interaction permissions for report action", err);
    }

    if (!canInteract) {
      return res.status(403).json({ ok: false, error: "Tài khoản của bạn hiện không có quyền tương tác." });
    }

    const commentRow = await dbGet(
      "SELECT id, author_user_id, author_email FROM comments WHERE id = ? AND status = 'visible'",
      [Math.floor(commentId)]
    );
    if (!commentRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
    }

    const ownerId = commentRow.author_user_id ? String(commentRow.author_user_id).trim() : "";
    const ownerEmail = commentRow.author_email
      ? String(commentRow.author_email).trim().toLowerCase()
      : "";
    const userEmail = user.email ? String(user.email).trim().toLowerCase() : "";
    if ((ownerId && ownerId === userId) || (ownerEmail && userEmail && ownerEmail === userEmail)) {
      return res.status(400).json({ ok: false, error: "Bạn không thể báo cáo bình luận của chính mình." });
    }

    const result = await withTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      const existing = await txGet(
        "SELECT 1 as ok FROM comment_reports WHERE comment_id = ? AND user_id = ?",
        [Math.floor(commentId), userId]
      );

      let reported = true;
      if (!existing) {
        const inserted = await txRun(
          "INSERT INTO comment_reports (comment_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [Math.floor(commentId), userId, Date.now()]
        );

        if (inserted && inserted.changes) {
          await txRun(
            `
            UPDATE comments
            SET report_count = COALESCE(report_count, 0) + 1,
                status = CASE WHEN COALESCE(report_count, 0) + 1 >= 3 THEN 'reported' ELSE status END
            WHERE id = ?
          `,
            [Math.floor(commentId)]
          );
        }
      }

      const countRow = await txGet(
        "SELECT COALESCE(report_count, 0) as report_count FROM comments WHERE id = ?",
        [Math.floor(commentId)]
      );
      const reportCount = countRow ? Number(countRow.report_count) || 0 : 0;
      if (existing) {
        reported = true;
      }

      return { reported, reportCount };
    });

    return res.json({ ok: true, reported: result.reported, reportCount: result.reportCount });
  })
);

app.get(
  "/admin/genres",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const focusIdValue = Number(req.query.id);
    const focusGenreId =
      Number.isFinite(focusIdValue) && focusIdValue > 0 ? Math.floor(focusIdValue) : 0;

    const genreRows = await getGenreStats();
    const qNormalized = q.replace(/^#/, "").trim();
    const queryLower = qNormalized.toLowerCase();
    const queryId = /^\d+$/.test(qNormalized) ? Number(qNormalized) : null;
    const genres = q
      ? genreRows.filter((genre) => {
        if (queryId && Number(genre.id) === queryId) return true;
        return genre.name.toLowerCase().includes(queryLower);
      })
      : genreRows;

    if (wantsJson(req)) {
      return res.json({
        genres: genres.map((genre) => ({
          id: genre.id,
          name: genre.name,
          count: Number(genre.count) || 0
        })),
        q
      });
    }

    res.render("admin/genres", {
      title: "Quản lý thể loại",
      adminUser: adminConfig.user,
      genres,
      status,
      q,
      focusGenreId
    });
  })
);

app.post(
  "/admin/genres/new",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = normalizeGenreName(req.body.name);
    if (!name) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "Vui lòng nhập tên thể loại." });
      }
      return res.redirect("/admin/genres?status=missing");
    }

    const existing = await dbGet("SELECT id FROM genres WHERE name = ?", [name]);
    if (existing) {
      if (wantsJson(req)) {
        return res.status(409).json({
          ok: false,
          error: "Thể loại đã tồn tại.",
          id: Number(existing.id) || 0
        });
      }
      return res.redirect(`/admin/genres?status=exists&id=${existing.id}#genre-${existing.id}`);
    }

    const normalizedExisting = await findGenreRowByNormalizedName(name);
    if (normalizedExisting) {
      if (normalizedExisting.name !== name) {
        await dbRun("UPDATE genres SET name = ? WHERE id = ?", [name, normalizedExisting.id]);
      }
      if (wantsJson(req)) {
        return res.status(409).json({
          ok: false,
          error: "Thể loại đã tồn tại.",
          id: Number(normalizedExisting.id) || 0
        });
      }
      return res.redirect(
        `/admin/genres?status=exists&id=${normalizedExisting.id}#genre-${normalizedExisting.id}`
      );
    }

    const result = await dbRun("INSERT INTO genres (name) VALUES (?)", [name]);
    if (wantsJson(req)) {
      return res.json({
        ok: true,
        created: true,
        genre: {
          id: result ? Number(result.lastID) || 0 : 0,
          name,
          count: 0
        }
      });
    }
    return res.redirect(`/admin/genres?status=created&id=${result.lastID}#genre-${result.lastID}`);
  })
);

app.post(
  "/admin/genres/:id/update",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const genreId = Number(req.params.id);
    if (!Number.isFinite(genreId) || genreId <= 0) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "ID thể loại không hợp lệ." });
      }
      return res.redirect("/admin/genres?status=invalid");
    }

    const name = normalizeGenreName(req.body.name);
    if (!name) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "Vui lòng nhập tên thể loại." });
      }
      return res.redirect(`/admin/genres?status=missing&id=${genreId}#genre-${genreId}`);
    }

    const safeGenreId = Math.floor(genreId);
    const current = await dbGet("SELECT id FROM genres WHERE id = ?", [safeGenreId]);
    if (!current) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thể loại." });
      }
      return res.redirect("/admin/genres?status=notfound");
    }

    const duplicate = await dbGet("SELECT id FROM genres WHERE name = ? AND id <> ?", [
      name,
      safeGenreId
    ]);
    if (duplicate) {
      if (wantsJson(req)) {
        return res.status(409).json({
          ok: false,
          error: "Tên thể loại đã được dùng cho ID khác.",
          id: Number(duplicate.id) || 0
        });
      }
      return res.redirect(
        `/admin/genres?status=duplicate&id=${safeGenreId}&target=${duplicate.id}#genre-${safeGenreId}`
      );
    }

    await dbRun("UPDATE genres SET name = ? WHERE id = ?", [name, safeGenreId]);
    if (wantsJson(req)) {
      return res.json({
        ok: true,
        updated: true,
        genre: {
          id: safeGenreId,
          name
        }
      });
    }
    return res.redirect(`/admin/genres?status=updated&id=${safeGenreId}#genre-${safeGenreId}`);
  })
);

app.post(
  "/admin/genres/:id/delete",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const genreId = Number(req.params.id);
    if (!Number.isFinite(genreId) || genreId <= 0) {
      if (wantsJson(req)) {
        return res.status(400).json({ ok: false, error: "ID thể loại không hợp lệ." });
      }
      return res.redirect("/admin/genres?status=invalid");
    }

    const safeGenreId = Math.floor(genreId);
    const result = await dbRun("DELETE FROM genres WHERE id = ?", [safeGenreId]);
    if (!result || !result.changes) {
      if (wantsJson(req)) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy thể loại cần xóa." });
      }
      return res.redirect("/admin/genres?status=notfound");
    }

    if (wantsJson(req)) {
      return res.json({ ok: true, deleted: true, id: safeGenreId });
    }

    return res.redirect("/admin/genres?status=deleted");
  })
);

app.use((req, res) => {
  res.status(404).render("not-found", {
    title: "Không tìm thấy",
    team,
    seo: buildSeoPayload(req, {
      title: "Không tìm thấy",
      description: "Trang bạn yêu cầu không tồn tại trên BFANG Team.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: ensureLeadingSlash(req.path || "/")
    })
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Đã xảy ra lỗi hệ thống.");
});

initDb()
  .then(() => {
    scheduleCoverTempCleanup();
    scheduleChapterDraftCleanup();
    scheduleNotificationCleanup();
    resumeChapterProcessingJobs().catch((err) => {
      console.warn("Failed to resume chapter processing jobs", err);
    });
    app.listen(PORT, () => {
      console.log(`BFANG manga server running on port ${PORT}`);
      console.log(`Asset version token: ${serverAssetVersion}`);
      console.log(
        `Production asset minify: ${isProductionApp ? "enabled (X-Asset-Minified: 1)" : "disabled"}`
      );
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database", error);
    process.exit(1);
  });
