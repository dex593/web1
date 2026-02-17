const registerSiteRoutes = (app, deps) => {
  const {
    AUTH_DISCORD_STRATEGY,
    AUTH_GOOGLE_STRATEGY,
    COMMENT_LINK_LABEL_FETCH_LIMIT,
    COMMENT_MAX_LENGTH,
    READING_HISTORY_MAX_ITEMS,
    SEO_ROBOTS_INDEX,
    SEO_ROBOTS_NOINDEX,
    SEO_SITE_NAME,
    asyncHandler,
    avatarsDir,
    buildAvatarUrlFromAuthUser,
    buildCommentAuthorFromAuthUser,
    buildCommentChapterContext,
    buildCommentMentionsForContent,
    buildHomepageNotices,
    buildOAuthCallbackUrl,
    buildSeoPayload,
    buildSessionUserFromUserRow,
    cacheBust,
    censorCommentContentByForbiddenWords,
    clearAllAuthSessionState,
    clearUserAuthSession,
    createMentionNotificationsForComment,
    crypto,
    dbAll,
    dbGet,
    dbRun,
    ensureCommentNotDuplicateRecently,
    ensureCommentPostCooldown,
    ensureCommentTurnstileIfSuspicious,
    ensureLeadingSlash,
    ensureUserRowFromAuthUser,
    escapeXml,
    extractMentionUsernamesFromContent,
    formatChapterNumberValue,
    formatTimeAgo,
    fs,
    getB2Config,
    getGenreStats,
    getMentionCandidatesForManga,
    getMentionProfileMapForManga,
    getPaginatedCommentTree,
    getPublicOriginFromRequest,
    getUserBadgeContext,
    hasOwnObjectKey,
    isDuplicateCommentRequestError,
    isOauthProviderEnabled,
    isServerSessionVersionMismatch,
    isUploadedAvatarUrl,
    listAuthIdentityRowsForUser,
    listQueryBase,
    listQueryOrder,
    loadSessionUserById,
    mapAuthIdentityRowToUserIdentity,
    mapMangaListRow,
    mapMangaRow,
    mapPublicUserRow,
    mapReadingHistoryRow,
    normalizeAvatarUrl,
    normalizeHomepageRow,
    normalizeNextPath,
    normalizeProfileBio,
    normalizeProfileDiscord,
    normalizeProfileDisplayName,
    normalizeProfileFacebook,
    normalizeSeoText,
    parseChapterNumberInput,
    passport,
    path,
    readAuthNextPath,
    readCommentRequestId,
    regenerateSession,
    registerCommentBotSignal,
    requireAuthUserForComments,
    resolveCommentScope,
    resolveOrCreateUserFromOauthProfile,
    resolvePaginationParams,
    sendCommentCooldownResponse,
    sendCommentDuplicateContentResponse,
    sendCommentRequestIdInvalidResponse,
    sendDuplicateCommentRequestResponse,
    serverSessionVersion,
    setAuthSessionUser,
    sharp,
    sitemapCacheByOrigin,
    sitemapCacheTtlMs,
    team,
    toAbsolutePublicUrl,
    toBooleanFlag,
    toIsoDate,
    uploadAvatar,
    upsertUserProfileFromAuthUser,
    wantsJson,
    withTransaction,
  } = deps;

  const TEAM_NAME_MAX_LENGTH = 30;
  const TEAM_INTRO_MAX_LENGTH = 300;
  const CHAT_MESSAGE_MAX_LENGTH = 300;
  const CHAT_POST_COOLDOWN_MS = 2000;

  const teamSlugify = (value) =>
    (value || "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

  const buildUniqueTeamSlug = async (name) => {
    const base = teamSlugify(name).slice(0, 60) || "team";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await dbGet(
        "SELECT id FROM translation_teams WHERE lower(slug) = lower(?) LIMIT 1",
        [candidate]
      );
      if (!existing) return candidate;
    }
    return `${base}-${Date.now()}`;
  };

  const normalizeCommunityUrl = (value, maxLength = 220) => {
    const raw = (value || "").toString().trim();
    if (!raw) return "";
    if (raw.length > maxLength) return "";
    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate.replace(/^\/+/, "")}`;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}${parsed.search || ""}`;
    } catch (_err) {
      return "";
    }
  };

  const getApprovedTeamMembership = async (userId) => {
    const safeUserId = (userId || "").toString().trim();
    if (!safeUserId) return null;
    return dbGet(
      `
        SELECT
          tm.team_id,
          tm.role,
          t.name as team_name,
          t.slug as team_slug,
          t.status as team_status
        FROM translation_team_members tm
        JOIN translation_teams t ON t.id = tm.team_id
        WHERE tm.user_id = ?
          AND tm.status = 'approved'
          AND t.status = 'approved'
        ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END ASC, tm.reviewed_at DESC, tm.requested_at DESC
        LIMIT 1
      `,
      [safeUserId]
    );
  };

  const buildTeamRoleLabel = ({ role, teamName }) => {
    const safeTeamName = (teamName || "").toString().trim();
    if (!safeTeamName) return "";
    const safeRole = (role || "").toString().trim().toLowerCase();
    return safeRole === "leader" ? `Leader ${safeTeamName}` : safeTeamName;
  };

  const CHAT_STREAM_HEARTBEAT_MS = 25000;
  const chatStreamClientsByUserId = new Map();

  const sendPrivateFeatureNotFound = (req, res) => {
    const acceptHeader = (req.get("accept") || "").toString().toLowerCase();
    if (acceptHeader.includes("text/event-stream")) {
      return res.status(404).end();
    }

    if (wantsJson(req)) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy." });
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
  };

  const requirePrivateFeatureAuthUser = async (req, res) => {
    if (isServerSessionVersionMismatch(req)) {
      clearAllAuthSessionState(req);
      sendPrivateFeatureNotFound(req, res);
      return null;
    }

    const authUserId =
      (req && req.session && req.session.authUserId ? req.session.authUserId : "").toString().trim();
    if (!authUserId) {
      sendPrivateFeatureNotFound(req, res);
      return null;
    }

    const user = await loadSessionUserById(authUserId);
    if (!user || !user.id) {
      clearUserAuthSession(req);
      sendPrivateFeatureNotFound(req, res);
      return null;
    }

    if (req && req.session) {
      req.session.sessionVersion = serverSessionVersion;
    }
    return user;
  };

  const writeChatStreamEvent = (response, eventName, payload) => {
    if (!response || response.writableEnded || response.destroyed) return false;
    const name = (eventName || "").toString().trim();
    const body = payload && typeof payload === "object" ? payload : {};
    const data = JSON.stringify(body);

    try {
      if (name) response.write(`event: ${name}\n`);
      response.write(`data: ${data}\n\n`);
      if (typeof response.flush === "function") {
        response.flush();
      }
      return true;
    } catch (_err) {
      return false;
    }
  };

  const addChatStreamClient = (userId, response) => {
    const safeUserId = (userId || "").toString().trim();
    if (!safeUserId || !response) return "";
    let bucket = chatStreamClientsByUserId.get(safeUserId);
    if (!bucket) {
      bucket = new Map();
      chatStreamClientsByUserId.set(safeUserId, bucket);
    }
    const clientId = crypto.randomUUID();
    bucket.set(clientId, { response });
    return clientId;
  };

  const removeChatStreamClient = (userId, clientId) => {
    const safeUserId = (userId || "").toString().trim();
    const safeClientId = (clientId || "").toString().trim();
    if (!safeUserId || !safeClientId) return;
    const bucket = chatStreamClientsByUserId.get(safeUserId);
    if (!bucket) return;

    bucket.delete(safeClientId);
    if (!bucket.size) {
      chatStreamClientsByUserId.delete(safeUserId);
    }
  };

  const publishChatStreamUpdate = ({ userIds, payload }) => {
    const ids = Array.from(
      new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((value) => (value == null ? "" : String(value)).trim())
          .filter(Boolean)
      )
    );
    if (!ids.length) return;

    ids.forEach((userId) => {
      const bucket = chatStreamClientsByUserId.get(userId);
      if (!bucket || !bucket.size) return;

      const staleClientIds = [];
      bucket.forEach((client, clientId) => {
        const ok = writeChatStreamEvent(client.response, "chat", payload || {});
        if (!ok) staleClientIds.push(clientId);
      });

      staleClientIds.forEach((clientId) => {
        removeChatStreamClient(userId, clientId);
      });
    });
  };

  const getUnreadChatMessageCount = async (userId) => {
    const safeUserId = (userId || "").toString().trim();
    if (!safeUserId) return 0;

    const row = await dbGet(
      `
        SELECT COUNT(*) as count
        FROM chat_messages m
        JOIN chat_thread_members tm ON tm.thread_id = m.thread_id
        WHERE tm.user_id = ?
          AND m.sender_user_id <> ?
          AND (tm.last_read_message_id IS NULL OR m.id > tm.last_read_message_id)
      `,
      [safeUserId, safeUserId]
    );

    const count = row ? Number(row.count) : 0;
    if (!Number.isFinite(count) || count <= 0) return 0;
    return Math.floor(count);
  };

