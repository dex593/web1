const registerEngagementRoutes = (app, deps) => {
  const {
    NOTIFICATION_STREAM_HEARTBEAT_MS,
    addNotificationStreamClient,
    asyncHandler,
    dbAll,
    dbGet,
    dbRun,
    deleteCommentCascade,
    ensureUserRowFromAuthUser,
    formatDate,
    getUnreadNotificationCount,
    getUserBadgeContext,
    getVisibleCommentCount,
    mapNotificationRow,
    normalizeAvatarUrl,
    normalizeProfileBio,
    normalizeProfileDiscord,
    normalizeProfileFacebook,
    publishNotificationStreamUpdate,
    removeNotificationStreamClient,
    requireAuthUserForComments,
    resolveCommentPermalinkForNotification,
    wantsJson,
    withTransaction,
    writeNotificationStreamEvent,
  } = deps;

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
        "SELECT id, username, display_name, avatar_url, facebook_url, discord_handle, bio, created_at FROM users WHERE id = ?",
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
    "/notifications/stream",
    asyncHandler(async (req, res) => {
      const user = await requireAuthUserForComments(req, res);
      if (!user) return;
      const userId = String(user.id || "").trim();
      if (!userId) {
        return res.status(401).end();
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const clientId = addNotificationStreamClient(userId, res);
      const unreadCount = await getUnreadNotificationCount(userId);
      writeNotificationStreamEvent(res, "ready", { unreadCount });

      const heartbeat = setInterval(() => {
        const ok = writeNotificationStreamEvent(res, "heartbeat", { ts: Date.now() });
        if (!ok) {
          cleanup();
        }
      }, NOTIFICATION_STREAM_HEARTBEAT_MS);
      if (heartbeat && typeof heartbeat.unref === "function") {
        heartbeat.unref();
      }

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        removeNotificationStreamClient(userId, clientId);
      };

      req.on("close", cleanup);
      req.on("aborted", cleanup);
    })
  );

  app.get(
    "/notifications",
    asyncHandler(async (req, res) => {
      if (!wantsJson(req)) {
        return res.status(406).send("Yêu cầu JSON.");
      }

      const user = await requireAuthUserForComments(req, res);
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
            n.team_id,
            n.chapter_number,
            n.comment_id,
            n.content_preview,
            n.is_read,
            n.created_at,
            n.read_at,
            m.slug as manga_slug,
            m.title as manga_title,
            notify_team.name as notify_team_name,
            notify_team.slug as notify_team_slug,
            actor.username as actor_username,
            actor.display_name as actor_display_name,
            actor.avatar_url as actor_avatar_url
          FROM notifications n
          LEFT JOIN manga m ON m.id = n.manga_id
          LEFT JOIN translation_teams notify_team ON notify_team.id = n.team_id
          LEFT JOIN users actor ON actor.id = n.actor_user_id
          WHERE n.user_id = ?
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ?
        `,
        [userId, limit]
      );

      const permalinkPromiseByKey = new Map();
      const getPermalinkForRow = (row) => {
        const notificationType = (row && row.type ? String(row.type) : "").trim().toLowerCase();
        if (notificationType !== "mention") {
          return Promise.resolve("");
        }

        const chapterValue = row && row.chapter_number != null ? Number(row.chapter_number) : NaN;
        const hasChapter = Number.isFinite(chapterValue);
        const commentId = row && row.comment_id != null ? Number(row.comment_id) : NaN;
        const key = [
          row && row.manga_slug ? String(row.manga_slug).trim() : "",
          row && row.manga_id != null ? String(row.manga_id) : "",
          hasChapter ? String(chapterValue) : "",
          Number.isFinite(commentId) && commentId > 0 ? String(Math.floor(commentId)) : ""
        ].join("|");

        if (!permalinkPromiseByKey.has(key)) {
          const resolver = resolveCommentPermalinkForNotification({
            mangaSlug: row && row.manga_slug ? row.manga_slug : "",
            mangaId: row && row.manga_id != null ? row.manga_id : null,
            chapterNumber: hasChapter ? chapterValue : null,
            commentId: Number.isFinite(commentId) && commentId > 0 ? Math.floor(commentId) : null,
            perPage: 20
          });
          permalinkPromiseByKey.set(key, resolver);
        }

        return permalinkPromiseByKey.get(key);
      };

      const notifications = await Promise.all(
        rows.map(async (row) => {
          const resolvedUrl = await getPermalinkForRow(row);
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

      const user = await requireAuthUserForComments(req, res);
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
      if (result && result.changes) {
        publishNotificationStreamUpdate({ userId, reason: "read_all" }).catch(() => null);
      }
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

      const user = await requireAuthUserForComments(req, res);
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
      if (result && result.changes) {
        publishNotificationStreamUpdate({ userId, reason: "read_one" }).catch(() => null);
      }
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

      const user = await requireAuthUserForComments(req, res);
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
        await ensureUserRowFromAuthUser(user);
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

      const user = await requireAuthUserForComments(req, res);
      if (!user) return;
      const userId = String(user.id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
      }

      let canInteract = false;
      try {
        await ensureUserRowFromAuthUser(user);
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

      const user = await requireAuthUserForComments(req, res);
      if (!user) return;

      const userId = String(user.id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
      }

      let canInteract = false;
      try {
        await ensureUserRowFromAuthUser(user);
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

      const user = await requireAuthUserForComments(req, res);
      if (!user) return;

      const userId = String(user.id || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
      }

      let canInteract = false;
      try {
        await ensureUserRowFromAuthUser(user);
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
};

module.exports = registerEngagementRoutes;
