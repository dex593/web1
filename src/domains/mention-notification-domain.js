const createMentionNotificationDomain = (deps) => {
  const {
    COMMENT_MENTION_FETCH_LIMIT,
    NOTIFICATION_CLEANUP_INTERVAL_MS,
    NOTIFICATION_RETENTION_MS,
    NOTIFICATION_TYPE_MENTION,
    crypto,
    dbAll,
    dbGet,
    dbRun,
    formatTimeAgo,
    normalizeAvatarUrl,
    normalizeHexColor,
    notificationStreamClientsByUserId,
    resolveCommentScope,
  } = deps;

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

const writeNotificationStreamEvent = (response, eventName, payload) => {
  if (!response || response.writableEnded || response.destroyed) return false;

  const name = (eventName || "").toString().trim();
  const body = payload && typeof payload === "object" ? payload : {};
  const data = JSON.stringify(body);

  try {
    if (name) {
      response.write(`event: ${name}\n`);
    }
    response.write(`data: ${data}\n\n`);
    if (typeof response.flush === "function") {
      response.flush();
    }
    return true;
  } catch (_err) {
    return false;
  }
};

const addNotificationStreamClient = (userId, response) => {
  const id = (userId || "").toString().trim();
  if (!id || !response) return "";

  let bucket = notificationStreamClientsByUserId.get(id);
  if (!bucket) {
    bucket = new Map();
    notificationStreamClientsByUserId.set(id, bucket);
  }

  const clientId = crypto.randomUUID();
  bucket.set(clientId, { response });
  return clientId;
};

const removeNotificationStreamClient = (userId, clientId) => {
  const id = (userId || "").toString().trim();
  const key = (clientId || "").toString().trim();
  if (!id || !key) return;

  const bucket = notificationStreamClientsByUserId.get(id);
  if (!bucket) return;

  bucket.delete(key);
  if (!bucket.size) {
    notificationStreamClientsByUserId.delete(id);
  }
};

const publishNotificationStreamUpdate = async ({ userId, reason }) => {
  const id = (userId || "").toString().trim();
  if (!id) return;

  const bucket = notificationStreamClientsByUserId.get(id);
  if (!bucket || !bucket.size) return;

  const unreadCount = await getUnreadNotificationCount(id);
  const payload = {
    reason: (reason || "changed").toString().trim() || "changed",
    unreadCount
  };

  const staleClientIds = [];
  bucket.forEach((client, clientId) => {
    const ok = writeNotificationStreamEvent(client.response, "notification", payload);
    if (!ok) {
      staleClientIds.push(clientId);
    }
  });

  staleClientIds.forEach((clientId) => {
    removeNotificationStreamClient(id, clientId);
  });
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
      publishNotificationStreamUpdate({ userId: targetUserId, reason: "created" }).catch(() => null);
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

  return {
    addNotificationStreamClient,
    buildCommentMentionsForContent,
    buildCommentNotificationPreview,
    buildCommentPermalink,
    cleanupOldNotifications,
    createMentionNotificationsForComment,
    extractMentionUsernamesFromContent,
    findMentionTargetsForComment,
    getCommentMentionRegex,
    getCommentPageForRoot,
    getCommentRootId,
    getMentionCandidatesForManga,
    getMentionProfileMapForManga,
    getUnreadNotificationCount,
    mapNotificationRow,
    normalizeMentionSearchQuery,
    publishNotificationStreamUpdate,
    removeNotificationStreamClient,
    resolveCommentPermalinkForNotification,
    scheduleNotificationCleanup,
    writeNotificationStreamEvent,
  };
};

module.exports = createMentionNotificationDomain;