app.get(
  "/auth/session",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

    if (isServerSessionVersionMismatch(req)) {
      clearAllAuthSessionState(req);
      return res.json({ ok: true, session: null, reason: "server_restart" });
    }

    const authUserId =
      (req && req.session && req.session.authUserId ? req.session.authUserId : "").toString().trim();
    if (!authUserId) {
      return res.json({ ok: true, session: null });
    }

    const user = await loadSessionUserById(authUserId);
    if (!user || !user.id) {
      clearUserAuthSession(req);
      return res.json({ ok: true, session: null });
    }

    req.session.sessionVersion = serverSessionVersion;
    return res.json({
      ok: true,
      session: {
        user,
        access_token: `session_${user.id}`,
        expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60
      }
    });
  })
);

app.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");

    if (req && req.session && typeof req.session.regenerate === "function") {
      await regenerateSession(req).catch(() => null);
    }
    if (req && req.session) {
      req.session.sessionVersion = serverSessionVersion;
    }
    return res.json({ ok: true });
  })
);

app.post(
  "/auth/profile",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;

    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ error: { message: "Phiên đăng nhập không hợp lệ." } });
    }

    const payload =
      req && req.body && typeof req.body.data === "object" && req.body.data ? req.body.data : {};

    const currentRow = await ensureUserRowFromAuthUser(user);
    const identityRows = await listAuthIdentityRowsForUser(userId);
    const identityList = identityRows.map(mapAuthIdentityRowToUserIdentity).filter(Boolean);
    const baseUser = {
      ...user,
      id: userId,
      identities: identityList
    };

    const now = Date.now();
    const hasDisplayName = hasOwnObjectKey(payload, "display_name");
    const hasFacebook = hasOwnObjectKey(payload, "facebook_url");
    const hasDiscord = hasOwnObjectKey(payload, "discord_handle") || hasOwnObjectKey(payload, "discord_url");
    const hasBio = hasOwnObjectKey(payload, "bio");
    const hasAvatarCustom = hasOwnObjectKey(payload, "avatar_url_custom");

    const displayName = hasDisplayName
      ? normalizeProfileDisplayName(payload.display_name)
      : normalizeProfileDisplayName(currentRow && currentRow.display_name ? currentRow.display_name : "");
    const facebookUrl = hasFacebook
      ? normalizeProfileFacebook(payload.facebook_url)
      : normalizeProfileFacebook(currentRow && currentRow.facebook_url ? currentRow.facebook_url : "");
    const discordHandle = hasDiscord
      ? normalizeProfileDiscord(payload.discord_handle || payload.discord_url)
      : normalizeProfileDiscord(currentRow && currentRow.discord_handle ? currentRow.discord_handle : "");
    const bio = hasBio
      ? normalizeProfileBio(payload.bio)
      : normalizeProfileBio(currentRow && currentRow.bio ? currentRow.bio : "");

    let avatarUrl = normalizeAvatarUrl(currentRow && currentRow.avatar_url ? currentRow.avatar_url : "");
    if (hasAvatarCustom) {
      const requestedCustomAvatar = normalizeAvatarUrl(payload.avatar_url_custom);
      if (requestedCustomAvatar && isUploadedAvatarUrl(requestedCustomAvatar)) {
        avatarUrl = requestedCustomAvatar;
      } else {
        avatarUrl = buildAvatarUrlFromAuthUser(
          {
            ...baseUser,
            user_metadata: {
              ...(baseUser && typeof baseUser.user_metadata === "object" ? baseUser.user_metadata : {}),
              avatar_url_custom: ""
            }
          },
          currentRow && currentRow.avatar_url ? currentRow.avatar_url : ""
        );
      }
    }

    await dbRun(
      "UPDATE users SET display_name = ?, avatar_url = ?, facebook_url = ?, discord_handle = ?, bio = ?, updated_at = ? WHERE id = ?",
      [displayName, avatarUrl, facebookUrl, discordHandle, bio, now, userId]
    );

    const updatedRow = await dbGet(
      "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
      [userId]
    );
    const sessionUser = buildSessionUserFromUserRow(updatedRow, identityRows);
    if (sessionUser) {
      setAuthSessionUser(req, sessionUser, req && req.session ? req.session.authProvider : "");
    }

    return res.json({
      data: {
        user: sessionUser || null
      },
      error: null
    });
  })
);

