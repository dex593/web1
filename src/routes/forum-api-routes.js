const registerForumApiRoutes = (app, deps) => {
  const {
    asyncHandler,
    b2CopyFile,
    b2DeleteAllByPrefix,
    b2DeleteFileVersions,
    b2UploadBuffer,
    buildCommentMentionsForContent,
    crypto,
    dbAll,
    dbGet,
    dbRun,
    extractMentionUsernamesFromContent,
    formatChapterNumberValue,
    formatTimeAgo,
    getB2Config,
    getMentionProfileMapForManga,
    getUserBadgeContext,
    isB2Ready,
    loadSessionUserById,
    normalizeAvatarUrl,
    requireAdmin,
    sharp,
    deleteCommentCascade,
    withTransaction,
  } = deps;

  const DEFAULT_PER_PAGE = 20;
  const MAX_PER_PAGE = 20;
  const FORUM_REQUEST_ID_PREFIX = "forum-";
  const FORUM_REQUEST_ID_LIKE = `${FORUM_REQUEST_ID_PREFIX}%`;
  const HOT_RECENT_WINDOW_MS = 30 * 60 * 1000;
  const HOT_RECENT_LIMIT = 5;
  const HOT_COMMENT_ACTIVITY_LIMIT = 10;
  const ADMIN_DEFAULT_PER_PAGE = 20;
  const ADMIN_MAX_PER_PAGE = 50;

  const FORUM_ADMIN_SECTION_OPTIONS = Object.freeze([
    { slug: "thao-luan-chung", label: "Thảo luận chung", icon: "💬" },
    { slug: "thong-bao", label: "Thông báo", icon: "📢" },
    { slug: "huong-dan", label: "Hướng dẫn", icon: "📘" },
    { slug: "tim-truyen", label: "Tìm truyện", icon: "🔎" },
    { slug: "gop-y", label: "Góp ý", icon: "💡" },
    { slug: "tam-su", label: "Tâm sự", icon: "🫶" },
    { slug: "chia-se", label: "Chia sẻ", icon: "🤝" },
  ]);
  const FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG = new Map(
    FORUM_ADMIN_SECTION_OPTIONS.map((item, index) => [item.slug, { ...item, defaultOrder: index + 1 }])
  );
  const FORUM_ADMIN_SECTION_LABEL_BY_SLUG = new Map(
    FORUM_ADMIN_SECTION_OPTIONS.map((item) => [item.slug, item.label])
  );

  const toText = (value) => (value == null ? "" : String(value)).trim();

  const normalizeAbsoluteHttpBaseUrl = (value) => {
    const raw = toText(value);
    if (!raw) return "";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      const pathname = (parsed.pathname || "/").replace(/\/+$/, "");
      return `${parsed.protocol}//${parsed.host}${pathname}`;
    } catch (_err) {
      return "";
    }
  };

  const resolveForumImageBaseUrl = (config) => {
    const forumBase = normalizeAbsoluteHttpBaseUrl(config && config.forumCdnBaseUrl);
    if (forumBase) return forumBase;
    const chapterBase = normalizeAbsoluteHttpBaseUrl(config && config.cdnBaseUrl);
    if (chapterBase) return chapterBase;
    const endpointBase = normalizeAbsoluteHttpBaseUrl(config && config.endpoint);
    if (endpointBase) return endpointBase;
    return "";
  };

  const safeDecodeUrlPath = (input) => {
    try {
      return decodeURIComponent(input || "");
    } catch (_err) {
      return String(input || "");
    }
  };

  const isManagedForumPathSegment = ({ segments, index, forumPrefix, chapterPrefix }) => {
    const current = segments[index] || "";
    const next = segments[index + 1] || "";
    const third = segments[index + 2] || "";

    if (current === forumPrefix) {
      return next === "posts" || (next === "tmp" && third === "posts");
    }
    if (current === chapterPrefix) {
      return next === "forum-posts" || (next === "tmp" && third === "forum-posts");
    }
    return false;
  };

  const normalizeObjectKeyFromPath = (pathValue, config, options = {}) => {
    const decodedPath = safeDecodeUrlPath(pathValue).replace(/^\/+/, "");
    if (!decodedPath) return "";

    const segments = decodedPath.split("/").filter(Boolean);
    if (!segments.length) return "";

    const bucketId = toText(config && config.bucketId);
    const forumPrefix = toText(config && config.forumPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "forum";
    const chapterPrefix =
      toText(config && config.chapterPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "chapters";
    const allowManagedPathSearch = Boolean(options.allowManagedPathSearch);

    const maybeStripManagedPrefix = (parts) => {
      if (!allowManagedPathSearch) {
        return parts.join("/");
      }
      const startIndex = parts.findIndex((_, index) =>
        isManagedForumPathSegment({ segments: parts, index, forumPrefix, chapterPrefix })
      );
      if (startIndex > 0) {
        return parts.slice(startIndex).join("/");
      }
      return parts.join("/");
    };

    if (bucketId && segments[0] === "file" && segments[1] === bucketId && segments.length > 2) {
      return maybeStripManagedPrefix(segments.slice(2));
    }

    if (bucketId && segments[0] === bucketId && segments.length > 1) {
      return maybeStripManagedPrefix(segments.slice(1));
    }

    if (segments[0] === "file" && segments.length > 2) {
      return maybeStripManagedPrefix(segments.slice(2));
    }

    return maybeStripManagedPrefix(segments);
  };

  const extractManagedForumKeyFromString = (value, config) => {
    const decoded = safeDecodeUrlPath(toText(value));
    if (!decoded) return "";

    const forumPrefix = toText(config && config.forumPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "forum";
    const chapterPrefix =
      toText(config && config.chapterPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "chapters";

    const patterns = [
      new RegExp(`(${escapeRegex(forumPrefix)}\\/(?:posts|tmp\\/posts)\\/[A-Za-z0-9._~!$&'()*+,;=:@\\/%-]+)`, "i"),
      new RegExp(
        `(${escapeRegex(chapterPrefix)}\\/(?:forum-posts|tmp\\/forum-posts)\\/[A-Za-z0-9._~!$&'()*+,;=:@\\/%-]+)`,
        "i"
      ),
    ];

    for (const pattern of patterns) {
      const match = decoded.match(pattern);
      if (!match || !match[1]) continue;
      const candidate = String(match[1])
        .replace(/[?#].*$/g, "")
        .replace(/[&"'<>\s]+$/g, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      if (candidate) return candidate;
    }

    return "";
  };

  const extractObjectKeyFromUrlLike = (value) => {
    const raw = toText(value);
    if (!raw) return "";

    const config = typeof getB2Config === "function" ? getB2Config() : null;

    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        const fromPath = normalizeObjectKeyFromPath(parsed.pathname || "", config, { allowManagedPathSearch: true });
        const extracted = extractManagedForumKeyFromString(fromPath || `${parsed.pathname || ""}${parsed.search || ""}`, config);
        return extracted || fromPath;
      } catch (_err) {
        return extractManagedForumKeyFromString(raw, config);
      }
    }

    if (/^\/\//.test(raw)) {
      try {
        const parsed = new URL(`https:${raw}`);
        const fromPath = normalizeObjectKeyFromPath(parsed.pathname || "", config, { allowManagedPathSearch: true });
        const extracted = extractManagedForumKeyFromString(fromPath || `${parsed.pathname || ""}${parsed.search || ""}`, config);
        return extracted || fromPath;
      } catch (_err) {
        return extractManagedForumKeyFromString(raw, config);
      }
    }

    const fromPath = normalizeObjectKeyFromPath(raw.split(/[?#]/)[0], config, { allowManagedPathSearch: true });
    const extracted = extractManagedForumKeyFromString(raw, config);
    return extracted || fromPath;
  };

  const replaceImageSourceByKey = ({ content, sourceKey, replacementUrl }) => {
    const targetKey = toText(sourceKey).replace(/^\/+/, "");
    const nextUrl = toText(replacementUrl);
    if (!targetKey || !nextUrl) {
      return { content: String(content || ""), replaced: false };
    }

    let replaced = false;
    const output = String(content || "").replace(
      /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi,
      (full, start, currentUrl, end) => {
        const currentKey = extractObjectKeyFromUrlLike(currentUrl);
        if (currentKey !== targetKey) return full;
        replaced = true;
        return `${start}${nextUrl}${end}`;
      }
    );

    return { content: output, replaced };
  };

  const contentHasImageKey = (content, key) => {
    const probe = replaceImageSourceByKey({
      content,
      sourceKey: key,
      replacementUrl: "__key_probe__",
    });
    return Boolean(probe && probe.replaced);
  };

  const listImageKeysFromContent = (content) => {
    const keys = new Set();
    String(content || "").replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_fullMatch, srcValue) => {
      const key = extractObjectKeyFromUrlLike(srcValue);
      if (key) {
        keys.add(key.replace(/^\/+/, ""));
      }
      return "";
    });
    return Array.from(keys);
  };

  const isForumManagedImageKey = (key, config) => {
    const normalizedKey = toText(key).replace(/^\/+/, "");
    if (!normalizedKey) return false;

    const forumPrefix = toText(config && config.forumPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "forum";
    const chapterPrefix =
      toText(config && config.chapterPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "chapters";

    return (
      normalizedKey.startsWith(`${forumPrefix}/posts/`) ||
      normalizedKey.startsWith(`${forumPrefix}/tmp/posts/`) ||
      normalizedKey.startsWith(`${chapterPrefix}/forum-posts/`) ||
      normalizedKey.startsWith(`${chapterPrefix}/tmp/forum-posts/`)
    );
  };

  const getRemovedForumImageKeys = ({ beforeContent, nextContent, config }) => {
    const previousKeys = new Set(
      listImageKeysFromContent(beforeContent).filter((key) => isForumManagedImageKey(key, config))
    );
    if (!previousKeys.size) return [];

    const currentKeys = new Set(listImageKeysFromContent(nextContent).filter((key) => isForumManagedImageKey(key, config)));
    return Array.from(previousKeys).filter((key) => !currentKeys.has(key));
  };

  const expandForumImageKeyCandidates = (value, config) => {
    const raw = toText(value);
    if (!raw) return [];

    const candidates = new Set();
    const addCandidate = (inputValue) => {
      const text = toText(inputValue);
      if (!text) return;

      const normalizedPath = normalizeObjectKeyFromPath(text, config, { allowManagedPathSearch: true });
      if (normalizedPath) {
        candidates.add(normalizedPath);
      }

      const extracted = extractManagedForumKeyFromString(text, config);
      if (extracted) {
        candidates.add(extracted);
      }
    };

    addCandidate(raw);

    const withoutQuery = raw.split(/[?#]/)[0];
    if (withoutQuery && withoutQuery !== raw) {
      addCandidate(withoutQuery);
    }

    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        addCandidate(`${parsed.pathname || ""}${parsed.search || ""}`);
      } catch (_err) {
        // ignore parse errors
      }
    } else if (/^\/\//.test(raw)) {
      try {
        const parsed = new URL(`https:${raw}`);
        addCandidate(`${parsed.pathname || ""}${parsed.search || ""}`);
      } catch (_err) {
        // ignore parse errors
      }
    }

    return Array.from(candidates).filter(Boolean);
  };

  const normalizeRequestedRemovedImageKeys = (value, config) => {
    return Array.from(
      new Set(
        (Array.isArray(value) ? value : [])
          .flatMap((item) => expandForumImageKeyCandidates(item, config))
          .filter((key) => isForumManagedImageKey(key, config))
      )
    );
  };

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const normalizePositiveInt = (value, fallback = 0) => {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.floor(raw);
  };

  const normalizeForumSort = (value) => {
    const raw = toText(value).toLowerCase();
    if (raw === "new" || raw === "most-commented" || raw === "hot") {
      return raw;
    }
    return "hot";
  };

  const normalizeForumAdminStatus = (value) => {
    const raw = toText(value).toLowerCase();
    if (raw === "visible" || raw === "hidden" || raw === "reported") {
      return raw;
    }
    return "all";
  };

  const normalizeForumAdminSort = (value) => {
    const raw = toText(value).toLowerCase();
    if (raw === "oldest" || raw === "likes" || raw === "reports" || raw === "comments") {
      return raw;
    }
    return "newest";
  };

  const normalizeForumAdminSection = (value) => {
    const slug = normalizeForumSectionSlug(value);
    return slug || "all";
  };

  const parseBooleanValue = (value, fallback = true) => {
    if (typeof value === "boolean") return value;
    if (value == null) return fallback;

    const normalized = toText(value).toLowerCase();
    if (!normalized) return fallback;
    if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
  };

  const normalizeAdminIdList = (input, maxCount = 200) => {
    const values = Array.isArray(input) ? input : [];
    return Array.from(
      new Set(
        values
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    ).slice(0, Math.max(1, normalizePositiveInt(maxCount, 200)));
  };

  const sanitizeForumSectionLabel = (value) => {
    const text = toText(value).replace(/\s+/g, " ").trim();
    return text.slice(0, 64);
  };

  const sanitizeForumSectionIcon = (value) => {
    const text = toText(value).replace(/\s+/g, "");
    if (!text) return "";
    return Array.from(text).slice(0, 2).join("");
  };

  const sanitizeForumSectionSlug = (value) =>
    toText(value)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);

  const buildForumSectionLabelFromSlug = (slugValue) => {
    const safeSlug = sanitizeForumSectionSlug(slugValue);
    if (!safeSlug) return "Thảo luận chung";
    return safeSlug
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  };

  let forumSectionSettingsTableReadyPromise = null;

  const ensureForumSectionSettingsTable = async () => {
    if (forumSectionSettingsTableReadyPromise) {
      return forumSectionSettingsTableReadyPromise;
    }

    forumSectionSettingsTableReadyPromise = dbRun(
      `
        CREATE TABLE IF NOT EXISTS forum_section_settings (
          slug TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          icon TEXT NOT NULL,
          is_visible BOOLEAN NOT NULL DEFAULT TRUE,
          is_system BOOLEAN NOT NULL DEFAULT FALSE,
          is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `
    )
      .then(async () => {
        await dbRun(
          "ALTER TABLE forum_section_settings ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE"
        );
        await dbRun(
          "ALTER TABLE forum_section_settings ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE"
        );
        await dbRun(
          "ALTER TABLE forum_section_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
        );

        for (const [slug, item] of FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG.entries()) {
          await dbRun(
            `
              INSERT INTO forum_section_settings (
                slug,
                label,
                icon,
                is_visible,
                is_system,
                is_deleted,
                sort_order,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, TRUE, TRUE, FALSE, ?, NOW(), NOW())
              ON CONFLICT (slug) DO UPDATE
              SET
                is_system = TRUE,
                label = CASE
                  WHEN COALESCE(TRIM(forum_section_settings.label), '') = '' THEN EXCLUDED.label
                  ELSE forum_section_settings.label
                END,
                icon = CASE
                  WHEN COALESCE(TRIM(forum_section_settings.icon), '') = '' THEN EXCLUDED.icon
                  ELSE forum_section_settings.icon
                END,
                sort_order = CASE
                  WHEN COALESCE(forum_section_settings.sort_order, 0) <= 0 THEN EXCLUDED.sort_order
                  ELSE forum_section_settings.sort_order
                END,
                created_at = COALESCE(forum_section_settings.created_at, NOW())
            `,
            [slug, item.label, item.icon, item.defaultOrder]
          );
        }
      })
      .catch((err) => {
      forumSectionSettingsTableReadyPromise = null;
      throw err;
    });

    return forumSectionSettingsTableReadyPromise;
  };

  const loadForumAdminSections = async () => {
    await ensureForumSectionSettingsTable();

    const rows = await dbAll(
      `
        SELECT
          slug,
          label,
          icon,
          is_visible,
          is_system,
          is_deleted,
          sort_order,
          created_at,
          updated_at
        FROM forum_section_settings
        WHERE COALESCE(is_deleted, FALSE) = FALSE
      `
    );

    const sections = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const rawSlug = sanitizeForumSectionSlug(row && row.slug);
        if (!rawSlug) return null;
        const systemDefaults = FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG.get(rawSlug);
        const sortOrderRaw = Number(row && row.sort_order);
        const sortOrder =
          Number.isFinite(sortOrderRaw) && sortOrderRaw > 0
            ? Math.floor(sortOrderRaw)
            : systemDefaults
              ? systemDefaults.defaultOrder
              : 9999;

        const label =
          sanitizeForumSectionLabel(row && row.label) ||
          (systemDefaults ? systemDefaults.label : rawSlug);

        const icon =
          sanitizeForumSectionIcon(row && row.icon) ||
          (systemDefaults ? systemDefaults.icon : "💬");

        return {
          slug: rawSlug,
          label,
          icon,
          visible: parseBooleanValue(row && row.is_visible, true),
          isSystem: parseBooleanValue(row && row.is_system, false),
          sortOrder,
          createdAt: toIso(row && row.created_at),
          updatedAt: toIso(row && row.updated_at),
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      const leftDefaultOrder = FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG.get(left.slug);
      const rightDefaultOrder = FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG.get(right.slug);
      return (leftDefaultOrder ? leftDefaultOrder.defaultOrder : 0) -
        (rightDefaultOrder ? rightDefaultOrder.defaultOrder : 0);
    });

    const labelBySlug = new Map(sections.map((item) => [item.slug, item.label]));

    return {
      sections,
      labelBySlug,
    };
  };

  const buildForumAdminSectionStatsMap = async (knownSlugs = []) => {
    const rows = await dbAll(
      `
        SELECT c.content, c.status, c.report_count, c.created_at
        FROM comments c
        WHERE c.parent_id IS NULL
          AND COALESCE(c.client_request_id, '') ILIKE ?
      `,
      [FORUM_REQUEST_ID_LIKE]
    );

    const statsBySlug = new Map(
      (Array.isArray(knownSlugs) ? knownSlugs : []).map((slug) => [
        slug,
        {
          postCount: 0,
          hiddenPostCount: 0,
          reportCount: 0,
          lastPostAt: "",
          lastPostTimeAgo: "",
        },
      ])
    );

    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const rawSlug = extractForumSectionSlug(toText(row && row.content));
      const sectionSlug = rawSlug || "thao-luan-chung";
      if (!statsBySlug.has(sectionSlug)) {
        statsBySlug.set(sectionSlug, {
          postCount: 0,
          hiddenPostCount: 0,
          reportCount: 0,
          lastPostAt: "",
          lastPostTimeAgo: "",
        });
      }
      const bucket = statsBySlug.get(sectionSlug);
      if (!bucket) return;

      bucket.postCount += 1;
      bucket.reportCount += Number(row && row.report_count) || 0;
      if (toText(row && row.status).toLowerCase() === "reported") {
        bucket.hiddenPostCount += 1;
      }

      const createdAtRaw = toText(row && row.created_at);
      if (!createdAtRaw) return;

      const currentTime = new Date(createdAtRaw).getTime();
      const previousTime = bucket.lastPostAt ? new Date(bucket.lastPostAt).getTime() : 0;
      if (!Number.isFinite(currentTime) || (Number.isFinite(previousTime) && previousTime >= currentTime)) {
        return;
      }

      bucket.lastPostAt = toIso(createdAtRaw);
      bucket.lastPostTimeAgo = typeof formatTimeAgo === "function" ? formatTimeAgo(createdAtRaw) : createdAtRaw;
    });

    return statsBySlug;
  };

  const toIso = (value) => {
    const raw = toText(value);
    if (!raw) return "";
    const parsed = new Date(raw).getTime();
    if (!Number.isFinite(parsed)) return raw;
    return new Date(parsed).toISOString();
  };

  const normalizeGenreSlug = (name) =>
    toText(name)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const FORUM_SECTION_SLUG_ALIASES = new Map([
    ["goi-y", "gop-y"],
    ["tin-tuc", "thong-bao"],
  ]);
  const FORUM_META_COMMENT_PATTERN = /<!--\s*forum-meta:([^>]*?)\s*-->/gi;

  const normalizeForumSectionSlug = (value) => {
    const slug = sanitizeForumSectionSlug(value);
    if (!slug) return "";
    const alias = FORUM_SECTION_SLUG_ALIASES.get(slug);
    return alias || slug;
  };

  const extractForumSectionSlug = (content) => {
    let resolved = "";
    String(content || "").replace(FORUM_META_COMMENT_PATTERN, (_fullMatch, payloadText) => {
      if (resolved) return "";
      const payload = toText(payloadText);
      if (!payload) return "";

      const pairs = payload
        .split(";")
        .map((item) => toText(item))
        .filter(Boolean);
      for (const pair of pairs) {
        const equalIndex = pair.indexOf("=");
        if (equalIndex <= 0) continue;
        const key = pair.slice(0, equalIndex).trim().toLowerCase();
        const value = pair.slice(equalIndex + 1).trim();
        if (key !== "section") continue;
        const slug = normalizeForumSectionSlug(value);
        if (slug) {
          resolved = slug;
          break;
        }
      }

      return "";
    });
    return resolved;
  };

  const FORUM_IMAGE_DRAFT_TTL_MS = 3 * 60 * 60 * 1000;
  const FORUM_DRAFT_CLEANUP_INTERVAL_MS = 8 * 60 * 60 * 1000;
  const FORUM_IMAGE_MAX_WIDTH = 600;
  const FORUM_IMAGE_MAX_HEIGHT = 1600;
  const FORUM_IMAGE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
  const FORUM_IMAGE_MAX_DIMENSION = 12000;
  const FORUM_POST_MAX_IMAGE_COUNT = 24;
  const FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX = "forum-local-image://";
  const FORUM_LOCAL_IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

  const normalizeForumLocalImageId = (value) => {
    const normalized = toText(value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-");
    if (!FORUM_LOCAL_IMAGE_ID_PATTERN.test(normalized)) return "";
    return normalized;
  };

  const buildForumLocalImagePlaceholder = (value) => {
    const safeId = normalizeForumLocalImageId(value);
    if (!safeId) return "";
    return `${FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX}${safeId}`;
  };

  let forumDraftTableReadyPromise = null;
  let forumDraftCleanupScheduled = false;

  const ensureForumDraftTable = async () => {
    if (forumDraftTableReadyPromise) {
      return forumDraftTableReadyPromise;
    }

    forumDraftTableReadyPromise = dbRun(
      `
        CREATE TABLE IF NOT EXISTS forum_post_image_drafts (
          token VARCHAR(40) PRIMARY KEY,
          user_id TEXT NOT NULL,
          manga_slug TEXT NOT NULL DEFAULT '',
          images_json TEXT NOT NULL DEFAULT '[]',
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        )
      `
    ).catch((err) => {
      forumDraftTableReadyPromise = null;
      throw err;
    });

    return forumDraftTableReadyPromise;
  };

  const createDraftToken = () => {
    if (crypto && typeof crypto.randomBytes === "function") {
      return crypto.randomBytes(16).toString("hex");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  };

  const parseDraftImages = (value) => {
    const text = toText(value);
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: toText(item.id),
          key: toText(item.key),
          url: toText(item.url),
          legacyUrl: toText(item.legacyUrl),
        }))
        .filter((item) => item.id && item.key && item.url);
    } catch (_err) {
      return [];
    }
  };

  const isTmpForumDraftImageKey = (value) => {
    const key = toText(value);
    if (!key) return false;
    return key.includes("/tmp/forum-posts/") || key.includes("/tmp/posts/");
  };

  const escapeSqlLikePattern = (value) => String(value || "").replace(/[!%_]/g, "!$&");

  const listForumDraftImageKeys = (images, options = {}) => {
    const onlyTmp = Boolean(options && options.onlyTmp);
    return Array.from(
      new Set(
        (Array.isArray(images) ? images : [])
          .map((item) => ({
            key: toText(item && item.key),
          }))
          .filter((item) => item.key)
          .filter((item) => (onlyTmp ? isTmpForumDraftImageKey(item.key) : true))
          .map((item) => item.key)
      )
    );
  };

  const isForumImageKeyReferencedByComments = async (key) => {
    const safeKey = toText(key);
    if (!safeKey) return false;
    const escaped = escapeSqlLikePattern(safeKey);
    const row = await dbGet(
      "SELECT 1 as ok FROM comments WHERE content ILIKE ? ESCAPE '!' LIMIT 1",
      [`%${escaped}%`]
    );
    return Boolean(row && row.ok);
  };

  const deleteForumImageKeys = async (keys, options = {}) => {
    const config = typeof getB2Config === "function" ? getB2Config() : null;
    const normalizedKeys = Array.from(
      new Set(
        (Array.isArray(keys) ? keys : [])
          .flatMap((value) => expandForumImageKeyCandidates(value, config))
          .filter(Boolean)
      )
    );
    if (!normalizedKeys.length) return 0;

    const skipReferenceCheck = Boolean(options && options.skipReferenceCheck);
    const keysToDelete = [];
    for (const key of normalizedKeys) {
      if (skipReferenceCheck) {
        keysToDelete.push(key);
        continue;
      }
      const isReferenced = await isForumImageKeyReferencedByComments(key);
      if (!isReferenced) {
        keysToDelete.push(key);
      }
    }

    if (!keysToDelete.length) return 0;

    if (typeof b2DeleteFileVersions === "function") {
      return b2DeleteFileVersions(
        keysToDelete.map((key) => ({
          fileName: key,
          fileId: key,
          versionId: "",
        }))
      );
    }

    if (typeof b2DeleteAllByPrefix !== "function") {
      throw new Error("Storage delete function unavailable.");
    }

    const prefixes = Array.from(
      new Set(keysToDelete.map((key) => key.split("/").slice(0, -1).join("/")).filter(Boolean))
    );
    let deletedCount = 0;
    for (const prefix of prefixes) {
      deletedCount += Number(await b2DeleteAllByPrefix(prefix)) || 0;
    }
    return deletedCount;
  };

  const resolveDraftUpdatedAtMs = (draftRow) => {
    const value = Number(
      draftRow && draftRow.updated_at != null
        ? draftRow.updated_at
        : draftRow && draftRow.created_at != null
          ? draftRow.created_at
          : 0
    );
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };

  const isForumDraftExpired = (draftRow, nowMs = Date.now()) => {
    const updatedAtMs = resolveDraftUpdatedAtMs(draftRow);
    if (!updatedAtMs) return false;
    return nowMs - updatedAtMs > FORUM_IMAGE_DRAFT_TTL_MS;
  };

  const purgeForumDraft = async (draftRow) => {
    const token = toText(draftRow && draftRow.token).slice(0, 40);
    if (!token) return 0;

    const images = parseDraftImages(draftRow && draftRow.images_json);
    const tmpKeys = listForumDraftImageKeys(images, { onlyTmp: true });
    const persistedKeys = listForumDraftImageKeys(images).filter((key) => !isTmpForumDraftImageKey(key));

    if (tmpKeys.length > 0) {
      await deleteForumImageKeys(tmpKeys, { skipReferenceCheck: true });
    }
    if (persistedKeys.length > 0) {
      await deleteForumImageKeys(persistedKeys);
    }

    await dbRun("DELETE FROM forum_post_image_drafts WHERE token = ?", [token]);
    return images.length;
  };

  const buildForumPostFinalPrefix = ({ forumPrefix, token, nowMs = Date.now() }) => {
    const safeForumPrefix = toText(forumPrefix).replace(/^\/+/, "").replace(/\/+$/, "") || "forum";
    const safeToken = toText(token).slice(0, 8) || "draft";
    const safeTimestamp = Number.isFinite(Number(nowMs)) ? Math.max(0, Math.floor(Number(nowMs))) : Date.now();
    const date = new Date(safeTimestamp);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${safeForumPrefix}/posts/${year}/${month}/post-${safeTimestamp}-${safeToken}`;
  };

  const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const replaceAllLiteral = (sourceText, fromValue, toValue) => {
    const fromText = toText(fromValue);
    if (!fromText) return sourceText;
    return String(sourceText || "").replace(new RegExp(escapeRegex(fromText), "g"), String(toValue || ""));
  };

  const cleanupExpiredForumDrafts = async () => {
    await ensureForumDraftTable();
    const cutoff = Date.now() - FORUM_IMAGE_DRAFT_TTL_MS;
    const rows = await dbAll(
      `
        SELECT token, images_json
        FROM forum_post_image_drafts
        WHERE updated_at < ?
        ORDER BY updated_at ASC
        LIMIT 30
      `,
      [cutoff]
    );

    for (const row of rows) {
      const token = toText(row && row.token);
      if (!token) continue;
      const images = parseDraftImages(row && row.images_json);

      const keys = listForumDraftImageKeys(images);
      let hasReferencedKey = false;
      for (const key of keys) {
        if (await isForumImageKeyReferencedByComments(key)) {
          hasReferencedKey = true;
          break;
        }
      }
      if (hasReferencedKey) {
        continue;
      }

      let hasCleanupFailure = false;
      try {
        await deleteForumImageKeys(keys, { skipReferenceCheck: true });
      } catch (_err) {
        hasCleanupFailure = true;
      }

      if (hasCleanupFailure) continue;
      await dbRun("DELETE FROM forum_post_image_drafts WHERE token = ?", [token]);
    }
  };

  const scheduleForumDraftCleanup = () => {
    if (forumDraftCleanupScheduled) return;
    forumDraftCleanupScheduled = true;

    const run = async () => {
      try {
        await cleanupExpiredForumDrafts();
      } catch (err) {
        console.warn("Forum draft cleanup failed", err);
      }
    };

    run();
    const timer = setInterval(run, FORUM_DRAFT_CLEANUP_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  scheduleForumDraftCleanup();

  const buildViewerContext = async (req) => {
    const resolveViewerRole = (badgeContext) => {
      const badges = Array.isArray(badgeContext && badgeContext.badges) ? badgeContext.badges : [];
      const codes = badges
        .map((badge) => String(badge && badge.code ? badge.code : "").trim().toLowerCase())
        .filter(Boolean);
      if (codes.includes("admin")) return "admin";
      if (codes.includes("mod") || codes.includes("moderator")) return "moderator";
      return "member";
    };

    const sessionUserId =
      req && req.session && req.session.authUserId ? String(req.session.authUserId).trim() : "";
    if (!sessionUserId) {
      return {
        authenticated: false,
        userId: "",
        canComment: false,
        canDeleteAnyComment: false,
        canAccessAdmin: false,
        canModerateForum: false,
        canCreateAnnouncement: false,
        role: "guest",
      };
    }

    const sessionUser = typeof loadSessionUserById === "function" ? await loadSessionUserById(sessionUserId) : null;
    if (!sessionUser || !sessionUser.id) {
      return {
        authenticated: false,
        userId: "",
        canComment: false,
        canDeleteAnyComment: false,
        canAccessAdmin: false,
        canModerateForum: false,
        canCreateAnnouncement: false,
        role: "guest",
      };
    }

    const userId = String(sessionUser.id).trim();
    if (!userId) {
      return {
        authenticated: false,
        userId: "",
        canComment: false,
        canDeleteAnyComment: false,
        canAccessAdmin: false,
        canModerateForum: false,
        canCreateAnnouncement: false,
        role: "guest",
      };
    }

    let badgeContext = null;
    try {
      badgeContext = typeof getUserBadgeContext === "function" ? await getUserBadgeContext(userId) : null;
    } catch (_err) {
      badgeContext = null;
    }

    const permissions = badgeContext && badgeContext.permissions ? badgeContext.permissions : {};
    const canComment = permissions.canComment !== false;
    const role = resolveViewerRole(badgeContext);
    const canCreateAnnouncement = role === "admin" || role === "moderator";

    return {
      authenticated: true,
      userId,
      canComment: Boolean(canComment),
      canDeleteAnyComment: Boolean(permissions.canDeleteAnyComment),
      canAccessAdmin: Boolean(permissions.canAccessAdmin),
      canModerateForum: Boolean(permissions.canDeleteAnyComment),
      canCreateAnnouncement,
      role,
    };
  };

  const buildCommentPermissions = ({ viewer, authorUserId }) => {
    const ownerId = toText(authorUserId);
    const isOwner = Boolean(viewer && viewer.authenticated && viewer.userId && ownerId && viewer.userId === ownerId);
    const canDeleteAny = Boolean(viewer && viewer.canDeleteAnyComment);
    const canComment = Boolean(viewer && viewer.canComment);

    return {
      canEdit: isOwner,
      canDelete: isOwner || canDeleteAny,
      canReport: Boolean(viewer && viewer.authenticated && canComment && !isOwner),
      canReply: canComment,
      isOwner,
    };
  };

  const decodeHtmlEntities = (value) =>
    String(value || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");

  const stripSpoilerHtml = (value) =>
    String(value || "").replace(
      /<span\b[^>]*class\s*=\s*(["'])[^"']*\bspoiler\b[^"']*\1[^>]*>[\s\S]*?<\/span>/gi,
      " [spoiler] "
    );

  const stripHtml = (value) => stripSpoilerHtml(value).replace(/<[^>]+>/g, " ");

  const toPlainText = (value) => {
    const decoded = decodeHtmlEntities(value);
    const withoutHtml = stripHtml(decoded);
    return decodeHtmlEntities(withoutHtml).replace(/\s+/g, " ").trim();
  };

  const buildExcerpt = (content, limit = 180) => {
    const compact = toPlainText(content);
    if (compact.length <= limit) return compact;
    return `${compact.slice(0, Math.max(0, limit - 1)).trim()}…`;
  };

  const extractTopicHeadline = (content, limit = 96) => {
    const raw = content == null ? "" : String(content);
    const htmlHeadlineMatch = raw.match(/^\s*<p>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i);
    const source = htmlHeadlineMatch ? htmlHeadlineMatch[1] : raw;

    const lines = source
      .split(/\r?\n/)
      .map((line) => toPlainText(line))
      .filter(Boolean);
    if (!lines.length) return "";

    const normalized = lines[0]
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .trim();
    if (!normalized) return "";
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
  };

  const formatChapterNumberText = (value) => {
    const chapterValue = value == null ? NaN : Number(value);
    if (!Number.isFinite(chapterValue)) return "";
    if (typeof formatChapterNumberValue === "function") {
      const formatted = toText(formatChapterNumberValue(chapterValue));
      if (formatted) return formatted;
    }
    return String(chapterValue);
  };

  const normalizeAuthorAvatar = (row) => {
    const userAvatar = toText(row && row.user_avatar_url);
    const commentAvatar = toText(row && row.author_avatar_url);
    const avatarCandidate = userAvatar || commentAvatar;
    if (typeof normalizeAvatarUrl === "function") {
      return normalizeAvatarUrl(avatarCandidate);
    }
    return avatarCandidate;
  };

  const normalizeAuthorBadges = (badgesInput) => {
    const badges = Array.isArray(badgesInput) ? badgesInput : [];
    const normalized = [];
    const seen = new Set();

    badges.forEach((badge) => {
      const code = toText(badge && badge.code).toLowerCase();
      const label = toText(badge && badge.label);
      const color = toText(badge && badge.color);
      const priority = Number(badge && badge.priority) || 0;
      const key = `${code}|${label.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);

      normalized.push({
        code: code || "badge",
        label: label || code || "Badge",
        color,
        priority,
      });
    });

    return normalized;
  };

  const mapAuthor = (row, options = {}) => {
    const decorationMap = options.authorDecorationMap instanceof Map ? options.authorDecorationMap : new Map();
    const includeAllBadges = Boolean(options.includeAllBadges);
    const authorUserId = toText(row && row.author_user_id);
    const decoration = authorUserId && decorationMap.has(authorUserId)
      ? decorationMap.get(authorUserId)
      : null;
    const badges = normalizeAuthorBadges(decoration && decoration.badges);
    const highestBadge = badges[0] || null;
    const username = toText(row && row.user_username);
    const displayName = toText(row && row.user_display_name);
    const fallbackName = toText(row && row.author);
    const profileUrl = username
      ? `/user/${encodeURIComponent(username)}`
      : authorUserId
        ? `/comments/users/${encodeURIComponent(authorUserId)}`
        : "";

    return {
      id: authorUserId,
      username,
      displayName: displayName || fallbackName || username || "Thành viên",
      avatarUrl: normalizeAuthorAvatar(row),
      badges: includeAllBadges ? badges : highestBadge ? [highestBadge] : [],
      userColor: toText(decoration && decoration.userColor),
      profileUrl,
    };
  };

  const mapManga = (row) => {
    const slug = toText(row && row.manga_slug);
    return {
      id: Number(row && row.manga_id) || 0,
      slug,
      title: toText(row && row.manga_title),
      cover: toText(row && row.manga_cover),
      url: slug ? `/manga/${encodeURIComponent(slug)}` : "/manga",
    };
  };

  const mapChapter = (row) => {
    const chapterNumberText = formatChapterNumberText(row && row.chapter_number);
    const chapterTitle = toText(row && row.chapter_title);
    if (!chapterNumberText) {
      return {
        number: "",
        title: "",
        label: "",
      };
    }

    const baseLabel = `Chương ${chapterNumberText}`;
    return {
      number: chapterNumberText,
      title: chapterTitle,
      label: chapterTitle ? `${baseLabel} - ${chapterTitle}` : baseLabel,
    };
  };

  const buildPostTitle = (row, manga, chapter) => {
    const headline = extractTopicHeadline(row && row.content);
    if (headline) {
      return headline;
    }

    const mangaTitle = toText(manga && manga.title) || "Manga";
    if (chapter && chapter.label) {
      return `${mangaTitle} · ${chapter.label}`;
    }
    return `Thảo luận: ${mangaTitle}`;
  };

  const mapPostSummary = (row, options = {}) => {
    const includeContent = Boolean(options.includeContent);
    const includeAllBadges = Boolean(options.includeAllBadges);
    const viewer = options.viewer || null;
    const mentionByCommentId = options.mentionByCommentId instanceof Map ? options.mentionByCommentId : new Map();
    const manga = mapManga(row);
    const chapter = mapChapter(row);
    const content = toText(row && row.content);
    const normalizedSectionSlug = normalizeForumSectionSlug(extractForumSectionSlug(content));
    const sectionSlug = normalizedSectionSlug || "thao-luan-chung";
    const sectionMetaBySlug =
      options && options.sectionMetaBySlug instanceof Map ? options.sectionMetaBySlug : new Map();
    const sectionMeta = sectionMetaBySlug.get(sectionSlug) || null;
    const sectionLabel = sectionMeta && sectionMeta.label
      ? toText(sectionMeta.label)
      : buildForumSectionLabelFromSlug(sectionSlug);
    const sectionIcon = sectionMeta && sectionMeta.icon ? toText(sectionMeta.icon) : "💬";
    const createdAtRaw = toText(row && row.created_at);
    const mappedId = Number(row && row.id) || 0;
    const mentions = mappedId > 0 && mentionByCommentId.has(mappedId)
      ? mentionByCommentId.get(mappedId)
      : [];
    const permissions = buildCommentPermissions({
      viewer,
      authorUserId: row && row.author_user_id,
    });

    const mapped = {
      id: mappedId,
      title: buildPostTitle(row, manga, chapter),
      excerpt: buildExcerpt(content),
      content: includeContent ? content : "",
      createdAt: toIso(createdAtRaw),
      timeAgo: typeof formatTimeAgo === "function" ? formatTimeAgo(createdAtRaw) : createdAtRaw,
      likeCount: Number(row && row.like_count) || 0,
      reportCount: Number(row && row.report_count) || 0,
      commentCount: Number(row && row.reply_count) || 0,
      isLocked: Boolean(row && row.forum_post_locked),
      isSticky: Boolean(row && row.forum_post_pinned),
      author: mapAuthor(row, {
        authorDecorationMap: options.authorDecorationMap,
        includeAllBadges,
      }),
      manga,
      chapter,
      category: {
        id: Number(row && row.genre_id) || 0,
        name: toText(row && row.genre_name) || "Thảo luận",
        slug: normalizeGenreSlug(row && row.genre_name),
      },
      sectionSlug,
      sectionLabel,
      sectionIcon,
      mentions: Array.isArray(mentions) ? mentions : [],
      permissions,
      liked: Boolean(options.likedIdSet instanceof Set && options.likedIdSet.has(Number(row && row.id) || 0)),
      saved: Boolean(options.savedIdSet instanceof Set && options.savedIdSet.has(Number(row && row.id) || 0)),
    };

    if (mapped.chapter && mapped.chapter.number && mapped.manga && mapped.manga.slug) {
      mapped.chapter.url = `/manga/${encodeURIComponent(mapped.manga.slug)}/chapters/${encodeURIComponent(
        mapped.chapter.number
      )}`;
    } else {
      mapped.chapter.url = mapped.manga.url;
    }

    return mapped;
  };

  const mapForumAdminPostSummary = (row, options = {}) => {
    const sectionLabelBySlug =
      options && options.sectionLabelBySlug instanceof Map
        ? options.sectionLabelBySlug
        : FORUM_ADMIN_SECTION_LABEL_BY_SLUG;
    const postId = Number(row && row.id);
    const safePostId = Number.isFinite(postId) && postId > 0 ? Math.floor(postId) : 0;
    const content = toText(row && row.content);
    const sectionSlug = extractForumSectionSlug(content) || "thao-luan-chung";
    const sectionLabel =
      sectionLabelBySlug.get(sectionSlug) ||
      sectionLabelBySlug.get("thao-luan-chung") ||
      "Thảo luận chung";
    const title = extractTopicHeadline(content, 120) || "Bài viết diễn đàn";
    const excerpt = buildExcerpt(content, 180);
    const createdAtRaw = toText(row && row.created_at);
    const authorDisplayName = toText(row && row.author_display_name);
    const authorUsername = toText(row && row.author_username).toLowerCase();
    const fallbackAuthor = toText(row && row.author);
    const authorName = authorDisplayName || (authorUsername ? `@${authorUsername}` : fallbackAuthor || "Thành viên");

    return {
      id: safePostId,
      title,
      content,
      excerpt,
      status: toText(row && row.status).toLowerCase() === "reported" ? "hidden" : "visible",
      sectionSlug,
      sectionLabel,
      commentCount: Number(row && row.reply_count) || 0,
      reportCount: Number(row && row.report_count) || 0,
      likeCount: Number(row && row.like_count) || 0,
      isLocked: Boolean(row && row.forum_post_locked),
      isPinned: Boolean(row && row.forum_post_pinned),
      author: {
        id: toText(row && row.author_user_id),
        username: authorUsername,
        displayName: authorDisplayName || fallbackAuthor || authorUsername || "Thành viên",
        name: authorName,
        avatarUrl: normalizeAuthorAvatar(row),
      },
      createdAt: toIso(createdAtRaw),
      timeAgo: typeof formatTimeAgo === "function" ? formatTimeAgo(createdAtRaw) : createdAtRaw,
    };
  };

  const mapForumAdminCommentSummary = (row) => {
    const commentId = Number(row && row.id);
    const safeCommentId = Number.isFinite(commentId) && commentId > 0 ? Math.floor(commentId) : 0;
    const content = toText(row && row.content);
    const createdAtRaw = toText(row && row.created_at);
    const authorDisplayName = toText(row && row.author_display_name);
    const authorUsername = toText(row && row.author_username).toLowerCase();
    const fallbackAuthor = toText(row && row.author);
    const authorName = authorDisplayName || (authorUsername ? `@${authorUsername}` : fallbackAuthor || "Thành viên");

    const topicIdRaw = Number(row && row.topic_id);
    const topicId = Number.isFinite(topicIdRaw) && topicIdRaw > 0 ? Math.floor(topicIdRaw) : 0;
    const topicTitle = extractTopicHeadline(toText(row && row.topic_content), 120) || "Bài viết diễn đàn";

    const parentParentId = Number(row && row.parent_parent_id);

    return {
      id: safeCommentId,
      content: buildExcerpt(content, 180),
      status: toText(row && row.status).toLowerCase() === "reported" ? "hidden" : "visible",
      kind: Number.isFinite(parentParentId) && parentParentId > 0 ? "reply" : "comment",
      likeCount: Number(row && row.like_count) || 0,
      reportCount: Number(row && row.report_count) || 0,
      parentAuthorName: toText(row && row.parent_author),
      post: {
        id: topicId,
        title: topicTitle,
      },
      author: {
        id: toText(row && row.author_user_id),
        username: authorUsername,
        displayName: authorDisplayName || fallbackAuthor || authorUsername || "Thành viên",
        name: authorName,
        avatarUrl: normalizeAuthorAvatar(row),
      },
      createdAt: toIso(createdAtRaw),
      timeAgo: typeof formatTimeAgo === "function" ? formatTimeAgo(createdAtRaw) : createdAtRaw,
    };
  };

  const getForumAdminRootPostById = async (postId) => {
    const safeId = normalizePositiveInt(postId, 0);
    if (!safeId) return null;

    const row = await dbGet(
      `
        SELECT
          c.id,
          c.content,
          c.status,
          c.forum_post_locked,
          c.forum_post_pinned
        FROM comments c
        WHERE c.id = ?
          AND c.parent_id IS NULL
          AND COALESCE(c.client_request_id, '') ILIKE ?
        LIMIT 1
      `,
      [safeId, FORUM_REQUEST_ID_LIKE]
    );

    return row || null;
  };

  const getForumAdminCommentById = async (commentId) => {
    const safeId = normalizePositiveInt(commentId, 0);
    if (!safeId) return null;

    const row = await dbGet(
      `
        SELECT
          c.id,
          c.parent_id,
          c.status
        FROM comments c
        JOIN comments parent ON parent.id = c.parent_id
        WHERE c.id = ?
          AND COALESCE(c.parent_id, 0) > 0
          AND COALESCE(c.client_request_id, '') ILIKE ?
          AND COALESCE(parent.client_request_id, '') ILIKE ?
        LIMIT 1
      `,
      [safeId, FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE]
    );

    return row || null;
  };

  const runForumAdminTransaction = async (handler) => {
    if (typeof withTransaction === "function") {
      return withTransaction(handler);
    }
    return handler({ dbRun, dbGet, dbAll });
  };

  const mapReply = (row, options = {}) => {
    const viewer = options.viewer || null;
    const mentionByCommentId = options.mentionByCommentId instanceof Map ? options.mentionByCommentId : new Map();
    const createdAtRaw = toText(row && row.created_at);
    const mappedId = Number(row && row.id) || 0;
    const mentions = mappedId > 0 && mentionByCommentId.has(mappedId)
      ? mentionByCommentId.get(mappedId)
      : [];
    const permissions = buildCommentPermissions({
      viewer,
      authorUserId: row && row.author_user_id,
    });
    return {
      id: mappedId,
      content: toText(row && row.content),
      createdAt: toIso(createdAtRaw),
      timeAgo: typeof formatTimeAgo === "function" ? formatTimeAgo(createdAtRaw) : createdAtRaw,
      likeCount: Number(row && row.like_count) || 0,
      reportCount: Number(row && row.report_count) || 0,
      parentId: Number(row && row.parent_id) || 0,
      parentAuthorUserId: toText(row && row.parent_author_user_id),
      author: mapAuthor(row, {
        authorDecorationMap: options.authorDecorationMap,
        includeAllBadges: false,
      }),
      mentions: Array.isArray(mentions) ? mentions : [],
      permissions,
      liked: Boolean(options.likedIdSet instanceof Set && options.likedIdSet.has(Number(row && row.id) || 0)),
    };
  };

  const buildSqlPlaceholders = (count) =>
    Array.from({ length: Math.max(0, Number(count) || 0) })
      .map(() => "?")
      .join(",");

  const decodePathSegment = (value) => {
    const text = toText(value);
    if (!text) return "";
    try {
      return decodeURIComponent(text);
    } catch (_err) {
      return text;
    }
  };

  const normalizePathname = (value) => {
    const source = toText(value).split(/[?#]/)[0];
    if (!source) return "";
    const withLeadingSlash = source.startsWith("/") ? source : `/${source}`;
    const compact = withLeadingSlash.replace(/\/{2,}/g, "/");
    const trimmed = compact.replace(/\/+$/, "");
    return trimmed || "/";
  };

  const normalizeHostName = (value) =>
    toText(value)
      .toLowerCase()
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/^www\./, "");

  const isLoopbackHostName = (value) => {
    const host = normalizeHostName(value);
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  };

  const resolvePortForUrl = (urlObject) => {
    const explicitPort = toText(urlObject && urlObject.port);
    if (explicitPort) return explicitPort;
    const protocol = toText(urlObject && urlObject.protocol).toLowerCase();
    if (protocol === "https:") return "443";
    if (protocol === "http:") return "80";
    return "";
  };

  const hasSameHostContext = (targetUrl, baseUrl) => {
    const targetHost = normalizeHostName(targetUrl && targetUrl.hostname);
    const baseHost = normalizeHostName(baseUrl && baseUrl.hostname);
    if (!targetHost || !baseHost) return false;

    const targetPort = resolvePortForUrl(targetUrl);
    const basePort = resolvePortForUrl(baseUrl);

    if (targetHost === baseHost) {
      return targetPort === basePort;
    }

    if (isLoopbackHostName(targetHost) && isLoopbackHostName(baseHost)) {
      return targetPort === basePort;
    }

    return false;
  };

  const parseInternalPathFromUrl = (rawUrl, req) => {
    const text = toText(rawUrl);
    if (!text) return "";

    const host = toText(req && typeof req.get === "function" ? req.get("host") : "");
    const protocol = toText(req && req.protocol ? req.protocol : "http") || "http";
    const baseOrigin = `${protocol}://${host || "localhost"}`;

    try {
      const parsed = new URL(text, baseOrigin);
      if (!/^https?:$/i.test(parsed.protocol)) return "";
      const base = new URL(baseOrigin);
      if (parsed.host && !hasSameHostContext(parsed, base)) {
        return "";
      }
      return normalizePathname(parsed.pathname);
    } catch (_err) {
      if (!text.startsWith("/")) return "";
      return normalizePathname(text);
    }
  };

  const formatChapterLabelFromPath = (value) => {
    const decoded = decodePathSegment(value).trim();
    if (!decoded) return "";
    const numeric = Number(decoded);
    if (Number.isFinite(numeric) && typeof formatChapterNumberValue === "function") {
      const formatted = toText(formatChapterNumberValue(numeric));
      if (formatted) return formatted;
    }
    return decoded;
  };

  const buildAuthorDecorationMap = async (rows) => {
    const result = new Map();
    const userIds = Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => toText(row && row.author_user_id))
          .filter(Boolean)
      )
    );
    if (!userIds.length || typeof getUserBadgeContext !== "function") return result;

    await Promise.all(
      userIds.map(async (userId) => {
        try {
          const context = await getUserBadgeContext(userId);
          const badges = normalizeAuthorBadges(
            Array.isArray(context && context.badges)
            ? context.badges.map((badge) => ({
                code: toText(badge && badge.code),
                label: toText(badge && badge.label),
                color: toText(badge && badge.color),
                priority: Number(badge && badge.priority) || 0,
              }))
            : []
          );
          result.set(userId, {
            badges,
            userColor: toText(context && context.userColor),
          });
        } catch (_err) {
          result.set(userId, { badges: [], userColor: "" });
        }
      })
    );

    return result;
  };

  const buildMentionMapForRows = async ({ rows, rootCommentId }) => {
    const result = new Map();
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return result;
    if (
      typeof extractMentionUsernamesFromContent !== "function" ||
      typeof getMentionProfileMapForManga !== "function" ||
      typeof buildCommentMentionsForContent !== "function"
    ) {
      return result;
    }

    const rowsByManga = new Map();
    list.forEach((row) => {
      const rowId = Number(row && row.id);
      const mangaId = Number(row && row.manga_id);
      if (!Number.isFinite(rowId) || rowId <= 0) return;
      if (!Number.isFinite(mangaId) || mangaId <= 0) return;
      const key = Math.floor(mangaId);
      const bucket = rowsByManga.get(key) || [];
      bucket.push(row);
      rowsByManga.set(key, bucket);
    });

    for (const [mangaId, mangaRows] of rowsByManga.entries()) {
      const usernames = Array.from(
        new Set(
          mangaRows
            .flatMap((row) => extractMentionUsernamesFromContent(toText(row && row.content)))
            .map((value) => toText(value).toLowerCase())
            .filter(Boolean)
        )
      );

      if (!usernames.length) {
        mangaRows.forEach((row) => {
          const rowId = Number(row && row.id);
          if (Number.isFinite(rowId) && rowId > 0) {
            result.set(Math.floor(rowId), []);
          }
        });
        continue;
      }

      let mentionProfileMap = new Map();
      try {
        mentionProfileMap = await getMentionProfileMapForManga({
          mangaId,
          usernames,
          rootCommentId,
        });
      } catch (_err) {
        mentionProfileMap = new Map();
      }

      mangaRows.forEach((row) => {
        const rowId = Number(row && row.id);
        if (!Number.isFinite(rowId) || rowId <= 0) return;
        const mentions = buildCommentMentionsForContent({
          content: toText(row && row.content),
          mentionProfileMap,
        });
        result.set(Math.floor(rowId), Array.isArray(mentions) ? mentions : []);
      });
    }

    return result;
  };

  const buildLikedIdSetForViewer = async ({ viewer, ids }) => {
    const set = new Set();
    if (!viewer || !viewer.authenticated || !viewer.userId) return set;
    const safeIds = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    );
    if (!safeIds.length) return set;
    const placeholders = safeIds.map(() => "?").join(",");
    const rows = await dbAll(
      `SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${placeholders})`,
      [viewer.userId, ...safeIds]
    );
    rows.forEach((row) => {
      const id = row && row.comment_id != null ? Number(row.comment_id) : 0;
      if (Number.isFinite(id) && id > 0) set.add(Math.floor(id));
    });
    return set;
  };

  const buildSavedPostIdSetForViewer = async ({ viewer, ids }) => {
    const set = new Set();
    if (!viewer || !viewer.authenticated || !viewer.userId) return set;
    const safeIds = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => Math.floor(value))
      )
    );
    if (!safeIds.length) return set;
    const placeholders = safeIds.map(() => "?").join(",");
    const rows = await dbAll(
      `SELECT comment_id FROM forum_post_bookmarks WHERE user_id = ? AND comment_id IN (${placeholders})`,
      [viewer.userId, ...safeIds]
    );
    rows.forEach((row) => {
      const id = row && row.comment_id != null ? Number(row.comment_id) : 0;
      if (Number.isFinite(id) && id > 0) set.add(Math.floor(id));
    });
    return set;
  };

  app.post(
    "/forum/api/posts/:id/images/finalize",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để đăng bài." });
      }
      const canModerateImages = Boolean(viewer.canModerateForum || viewer.canDeleteAnyComment || viewer.canAccessAdmin);
      if (!viewer.canComment && !canModerateImages) {
        return res.status(403).json({ ok: false, error: "Tài khoản của bạn không có quyền đăng bài." });
      }

      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      if (typeof sharp !== "function" || typeof b2UploadBuffer !== "function") {
        return res.status(500).json({ ok: false, error: "Máy chủ chưa cấu hình xử lý ảnh." });
      }

      const config = typeof getB2Config === "function" ? getB2Config() : null;
      if (!isB2Ready || typeof isB2Ready !== "function" || !isB2Ready(config)) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình lưu trữ ảnh trong .env" });
      }
      const imageBaseUrl = resolveForumImageBaseUrl(config);
      if (!imageBaseUrl) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình URL public cho ảnh forum." });
      }

      const postRow = await dbGet(
        `
          SELECT id, author_user_id, content, status
          FROM comments
          WHERE id = ?
            AND parent_id IS NULL
            AND COALESCE(client_request_id, '') ILIKE ?
          LIMIT 1
        `,
        [postId, FORUM_REQUEST_ID_LIKE]
      );

      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết để đồng bộ ảnh." });
      }
      const authorUserId = toText(postRow.author_user_id);
      const isOwner = Boolean(authorUserId && authorUserId === viewer.userId);
      if (!isOwner && !canModerateImages) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền cập nhật ảnh cho bài viết này." });
      }
      if (!canModerateImages && toText(postRow.status) !== "visible") {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết để đồng bộ ảnh." });
      }

      const rawContent =
        req && req.body && typeof req.body.content === "string"
          ? req.body.content
          : postRow && typeof postRow.content === "string"
            ? postRow.content
            : "";
      const allowPartialFinalize = Boolean(req && req.body && req.body.allowPartialFinalize === true);
      let outputContent = String(rawContent || "");

      const rawImages = Array.isArray(req && req.body ? req.body.images : null) ? req.body.images : [];
      const images = [];
      const seenImageIds = new Set();
      rawImages.forEach((item) => {
        const imageId = normalizeForumLocalImageId(item && item.id);
        const dataUrl = toText(item && item.dataUrl);
        if (!imageId || !dataUrl || seenImageIds.has(imageId)) return;
        seenImageIds.add(imageId);
        images.push({ id: imageId, dataUrl });
      });

      if (!images.length) {
        return res.json({ ok: true, content: outputContent, uploadedCount: 0 });
      }
      if (images.length > FORUM_POST_MAX_IMAGE_COUNT) {
        return res.status(400).json({ ok: false, error: `Tối đa ${FORUM_POST_MAX_IMAGE_COUNT} ảnh mỗi bài viết.` });
      }

      const processedImages = [];
      for (const image of images) {
        const imageId = toText(image && image.id);
        const dataUrl = toText(image && image.dataUrl);
        const placeholder = buildForumLocalImagePlaceholder(imageId);
        if (!placeholder) {
          return res.status(400).json({ ok: false, error: "ID ảnh cục bộ không hợp lệ." });
        }
        if (!outputContent.includes(placeholder)) {
          continue;
        }

        const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
        if (!match) {
          return res.status(400).json({ ok: false, error: "Dữ liệu ảnh không hợp lệ." });
        }

        const base64Payload = match[1].replace(/\s+/g, "");
        if (!base64Payload) {
          return res.status(400).json({ ok: false, error: "Không đọc được dữ liệu ảnh." });
        }

        let sourceBuffer = null;
        try {
          sourceBuffer = Buffer.from(base64Payload, "base64");
        } catch (_err) {
          sourceBuffer = null;
        }
        if (!sourceBuffer || !sourceBuffer.length) {
          return res.status(400).json({ ok: false, error: "Không đọc được dữ liệu ảnh." });
        }
        if (sourceBuffer.length > FORUM_IMAGE_MAX_SOURCE_BYTES) {
          return res.status(400).json({ ok: false, error: "Ảnh quá lớn. Vui lòng chọn ảnh nhỏ hơn 8MB." });
        }

        let metadata = null;
        try {
          metadata = await sharp(sourceBuffer, { limitInputPixels: 70000000 }).metadata();
        } catch (_err) {
          metadata = null;
        }

        const sourceWidth = Number(metadata && metadata.width) || 0;
        const sourceHeight = Number(metadata && metadata.height) || 0;
        if (!sourceWidth || !sourceHeight) {
          return res.status(400).json({ ok: false, error: "Không đọc được kích thước ảnh." });
        }
        if (sourceWidth > FORUM_IMAGE_MAX_DIMENSION || sourceHeight > FORUM_IMAGE_MAX_DIMENSION) {
          return res
            .status(400)
            .json({ ok: false, error: "Kích thước ảnh quá lớn. Vui lòng chọn ảnh tối đa 12000px." });
        }

        let webpBuffer = null;
        try {
          webpBuffer = await sharp(sourceBuffer)
            .rotate()
            .resize({
              width: FORUM_IMAGE_MAX_WIDTH,
              height: FORUM_IMAGE_MAX_HEIGHT,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 82, effort: 6 })
            .toBuffer();
        } catch (_err) {
          webpBuffer = null;
        }

        if (!webpBuffer || !webpBuffer.length) {
          return res.status(400).json({ ok: false, error: "Không thể xử lý ảnh." });
        }

        processedImages.push({
          id: imageId,
          placeholder,
          buffer: webpBuffer,
        });
      }

      if (!processedImages.length) {
        return res.json({ ok: true, content: outputContent, uploadedCount: 0 });
      }

      const nowMs = Date.now();
      const finalPrefix = buildForumPostFinalPrefix({
        forumPrefix: config.forumPrefix,
        token: `post-${postId}`,
        nowMs,
      });

      const uploadedKeys = [];
      const finalUrlById = new Map();

      try {
        for (let index = 0; index < processedImages.length; index += 1) {
          const item = processedImages[index];
          const destinationName = `${finalPrefix}/${String(index + 1).padStart(3, "0")}.webp`;
          await b2UploadBuffer({
            fileName: destinationName,
            buffer: item.buffer,
            contentType: "image/webp",
          });
          uploadedKeys.push(destinationName);
          finalUrlById.set(item.id, `${imageBaseUrl}/${destinationName}`);
        }
      } catch (_err) {
        if (uploadedKeys.length > 0) {
          await deleteForumImageKeys(uploadedKeys, { skipReferenceCheck: true }).catch(() => null);
        }
        return res.status(500).json({ ok: false, error: "Upload ảnh thất bại." });
      }

      for (const item of processedImages) {
        const finalUrl = toText(finalUrlById.get(item.id));
        if (!finalUrl) continue;
        outputContent = replaceAllLiteral(outputContent, item.placeholder, finalUrl);
      }

      const hasPendingLocalPlaceholders = new RegExp(
        `${escapeRegex(FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX)}[a-z0-9][a-z0-9_-]{0,63}`,
        "i"
      ).test(outputContent);

      if (hasPendingLocalPlaceholders && !allowPartialFinalize) {
        await deleteForumImageKeys(uploadedKeys, { skipReferenceCheck: true }).catch(() => null);
        return res.status(400).json({ ok: false, error: "Thiếu dữ liệu ảnh để hoàn tất bài viết." });
      }

      const removedImageKeys = Array.from(
        new Set([
          ...getRemovedForumImageKeys({
            beforeContent: postRow && postRow.content,
            nextContent: outputContent,
            config,
          }),
          ...normalizeRequestedRemovedImageKeys(req && req.body ? req.body.removedImageKeys : [], config),
        ])
      );

      let deletedImageCount = 0;
      await dbRun("UPDATE comments SET content = ? WHERE id = ?", [outputContent, postId]);
      if (removedImageKeys.length > 0) {
        try {
          deletedImageCount = Number(await deleteForumImageKeys(removedImageKeys, { skipReferenceCheck: true })) || 0;
        } catch (err) {
          console.warn("forum finalize image cleanup failed", err);
        }
      }
      return res.json({
        ok: true,
        content: outputContent,
        uploadedCount: processedImages.length,
        removedImageCount: removedImageKeys.length,
        deletedImageCount,
        pendingPlaceholders: hasPendingLocalPlaceholders,
      });
    })
  );

  app.post(
    "/forum/api/post-drafts",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để tải ảnh." });
      }
      if (!viewer.canComment) {
        return res.status(403).json({ ok: false, error: "Tài khoản của bạn không có quyền đăng bài." });
      }

      await ensureForumDraftTable();
      cleanupExpiredForumDrafts().catch(() => null);

      const token = createDraftToken();
      const now = Date.now();
      await dbRun(
        `
          INSERT INTO forum_post_image_drafts (token, user_id, manga_slug, images_json, created_at, updated_at)
          VALUES (?, ?, '', '[]', ?, ?)
        `,
        [token, viewer.userId, now, now]
      );

      return res.json({ ok: true, token, createdAt: now });
    })
  );

  app.post(
    "/forum/api/post-drafts/:token/images",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để tải ảnh." });
      }
      if (!viewer.canComment) {
        return res.status(403).json({ ok: false, error: "Tài khoản của bạn không có quyền đăng bài." });
      }

      if (typeof sharp !== "function" || typeof b2UploadBuffer !== "function") {
        return res.status(500).json({ ok: false, error: "Máy chủ chưa cấu hình xử lý ảnh." });
      }

      const config = typeof getB2Config === "function" ? getB2Config() : null;
      if (!isB2Ready || typeof isB2Ready !== "function" || !isB2Ready(config)) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình lưu trữ ảnh trong .env" });
      }
      const imageBaseUrl = resolveForumImageBaseUrl(config);
      if (!imageBaseUrl) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình URL public cho ảnh forum." });
      }

      const token = toText(req.params.token).slice(0, 40);
      if (!token) {
        return res.status(400).json({ ok: false, error: "Draft không hợp lệ." });
      }

      await ensureForumDraftTable();
      const draftRow = await dbGet("SELECT * FROM forum_post_image_drafts WHERE token = ? LIMIT 1", [token]);
      if (!draftRow) {
        return res.status(404).json({ ok: false, error: "Draft không tồn tại hoặc đã hết hạn." });
      }
      if (toText(draftRow.user_id) !== viewer.userId) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền chỉnh draft này." });
      }
      if (isForumDraftExpired(draftRow)) {
        await purgeForumDraft(draftRow).catch(() => null);
        return res.status(410).json({ ok: false, error: "Draft đã hết hạn. Vui lòng tạo bài viết mới." });
      }

      const imageDataUrl = toText(req && req.body ? req.body.imageDataUrl : "");
      const match = imageDataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) {
        return res.status(400).json({ ok: false, error: "Dữ liệu ảnh không hợp lệ." });
      }

      const base64Payload = match[1].replace(/\s+/g, "");
      if (!base64Payload) {
        return res.status(400).json({ ok: false, error: "Không đọc được dữ liệu ảnh." });
      }

      let sourceBuffer = null;
      try {
        sourceBuffer = Buffer.from(base64Payload, "base64");
      } catch (_err) {
        sourceBuffer = null;
      }
      if (!sourceBuffer || !sourceBuffer.length) {
        return res.status(400).json({ ok: false, error: "Không đọc được dữ liệu ảnh." });
      }
      if (sourceBuffer.length > FORUM_IMAGE_MAX_SOURCE_BYTES) {
        return res.status(400).json({ ok: false, error: "Ảnh quá lớn. Vui lòng chọn ảnh nhỏ hơn 8MB." });
      }

      let metadata = null;
      try {
        metadata = await sharp(sourceBuffer, { limitInputPixels: 70000000 }).metadata();
      } catch (_err) {
        metadata = null;
      }

      const sourceWidth = Number(metadata && metadata.width) || 0;
      const sourceHeight = Number(metadata && metadata.height) || 0;
      if (!sourceWidth || !sourceHeight) {
        return res.status(400).json({ ok: false, error: "Không đọc được kích thước ảnh." });
      }
      if (sourceWidth > FORUM_IMAGE_MAX_DIMENSION || sourceHeight > FORUM_IMAGE_MAX_DIMENSION) {
        return res
          .status(400)
          .json({ ok: false, error: "Kích thước ảnh quá lớn. Vui lòng chọn ảnh tối đa 12000px." });
      }

      let webpBuffer = null;
      try {
        webpBuffer = await sharp(sourceBuffer)
          .rotate()
          .resize({
            width: FORUM_IMAGE_MAX_WIDTH,
            height: FORUM_IMAGE_MAX_HEIGHT,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82, effort: 6 })
          .toBuffer();
      } catch (_err) {
        return res.status(400).json({ ok: false, error: "Ảnh không hợp lệ hoặc không hỗ trợ." });
      }

      if (!webpBuffer || !webpBuffer.length) {
        return res.status(400).json({ ok: false, error: "Không thể xử lý ảnh." });
      }

      const imageId = crypto && typeof crypto.randomBytes === "function"
        ? crypto.randomBytes(12).toString("hex")
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const keyPrefix = `${config.forumPrefix || "forum"}/tmp/posts/user-${viewer.userId}/draft-${token}`;
      const fileName = `${keyPrefix}/${imageId}.webp`;

      try {
        await b2UploadBuffer({
          fileName,
          buffer: webpBuffer,
          contentType: "image/webp",
        });
      } catch (_err) {
        return res.status(500).json({ ok: false, error: "Upload ảnh thất bại." });
      }

      const imageUrl = `${imageBaseUrl}/${fileName}`;
      const images = parseDraftImages(draftRow.images_json);
      images.push({ id: imageId, key: fileName, url: imageUrl });

      await dbRun(
        "UPDATE forum_post_image_drafts SET images_json = ?, updated_at = ? WHERE token = ?",
        [JSON.stringify(images), Date.now(), token]
      );

      return res.json({
        ok: true,
        image: {
          id: imageId,
          url: imageUrl,
          key: fileName,
        },
      });
    })
  );

  app.post(
    "/forum/api/post-drafts/:token/finalize",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để đăng bài." });
      }

      if (typeof b2CopyFile !== "function") {
        return res.status(500).json({ ok: false, error: "Máy chủ chưa cấu hình lưu trữ ảnh." });
      }

      const config = typeof getB2Config === "function" ? getB2Config() : null;
      if (!isB2Ready || typeof isB2Ready !== "function" || !isB2Ready(config)) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình lưu trữ ảnh trong .env" });
      }
      const imageBaseUrl = resolveForumImageBaseUrl(config);
      if (!imageBaseUrl) {
        return res.status(500).json({ ok: false, error: "Thiếu cấu hình URL public cho ảnh forum." });
      }

      const token = toText(req.params.token).slice(0, 40);
      if (!token) {
        return res.status(400).json({ ok: false, error: "Draft không hợp lệ." });
      }

      await ensureForumDraftTable();
      const draftRow = await dbGet("SELECT * FROM forum_post_image_drafts WHERE token = ? LIMIT 1", [token]);
      if (!draftRow) {
        return res.status(404).json({ ok: false, error: "Draft không tồn tại hoặc đã hết hạn." });
      }
      if (toText(draftRow.user_id) !== viewer.userId) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền chỉnh draft này." });
      }
      if (isForumDraftExpired(draftRow)) {
        await purgeForumDraft(draftRow).catch(() => null);
        return res.status(410).json({ ok: false, error: "Draft đã hết hạn. Vui lòng tạo bài viết mới." });
      }

      const content = toText(req && req.body ? req.body.content : "");
      const images = parseDraftImages(draftRow.images_json);
      if (!images.length) {
        await dbRun("UPDATE forum_post_image_drafts SET images_json = '[]', updated_at = ? WHERE token = ?", [
          Date.now(),
          token,
        ]);
        return res.json({ ok: true, content });
      }

      const nowMs = Date.now();
      const finalPrefix = buildForumPostFinalPrefix({
        forumPrefix: config.forumPrefix,
        token,
        nowMs,
      });
      let outputContent = String(content || "");
      let savedCount = 0;
      const nextImages = [];

      for (const image of images) {
        const imageId = toText(image && image.id) || `${nextImages.length + 1}`;
        const imageKey = toText(image && image.key);
        const imageUrl = toText(image && image.url);
        const imageLegacyUrl = toText(image && image.legacyUrl);
        if (!imageKey || !imageUrl) continue;

        const hasCurrentUrl = extractObjectKeyFromUrlLike(imageUrl) === imageKey
          ? outputContent.includes(imageUrl)
          : false;
        const hasLegacyUrl = Boolean(imageLegacyUrl && outputContent.includes(imageLegacyUrl));
        const currentMatch = replaceImageSourceByKey({
          content: outputContent,
          sourceKey: imageKey,
          replacementUrl: imageUrl,
        });
        const hasKeyMatch = currentMatch.replaced;
        if (!hasCurrentUrl && !hasLegacyUrl && !hasKeyMatch) continue;
        if (hasKeyMatch) {
          outputContent = currentMatch.content;
        }

        if (!isTmpForumDraftImageKey(imageKey)) {
          if (!hasCurrentUrl && hasLegacyUrl) {
            outputContent = replaceAllLiteral(outputContent, imageLegacyUrl, imageUrl);
          }
          nextImages.push({ id: imageId, key: imageKey, url: imageUrl, legacyUrl: imageLegacyUrl });
          continue;
        }

        savedCount += 1;
        const destinationName = `${finalPrefix}/${String(savedCount).padStart(3, "0")}.webp`;
        await b2CopyFile({ sourceFileId: imageKey, destinationFileName: destinationName });
        const finalUrl = `${imageBaseUrl}/${destinationName}`;
        const replacedCurrent = replaceImageSourceByKey({
          content: outputContent,
          sourceKey: imageKey,
          replacementUrl: finalUrl,
        });
        outputContent = replacedCurrent.content;
        if (!replacedCurrent.replaced) {
          outputContent = replaceAllLiteral(outputContent, imageUrl, finalUrl);
        }
        nextImages.push({ id: imageId, key: destinationName, url: finalUrl, legacyUrl: imageUrl });
      }

      await dbRun("UPDATE forum_post_image_drafts SET images_json = ?, updated_at = ? WHERE token = ?", [
        JSON.stringify(nextImages),
        nowMs,
        token,
      ]);

      const tmpKeys = listForumDraftImageKeys(images, { onlyTmp: true });
      if (tmpKeys.length) {
        deleteForumImageKeys(tmpKeys, { skipReferenceCheck: true }).catch(() => null);
      }

      return res.json({ ok: true, content: outputContent });
    })
  );

  app.post(
    "/forum/api/post-drafts/:token/commit",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập." });
      }

      const token = toText(req.params.token).slice(0, 40);
      if (!token) {
        return res.status(400).json({ ok: false, error: "Draft không hợp lệ." });
      }

      await ensureForumDraftTable();
      const draftRow = await dbGet("SELECT * FROM forum_post_image_drafts WHERE token = ? LIMIT 1", [token]);
      if (!draftRow) {
        return res.json({ ok: true, committed: true });
      }
      if (toText(draftRow.user_id) !== viewer.userId) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền chỉnh draft này." });
      }
      if (isForumDraftExpired(draftRow)) {
        await purgeForumDraft(draftRow).catch(() => null);
        return res.status(410).json({ ok: false, error: "Draft đã hết hạn. Vui lòng tạo bài viết mới." });
      }

      const images = parseDraftImages(draftRow.images_json);
      const requestedCommentId = normalizePositiveInt(req && req.body ? req.body.commentId : 0, 0);
      let effectiveCommentId = requestedCommentId;
      const config = typeof getB2Config === "function" ? getB2Config() : null;
      const canOperateStorage =
        typeof b2CopyFile === "function" &&
        (typeof b2DeleteFileVersions === "function" || typeof b2DeleteAllByPrefix === "function") &&
        typeof isB2Ready === "function" &&
        Boolean(isB2Ready(config));
      const imageBaseUrl = resolveForumImageBaseUrl(config);

      if (effectiveCommentId <= 0 && images.length > 0) {
        const candidateRows = await dbAll(
          `
            SELECT id, content
            FROM comments
            WHERE author_user_id = ?
              AND parent_id IS NULL
              AND status = 'visible'
              AND COALESCE(client_request_id, '') ILIKE ?
            ORDER BY id DESC
            LIMIT 30
          `,
          [viewer.userId, FORUM_REQUEST_ID_LIKE]
        );

        const matchedRow = (Array.isArray(candidateRows) ? candidateRows : []).find((row) => {
          const rowContent = String(row && row.content ? row.content : "");
          if (!rowContent) return false;

          return images.some((image) => {
            const imageKey = toText(image && image.key);
            const imageUrl = toText(image && image.url);
            const imageLegacyUrl = toText(image && image.legacyUrl);

            if (imageKey && contentHasImageKey(rowContent, imageKey)) return true;
            if (imageUrl && rowContent.includes(imageUrl)) return true;
            if (imageLegacyUrl && rowContent.includes(imageLegacyUrl)) return true;
            return false;
          });
        });

        if (matchedRow) {
          effectiveCommentId = normalizePositiveInt(matchedRow.id, 0);
        }
      }

      if (effectiveCommentId > 0 && images.length > 0) {
        if (!canOperateStorage || !imageBaseUrl) {
          return res.status(500).json({ ok: false, error: "Thiếu cấu hình URL public cho ảnh forum." });
        }

        const commentRow = await dbGet(
          `
            SELECT id, author_user_id, content
            FROM comments
            WHERE id = ?
              AND parent_id IS NULL
              AND status = 'visible'
              AND COALESCE(client_request_id, '') ILIKE ?
            LIMIT 1
          `,
          [effectiveCommentId, FORUM_REQUEST_ID_LIKE]
        );

        if (!commentRow) {
          return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết để hoàn tất ảnh." });
        }
        if (toText(commentRow.author_user_id) !== viewer.userId) {
          return res.status(403).json({ ok: false, error: "Bạn không có quyền hoàn tất ảnh cho bài viết này." });
        }

        const nowMs = Date.now();
        const finalPrefix = buildForumPostFinalPrefix({
          forumPrefix: config.forumPrefix,
          token,
          nowMs,
        });
        const originalContent = String(commentRow && commentRow.content ? commentRow.content : "");
        let outputContent = originalContent;
        let savedCount = 0;

        for (const image of images) {
          const imageKey = toText(image && image.key);
          const imageUrl = toText(image && image.url);
          const imageLegacyUrl = toText(image && image.legacyUrl);
          if (!imageKey || !imageUrl) continue;

          const hasCurrentUrl = extractObjectKeyFromUrlLike(imageUrl) === imageKey
            ? outputContent.includes(imageUrl)
            : false;
          const hasLegacyUrl = Boolean(imageLegacyUrl && outputContent.includes(imageLegacyUrl));
          const currentMatch = replaceImageSourceByKey({
            content: outputContent,
            sourceKey: imageKey,
            replacementUrl: imageUrl,
          });
          const hasKeyMatch = currentMatch.replaced;
          if (!hasCurrentUrl && !hasLegacyUrl && !hasKeyMatch) continue;
          if (hasKeyMatch) {
            outputContent = currentMatch.content;
          }

          if (!isTmpForumDraftImageKey(imageKey)) {
            if (!hasCurrentUrl && hasLegacyUrl) {
              outputContent = replaceAllLiteral(outputContent, imageLegacyUrl, imageUrl);
            }
            continue;
          }

          savedCount += 1;
          const destinationName = `${finalPrefix}/${String(savedCount).padStart(3, "0")}.webp`;
          await b2CopyFile({ sourceFileId: imageKey, destinationFileName: destinationName });
          const finalUrl = `${imageBaseUrl}/${destinationName}`;

          const replacedCurrent = replaceImageSourceByKey({
            content: outputContent,
            sourceKey: imageKey,
            replacementUrl: finalUrl,
          });
          outputContent = replacedCurrent.content;
          if (!replacedCurrent.replaced) {
            outputContent = replaceAllLiteral(outputContent, imageUrl, finalUrl);
            if (imageLegacyUrl && imageLegacyUrl !== imageUrl) {
              outputContent = replaceAllLiteral(outputContent, imageLegacyUrl, finalUrl);
            }
          }
        }

        if (outputContent !== originalContent) {
          await dbRun("UPDATE comments SET content = ? WHERE id = ?", [outputContent, effectiveCommentId]);
        }
      }

      const hasTmpImages = images.some((image) => isTmpForumDraftImageKey(toText(image && image.key)));
      if (images.length > 0 && hasTmpImages && effectiveCommentId <= 0) {
        return res.status(409).json({
          ok: false,
          error: "Không xác định được bài viết để hoàn tất ảnh. Vui lòng thử đăng lại hoặc huỷ nháp.",
        });
      }

      const tmpKeys = listForumDraftImageKeys(images, { onlyTmp: true });
      if (tmpKeys.length > 0) {
        try {
          await deleteForumImageKeys(tmpKeys, { skipReferenceCheck: true });
        } catch (_err) {
          return res.status(500).json({ ok: false, error: "Không thể dọn ảnh nháp. Vui lòng thử lại." });
        }
      }

      await dbRun("DELETE FROM forum_post_image_drafts WHERE token = ?", [token]);
      return res.json({ ok: true, committed: true });
    })
  );

  app.delete(
    "/forum/api/post-drafts/:token",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập." });
      }

      const token = toText(req.params.token).slice(0, 40);
      if (!token) {
        return res.status(400).json({ ok: false, error: "Draft không hợp lệ." });
      }

      await ensureForumDraftTable();
      const draftRow = await dbGet("SELECT * FROM forum_post_image_drafts WHERE token = ? LIMIT 1", [token]);
      if (!draftRow) {
        return res.json({ ok: true, deletedImages: 0 });
      }
      if (toText(draftRow.user_id) !== viewer.userId) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền chỉnh draft này." });
      }

      if (isForumDraftExpired(draftRow)) {
        const deletedCount = await purgeForumDraft(draftRow).catch(() => 0);
        return res.json({ ok: true, deletedImages: deletedCount });
      }

      const images = parseDraftImages(draftRow.images_json);
      const config = typeof getB2Config === "function" ? getB2Config() : null;
      const canDeleteStorage =
        (typeof b2DeleteFileVersions === "function" || typeof b2DeleteAllByPrefix === "function") &&
        typeof isB2Ready === "function" &&
        Boolean(isB2Ready(config));

      if (images.length > 0 && !canDeleteStorage) {
        return res.status(500).json({ ok: false, error: "Không thể dọn ảnh nháp. Vui lòng thử lại." });
      }

      if (canDeleteStorage && images.length > 0) {
        const tmpKeys = listForumDraftImageKeys(images, { onlyTmp: true });
        const persistedKeys = listForumDraftImageKeys(images).filter((key) => !isTmpForumDraftImageKey(key));
        let hasCleanupFailure = false;

        try {
          if (tmpKeys.length > 0) {
            await deleteForumImageKeys(tmpKeys, { skipReferenceCheck: true });
          }
          if (persistedKeys.length > 0) {
            await deleteForumImageKeys(persistedKeys);
          }
        } catch (_err) {
          hasCleanupFailure = true;
        }

        if (hasCleanupFailure) {
          return res.status(500).json({ ok: false, error: "Không thể dọn ảnh nháp. Vui lòng thử lại." });
        }
      }

      await dbRun("DELETE FROM forum_post_image_drafts WHERE token = ?", [token]);
      return res.json({ ok: true, deletedImages: images.length });
    })
  );

  app.get(
    "/forum/api/home",
    asyncHandler(async (req, res) => {
      const requestedPage = normalizePositiveInt(req.query.page, 1);
      const perPageRequested = normalizePositiveInt(req.query.perPage, DEFAULT_PER_PAGE);
      const perPage = Math.min(Math.max(perPageRequested, 1), MAX_PER_PAGE);
      const genreId = normalizePositiveInt(req.query.genreId, 0);
      const queryText = toText(req.query.q).replace(/\s+/g, " ").slice(0, 120);
      const sort = normalizeForumSort(req.query.sort);

      const whereParts = [
        "c.status = 'visible'",
        "c.parent_id IS NULL",
        "COALESCE(c.client_request_id, '') ILIKE ?",
        "COALESCE(m.is_hidden, 0) = 0",
      ];
      const whereParams = [FORUM_REQUEST_ID_LIKE];

      if (queryText) {
        whereParts.push("(c.content ILIKE ? OR m.title ILIKE ?)");
        whereParams.push(`%${queryText}%`, `%${queryText}%`);
      }

      if (genreId > 0) {
        whereParts.push(
          `EXISTS (
            SELECT 1
            FROM manga_genres mgf
            WHERE mgf.manga_id = c.manga_id
              AND mgf.genre_id = ?
          )`
        );
        whereParams.push(genreId);
      }

      const whereSql = whereParts.join(" AND ");
      const viewer = await buildViewerContext(req);
      const forumSectionConfig = await loadForumAdminSections();
      const sectionMetaBySlug = new Map(
        forumSectionConfig.sections.map((section) => [
          section.slug,
          {
            label: section.label,
            icon: section.icon,
          },
        ])
      );

      const countRow = await dbGet(
        `
          SELECT COUNT(*) AS count
          FROM comments c
          JOIN manga m ON m.id = c.manga_id
          WHERE ${whereSql}
        `,
        whereParams
      );

      const total = Number(countRow && countRow.count) || 0;
      const pageCount = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(Math.max(requestedPage, 1), pageCount);
      const offset = (page - 1) * perPage;

      const basePostSelectSql = `
        SELECT
          c.id,
          c.content,
          c.created_at,
          c.like_count,
          c.report_count,
          c.forum_post_locked,
          c.forum_post_pinned,
          c.author,
          c.author_user_id,
          c.author_avatar_url,
          c.chapter_number,
          m.id AS manga_id,
          m.slug AS manga_slug,
          m.title AS manga_title,
          m.cover AS manga_cover,
          ch.title AS chapter_title,
          u.username AS user_username,
          u.display_name AS user_display_name,
          u.avatar_url AS user_avatar_url,
          COALESCE(reply_stats.reply_count, 0) AS reply_count,
          reply_stats.latest_reply_at,
          (COALESCE(c.like_count, 0) + (COALESCE(reply_stats.reply_count, 0) * 2))::int AS hot_score,
          COALESCE(primary_genre.id, 0) AS genre_id,
          COALESCE(primary_genre.name, 'Thảo luận') AS genre_name
        FROM comments c
        JOIN manga m ON m.id = c.manga_id
        LEFT JOIN chapters ch
          ON ch.manga_id = c.manga_id
         AND c.chapter_number IS NOT NULL
         AND ch.number = c.chapter_number
        LEFT JOIN users u ON u.id = c.author_user_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS reply_count,
            MAX(r.created_at) AS latest_reply_at
          FROM comments r
          WHERE r.status = 'visible'
            AND COALESCE(r.client_request_id, '') ILIKE ?
            AND (
              r.parent_id = c.id
              OR r.parent_id IN (
                SELECT c1.id
                FROM comments c1
                WHERE c1.parent_id = c.id
                  AND c1.status = 'visible'
                  AND COALESCE(c1.client_request_id, '') ILIKE ?
              )
            )
        ) reply_stats ON TRUE
        LEFT JOIN LATERAL (
          SELECT g.id, g.name
          FROM manga_genres mg
          JOIN genres g ON g.id = mg.genre_id
          WHERE mg.manga_id = c.manga_id
          ORDER BY g.name ASC
          LIMIT 1
        ) primary_genre ON TRUE
        WHERE ${whereSql}
      `;

      let postRows = [];
      if (sort === "hot") {
        const recentCutoffIso = new Date(Date.now() - HOT_RECENT_WINDOW_MS).toISOString();
        postRows = await dbAll(
          `
            WITH base_posts AS (
              ${basePostSelectSql}
            ),
            recent_bucket AS (
              SELECT
                bp.id,
                ROW_NUMBER() OVER (ORDER BY bp.created_at DESC, bp.id DESC) AS bucket_rank
              FROM base_posts bp
              WHERE bp.created_at >= ?
            ),
            recent_picks AS (
              SELECT id, bucket_rank
              FROM recent_bucket
              WHERE bucket_rank <= ${HOT_RECENT_LIMIT}
            ),
            comment_bucket AS (
              SELECT
                bp.id,
                ROW_NUMBER() OVER (ORDER BY bp.latest_reply_at DESC, bp.id DESC) AS bucket_rank
              FROM base_posts bp
              WHERE bp.latest_reply_at IS NOT NULL
                AND bp.id NOT IN (SELECT id FROM recent_picks)
            ),
            comment_picks AS (
              SELECT id, bucket_rank
              FROM comment_bucket
              WHERE bucket_rank <= ${HOT_COMMENT_ACTIVITY_LIMIT}
            ),
            hot_bucket AS (
              SELECT
                bp.id,
                ROW_NUMBER() OVER (ORDER BY bp.hot_score DESC, bp.created_at DESC, bp.id DESC) AS bucket_rank
              FROM base_posts bp
              WHERE bp.id NOT IN (SELECT id FROM recent_picks)
                AND bp.id NOT IN (SELECT id FROM comment_picks)
            ),
            ranked AS (
              SELECT
                merged.id,
                ROW_NUMBER() OVER (ORDER BY merged.bucket ASC, merged.bucket_rank ASC) AS global_rank
              FROM (
                SELECT rp.id, 1 AS bucket, rp.bucket_rank
                FROM recent_picks rp
                UNION ALL
                SELECT cp.id, 2 AS bucket, cp.bucket_rank
                FROM comment_picks cp
                UNION ALL
                SELECT hb.id, 3 AS bucket, hb.bucket_rank
                FROM hot_bucket hb
              ) merged
            )
            SELECT bp.*
            FROM ranked r
            JOIN base_posts bp ON bp.id = r.id
            ORDER BY r.global_rank ASC
            LIMIT ? OFFSET ?
          `,
          [FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE, ...whereParams, recentCutoffIso, perPage, offset]
        );
      } else {
        const orderSql =
          sort === "most-commented"
            ? "ORDER BY COALESCE(reply_stats.reply_count, 0) DESC, c.created_at DESC, c.id DESC"
            : "ORDER BY c.created_at DESC, c.id DESC";

        postRows = await dbAll(
          `
            ${basePostSelectSql}
            ${orderSql}
            LIMIT ? OFFSET ?
          `,
          [FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE, ...whereParams, perPage, offset]
        );
      }

      const statsRow = await dbGet(`
        SELECT
          (SELECT COUNT(*) FROM users) AS member_count,
          (
            SELECT COUNT(*)
            FROM comments c
            JOIN manga m ON m.id = c.manga_id
            WHERE c.status = 'visible'
              AND c.parent_id IS NULL
              AND COALESCE(c.client_request_id, '') ILIKE ?
              AND COALESCE(m.is_hidden, 0) = 0
          ) AS post_count,
          (
            SELECT COUNT(*)
            FROM comments c
            WHERE c.status = 'visible'
              AND c.parent_id IS NOT NULL
              AND COALESCE(c.client_request_id, '') ILIKE ?
          ) AS reply_count
      `, [FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE]);

      const categoryRows = await dbAll(`
        SELECT
          g.id,
          g.name,
          COUNT(DISTINCT c.id)::int AS post_count
        FROM genres g
        LEFT JOIN manga_genres mg ON mg.genre_id = g.id
        LEFT JOIN manga m ON m.id = mg.manga_id
          AND COALESCE(m.is_hidden, 0) = 0
        LEFT JOIN comments c ON c.manga_id = m.id
          AND c.status = 'visible'
          AND c.parent_id IS NULL
          AND COALESCE(c.client_request_id, '') ILIKE ?
        GROUP BY g.id, g.name
        HAVING COUNT(DISTINCT c.id) > 0
        ORDER BY post_count DESC, g.name ASC
        LIMIT 16
      `, [FORUM_REQUEST_ID_LIKE]);

      const featuredMangaRows = await dbAll(`
        SELECT
          m.id,
          m.slug,
          m.title,
          m.cover,
          MAX(c.created_at) AS last_post_at,
          COUNT(*)::int AS post_count
        FROM manga m
        JOIN comments c ON c.manga_id = m.id
          AND c.status = 'visible'
          AND c.parent_id IS NULL
          AND COALESCE(c.client_request_id, '') ILIKE ?
        WHERE COALESCE(m.is_hidden, 0) = 0
        GROUP BY m.id, m.slug, m.title, m.cover
        ORDER BY MAX(c.created_at) DESC
        LIMIT 8
      `, [FORUM_REQUEST_ID_LIKE]);

      const mangaOptionRows = await dbAll(`
        SELECT
          m.slug,
          m.title
        FROM manga m
        WHERE COALESCE(m.is_hidden, 0) = 0
          AND TRIM(COALESCE(m.slug, '')) <> ''
          AND TRIM(COALESCE(m.title, '')) <> ''
        ORDER BY lower(m.title) ASC
        LIMIT 200
      `);

      const postIds = postRows
        .map((row) => Number(row && row.id))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value));
      const likedIdSet = await buildLikedIdSetForViewer({ viewer, ids: postIds });
      const savedIdSet = await buildSavedPostIdSetForViewer({ viewer, ids: postIds });
      const authorDecorationMap = await buildAuthorDecorationMap(postRows);
      const mentionByCommentId = await buildMentionMapForRows({ rows: postRows });
      const sectionStatsBySlug = await buildForumAdminSectionStatsMap(
        forumSectionConfig.sections.map((section) => section.slug)
      );

      return res.json({
        ok: true,
        filters: {
          page,
          perPage,
          genreId,
          q: queryText,
          sort,
        },
        pagination: {
          page,
          perPage,
          total,
          pageCount,
          hasPrev: page > 1,
          hasNext: page < pageCount,
        },
        stats: {
          memberCount: Number(statsRow && statsRow.member_count) || 0,
          postCount: Number(statsRow && statsRow.post_count) || 0,
          replyCount: Number(statsRow && statsRow.reply_count) || 0,
        },
        categories: categoryRows.map((row) => ({
          id: Number(row && row.id) || 0,
          name: toText(row && row.name) || "Thảo luận",
          slug: normalizeGenreSlug(row && row.name),
          postCount: Number(row && row.post_count) || 0,
        })),
        sections: forumSectionConfig.sections
          .filter((section) => section.visible)
          .map((section, index) => {
            const sectionStats = sectionStatsBySlug.get(section.slug) || {
              postCount: 0,
              hiddenPostCount: 0,
            };
            const visiblePostCount = Math.max(
              0,
              (Number(sectionStats.postCount) || 0) - (Number(sectionStats.hiddenPostCount) || 0)
            );

            return {
              id: index + 1,
              slug: section.slug,
              label: section.label,
              icon: section.icon,
              visible: section.visible,
              isSystem: section.isSystem,
              postCount: visiblePostCount,
            };
          }),
        featuredManga: featuredMangaRows.map((row) => ({
          id: Number(row && row.id) || 0,
          title: toText(row && row.title),
          slug: toText(row && row.slug),
          cover: toText(row && row.cover),
          url: toText(row && row.slug)
            ? `/manga/${encodeURIComponent(toText(row.slug))}`
            : "/manga",
          postCount: Number(row && row.post_count) || 0,
          lastPostAt: toIso(row && row.last_post_at),
          lastPostTimeAgo:
            typeof formatTimeAgo === "function"
              ? formatTimeAgo(toText(row && row.last_post_at))
              : toText(row && row.last_post_at),
        })),
        mangaOptions: mangaOptionRows.map((row) => ({
          slug: toText(row && row.slug),
          title: toText(row && row.title),
        })),
        posts: postRows.map((row) =>
          mapPostSummary(row, {
            viewer,
            authorDecorationMap,
            mentionByCommentId,
            likedIdSet,
            savedIdSet,
            sectionMetaBySlug,
            includeAllBadges: false,
          })
        ),
        viewer,
      });
    })
  );

  app.post(
    "/forum/api/link-labels",
    asyncHandler(async (req, res) => {
      const rawUrls = Array.isArray(req && req.body && req.body.urls) ? req.body.urls : [];
      const urls = Array.from(
        new Set(
          rawUrls
            .map((value) => toText(value))
            .filter(Boolean)
        )
      ).slice(0, 80);

      if (!urls.length) {
        return res.json({ ok: true, labels: [] });
      }

      const parsedLinks = [];
      const mangaSlugSet = new Set();
      const usernameSet = new Set();
      const userIdSet = new Set();
      const postIdSet = new Set();
      const teamIdSet = new Set();
      const teamSlugSet = new Set();

      urls.forEach((url) => {
        const path = parseInternalPathFromUrl(url, req);
        if (!path) return;

        let match = path.match(/^\/manga\/([^/]+)\/chapters\/([^/]+)$/i);
        if (match) {
          const slug = decodePathSegment(match[1]).toLowerCase();
          if (!slug) return;
          const chapterLabel = formatChapterLabelFromPath(match[2]);
          parsedLinks.push({ kind: "manga-chapter", url, slug, chapterLabel });
          mangaSlugSet.add(slug);
          return;
        }

        match = path.match(/^\/manga\/([^/]+)$/i);
        if (match) {
          const slug = decodePathSegment(match[1]).toLowerCase();
          if (!slug) return;
          parsedLinks.push({ kind: "manga", url, slug });
          mangaSlugSet.add(slug);
          return;
        }

        match = path.match(/^\/user\/([^/]+)$/i);
        if (match) {
          const username = decodePathSegment(match[1]).toLowerCase();
          if (!username) return;
          parsedLinks.push({ kind: "user", url, username });
          usernameSet.add(username);
          return;
        }

        match = path.match(/^\/comments\/users\/([^/]+)$/i);
        if (match) {
          const userId = decodePathSegment(match[1]);
          if (!userId) return;
          parsedLinks.push({ kind: "user-id", url, userId });
          userIdSet.add(userId);
          return;
        }

        match = path.match(/^\/(?:forum\/)?post\/(\d+)$/i);
        if (match) {
          const postId = Number(match[1]);
          if (!Number.isFinite(postId) || postId <= 0) return;
          const safePostId = Math.floor(postId);
          parsedLinks.push({ kind: "forum-post", url, postId: safePostId });
          postIdSet.add(safePostId);
          return;
        }

        match = path.match(/^\/team\/(\d+)\/([^/]+)$/i);
        if (match) {
          const teamId = Number(match[1]);
          const teamSlug = decodePathSegment(match[2]).toLowerCase();
          const safeTeamId = Number.isFinite(teamId) && teamId > 0 ? Math.floor(teamId) : 0;
          if (!safeTeamId && !teamSlug) return;
          parsedLinks.push({ kind: "team", url, teamId: safeTeamId, teamSlug });
          if (safeTeamId) teamIdSet.add(safeTeamId);
          if (teamSlug) teamSlugSet.add(teamSlug);
        }
      });

      if (!parsedLinks.length) {
        return res.json({ ok: true, labels: [] });
      }

      const mangaTitleBySlug = new Map();
      const usernameLabelByUsername = new Map();
      const usernameLabelByUserId = new Map();
      const postTitleById = new Map();
      const teamNameById = new Map();
      const teamNameBySlug = new Map();

      if (mangaSlugSet.size) {
        const slugs = Array.from(mangaSlugSet);
        const placeholders = buildSqlPlaceholders(slugs.length);
        const rows = await dbAll(
          `
            SELECT slug, title
            FROM manga
            WHERE COALESCE(is_hidden, 0) = 0
              AND LOWER(slug) IN (${placeholders})
          `,
          slugs
        );
        rows.forEach((row) => {
          const slug = toText(row && row.slug).toLowerCase();
          const title = toText(row && row.title);
          if (!slug || !title) return;
          mangaTitleBySlug.set(slug, title);
        });
      }

      if (usernameSet.size) {
        const usernames = Array.from(usernameSet);
        const placeholders = buildSqlPlaceholders(usernames.length);
        const rows = await dbAll(
          `
            SELECT username, display_name
            FROM users
            WHERE LOWER(username) IN (${placeholders})
          `,
          usernames
        );
        rows.forEach((row) => {
          const username = toText(row && row.username).toLowerCase();
          if (!username) return;
          const label = toText(row && row.display_name) || toText(row && row.username);
          if (!label) return;
          usernameLabelByUsername.set(username, label);
        });
      }

      if (userIdSet.size) {
        const userIds = Array.from(userIdSet);
        const placeholders = buildSqlPlaceholders(userIds.length);
        const rows = await dbAll(
          `
            SELECT id, username, display_name
            FROM users
            WHERE id IN (${placeholders})
          `,
          userIds
        );
        rows.forEach((row) => {
          const userId = toText(row && row.id);
          if (!userId) return;
          const label = toText(row && row.display_name) || toText(row && row.username);
          if (!label) return;
          usernameLabelByUserId.set(userId, label);
        });
      }

      if (postIdSet.size) {
        const ids = Array.from(postIdSet);
        const placeholders = buildSqlPlaceholders(ids.length);
        const rows = await dbAll(
          `
            SELECT
              c.id,
              c.content,
              c.chapter_number,
              m.id AS manga_id,
              m.slug AS manga_slug,
              m.title AS manga_title,
              ch.title AS chapter_title
            FROM comments c
            JOIN manga m ON m.id = c.manga_id
            LEFT JOIN chapters ch
              ON ch.manga_id = c.manga_id
             AND c.chapter_number IS NOT NULL
             AND ch.number = c.chapter_number
            WHERE c.id IN (${placeholders})
              AND c.parent_id IS NULL
              AND c.status = 'visible'
              AND COALESCE(c.client_request_id, '') ILIKE ?
              AND COALESCE(m.is_hidden, 0) = 0
          `,
          [...ids, FORUM_REQUEST_ID_LIKE]
        );
        rows.forEach((row) => {
          const id = Number(row && row.id);
          if (!Number.isFinite(id) || id <= 0) return;
          const title = buildPostTitle(row, mapManga(row), mapChapter(row));
          if (!title) return;
          postTitleById.set(Math.floor(id), title);
        });
      }

      if (teamIdSet.size || teamSlugSet.size) {
        const teamIds = Array.from(teamIdSet);
        const teamSlugs = Array.from(teamSlugSet);
        const idPlaceholders = buildSqlPlaceholders(teamIds.length);
        const slugPlaceholders = buildSqlPlaceholders(teamSlugs.length);

        const whereParts = [];
        const whereParams = [];
        if (teamIds.length) {
          whereParts.push(`id IN (${idPlaceholders})`);
          whereParams.push(...teamIds);
        }
        if (teamSlugs.length) {
          whereParts.push(`LOWER(slug) IN (${slugPlaceholders})`);
          whereParams.push(...teamSlugs);
        }

        if (whereParts.length) {
          const rows = await dbAll(
            `
              SELECT id, slug, name
              FROM translation_teams
              WHERE ${whereParts.join(" OR ")}
            `,
            whereParams
          );
          rows.forEach((row) => {
            const id = Number(row && row.id);
            const slug = toText(row && row.slug).toLowerCase();
            const name = toText(row && row.name);
            if (!name) return;
            if (Number.isFinite(id) && id > 0) {
              teamNameById.set(Math.floor(id), name);
            }
            if (slug) {
              teamNameBySlug.set(slug, name);
            }
          });
        }
      }

      const labels = [];
      parsedLinks.forEach((item) => {
        let label = "";

        if (item.kind === "manga") {
          label = toText(mangaTitleBySlug.get(item.slug));
        } else if (item.kind === "manga-chapter") {
          const mangaTitle = toText(mangaTitleBySlug.get(item.slug));
          const chapterLabel = toText(item.chapterLabel);
          if (mangaTitle && chapterLabel) {
            label = `${mangaTitle} - Ch. ${chapterLabel}`;
          } else if (mangaTitle) {
            label = mangaTitle;
          }
        } else if (item.kind === "user") {
          label = toText(usernameLabelByUsername.get(item.username));
        } else if (item.kind === "user-id") {
          label = toText(usernameLabelByUserId.get(item.userId));
        } else if (item.kind === "forum-post") {
          label = toText(postTitleById.get(item.postId));
        } else if (item.kind === "team") {
          label =
            toText(item.teamId ? teamNameById.get(item.teamId) : "") ||
            toText(item.teamSlug ? teamNameBySlug.get(item.teamSlug) : "");
        }

        if (!label) return;
        labels.push({
          url: item.url,
          label,
        });
      });

      return res.json({ ok: true, labels });
    })
  );

  app.get(
    "/forum/api/posts/:id",
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã chủ đề không hợp lệ." });
      }
      const viewer = await buildViewerContext(req);

      const postRow = await dbGet(
        `
          SELECT
            c.id,
            c.content,
          c.created_at,
          c.like_count,
          c.report_count,
          c.forum_post_locked,
          c.forum_post_pinned,
          c.author,
            c.author_user_id,
            c.author_avatar_url,
            c.chapter_number,
            m.id AS manga_id,
            m.slug AS manga_slug,
            m.title AS manga_title,
            m.cover AS manga_cover,
            ch.title AS chapter_title,
            u.username AS user_username,
            u.display_name AS user_display_name,
            u.avatar_url AS user_avatar_url,
            COALESCE(reply_stats.reply_count, 0) AS reply_count,
            COALESCE(primary_genre.id, 0) AS genre_id,
            COALESCE(primary_genre.name, 'Thảo luận') AS genre_name
          FROM comments c
          JOIN manga m ON m.id = c.manga_id
          LEFT JOIN chapters ch
            ON ch.manga_id = c.manga_id
           AND c.chapter_number IS NOT NULL
           AND ch.number = c.chapter_number
          LEFT JOIN users u ON u.id = c.author_user_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS reply_count
            FROM comments r
            WHERE r.status = 'visible'
              AND (
                r.parent_id = c.id
                OR r.parent_id IN (
                  SELECT c1.id
                  FROM comments c1
                  WHERE c1.parent_id = c.id
                    AND c1.status = 'visible'
                )
              )
          ) reply_stats ON TRUE
          LEFT JOIN LATERAL (
            SELECT g.id, g.name
            FROM manga_genres mg
            JOIN genres g ON g.id = mg.genre_id
            WHERE mg.manga_id = c.manga_id
            ORDER BY g.name ASC
            LIMIT 1
          ) primary_genre ON TRUE
          WHERE c.id = ?
            AND c.status = 'visible'
            AND c.parent_id IS NULL
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(m.is_hidden, 0) = 0
          LIMIT 1
        `,
        [postId, FORUM_REQUEST_ID_LIKE]
      );

      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy chủ đề." });
      }

      const mangaSlug = toText(postRow && postRow.manga_slug);
      const chapterNumberText = formatChapterNumberText(postRow && postRow.chapter_number);
      const replyEndpoint = !mangaSlug
        ? ""
        : chapterNumberText
          ? `/manga/${encodeURIComponent(mangaSlug)}/chapters/${encodeURIComponent(chapterNumberText)}/comments`
          : `/manga/${encodeURIComponent(mangaSlug)}/comments`;

      const replyRows = await dbAll(
        `
          SELECT
            r.id,
            r.content,
            r.created_at,
            r.like_count,
            r.report_count,
            r.manga_id,
            r.parent_id,
            r.author,
            r.author_user_id,
            r.author_avatar_url,
            parent.author_user_id AS parent_author_user_id,
            u.username AS user_username,
            u.display_name AS user_display_name,
            u.avatar_url AS user_avatar_url
          FROM comments r
          LEFT JOIN comments parent ON parent.id = r.parent_id
          LEFT JOIN users u ON u.id = r.author_user_id
          WHERE r.status = 'visible'
            AND COALESCE(r.client_request_id, '') ILIKE ?
            AND (
              r.parent_id = ?
              OR r.parent_id IN (
                SELECT c1.id
                FROM comments c1
                WHERE c1.parent_id = ?
                  AND c1.status = 'visible'
              )
            )
          ORDER BY r.created_at ASC, r.id ASC
        `,
        [FORUM_REQUEST_ID_LIKE, postId, postId]
      );

      const reactionIds = [postId, ...replyRows.map((row) => Number(row && row.id))]
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value));
      const likedIdSet = await buildLikedIdSetForViewer({ viewer, ids: reactionIds });
      const savedIdSet = await buildSavedPostIdSetForViewer({ viewer, ids: [postId] });
      const authorDecorationMap = await buildAuthorDecorationMap([postRow, ...replyRows]);
      const forumSectionConfig = await loadForumAdminSections();
      const sectionMetaBySlug = new Map(
        forumSectionConfig.sections.map((section) => [
          section.slug,
          {
            label: section.label,
            icon: section.icon,
          },
        ])
      );
      const mentionByCommentId = await buildMentionMapForRows({
        rows: [postRow, ...replyRows],
        rootCommentId: postId,
      });
      const mappedPostWithAuthor = mapPostSummary(postRow, {
        includeContent: true,
        viewer,
        includeAllBadges: true,
        authorDecorationMap,
        mentionByCommentId,
        likedIdSet,
        savedIdSet,
        sectionMetaBySlug,
      });

      return res.json({
        ok: true,
        post: {
          ...mappedPostWithAuthor,
          replyEndpoint,
        },
        sections: forumSectionConfig.sections.map((section, index) => ({
          id: index + 1,
          slug: section.slug,
          label: section.label,
          icon: section.icon,
          visible: section.visible,
          isSystem: section.isSystem,
        })),
        comments: replyRows.map((row) =>
          mapReply(row, {
            viewer,
            authorDecorationMap,
            mentionByCommentId,
            likedIdSet,
          })
        ),
        viewer,
      });
    })
  );

  app.post(
    "/forum/api/posts/:id/lock",
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã chủ đề không hợp lệ." });
      }

      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để khóa chủ đề." });
      }

      const postRow = await dbGet(
        `
          SELECT
            c.id,
            c.author_user_id,
            COALESCE(c.forum_post_locked, false) AS forum_post_locked
          FROM comments c
          JOIN manga m ON m.id = c.manga_id
          WHERE c.id = ?
            AND c.parent_id IS NULL
            AND c.status = 'visible'
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(m.is_hidden, 0) = 0
          LIMIT 1
        `,
        [postId, FORUM_REQUEST_ID_LIKE]
      );
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy chủ đề." });
      }

      const ownerId = toText(postRow && postRow.author_user_id);
      const isOwner = Boolean(ownerId && ownerId === viewer.userId);
      const canModerate = Boolean(viewer.canModerateForum || viewer.canDeleteAnyComment);
      if (!isOwner && !canModerate) {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền khóa chủ đề này." });
      }

      const explicitLocked = req && req.body && typeof req.body.locked === "boolean" ? req.body.locked : null;
      const currentLocked = Boolean(postRow && postRow.forum_post_locked);
      const nextLocked = explicitLocked == null ? !currentLocked : explicitLocked;

      await dbRun("UPDATE comments SET forum_post_locked = ? WHERE id = ?", [nextLocked, postId]);
      return res.json({ ok: true, locked: nextLocked });
    })
  );

  app.post(
    "/forum/api/posts/:id/pin",
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã chủ đề không hợp lệ." });
      }

      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để ghim chủ đề." });
      }

      if (!viewer.canModerateForum && !viewer.canDeleteAnyComment) {
        return res.status(403).json({ ok: false, error: "Chỉ Mod/Admin mới có thể ghim chủ đề." });
      }

      const postRow = await dbGet(
        `
          SELECT
            c.id,
            COALESCE(c.forum_post_pinned, false) AS forum_post_pinned
          FROM comments c
          JOIN manga m ON m.id = c.manga_id
          WHERE c.id = ?
            AND c.parent_id IS NULL
            AND c.status = 'visible'
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(m.is_hidden, 0) = 0
          LIMIT 1
        `,
        [postId, FORUM_REQUEST_ID_LIKE]
      );
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy chủ đề." });
      }

      const explicitPinned = req && req.body && typeof req.body.pinned === "boolean" ? req.body.pinned : null;
      const currentPinned = Boolean(postRow && postRow.forum_post_pinned);
      const nextPinned = explicitPinned == null ? !currentPinned : explicitPinned;

      await dbRun("UPDATE comments SET forum_post_pinned = ? WHERE id = ?", [nextPinned, postId]);
      return res.json({ ok: true, pinned: nextPinned });
    })
  );

  app.get(
    "/forum/api/saved-posts",
    asyncHandler(async (req, res) => {
      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.json({ ok: true, posts: [], viewer });
      }

      const requestedLimit = normalizePositiveInt(req.query.limit, 50);
      const limit = Math.min(Math.max(requestedLimit, 1), 100);

      const postRows = await dbAll(
        `
          SELECT
            c.id,
            c.content,
            c.created_at,
            c.like_count,
            c.report_count,
            c.forum_post_locked,
            c.forum_post_pinned,
            c.author,
            c.author_user_id,
            c.author_avatar_url,
            c.chapter_number,
            m.id AS manga_id,
            m.slug AS manga_slug,
            m.title AS manga_title,
            m.cover AS manga_cover,
            ch.title AS chapter_title,
            u.username AS user_username,
            u.display_name AS user_display_name,
            u.avatar_url AS user_avatar_url,
            COALESCE(reply_stats.reply_count, 0) AS reply_count,
            COALESCE(primary_genre.id, 0) AS genre_id,
            COALESCE(primary_genre.name, 'Thảo luận') AS genre_name
          FROM forum_post_bookmarks b
          JOIN comments c ON c.id = b.comment_id
          JOIN manga m ON m.id = c.manga_id
          LEFT JOIN chapters ch
            ON ch.manga_id = c.manga_id
           AND c.chapter_number IS NOT NULL
           AND ch.number = c.chapter_number
          LEFT JOIN users u ON u.id = c.author_user_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS reply_count
            FROM comments r
            WHERE r.status = 'visible'
              AND (
                r.parent_id = c.id
                OR r.parent_id IN (
                  SELECT c1.id
                  FROM comments c1
                  WHERE c1.parent_id = c.id
                    AND c1.status = 'visible'
                )
              )
          ) reply_stats ON TRUE
          LEFT JOIN LATERAL (
            SELECT g.id, g.name
            FROM manga_genres mg
            JOIN genres g ON g.id = mg.genre_id
            WHERE mg.manga_id = c.manga_id
            ORDER BY g.name ASC
            LIMIT 1
          ) primary_genre ON TRUE
          WHERE b.user_id = ?
            AND c.status = 'visible'
            AND c.parent_id IS NULL
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(m.is_hidden, 0) = 0
          ORDER BY COALESCE(c.forum_post_pinned, false) DESC, b.created_at DESC, b.comment_id DESC
          LIMIT ?
        `,
        [viewer.userId, FORUM_REQUEST_ID_LIKE, limit]
      );

      if (!Array.isArray(postRows) || !postRows.length) {
        return res.json({ ok: true, posts: [], viewer });
      }

      const postIds = postRows
        .map((row) => Number(row && row.id))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value));
      const likedIdSet = await buildLikedIdSetForViewer({ viewer, ids: postIds });
      const savedIdSet = await buildSavedPostIdSetForViewer({ viewer, ids: postIds });
      const authorDecorationMap = await buildAuthorDecorationMap(postRows);
      const mentionByCommentId = await buildMentionMapForRows({ rows: postRows });

      return res.json({
        ok: true,
        posts: postRows.map((row) =>
          mapPostSummary(row, {
            viewer,
            authorDecorationMap,
            mentionByCommentId,
            likedIdSet,
            savedIdSet,
            sectionMetaBySlug,
            includeAllBadges: false,
          })
        ),
        viewer,
      });
    })
  );

  app.post(
    "/forum/api/posts/:id/bookmark",
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã chủ đề không hợp lệ." });
      }

      const viewer = await buildViewerContext(req);
      if (!viewer.authenticated || !viewer.userId) {
        return res.status(401).json({ ok: false, error: "Bạn cần đăng nhập để lưu bài viết." });
      }

      const postRow = await dbGet(
        `
          SELECT c.id
          FROM comments c
          JOIN manga m ON m.id = c.manga_id
          WHERE c.id = ?
            AND c.parent_id IS NULL
            AND c.status = 'visible'
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(m.is_hidden, 0) = 0
          LIMIT 1
        `,
        [postId, FORUM_REQUEST_ID_LIKE]
      );
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy chủ đề." });
      }

      const existing = await dbGet(
        "SELECT comment_id FROM forum_post_bookmarks WHERE user_id = ? AND comment_id = ? LIMIT 1",
        [viewer.userId, postId]
      );

      let saved = false;
      if (existing) {
        await dbRun("DELETE FROM forum_post_bookmarks WHERE user_id = ? AND comment_id = ?", [viewer.userId, postId]);
        saved = false;
      } else {
        await dbRun(
          "INSERT INTO forum_post_bookmarks (user_id, comment_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          [viewer.userId, postId, Date.now()]
        );
        saved = true;
      }

      return res.json({ ok: true, saved });
    })
  );

  app.get(
    "/forum/api/admin/overview",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const statsRow = await dbGet(
        `
          SELECT
            COUNT(*) FILTER (WHERE c.parent_id IS NULL) AS total_posts,
            COUNT(*) FILTER (WHERE c.parent_id IS NULL AND c.status = 'visible') AS visible_posts,
            COUNT(*) FILTER (WHERE c.parent_id IS NULL AND c.status = 'reported') AS hidden_posts,
            COUNT(*) FILTER (WHERE c.parent_id IS NOT NULL) AS total_replies,
            COALESCE(SUM(COALESCE(c.report_count, 0)) FILTER (WHERE c.parent_id IS NULL), 0) AS total_reports,
            COUNT(DISTINCT c.author_user_id) FILTER (
              WHERE c.parent_id IS NULL
                AND c.author_user_id IS NOT NULL
                AND TRIM(c.author_user_id) <> ''
            ) AS unique_authors
          FROM comments c
          WHERE COALESCE(c.client_request_id, '') ILIKE ?
        `,
        [FORUM_REQUEST_ID_LIKE]
      );

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const todayRow = await dbGet(
        `
          SELECT
            COUNT(*) FILTER (WHERE c.parent_id IS NULL) AS new_posts_today,
            COUNT(*) FILTER (WHERE c.parent_id IS NOT NULL) AS new_replies_today
          FROM comments c
          WHERE COALESCE(c.client_request_id, '') ILIKE ?
            AND c.created_at >= ?
        `,
        [FORUM_REQUEST_ID_LIKE, startOfDay.toISOString()]
      );

      const latestRows = await dbAll(
        `
          SELECT
            c.id,
            c.content,
            c.status,
            c.created_at,
            c.author,
            c.author_user_id,
            COALESCE(u.username, '') AS author_username,
            COALESCE(u.display_name, '') AS author_display_name
          FROM comments c
          LEFT JOIN users u ON u.id = c.author_user_id
          WHERE c.parent_id IS NULL
            AND COALESCE(c.client_request_id, '') ILIKE ?
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 6
        `,
        [FORUM_REQUEST_ID_LIKE]
      );

      const adminSectionConfig = await loadForumAdminSections();

      return res.json({
        ok: true,
        stats: {
          totalPosts: Number(statsRow && statsRow.total_posts) || 0,
          visiblePosts: Number(statsRow && statsRow.visible_posts) || 0,
          hiddenPosts: Number(statsRow && statsRow.hidden_posts) || 0,
          totalReplies: Number(statsRow && statsRow.total_replies) || 0,
          totalReports: Number(statsRow && statsRow.total_reports) || 0,
          activeAuthors: Number(statsRow && statsRow.unique_authors) || 0,
          newPostsToday: Number(todayRow && todayRow.new_posts_today) || 0,
          newRepliesToday: Number(todayRow && todayRow.new_replies_today) || 0,
        },
        latestPosts: (Array.isArray(latestRows) ? latestRows : []).map((row) => {
          const mapped = mapForumAdminPostSummary(row, {
            sectionLabelBySlug: adminSectionConfig.labelBySlug,
          });
          return {
            id: mapped.id,
            title: mapped.title,
            status: mapped.status,
            sectionLabel: mapped.sectionLabel,
            authorName: mapped.author.name,
            timeAgo: mapped.timeAgo,
            createdAt: mapped.createdAt,
          };
        }),
      });
    })
  );

  app.get(
    "/forum/api/admin/posts",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const q = toText(req.query.q).replace(/\s+/g, " ").slice(0, 120);
      const status = normalizeForumAdminStatus(req.query.status);
      const section = normalizeForumAdminSection(req.query.section);
      const sort = normalizeForumAdminSort(req.query.sort);
      const perPageRequested = normalizePositiveInt(req.query.perPage, ADMIN_DEFAULT_PER_PAGE);
      const perPage = Math.min(Math.max(perPageRequested, 1), ADMIN_MAX_PER_PAGE);
      const requestedPage = normalizePositiveInt(req.query.page, 1);

      const whereParts = [
        "c.parent_id IS NULL",
        "COALESCE(c.client_request_id, '') ILIKE ?",
      ];
      const whereParams = [FORUM_REQUEST_ID_LIKE];

      if (q) {
        const likeValue = `%${q}%`;
        whereParts.push(
          `(
            c.content ILIKE ?
            OR c.author ILIKE ?
            OR COALESCE(u.username, '') ILIKE ?
            OR COALESCE(u.display_name, '') ILIKE ?
            OR CAST(c.id AS TEXT) = ?
          )`
        );
        whereParams.push(likeValue, likeValue, likeValue, likeValue, q);
      }

      if (status === "visible") {
        whereParts.push("c.status = 'visible'");
      } else if (status === "hidden") {
        whereParts.push("c.status = 'reported'");
      } else if (status === "reported") {
        whereParts.push("c.status = 'visible' AND COALESCE(c.report_count, 0) > 0");
      }

      if (section !== "all") {
        whereParts.push("COALESCE(c.content, '') ILIKE ?");
        whereParams.push(`%forum-meta:section=${section}%`);
      }

      const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

      const countRow = await dbGet(
        `
          SELECT COUNT(*) AS count
          FROM comments c
          LEFT JOIN users u ON u.id = c.author_user_id
          ${whereSql}
        `,
        whereParams
      );
      const total = Number(countRow && countRow.count) || 0;
      const pageCount = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(Math.max(requestedPage, 1), pageCount);
      const offset = (page - 1) * perPage;

      const adminSectionConfig = await loadForumAdminSections();

      let orderBySql = "c.created_at DESC, c.id DESC";
      if (sort === "oldest") {
        orderBySql = "c.created_at ASC, c.id ASC";
      } else if (sort === "likes") {
        orderBySql = "COALESCE(c.like_count, 0) DESC, c.created_at DESC, c.id DESC";
      } else if (sort === "reports") {
        orderBySql = "COALESCE(c.report_count, 0) DESC, c.created_at DESC, c.id DESC";
      } else if (sort === "comments") {
        orderBySql = "COALESCE(reply_stats.reply_count, 0) DESC, c.created_at DESC, c.id DESC";
      }

      const rows = await dbAll(
        `
          SELECT
            c.id,
            c.content,
            c.status,
            c.like_count,
            c.report_count,
            c.forum_post_locked,
            c.forum_post_pinned,
            c.created_at,
            c.author,
            c.author_user_id,
            c.author_avatar_url,
            COALESCE(u.username, '') AS author_username,
            COALESCE(u.display_name, '') AS author_display_name,
            u.avatar_url AS user_avatar_url,
            COALESCE(reply_stats.reply_count, 0) AS reply_count
          FROM comments c
          LEFT JOIN users u ON u.id = c.author_user_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS reply_count
            FROM comments r
            WHERE r.parent_id = c.id
              AND COALESCE(r.client_request_id, '') ILIKE ?
          ) reply_stats ON TRUE
          ${whereSql}
          ORDER BY ${orderBySql}
          LIMIT ? OFFSET ?
        `,
        [FORUM_REQUEST_ID_LIKE, ...whereParams, perPage, offset]
      );

      return res.json({
        ok: true,
        filters: {
          q,
          status,
          section,
          sort,
          page,
          perPage,
        },
        pagination: {
          page,
          perPage,
          total,
          pageCount,
          hasPrev: page > 1,
          hasNext: page < pageCount,
        },
        sections: adminSectionConfig.sections.map((item) => ({
          slug: item.slug,
          label: item.label,
        })),
        posts: (Array.isArray(rows) ? rows : []).map((row) =>
          mapForumAdminPostSummary(row, {
            sectionLabelBySlug: adminSectionConfig.labelBySlug,
          })
        ),
      });
    })
  );

  app.get(
    "/forum/api/admin/categories",
    requireAdmin,
    asyncHandler(async (_req, res) => {
      const adminSectionConfig = await loadForumAdminSections();
      const statsBySlug = await buildForumAdminSectionStatsMap(
        adminSectionConfig.sections.map((section) => section.slug)
      );

      return res.json({
        ok: true,
        categories: adminSectionConfig.sections.map((section) => {
          const stats = statsBySlug.get(section.slug) || {
            postCount: 0,
            hiddenPostCount: 0,
            reportCount: 0,
            lastPostAt: "",
            lastPostTimeAgo: "",
          };

          return {
            slug: section.slug,
            label: section.label,
            icon: section.icon,
            visible: section.visible,
            isSystem: section.isSystem,
            sortOrder: section.sortOrder,
            postCount: Number(stats.postCount) || 0,
            hiddenPostCount: Number(stats.hiddenPostCount) || 0,
            reportCount: Number(stats.reportCount) || 0,
            lastPostAt: toText(stats.lastPostAt),
            lastPostTimeAgo: toText(stats.lastPostTimeAgo),
          };
        }),
      });
    })
  );

  app.post(
    "/forum/api/admin/categories",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const label = sanitizeForumSectionLabel(body.label);
      const icon = sanitizeForumSectionIcon(body.icon) || "💬";
      const requestedSlug = toText(body.slug);

      if (!label) {
        return res.status(400).json({ ok: false, error: "Tên danh mục không hợp lệ." });
      }

      const slug = normalizeForumSectionSlug(requestedSlug || label);
      if (!slug) {
        return res.status(400).json({ ok: false, error: "Slug danh mục không hợp lệ." });
      }

      await ensureForumSectionSettingsTable();

      const existing = await dbGet(
        `
          SELECT slug, is_deleted
          FROM forum_section_settings
          WHERE slug = ?
          LIMIT 1
        `,
        [slug]
      );

      if (existing && !parseBooleanValue(existing.is_deleted, false)) {
        return res.status(409).json({ ok: false, error: "Slug danh mục đã tồn tại." });
      }

      const maxOrderRow = await dbGet(
        `
          SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
          FROM forum_section_settings
          WHERE COALESCE(is_deleted, FALSE) = FALSE
        `
      );
      const nextSortOrder = (Number(maxOrderRow && maxOrderRow.max_sort_order) || 0) + 1;

      if (existing) {
        await dbRun(
          `
            UPDATE forum_section_settings
            SET
              label = ?,
              icon = ?,
              is_visible = TRUE,
              is_deleted = FALSE,
              sort_order = ?,
              updated_at = NOW()
            WHERE slug = ?
          `,
          [label, icon, nextSortOrder, slug]
        );
      } else {
        await dbRun(
          `
            INSERT INTO forum_section_settings (
              slug,
              label,
              icon,
              is_visible,
              is_system,
              is_deleted,
              sort_order,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, TRUE, FALSE, FALSE, ?, NOW(), NOW())
          `,
          [slug, label, icon, nextSortOrder]
        );
      }

      const adminSectionConfig = await loadForumAdminSections();
      const created = adminSectionConfig.sections.find((item) => item.slug === slug);

      return res.status(201).json({
        ok: true,
        category: created
          ? {
              slug: created.slug,
              label: created.label,
              icon: created.icon,
              visible: created.visible,
              isSystem: created.isSystem,
              sortOrder: created.sortOrder,
            }
          : null,
      });
    })
  );

  app.patch(
    "/forum/api/admin/categories/:slug",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const slug = normalizeForumSectionSlug(req.params.slug);
      if (!slug) {
        return res.status(400).json({ ok: false, error: "Danh mục không hợp lệ." });
      }

      await ensureForumSectionSettingsTable();

      const defaultSection = FORUM_ADMIN_SECTION_DEFAULT_BY_SLUG.get(slug);
      const existing = await dbGet(
        `
          SELECT slug, label, icon, is_system, is_deleted, sort_order
          FROM forum_section_settings
          WHERE slug = ?
          LIMIT 1
        `,
        [slug]
      );

      if (!existing && !defaultSection) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy danh mục." });
      }

      if (!existing) {
        const maxOrderRow = await dbGet(
          `
            SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
            FROM forum_section_settings
            WHERE COALESCE(is_deleted, FALSE) = FALSE
          `
        );
        const nextSortOrder = (Number(maxOrderRow && maxOrderRow.max_sort_order) || 0) + 1;
        await dbRun(
          `
            INSERT INTO forum_section_settings (
              slug,
              label,
              icon,
              is_visible,
              is_system,
              is_deleted,
              sort_order,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, TRUE, ?, FALSE, ?, NOW(), NOW())
          `,
          [
            slug,
            defaultSection ? defaultSection.label : slug,
            defaultSection ? defaultSection.icon : "💬",
            Boolean(defaultSection),
            defaultSection ? defaultSection.defaultOrder : nextSortOrder,
          ]
        );
      }

      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const updates = [];
      const values = [];

      const fallbackLabel =
        sanitizeForumSectionLabel(existing && existing.label) ||
        (defaultSection ? defaultSection.label : slug);
      const fallbackIcon =
        sanitizeForumSectionIcon(existing && existing.icon) ||
        (defaultSection ? defaultSection.icon : "💬");

      if (Object.prototype.hasOwnProperty.call(body, "label")) {
        const nextLabel = sanitizeForumSectionLabel(body.label) || fallbackLabel;
        updates.push("label = ?");
        values.push(nextLabel);
      }

      if (Object.prototype.hasOwnProperty.call(body, "icon")) {
        const nextIcon = sanitizeForumSectionIcon(body.icon) || fallbackIcon;
        updates.push("icon = ?");
        values.push(nextIcon);
      }

      if (Object.prototype.hasOwnProperty.call(body, "visible")) {
        if (typeof body.visible !== "boolean") {
          return res.status(400).json({ ok: false, error: "Trạng thái hiển thị không hợp lệ." });
        }
        updates.push("is_visible = ?");
        values.push(Boolean(body.visible));
      }

      if (Object.prototype.hasOwnProperty.call(body, "sortOrder")) {
        const sortOrder = normalizePositiveInt(body.sortOrder, 0);
        if (!sortOrder) {
          return res.status(400).json({ ok: false, error: "Thứ tự danh mục không hợp lệ." });
        }
        updates.push("sort_order = ?");
        values.push(sortOrder);
      }

      updates.push("is_deleted = FALSE");

      if (!updates.length) {
        return res.status(400).json({ ok: false, error: "Không có dữ liệu cần cập nhật." });
      }

      await dbRun(
        `
          UPDATE forum_section_settings
          SET ${updates.join(", ")}, updated_at = NOW()
          WHERE slug = ?
        `,
        [...values, slug]
      );

      const adminSectionConfig = await loadForumAdminSections();
      const updated = adminSectionConfig.sections.find((item) => item.slug === slug);

      return res.json({
        ok: true,
        category: updated
          ? {
              slug: updated.slug,
              label: updated.label,
              icon: updated.icon,
              visible: updated.visible,
              isSystem: updated.isSystem,
              sortOrder: updated.sortOrder,
            }
          : null,
      });
    })
  );

  app.delete(
    "/forum/api/admin/categories/:slug",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const slug = normalizeForumSectionSlug(req.params.slug);
      if (!slug) {
        return res.status(400).json({ ok: false, error: "Danh mục không hợp lệ." });
      }

      await ensureForumSectionSettingsTable();

      const existing = await dbGet(
        `
          SELECT slug, is_system
          FROM forum_section_settings
          WHERE slug = ?
            AND COALESCE(is_deleted, FALSE) = FALSE
          LIMIT 1
        `,
        [slug]
      );

      if (!existing) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy danh mục." });
      }

      if (parseBooleanValue(existing.is_system, false)) {
        return res.status(400).json({ ok: false, error: "Danh mục hệ thống không thể xóa." });
      }

      await dbRun(
        `
          UPDATE forum_section_settings
          SET
            is_deleted = TRUE,
            is_visible = FALSE,
            updated_at = NOW()
          WHERE slug = ?
        `,
        [slug]
      );

      return res.json({ ok: true, deleted: true, slug });
    })
  );

  app.get(
    "/forum/api/admin/comments",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const q = toText(req.query.q).replace(/\s+/g, " ").slice(0, 120);
      const status = normalizeForumAdminStatus(req.query.status);
      const perPageRequested = normalizePositiveInt(req.query.perPage, ADMIN_DEFAULT_PER_PAGE);
      const perPage = Math.min(Math.max(perPageRequested, 1), ADMIN_MAX_PER_PAGE);
      const requestedPage = normalizePositiveInt(req.query.page, 1);

      const whereParts = [
        "COALESCE(c.parent_id, 0) > 0",
        "parent.id IS NOT NULL",
        "COALESCE(c.client_request_id, '') ILIKE ?",
        "COALESCE(parent.client_request_id, '') ILIKE ?",
      ];
      const whereParams = [FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE];

      if (q) {
        const likeValue = `%${q}%`;
        whereParts.push(
          `(
            c.content ILIKE ?
            OR c.author ILIKE ?
            OR COALESCE(u.username, '') ILIKE ?
            OR COALESCE(u.display_name, '') ILIKE ?
            OR COALESCE(parent.content, '') ILIKE ?
            OR CAST(c.id AS TEXT) = ?
          )`
        );
        whereParams.push(likeValue, likeValue, likeValue, likeValue, likeValue, q);
      }

      if (status === "visible") {
        whereParts.push("c.status = 'visible'");
      } else if (status === "hidden") {
        whereParts.push("c.status = 'reported'");
      } else if (status === "reported") {
        whereParts.push("c.status = 'visible' AND COALESCE(c.report_count, 0) > 0");
      }

      const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

      const countRow = await dbGet(
        `
          SELECT COUNT(*) AS count
          FROM comments c
          LEFT JOIN users u ON u.id = c.author_user_id
          LEFT JOIN comments parent ON parent.id = c.parent_id
          ${whereSql}
        `,
        whereParams
      );

      const total = Number(countRow && countRow.count) || 0;
      const pageCount = Math.max(1, Math.ceil(total / perPage));
      const page = Math.min(Math.max(requestedPage, 1), pageCount);
      const offset = (page - 1) * perPage;

      const rows = await dbAll(
        `
          SELECT
            c.id,
            c.parent_id,
            c.content,
            c.status,
            c.like_count,
            c.report_count,
            c.created_at,
            c.author,
            c.author_user_id,
            c.author_avatar_url,
            COALESCE(u.username, '') AS author_username,
            COALESCE(u.display_name, '') AS author_display_name,
            u.avatar_url AS user_avatar_url,
            COALESCE(parent.parent_id, 0) AS parent_parent_id,
            COALESCE(parent.author, '') AS parent_author,
            COALESCE(root_topic.id, 0) AS topic_id,
            COALESCE(root_topic.content, '') AS topic_content
          FROM comments c
          LEFT JOIN users u ON u.id = c.author_user_id
          LEFT JOIN comments parent ON parent.id = c.parent_id
          LEFT JOIN LATERAL (
            WITH RECURSIVE lineage AS (
              SELECT cc.id, cc.parent_id, cc.content
              FROM comments cc
              WHERE cc.id = c.id
              UNION ALL
              SELECT pp.id, pp.parent_id, pp.content
              FROM comments pp
              JOIN lineage l ON pp.id = l.parent_id
            )
            SELECT l.id, l.content
            FROM lineage l
            WHERE l.parent_id IS NULL
            LIMIT 1
          ) root_topic ON TRUE
          ${whereSql}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ? OFFSET ?
        `,
        [...whereParams, perPage, offset]
      );

      return res.json({
        ok: true,
        filters: {
          q,
          status,
          page,
          perPage,
        },
        pagination: {
          page,
          perPage,
          total,
          pageCount,
          hasPrev: page > 1,
          hasNext: page < pageCount,
        },
        comments: (Array.isArray(rows) ? rows : []).map((row) => mapForumAdminCommentSummary(row)),
      });
    })
  );

  app.post(
    "/forum/api/admin/comments/bulk",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const action = toText(body.action).toLowerCase();
      if (action !== "hide" && action !== "delete") {
        return res.status(400).json({ ok: false, error: "Thao tác hàng loạt không hợp lệ." });
      }

      const ids = normalizeAdminIdList(body.ids, 200);
      if (!ids.length) {
        return res.status(400).json({ ok: false, error: "Vui lòng chọn ít nhất một bình luận." });
      }

      const placeholders = buildSqlPlaceholders(ids.length);
      const validRows = await dbAll(
        `
          SELECT c.id
          FROM comments c
          JOIN comments parent ON parent.id = c.parent_id
          WHERE c.id IN (${placeholders})
            AND COALESCE(c.parent_id, 0) > 0
            AND COALESCE(c.client_request_id, '') ILIKE ?
            AND COALESCE(parent.client_request_id, '') ILIKE ?
        `,
        [...ids, FORUM_REQUEST_ID_LIKE, FORUM_REQUEST_ID_LIKE]
      );
      const validIds = normalizeAdminIdList(
        (Array.isArray(validRows) ? validRows : []).map((row) => Number(row && row.id)),
        200
      );

      if (!validIds.length) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận hợp lệ để xử lý." });
      }

      let changedCount = 0;
      let deletedCount = 0;

      if (action === "hide") {
        const validPlaceholders = buildSqlPlaceholders(validIds.length);
        const result = await dbRun(
          `
            WITH RECURSIVE subtree AS (
              SELECT id
              FROM comments
              WHERE id IN (${validPlaceholders})
              UNION ALL
              SELECT c.id
              FROM comments c
              JOIN subtree s ON c.parent_id = s.id
            )
            UPDATE comments
            SET
              status = 'reported',
              report_count = GREATEST(COALESCE(report_count, 0), 1)
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'reported' OR COALESCE(report_count, 0) < 1)
          `,
          validIds
        );
        changedCount = result && result.changes ? Number(result.changes) || 0 : 0;
      } else {
        if (typeof deleteCommentCascade === "function") {
          for (const commentId of validIds) {
            deletedCount += Number(await deleteCommentCascade(commentId)) || 0;
          }
        } else {
          const validPlaceholders = buildSqlPlaceholders(validIds.length);
          const result = await dbRun(
            `
              WITH RECURSIVE subtree AS (
                SELECT id
                FROM comments
                WHERE id IN (${validPlaceholders})
                UNION ALL
                SELECT c.id
                FROM comments c
                JOIN subtree s ON c.parent_id = s.id
              )
              DELETE FROM comments
              WHERE id IN (SELECT id FROM subtree)
            `,
            validIds
          );
          deletedCount = result && result.changes ? Number(result.changes) || 0 : 0;
        }
      }

      return res.json({
        ok: true,
        action,
        targetCount: validIds.length,
        changedCount,
        deletedCount,
      });
    })
  );

  app.post(
    "/forum/api/admin/comments/:id/hide",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const commentId = normalizePositiveInt(req.params.id, 0);
      if (!commentId) {
        return res.status(400).json({ ok: false, error: "Mã bình luận không hợp lệ." });
      }

      const commentRow = await getForumAdminCommentById(commentId);
      if (!commentRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
      }

      const changedCount = await runForumAdminTransaction(async ({ dbRun: txRun }) => {
        const result = await txRun(
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
            UPDATE comments
            SET
              status = 'reported',
              report_count = GREATEST(COALESCE(report_count, 0), 1)
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'reported' OR COALESCE(report_count, 0) < 1)
          `,
          [commentId]
        );

        return result && result.changes ? Number(result.changes) || 0 : 0;
      });

      return res.json({ ok: true, hidden: true, changedCount });
    })
  );

  app.post(
    "/forum/api/admin/comments/:id/restore",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const commentId = normalizePositiveInt(req.params.id, 0);
      if (!commentId) {
        return res.status(400).json({ ok: false, error: "Mã bình luận không hợp lệ." });
      }

      const commentRow = await getForumAdminCommentById(commentId);
      if (!commentRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
      }

      const changedCount = await runForumAdminTransaction(async ({ dbRun: txRun }) => {
        const updateResult = await txRun(
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
            UPDATE comments
            SET status = 'visible', report_count = 0
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'visible' OR COALESCE(report_count, 0) <> 0)
          `,
          [commentId]
        );

        const changed = updateResult && updateResult.changes ? Number(updateResult.changes) || 0 : 0;
        if (changed > 0) {
          await txRun(
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
              DELETE FROM comment_reports
              WHERE comment_id IN (SELECT id FROM subtree)
            `,
            [commentId]
          );
        }
        return changed;
      });

      return res.json({ ok: true, restored: true, changedCount });
    })
  );

  app.delete(
    "/forum/api/admin/comments/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const commentId = normalizePositiveInt(req.params.id, 0);
      if (!commentId) {
        return res.status(400).json({ ok: false, error: "Mã bình luận không hợp lệ." });
      }

      const commentRow = await getForumAdminCommentById(commentId);
      if (!commentRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bình luận." });
      }

      let deletedCount = 0;
      if (typeof deleteCommentCascade === "function") {
        deletedCount = Number(await deleteCommentCascade(commentId)) || 0;
      } else {
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
          [commentId]
        );
        deletedCount = result && result.changes ? Number(result.changes) || 0 : 0;
      }

      return res.json({ ok: true, deleted: true, deletedCount });
    })
  );

  app.post(
    "/forum/api/admin/posts/bulk",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const action = toText(body.action).toLowerCase();
      if (action !== "hide" && action !== "delete") {
        return res.status(400).json({ ok: false, error: "Thao tác hàng loạt không hợp lệ." });
      }

      const ids = normalizeAdminIdList(body.ids, 200);
      if (!ids.length) {
        return res.status(400).json({ ok: false, error: "Vui lòng chọn ít nhất một bài viết." });
      }

      const placeholders = buildSqlPlaceholders(ids.length);
      const validRows = await dbAll(
        `
          SELECT c.id
          FROM comments c
          WHERE c.id IN (${placeholders})
            AND c.parent_id IS NULL
            AND COALESCE(c.client_request_id, '') ILIKE ?
        `,
        [...ids, FORUM_REQUEST_ID_LIKE]
      );
      const validIds = normalizeAdminIdList(
        (Array.isArray(validRows) ? validRows : []).map((row) => Number(row && row.id)),
        200
      );

      if (!validIds.length) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết hợp lệ để xử lý." });
      }

      let changedCount = 0;
      let deletedCount = 0;

      if (action === "hide") {
        const validPlaceholders = buildSqlPlaceholders(validIds.length);
        const result = await dbRun(
          `
            WITH RECURSIVE subtree AS (
              SELECT id
              FROM comments
              WHERE id IN (${validPlaceholders})
              UNION ALL
              SELECT c.id
              FROM comments c
              JOIN subtree s ON c.parent_id = s.id
            )
            UPDATE comments
            SET
              status = 'reported',
              report_count = GREATEST(COALESCE(report_count, 0), 1)
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'reported' OR COALESCE(report_count, 0) < 1)
          `,
          validIds
        );
        changedCount = result && result.changes ? Number(result.changes) || 0 : 0;
      } else {
        if (typeof deleteCommentCascade === "function") {
          for (const postId of validIds) {
            deletedCount += Number(await deleteCommentCascade(postId)) || 0;
          }
        } else {
          const validPlaceholders = buildSqlPlaceholders(validIds.length);
          const result = await dbRun(
            `
              WITH RECURSIVE subtree AS (
                SELECT id
                FROM comments
                WHERE id IN (${validPlaceholders})
                UNION ALL
                SELECT c.id
                FROM comments c
                JOIN subtree s ON c.parent_id = s.id
              )
              DELETE FROM comments
              WHERE id IN (SELECT id FROM subtree)
            `,
            validIds
          );
          deletedCount = result && result.changes ? Number(result.changes) || 0 : 0;
        }
      }

      return res.json({
        ok: true,
        action,
        targetCount: validIds.length,
        changedCount,
        deletedCount,
      });
    })
  );

  app.patch(
    "/forum/api/admin/posts/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      const body = req && req.body && typeof req.body === "object" ? req.body : {};
      const title = toText(body.title).replace(/\s+/g, " ").slice(0, 300);
      const content = toText(body.content);
      const requestedSectionSlug = normalizeForumSectionSlug(body.sectionSlug);
      const config = typeof getB2Config === "function" ? getB2Config() : null;

      if (!title) {
        return res.status(400).json({ ok: false, error: "Tiêu đề bài viết không hợp lệ." });
      }

      if (!content || content === "<p></p>") {
        return res.status(400).json({ ok: false, error: "Nội dung bài viết không được để trống." });
      }

      const adminSectionConfig = await loadForumAdminSections();
      const availableSectionSlugs = new Set(adminSectionConfig.sections.map((item) => item.slug));

      let sectionSlug = requestedSectionSlug;
      if (!sectionSlug || !availableSectionSlugs.has(sectionSlug)) {
        sectionSlug = extractForumSectionSlug(toText(postRow && postRow.content)) || "thao-luan-chung";
      }
      if (!sectionSlug || !availableSectionSlugs.has(sectionSlug)) {
        sectionSlug = "thao-luan-chung";
      }

      const nextContent = `<p><strong>${escapeHtml(title)}</strong></p><!--forum-meta:section=${sectionSlug}-->${content}`;
      const removedImageKeys = Array.from(
        new Set([
          ...getRemovedForumImageKeys({
            beforeContent: postRow && postRow.content,
            nextContent,
            config,
          }),
          ...normalizeRequestedRemovedImageKeys(body && body.removedImageKeys ? body.removedImageKeys : [], config),
        ])
      );

      await dbRun(
        `
          UPDATE comments
          SET content = ?
          WHERE id = ?
        `,
        [nextContent, postId]
      );

      let deletedImageCount = 0;
      if (removedImageKeys.length > 0) {
        try {
          deletedImageCount = Number(await deleteForumImageKeys(removedImageKeys, { skipReferenceCheck: true })) || 0;
        } catch (err) {
          console.warn("admin post image cleanup failed", err);
        }
      }

      return res.json({
        ok: true,
        removedImageCount: removedImageKeys.length,
        deletedImageCount,
        post: {
          id: postId,
          sectionSlug,
          content: nextContent,
        },
      });
    })
  );

  app.post(
    "/forum/api/admin/posts/:id/pin",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      const explicitPinned = req && req.body && typeof req.body.pinned === "boolean" ? req.body.pinned : null;
      const currentPinned = Boolean(postRow && postRow.forum_post_pinned);
      const nextPinned = explicitPinned == null ? !currentPinned : explicitPinned;

      await dbRun("UPDATE comments SET forum_post_pinned = ? WHERE id = ?", [nextPinned, postId]);
      return res.json({ ok: true, pinned: nextPinned });
    })
  );

  app.post(
    "/forum/api/admin/posts/:id/lock",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      const explicitLocked = req && req.body && typeof req.body.locked === "boolean" ? req.body.locked : null;
      const currentLocked = Boolean(postRow && postRow.forum_post_locked);
      const nextLocked = explicitLocked == null ? !currentLocked : explicitLocked;

      await dbRun("UPDATE comments SET forum_post_locked = ? WHERE id = ?", [nextLocked, postId]);
      return res.json({ ok: true, locked: nextLocked });
    })
  );

  app.post(
    "/forum/api/admin/posts/:id/hide",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      const changedCount = await runForumAdminTransaction(async ({ dbRun: txRun }) => {
        const result = await txRun(
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
            UPDATE comments
            SET
              status = 'reported',
              report_count = GREATEST(COALESCE(report_count, 0), 1)
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'reported' OR COALESCE(report_count, 0) < 1)
          `,
          [postId]
        );

        return result && result.changes ? Number(result.changes) || 0 : 0;
      });

      return res.json({
        ok: true,
        hidden: true,
        changedCount,
      });
    })
  );

  app.post(
    "/forum/api/admin/posts/:id/restore",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      const changedCount = await runForumAdminTransaction(async ({ dbRun: txRun }) => {
        const updateResult = await txRun(
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
            UPDATE comments
            SET status = 'visible', report_count = 0
            WHERE id IN (SELECT id FROM subtree)
              AND (status <> 'visible' OR COALESCE(report_count, 0) <> 0)
          `,
          [postId]
        );

        const changed = updateResult && updateResult.changes ? Number(updateResult.changes) || 0 : 0;
        if (changed > 0) {
          await txRun(
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
              DELETE FROM comment_reports
              WHERE comment_id IN (SELECT id FROM subtree)
            `,
            [postId]
          );
        }
        return changed;
      });

      return res.json({ ok: true, restored: true, changedCount });
    })
  );

  app.delete(
    "/forum/api/admin/posts/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const postId = normalizePositiveInt(req.params.id, 0);
      if (!postId) {
        return res.status(400).json({ ok: false, error: "Mã bài viết không hợp lệ." });
      }

      const postRow = await getForumAdminRootPostById(postId);
      if (!postRow) {
        return res.status(404).json({ ok: false, error: "Không tìm thấy bài viết." });
      }

      let deletedCount = 0;
      if (typeof deleteCommentCascade === "function") {
        deletedCount = Number(await deleteCommentCascade(postId)) || 0;
      } else {
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
          [postId]
        );
        deletedCount = result && result.changes ? Number(result.changes) || 0 : 0;
      }

      return res.json({ ok: true, deleted: true, deletedCount });
    })
  );
};

module.exports = registerForumApiRoutes;
