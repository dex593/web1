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