app.get("/auth/google", (req, res, next) => {
  if (!isOauthProviderEnabled("google")) {
    return res.status(503).send("Google OAuth chưa được cấu hình.");
  }

  req.session.authNextPath = normalizeNextPath(req.query.next || "/");
  const callbackURL = buildOAuthCallbackUrl(req, "google");
  if (!callbackURL) {
    return res.status(500).send("Không xác định được callback URL cho Google OAuth.");
  }

  return passport.authenticate(AUTH_GOOGLE_STRATEGY, {
    callbackURL,
    session: false,
    scope: ["profile", "email"],
    prompt: "select_account"
  })(req, res, next);
});

app.get("/auth/google/callback", (req, res, next) => {
  if (!isOauthProviderEnabled("google")) {
    return res.redirect("/");
  }
  const callbackURL = buildOAuthCallbackUrl(req, "google");
  if (!callbackURL) {
    return res.redirect("/");
  }
  return passport.authenticate(AUTH_GOOGLE_STRATEGY, {
    callbackURL,
    session: false,
    failureRedirect: "/?auth=failed"
  })(req, res, next);
}, asyncHandler(async (req, res) => {
  const nextPath = readAuthNextPath(req);
  const profile = req && req.user ? req.user : null;
  if (!profile) {
    return res.redirect(nextPath || "/");
  }
  try {
    const resolved = await resolveOrCreateUserFromOauthProfile(profile);
    if (resolved && resolved.sessionUser) {
      await regenerateSession(req);
      setAuthSessionUser(req, resolved.sessionUser, resolved.provider);
    }
  } catch (err) {
    console.warn("Google OAuth callback failed", err);
  }
  return res.redirect(nextPath || "/");
}));

app.get("/auth/discord", (req, res, next) => {
  if (!isOauthProviderEnabled("discord")) {
    return res.status(503).send("Discord OAuth chưa được cấu hình.");
  }

  req.session.authNextPath = normalizeNextPath(req.query.next || "/");
  const callbackURL = buildOAuthCallbackUrl(req, "discord");
  if (!callbackURL) {
    return res.status(500).send("Không xác định được callback URL cho Discord OAuth.");
  }

  return passport.authenticate(AUTH_DISCORD_STRATEGY, {
    callbackURL,
    session: false
  })(req, res, next);
});

app.get("/auth/discord/callback", (req, res, next) => {
  if (!isOauthProviderEnabled("discord")) {
    return res.redirect("/");
  }
  const callbackURL = buildOAuthCallbackUrl(req, "discord");
  if (!callbackURL) {
    return res.redirect("/");
  }
  return passport.authenticate(AUTH_DISCORD_STRATEGY, {
    callbackURL,
    session: false,
    failureRedirect: "/?auth=failed"
  })(req, res, next);
}, asyncHandler(async (req, res) => {
  const nextPath = readAuthNextPath(req);
  const profile = req && req.user ? req.user : null;
  if (!profile) {
    return res.redirect(nextPath || "/");
  }
  try {
    const resolved = await resolveOrCreateUserFromOauthProfile(profile);
    if (resolved && resolved.sessionUser) {
      await regenerateSession(req);
      setAuthSessionUser(req, resolved.sessionUser, resolved.provider);
    }
  } catch (err) {
    console.warn("Discord OAuth callback failed", err);
  }
  return res.redirect(nextPath || "/");
}));

app.get("/auth/callback", (req, res) => {
  return res.redirect(normalizeNextPath(req.query.next || "/"));
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

app.get(
  "/publish",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    res.render("publish", {
      title: "Đăng truyện",
      team,
      headScripts: {
        notifications: true
      },
      seo: buildSeoPayload(req, {
        title: "Đăng truyện",
        description: "Tạo hoặc tham gia nhóm dịch để có quyền đăng truyện.",
        robots: SEO_ROBOTS_NOINDEX,
        canonicalPath: "/publish"
      })
    });
  })
);

app.get(
  "/messages",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;
    const currentUserId = String(user.id || "").trim();

    const threadRows = currentUserId
      ? await dbAll(
        `
          SELECT
            t.id,
            t.last_message_at,
            other.id as other_user_id,
            other.username as other_username,
            other.display_name as other_display_name,
            other.avatar_url as other_avatar_url,
            msg.id as last_message_id,
            msg.content as last_message_content,
            msg.created_at as last_message_created_at,
            msg.sender_user_id as last_message_sender_user_id
          FROM chat_thread_members self_member
          JOIN chat_threads t ON t.id = self_member.thread_id
          JOIN chat_thread_members other_member ON other_member.thread_id = t.id AND other_member.user_id <> self_member.user_id
          JOIN users other ON other.id = other_member.user_id
          LEFT JOIN LATERAL (
            SELECT id, content, created_at, sender_user_id
            FROM chat_messages m
            WHERE m.thread_id = t.id
            ORDER BY id DESC
            LIMIT 1
          ) msg ON true
          WHERE self_member.user_id = ?
          ORDER BY COALESCE(msg.created_at, t.last_message_at) DESC, t.id DESC
          LIMIT 40
        `,
        [currentUserId]
      )
      : [];

    const initialThreads = threadRows.map((row) => ({
      id: Number(row.id),
      lastMessageAt: Number(row.last_message_created_at || row.last_message_at) || 0,
      lastMessageId: Number(row.last_message_id) || 0,
      lastMessageContent: (row.last_message_content || "").toString(),
      lastMessageSenderUserId: row.last_message_sender_user_id || "",
      otherUser: {
        id: row.other_user_id,
        username: row.other_username || "",
        displayName: (row.other_display_name || "").toString().trim(),
        avatarUrl: normalizeAvatarUrl(row.other_avatar_url || "")
      }
    }));

    const initialThreadId = initialThreads.length ? Number(initialThreads[0].id) || 0 : 0;
    let initialMessages = [];
    let initialMessagesHasMore = false;
    if (initialThreadId > 0) {
      const rows = await dbAll(
        `
          SELECT id, thread_id, sender_user_id, content, created_at
          FROM chat_messages
          WHERE thread_id = ?
          ORDER BY id DESC
          LIMIT 11
        `,
        [Math.floor(initialThreadId)]
      );
      initialMessagesHasMore = rows.length > 10;
      const pageRows = initialMessagesHasMore ? rows.slice(0, 10) : rows;
      initialMessages = pageRows
        .map((row) => ({
          id: Number(row.id),
          threadId: Number(row.thread_id),
          senderUserId: row.sender_user_id || "",
          content: (row.content || "").toString(),
          createdAt: Number(row.created_at) || 0
        }))
        .reverse();
    }

    res.render("messages", {
      title: "Tin nhắn",
      team,
      chatBootstrap: {
        currentUserId,
        initialThreads,
        initialThreadId,
        initialMessages,
        initialMessagesHasMore
      },
      headScripts: {
        notifications: false,
        messagesIndicator: false
      },
      seo: buildSeoPayload(req, {
        title: "Tin nhắn",
        description: "Nhắn tin với các thành viên trong cộng đồng BFANG Team.",
        robots: SEO_ROBOTS_NOINDEX,
        canonicalPath: "/messages"
      })
    });
  })
);

app.get(
  "/messages/unread-count",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const userId = String(user.id || "").trim();
    if (!userId) {
      return sendPrivateFeatureNotFound(req, res);
    }

    const unreadCount = await getUnreadChatMessageCount(userId);
    return res.json({ ok: true, unreadCount });
  })
);

app.get(
  "/messages/stream",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return sendPrivateFeatureNotFound(req, res);
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    const clientId = addChatStreamClient(userId, res);
    writeChatStreamEvent(res, "ready", { ts: Date.now() });

    const heartbeat = setInterval(() => {
      const ok = writeChatStreamEvent(res, "heartbeat", { ts: Date.now() });
      if (!ok) {
        cleanup();
      }
    }, CHAT_STREAM_HEARTBEAT_MS);
    if (heartbeat && typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      removeChatStreamClient(userId, clientId);
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  })
);

app.get(
  "/account/team-status",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const membership = await getApprovedTeamMembership(userId);
    if (!membership) {
      return res.json({ ok: true, inTeam: false, team: null, roleLabel: "" });
    }

    return res.json({
      ok: true,
      inTeam: true,
      team: {
        id: Number(membership.team_id),
        name: membership.team_name || "",
        slug: membership.team_slug || "",
        role: membership.role || "member"
      },
      roleLabel: buildTeamRoleLabel({ role: membership.role, teamName: membership.team_name })
    });
  })
);

app.get(
  "/teams/search",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const query = (req.query.q || "").toString().trim().slice(0, 60);
    const likeValue = `%${query}%`;
    const rows = await dbAll(
      `
        SELECT id, name, slug, intro
        FROM translation_teams
        WHERE status = 'approved'
          AND (? = '' OR name ILIKE ?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 20
      `,
      [query, likeValue]
    );

    return res.json({
      ok: true,
      teams: rows.map((row) => ({
        id: Number(row.id),
        name: row.name || "",
        slug: row.slug || "",
        intro: (row.intro || "").toString().trim()
      }))
    });
  })
);

app.post(
  "/teams/create",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }
    await ensureUserRowFromAuthUser(user).catch(() => null);

    const existingMembership = await dbGet(
      "SELECT 1 as ok FROM translation_team_members WHERE user_id = ? AND status IN ('pending', 'approved') LIMIT 1",
      [userId]
    );
    if (existingMembership) {
      return res.status(409).json({ ok: false, error: "Bạn đã ở trong một nhóm dịch hoặc đang chờ duyệt." });
    }

    const name = (req.body && req.body.name ? String(req.body.name) : "").replace(/\s+/g, " ").trim();
    const intro = (req.body && req.body.intro ? String(req.body.intro) : "").replace(/\s+/g, " ").trim();
    const facebookUrl = normalizeCommunityUrl(req.body && req.body.facebookUrl ? req.body.facebookUrl : "", 220);
    const discordUrl = normalizeCommunityUrl(req.body && req.body.discordUrl ? req.body.discordUrl : "", 160);

    if (!name) {
      return res.status(400).json({ ok: false, error: "Tên nhóm dịch không được để trống." });
    }
    if (name.length > TEAM_NAME_MAX_LENGTH) {
      return res.status(400).json({ ok: false, error: `Tên nhóm dịch tối đa ${TEAM_NAME_MAX_LENGTH} ký tự.` });
    }
    if (intro.length > TEAM_INTRO_MAX_LENGTH) {
      return res.status(400).json({ ok: false, error: `Giới thiệu tối đa ${TEAM_INTRO_MAX_LENGTH} ký tự.` });
    }

    const slug = await buildUniqueTeamSlug(name);
    const now = Date.now();

    const created = await withTransaction(async ({ dbRun: txRun }) => {
      const teamInsert = await txRun(
        `
          INSERT INTO translation_teams (
            name,
            slug,
            intro,
            facebook_url,
            discord_url,
            status,
            created_by_user_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `,
        [name, slug, intro, facebookUrl, discordUrl, userId, now, now]
      );
      const teamId = teamInsert && teamInsert.lastID ? Number(teamInsert.lastID) : 0;
      if (!teamId) {
        throw new Error("Không thể tạo nhóm dịch.");
      }

      await txRun(
        `
          INSERT INTO translation_team_members (
            team_id,
            user_id,
            role,
            status,
            requested_at,
            reviewed_at,
            reviewed_by_user_id
          )
          VALUES (?, ?, 'leader', 'approved', ?, ?, ?)
        `,
        [teamId, userId, now, now, userId]
      );

      return { teamId };
    });

    return res.json({
      ok: true,
      team: {
        id: Number(created.teamId),
        name,
        slug,
        status: "pending",
        url: `/team/${encodeURIComponent(String(created.teamId))}/${encodeURIComponent(slug)}`
      }
    });
  })
);

app.post(
  "/teams/join-request",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }
    await ensureUserRowFromAuthUser(user).catch(() => null);

    const teamId = Number(req.body && req.body.teamId);
    if (!Number.isFinite(teamId) || teamId <= 0) {
      return res.status(400).json({ ok: false, error: "Nhóm dịch không hợp lệ." });
    }

    const teamRow = await dbGet(
      "SELECT id, name, status FROM translation_teams WHERE id = ? LIMIT 1",
      [Math.floor(teamId)]
    );
    if (!teamRow || String(teamRow.status || "") !== "approved") {
      return res.status(404).json({ ok: false, error: "Không tìm thấy nhóm dịch." });
    }

    const current = await dbGet(
      "SELECT team_id, status FROM translation_team_members WHERE user_id = ? AND status IN ('pending', 'approved') LIMIT 1",
      [userId]
    );
    if (current) {
      return res.status(409).json({ ok: false, error: "Bạn đã có nhóm dịch hoặc đang chờ duyệt." });
    }

    await dbRun(
      `
        INSERT INTO translation_team_members (team_id, user_id, role, status, requested_at)
        VALUES (?, ?, 'member', 'pending', ?)
        ON CONFLICT (team_id, user_id)
        DO UPDATE SET status = 'pending', requested_at = EXCLUDED.requested_at, reviewed_at = NULL, reviewed_by_user_id = NULL
      `,
      [Math.floor(teamId), userId, Date.now()]
    );

    return res.json({ ok: true, message: `Đã gửi yêu cầu tham gia ${teamRow.name || "nhóm dịch"}.` });
  })
);

app.get(
  "/teams/:id/requests",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    const teamId = Number(req.params.id);
    if (!userId || !Number.isFinite(teamId) || teamId <= 0) {
      return res.status(400).json({ ok: false, error: "Yêu cầu không hợp lệ." });
    }

    const leaderRow = await dbGet(
      `
        SELECT tm.team_id
        FROM translation_team_members tm
        JOIN translation_teams t ON t.id = tm.team_id
        WHERE tm.team_id = ?
          AND tm.user_id = ?
          AND tm.role = 'leader'
          AND tm.status = 'approved'
          AND t.status = 'approved'
        LIMIT 1
      `,
      [Math.floor(teamId), userId]
    );
    if (!leaderRow) {
      return res.status(403).json({ ok: false, error: "Bạn không có quyền duyệt yêu cầu của nhóm này." });
    }

    const rows = await dbAll(
      `
        SELECT
          tm.user_id,
          tm.requested_at,
          u.username,
          u.display_name,
          u.avatar_url
        FROM translation_team_members tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
          AND tm.status = 'pending'
        ORDER BY tm.requested_at ASC, tm.user_id ASC
      `,
      [Math.floor(teamId)]
    );

    return res.json({
      ok: true,
      requests: rows.map((row) => ({
        userId: row.user_id,
        username: row.username || "",
        displayName: (row.display_name || "").toString().trim(),
        avatarUrl: normalizeAvatarUrl(row.avatar_url || ""),
        requestedAt: Number(row.requested_at) || 0
      }))
    });
  })
);

app.post(
  "/teams/requests/:teamId/:userId/review",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const reviewerUserId = String(user.id || "").trim();
    const teamId = Number(req.params.teamId);
    const targetUserId = String(req.params.userId || "").trim();
    const action = (req.body && req.body.action ? String(req.body.action) : "").toLowerCase().trim();
    const nextStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "";

    if (!reviewerUserId || !targetUserId || !Number.isFinite(teamId) || teamId <= 0 || !nextStatus) {
      return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ." });
    }

    const leaderRow = await dbGet(
      `
        SELECT tm.team_id, t.name as team_name
        FROM translation_team_members tm
        JOIN translation_teams t ON t.id = tm.team_id
        WHERE tm.team_id = ?
          AND tm.user_id = ?
          AND tm.role = 'leader'
          AND tm.status = 'approved'
          AND t.status = 'approved'
        LIMIT 1
      `,
      [Math.floor(teamId), reviewerUserId]
    );
    if (!leaderRow) {
      return res.status(403).json({ ok: false, error: "Bạn không có quyền duyệt yêu cầu này." });
    }

    const requestRow = await dbGet(
      `
        SELECT team_id, user_id
        FROM translation_team_members
        WHERE team_id = ? AND user_id = ? AND status = 'pending'
        LIMIT 1
      `,
      [Math.floor(teamId), targetUserId]
    );
    if (!requestRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy yêu cầu đang chờ duyệt." });
    }

    await dbRun(
      `
        UPDATE translation_team_members
        SET status = ?, reviewed_at = ?, reviewed_by_user_id = ?
        WHERE team_id = ? AND user_id = ?
      `,
      [nextStatus, Date.now(), reviewerUserId, Math.floor(teamId), targetUserId]
    );

    if (nextStatus === "approved") {
      await dbRun("UPDATE users SET badge = ? WHERE id = ?", [leaderRow.team_name || "Member", targetUserId]);
    }

    return res.json({ ok: true, status: nextStatus });
  })
);

app.get(
  "/messages/users",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const currentUserId = String(user.id || "").trim();
    if (!currentUserId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const query = (req.query.q || "").toString().trim().slice(0, 40);
    const likeValue = `%${query}%`;
    const rows = await dbAll(
      `
        SELECT id, username, display_name, avatar_url
        FROM users
        WHERE id <> ?
          AND username IS NOT NULL
          AND TRIM(username) <> ''
          AND (? = '' OR username ILIKE ? OR COALESCE(display_name, '') ILIKE ?)
        ORDER BY
          CASE WHEN lower(username) = lower(?) THEN 0 ELSE 1 END,
          CASE WHEN lower(username) LIKE lower(?) THEN 0 ELSE 1 END,
          lower(username) ASC
        LIMIT 20
      `,
      [currentUserId, query, likeValue, likeValue, query, `${query}%`]
    );

    return res.json({
      ok: true,
      users: rows.map((row) => ({
        id: row.id,
        username: row.username || "",
        displayName: (row.display_name || "").toString().trim(),
        avatarUrl: normalizeAvatarUrl(row.avatar_url || "")
      }))
    });
  })
);

app.post(
  "/messages/threads",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    const targetUserId = String(req.body && req.body.targetUserId ? req.body.targetUserId : "").trim();
    if (!userId || !targetUserId || userId === targetUserId) {
      return res.status(400).json({ ok: false, error: "Không thể tạo cuộc trò chuyện." });
    }

    const targetRow = await dbGet("SELECT id FROM users WHERE id = ? LIMIT 1", [targetUserId]);
    if (!targetRow) {
      return res.status(404).json({ ok: false, error: "Không tìm thấy thành viên." });
    }

    const now = Date.now();
    const result = await withTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      const existing = await txGet(
        `
          SELECT tm1.thread_id
          FROM chat_thread_members tm1
          JOIN chat_thread_members tm2 ON tm2.thread_id = tm1.thread_id
          WHERE tm1.user_id = ? AND tm2.user_id = ?
          GROUP BY tm1.thread_id
          HAVING COUNT(*) = 2
          LIMIT 1
        `,
        [userId, targetUserId]
      );
      if (existing && existing.thread_id) {
        return Number(existing.thread_id);
      }

      const threadInsert = await txRun(
        "INSERT INTO chat_threads (created_at, updated_at, last_message_at) VALUES (?, ?, ?)",
        [now, now, now]
      );
      const threadId = threadInsert && threadInsert.lastID ? Number(threadInsert.lastID) : 0;
      if (!threadId) throw new Error("Không thể tạo cuộc trò chuyện.");

      await txRun(
        "INSERT INTO chat_thread_members (thread_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, NULL)",
        [threadId, userId, now]
      );
      await txRun(
        "INSERT INTO chat_thread_members (thread_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, NULL)",
        [threadId, targetUserId, now]
      );
      return threadId;
    });

    return res.json({ ok: true, threadId: Number(result) || 0 });
  })
);

app.get(
  "/messages/threads",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    const rows = await dbAll(
      `
        SELECT
          t.id,
          t.last_message_at,
          other.id as other_user_id,
          other.username as other_username,
          other.display_name as other_display_name,
          other.avatar_url as other_avatar_url,
          msg.id as last_message_id,
          msg.content as last_message_content,
          msg.created_at as last_message_created_at,
          msg.sender_user_id as last_message_sender_user_id
        FROM chat_thread_members self_member
        JOIN chat_threads t ON t.id = self_member.thread_id
        JOIN chat_thread_members other_member ON other_member.thread_id = t.id AND other_member.user_id <> self_member.user_id
        JOIN users other ON other.id = other_member.user_id
        LEFT JOIN LATERAL (
          SELECT id, content, created_at, sender_user_id
          FROM chat_messages m
          WHERE m.thread_id = t.id
          ORDER BY id DESC
          LIMIT 1
        ) msg ON true
        WHERE self_member.user_id = ?
        ORDER BY COALESCE(msg.created_at, t.last_message_at) DESC, t.id DESC
        LIMIT 40
      `,
      [userId]
    );

    return res.json({
      ok: true,
      threads: rows.map((row) => ({
        id: Number(row.id),
        lastMessageAt: Number(row.last_message_created_at || row.last_message_at) || 0,
        lastMessageId: Number(row.last_message_id) || 0,
        lastMessageContent: (row.last_message_content || "").toString(),
        lastMessageSenderUserId: row.last_message_sender_user_id || "",
        otherUser: {
          id: row.other_user_id,
          username: row.other_username || "",
          displayName: (row.other_display_name || "").toString().trim(),
          avatarUrl: normalizeAvatarUrl(row.other_avatar_url || "")
        }
      }))
    });
  })
);

app.get(
  "/messages/threads/:id/messages",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    const threadId = Number(req.params.id);
    if (!userId || !Number.isFinite(threadId) || threadId <= 0) {
      return res.status(400).json({ ok: false, error: "Yêu cầu không hợp lệ." });
    }

    const memberRow = await dbGet(
      "SELECT 1 as ok FROM chat_thread_members WHERE thread_id = ? AND user_id = ? LIMIT 1",
      [Math.floor(threadId), userId]
    );
    if (!memberRow) {
      return res.status(403).json({ ok: false, error: "Bạn không có quyền xem đoạn chat này." });
    }

    const beforeIdRaw = Number(req.query.beforeId);
    const beforeId = Number.isFinite(beforeIdRaw) && beforeIdRaw > 0 ? Math.floor(beforeIdRaw) : 0;
    const markReadRaw = (req.query.markRead || "").toString().trim().toLowerCase();
    const shouldMarkRead = beforeId === 0 && (markReadRaw === "1" || markReadRaw === "true");
    const limitRaw = Number(req.query.limit);
    const defaultLimit = beforeId > 0 ? 25 : 10;
    const maxLimit = beforeId > 0 ? 25 : 10;
    const requestedLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : defaultLimit;
    const safeLimit = Math.max(1, Math.min(maxLimit, requestedLimit));

    const rows = await dbAll(
      `
        SELECT id, thread_id, sender_user_id, content, created_at
        FROM chat_messages
        WHERE thread_id = ?
          AND (? = 0 OR id < ?)
        ORDER BY id DESC
        LIMIT ?
      `,
      [Math.floor(threadId), beforeId, beforeId, safeLimit + 1]
    );

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;

    if (shouldMarkRead && pageRows.length) {
      const latestMessageId = Number(pageRows[0].id);
      if (Number.isFinite(latestMessageId) && latestMessageId > 0) {
        await dbRun(
          `
            UPDATE chat_thread_members
            SET last_read_message_id = ?
            WHERE thread_id = ? AND user_id = ?
              AND (last_read_message_id IS NULL OR last_read_message_id < ?)
          `,
          [Math.floor(latestMessageId), Math.floor(threadId), userId, Math.floor(latestMessageId)]
        );
      }
    }

    const messages = pageRows
      .map((row) => ({
        id: Number(row.id),
        threadId: Number(row.thread_id),
        senderUserId: row.sender_user_id || "",
        content: (row.content || "").toString(),
        createdAt: Number(row.created_at) || 0
      }))
      .reverse();

    const nextBeforeId = messages.length ? Number(messages[0].id) || 0 : 0;

    return res.json({
      ok: true,
      messages,
      hasMore,
      nextBeforeId
    });
  })
);

app.post(
  "/messages/threads/:id/messages",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }
    const userId = String(user.id || "").trim();
    const threadId = Number(req.params.id);
    const requestId = (req.body && req.body.requestId ? String(req.body.requestId) : "").trim().slice(0, 80);
    const content = (req.body && req.body.content ? String(req.body.content) : "").replace(/\r\n/g, "\n").trim();

    if (!userId || !Number.isFinite(threadId) || threadId <= 0) {
      return res.status(400).json({ ok: false, error: "Yêu cầu không hợp lệ." });
    }
    if (!content) {
      return res.status(400).json({ ok: false, error: "Tin nhắn không được để trống." });
    }
    if (content.length > CHAT_MESSAGE_MAX_LENGTH) {
      return res.status(400).json({ ok: false, error: `Tin nhắn tối đa ${CHAT_MESSAGE_MAX_LENGTH} ký tự.` });
    }
    if (requestId && !/^[a-z0-9][a-z0-9._:-]{2,79}$/i.test(requestId)) {
      return res.status(400).json({ ok: false, error: "Mã yêu cầu tin nhắn không hợp lệ." });
    }

    const now = Date.now();

    try {
      const messageId = await withTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
        await txRun("SELECT pg_advisory_xact_lock(hashtext(?), 0)", [`chat-post:${userId}`]);

        const memberRow = await txGet(
          "SELECT 1 as ok FROM chat_thread_members WHERE thread_id = ? AND user_id = ? LIMIT 1",
          [Math.floor(threadId), userId]
        );
        if (!memberRow) {
          const err = new Error("FORBIDDEN");
          err.code = "FORBIDDEN";
          throw err;
        }

        const latestSent = await txGet(
          "SELECT created_at FROM chat_messages WHERE sender_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
          [userId]
        );
        const latestSentAt = latestSent && latestSent.created_at != null ? Number(latestSent.created_at) : 0;
        if (Number.isFinite(latestSentAt) && latestSentAt > 0) {
          const retryAfterMs = CHAT_POST_COOLDOWN_MS - (now - latestSentAt);
          if (retryAfterMs > 0) {
            const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
            const err = new Error("CHAT_RATE_LIMITED");
            err.code = "CHAT_RATE_LIMITED";
            err.retryAfter = retryAfter;
            throw err;
          }
        }

        const inserted = await txRun(
          `
            INSERT INTO chat_messages (thread_id, sender_user_id, content, client_request_id, created_at)
            VALUES (?, ?, ?, ?, ?)
          `,
          [Math.floor(threadId), userId, content, requestId || null, now]
        );
        const messageIdValue = inserted && inserted.lastID ? Number(inserted.lastID) : 0;
        if (!messageIdValue) throw new Error("Không thể gửi tin nhắn.");

        await txRun(
          `
            DELETE FROM chat_messages
            WHERE thread_id = ?
              AND id NOT IN (
                SELECT id
                FROM chat_messages
                WHERE thread_id = ?
                ORDER BY id DESC
                LIMIT 200
              )
          `,
          [Math.floor(threadId), Math.floor(threadId)]
        );

        await txRun(
          "UPDATE chat_threads SET updated_at = ?, last_message_at = ? WHERE id = ?",
          [now, now, Math.floor(threadId)]
        );
        await txRun(
          "UPDATE chat_thread_members SET last_read_message_id = ? WHERE thread_id = ? AND user_id = ?",
          [messageIdValue, Math.floor(threadId), userId]
        );

        return messageIdValue;
      });

      const threadMemberRows = await dbAll(
        "SELECT user_id FROM chat_thread_members WHERE thread_id = ?",
        [Math.floor(threadId)]
      );
      const notifyUserIds = threadMemberRows
        .map((row) => (row && row.user_id ? String(row.user_id).trim() : ""))
        .filter(Boolean);
      publishChatStreamUpdate({
        userIds: notifyUserIds,
        payload: {
          threadId: Math.floor(threadId),
          messageId: Number(messageId),
          senderUserId: userId,
          createdAt: now
        }
      });

      return res.json({
        ok: true,
        message: {
          id: Number(messageId),
          threadId: Math.floor(threadId),
          senderUserId: userId,
          content,
          createdAt: now
        }
      });
    } catch (error) {
      if (error && error.code === "FORBIDDEN") {
        return res.status(403).json({ ok: false, error: "Bạn không có quyền gửi tin nhắn trong đoạn chat này." });
      }
      if (error && error.code === "CHAT_RATE_LIMITED") {
        const retryAfter = Number(error.retryAfter) || 1;
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
          ok: false,
          error: `Bạn gửi tin nhắn quá nhanh. Vui lòng chờ ${retryAfter} giây.`,
          retryAfter
        });
      }
      if (error && error.code === "23505") {
        const duplicated = await dbGet(
          `
            SELECT id, thread_id, sender_user_id, content, created_at
            FROM chat_messages
            WHERE sender_user_id = ? AND client_request_id = ?
            LIMIT 1
          `,
          [userId, requestId || ""]
        );
        if (duplicated && Number(duplicated.id) > 0) {
          return res.json({
            ok: true,
            message: {
              id: Number(duplicated.id),
              threadId: Number(duplicated.thread_id),
              senderUserId: duplicated.sender_user_id || "",
              content: (duplicated.content || "").toString(),
              createdAt: Number(duplicated.created_at) || now
            }
          });
        }
      }
      throw error;
    }
  })
);

app.get(
  "/team/:id/:slug",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    const teamId = Number(req.params.id);
    const requestedSlug = (req.params.slug || "").toString().trim();
    if (!Number.isFinite(teamId) || teamId <= 0) {
      return res.status(404).render("not-found", { title: "Không tìm thấy", team });
    }

    const teamRow = await dbGet(
      `
        SELECT id, name, slug, intro, facebook_url, discord_url, status, created_at
        FROM translation_teams
        WHERE id = ?
        LIMIT 1
      `,
      [Math.floor(teamId)]
    );
    if (!teamRow) {
      return res.status(404).render("not-found", { title: "Không tìm thấy", team });
    }
    const canonicalSlug = (teamRow.slug || "").toString().trim();
    if (requestedSlug !== canonicalSlug) {
      return res.redirect(301, `/team/${encodeURIComponent(String(teamRow.id))}/${encodeURIComponent(canonicalSlug)}`);
    }

    const memberRows = await dbAll(
      `
        SELECT
          tm.user_id,
          tm.role,
          u.username,
          u.display_name,
          u.avatar_url
        FROM translation_team_members tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ?
          AND tm.status = 'approved'
        ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END ASC, lower(u.username) ASC
      `,
      [teamRow.id]
    );

    return res.render("team", {
      title: teamRow.name || "Nhóm dịch",
      team,
      teamProfile: {
        id: Number(teamRow.id),
        name: teamRow.name || "",
        slug: canonicalSlug,
        intro: (teamRow.intro || "").toString().trim(),
        facebookUrl: normalizeCommunityUrl(teamRow.facebook_url || ""),
        discordUrl: normalizeCommunityUrl(teamRow.discord_url || ""),
        status: teamRow.status || "pending",
        createdAt: Number(teamRow.created_at) || 0,
        members: memberRows.map((row) => ({
          userId: row.user_id,
          username: row.username || "",
          displayName: (row.display_name || "").toString().trim(),
          avatarUrl: normalizeAvatarUrl(row.avatar_url || ""),
          role: row.role || "member"
        }))
      },
      seo: buildSeoPayload(req, {
        title: `${teamRow.name || "Nhóm dịch"}`,
        description: (teamRow.intro || "").toString().trim() || `Trang nhóm dịch ${teamRow.name || ""}`,
        canonicalPath: `/team/${encodeURIComponent(String(teamRow.id))}/${encodeURIComponent(canonicalSlug)}`,
        robots: SEO_ROBOTS_NOINDEX,
        ogType: "profile"
      })
    });
  })
);

app.get(
  "/user/:username",
  asyncHandler(async (req, res) => {
    const user = await requirePrivateFeatureAuthUser(req, res);
    if (!user) return;

    const username = (req.params.username || "").toString().trim().toLowerCase();
    if (!/^[a-z0-9_]{1,24}$/.test(username)) {
      return res.status(404).render("not-found", { title: "Không tìm thấy", team });
    }

    const profileRow = await dbGet(
      `
        SELECT id, username, display_name, avatar_url, bio, facebook_url, discord_handle, created_at
        FROM users
        WHERE lower(username) = lower(?)
        LIMIT 1
      `,
      [username]
    );
    if (!profileRow) {
      return res.status(404).render("not-found", { title: "Không tìm thấy", team });
    }

    const teamRow = await getApprovedTeamMembership(profileRow.id);
    return res.render("user-profile", {
      title: `@${profileRow.username || username}`,
      team,
      profile: {
        id: profileRow.id,
        username: profileRow.username || username,
        displayName: (profileRow.display_name || "").toString().trim(),
        avatarUrl: normalizeAvatarUrl(profileRow.avatar_url || ""),
        bio: normalizeProfileBio(profileRow.bio || ""),
        facebookUrl: normalizeCommunityUrl(profileRow.facebook_url || ""),
        discordUrl: normalizeCommunityUrl(profileRow.discord_handle || ""),
        joinedAt: Number(profileRow.created_at) || 0,
        team: teamRow
          ? {
            id: Number(teamRow.team_id),
            name: teamRow.team_name || "",
            slug: teamRow.team_slug || "",
            role: teamRow.role || "member",
            roleLabel: buildTeamRoleLabel({ role: teamRow.role, teamName: teamRow.team_name })
          }
          : null
      },
      seo: buildSeoPayload(req, {
        title: `@${profileRow.username || username}`,
        description: normalizeSeoText(profileRow.bio || `Trang thành viên ${profileRow.username || username}`, 180),
        canonicalPath: `/user/${encodeURIComponent(profileRow.username || username)}`,
        robots: SEO_ROBOTS_NOINDEX,
        ogType: "profile"
      })
    });
  })
);

app.get("/privacy-policy", (req, res) => {
  res.render("privacy-policy", {
    title: "Privacy Policy",
    team,
    seo: buildSeoPayload(req, {
      title: "Privacy Policy",
      description: "Privacy Policy for BFANG Team web services and OAuth login.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: "/privacy-policy"
    })
  });
});

app.get("/terms-of-service", (req, res) => {
  res.render("terms-of-service", {
    title: "Terms of Service",
    team,
    seo: buildSeoPayload(req, {
      title: "Terms of Service",
      description: "Terms of Service for using BFANG Team website and related features.",
      robots: SEO_ROBOTS_NOINDEX,
      canonicalPath: "/terms-of-service"
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
      "Disallow: /auth/",
      "Disallow: /publish",
      "Disallow: /messages",
      "Disallow: /team/",
      "Disallow: /user/",
      "Disallow: /privacy-policy",
      "Disallow: /terms-of-service",
      "",
      `Sitemap: ${sitemapUrl}`
    ].join("\n")
  );
});

app.get(
  "/sitemap.xml",
  asyncHandler(async (req, res) => {
    const origin = getPublicOriginFromRequest(req) || "";
    const cacheKey = origin || "__default__";
    const now = Date.now();
    const cached = sitemapCacheByOrigin.get(cacheKey);

    res.type("application/xml");
    res.set("Cache-Control", "public, max-age=600, stale-while-revalidate=3600");

    if (cached && cached.expiresAt > now) {
      const requestEtag = (req.get("if-none-match") || "").toString();
      if (requestEtag && requestEtag.includes(cached.etag)) {
        res.set("ETag", cached.etag);
        return res.status(304).end();
      }
      res.set("ETag", cached.etag);
      return res.send(cached.xmlBody);
    }

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

    const etag = `"${crypto.createHash("sha1").update(xmlBody).digest("hex")}"`;
    sitemapCacheByOrigin.set(cacheKey, {
      etag,
      xmlBody,
      expiresAt: now + sitemapCacheTtlMs
    });

    res.set("ETag", etag);
    return res.send(xmlBody);
  })
);

app.get(
  "/account/me",
  asyncHandler(async (req, res) => {
    if (!wantsJson(req)) {
      return res.status(406).send("Yêu cầu JSON.");
    }

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;

    const profileRow = await upsertUserProfileFromAuthUser(user);
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromAuthUser(user);
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromAuthUser(user);
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

    const user = await requireAuthUserForComments(req, res);
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
      await ensureUserRowFromAuthUser(user);
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromAuthUser(user);
    const authorEmail = user.email ? String(user.email).trim() : "";
    let authorAvatarUrl = buildAvatarUrlFromAuthUser(
      user,
      user && user.bfangAvatarUrl ? user.bfangAvatarUrl : ""
    );
    const authorUserId = String(user.id || "").trim();
    if (!authorUserId) {
      return res.status(400).json({ ok: false, error: "Không xác định được người dùng." });
    }

    let profileRow = null;
    try {
      profileRow = await upsertUserProfileFromAuthUser(user);
      if (profileRow && profileRow.avatar_url) {
        authorAvatarUrl = normalizeAvatarUrl(profileRow.avatar_url);
      }
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
    const countRow = await dbGet(`SELECT COUNT(*) as count FROM manga m ${whereClause}`, params);
    const pagination = resolvePaginationParams({
      pageInput: req.query.page,
      perPageInput: req.query.perPage,
      defaultPerPage: 24,
      maxPerPage: 60,
      totalCount: countRow && countRow.count ? Number(countRow.count) : 0
    });

    const query = `${listQueryBase} ${whereClause} ${listQueryOrder} LIMIT ? OFFSET ?`;
    const mangaRows = await dbAll(query, [...params, pagination.perPage, pagination.offset]);
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
    const shouldNoIndex = hasFilters || pagination.page > 1;

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
      resultCount: pagination.total,
      pagination,
      seo: buildSeoPayload(req, {
        title: seoTitle,
        description: seoDescription,
        canonicalPath: "/manga",
        robots: shouldNoIndex ? SEO_ROBOTS_NOINDEX : SEO_ROBOTS_INDEX,
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
          const prefetchCount = Math.min(3, nextPageCount);
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromAuthUser(user);
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromAuthUser(user);
    const authorUserId = String(user.id || "").trim();
    const authorEmail = user.email ? String(user.email).trim() : "";
    let authorAvatarUrl = buildAvatarUrlFromAuthUser(
      user,
      user && user.bfangAvatarUrl ? user.bfangAvatarUrl : ""
    );

    let badgeContext = {
      badges: [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
    try {
      const ensuredUserRow = await ensureUserRowFromAuthUser(user);
      authorAvatarUrl = buildAvatarUrlFromAuthUser(
        user,
        ensuredUserRow && ensuredUserRow.avatar_url ? ensuredUserRow.avatar_url : authorAvatarUrl
      );
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;

    const author = buildCommentAuthorFromAuthUser(user);
    const authorUserId = String(user.id || "").trim();
    const authorEmail = user.email ? String(user.email).trim() : "";
    let authorAvatarUrl = buildAvatarUrlFromAuthUser(
      user,
      user && user.bfangAvatarUrl ? user.bfangAvatarUrl : ""
    );

    let badgeContext = {
      badges: [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
    try {
      const ensuredUserRow = await ensureUserRowFromAuthUser(user);
      authorAvatarUrl = buildAvatarUrlFromAuthUser(
        user,
        ensuredUserRow && ensuredUserRow.avatar_url ? ensuredUserRow.avatar_url : authorAvatarUrl
      );
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
};

module.exports = registerSiteRoutes;
