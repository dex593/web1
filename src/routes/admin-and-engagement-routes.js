const registerAdminAndEngagementRoutes = (app, deps) => {
  const {
    ADMIN_MEMBERS_PER_PAGE,
    NOTIFICATION_STREAM_HEARTBEAT_MS,
    addNotificationStreamClient,
    adminConfig,
    adminJobs,
    adminLoginRateLimiter,
    adminSsoRateLimiter,
    asyncHandler,
    b2DeleteAllByPrefix,
    b2DeleteChapterExtraPages,
    b2DeleteFileVersions,
    b2ListFileVersionsByPrefix,
    b2UploadBuffer,
    buildAutoBadgeCode,
    buildChapterExistingPageId,
    buildChapterTimestampIso,
    buildMangaSlug,
    cacheBust,
    chapterDraftTtlMs,
    convertChapterPageToWebp,
    convertCoverToWebp,
    coversDir,
    coversUrlPrefix,
    createAdminJob,
    createChapterDraft,
    createCoverTempToken,
    dbAll,
    dbGet,
    dbRun,
    deleteChapterAndCleanupStorage,
    deleteCommentCascade,
    deleteCoverTemp,
    deleteFileIfExists,
    deleteMangaAndCleanupStorage,
    enqueueChapterProcessing,
    ensureHomepageDefaults,
    ensureMemberBadgeForUser,
    ensureUserRowFromAuthUser,
    extractLocalCoverFilename,
    findGenreRowByNormalizedName,
    formatDate,
    formatDateTime,
    getB2Config,
    getChapterDraft,
    getDefaultFeaturedIds,
    getForbiddenWords,
    getGenreStats,
    getGenresStringByIds,
    getMemberBadgeId,
    getOneshotGenreId,
    getPublicOriginFromRequest,
    getUnreadNotificationCount,
    getUserBadgeContext,
    getVisibleCommentCount,
    invalidateForbiddenWordsCache,
    isAdminConfigured,
    isB2Ready,
    isChapterDraftPageIdValid,
    isChapterDraftTokenValid,
    isPasswordAdminEnabled,
    isTruthyInput,
    listQuery,
    listQueryBase,
    listQueryOrder,
    loadCoverTempBuffer,
    localDevOrigin,
    mapBadgeRow,
    mapMangaListRow,
    mapNotificationRow,
    markMangaUpdatedAtForNewChapter,
    normalizeAdminJobError,
    normalizeAvatarUrl,
    normalizeBadgeCode,
    normalizeForbiddenWordList,
    normalizeGenreName,
    normalizeHexColor,
    normalizeHomepageRow,
    normalizeIdList,
    normalizeProfileBio,
    normalizeProfileDiscord,
    normalizeProfileDisplayName,
    normalizeProfileFacebook,
    parseChapterNumberInput,
    path,
    publishNotificationStreamUpdate,
    regenerateSession,
    removeNotificationStreamClient,
    requireAdmin,
    requireAuthUserForComments,
    resolveCommentPermalinkForNotification,
    resolvePaginationParams,
    safeCompareText,
    saveCoverBuffer,
    saveCoverTempBuffer,
    serverSessionVersion,
    setMangaGenresByIds,
    team,
    toBooleanFlag,
    touchChapterDraft,
    updateChapterProcessing,
    uploadChapterPage,
    uploadChapterPages,
    uploadCover,
    wantsJson,
    withTransaction,
    writeNotificationStreamEvent,
  } = deps;

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
        error: "Đăng nhập mật khẩu đã bị tắt. Hãy dùng đăng nhập Google/Discord với huy hiệu Admin.",
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
      req.session.sessionVersion = serverSessionVersion;
      delete req.session.adminUserId;
      delete req.session.adminAuthUserId;
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

    const user = await requireAuthUserForComments(req, res);
    if (!user) return;
    const userId = String(user.id || "").trim();
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Phiên đăng nhập không hợp lệ." });
    }

    try {
      await ensureUserRowFromAuthUser(user);
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
    req.session.sessionVersion = serverSessionVersion;
    req.session.adminUserId = userId;
    req.session.adminAuthUserId = userId;
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
  const adminAuthUserId =
    (req.session && req.session.adminAuthUserId ? req.session.adminAuthUserId : "")
      .toString()
      .trim();

  req.session.destroy(() => {
    if (adminAuthMode === "badge" && adminUserId) {
      const params = new URLSearchParams();
      params.set("logout_scope", "web");
      params.set("logout_user", adminAuthUserId || adminUserId);
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
    const memberCountRow = await dbGet("SELECT COUNT(*) as count FROM users");
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
        totalComments: commentCountRow ? commentCountRow.count : 0,
        totalMembers: memberCountRow ? memberCountRow.count : 0
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
    const countRow = await dbGet(`SELECT COUNT(*) as count FROM manga m ${whereClause}`, params);
    const isJsonRequest = wantsJson(req);
    const pagination = resolvePaginationParams({
      pageInput: req.query.page,
      perPageInput: req.query.perPage,
      defaultPerPage: isJsonRequest ? 1000 : 30,
      maxPerPage: isJsonRequest ? 2000 : 100,
      totalCount: countRow && countRow.count ? Number(countRow.count) : 0
    });

    const query = `${listQueryBase} ${whereClause} ${listQueryOrder} LIMIT ? OFFSET ?`;
    const mangaRows = await dbAll(query, [...params, pagination.perPage, pagination.offset]);

    if (isJsonRequest) {
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
        resultCount: pagination.total,
        returnedCount: mangaRows.length,
        pagination,
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
      resultCount: pagination.total,
      pagination
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
    const now = new Date().toISOString();
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

    await markMangaUpdatedAtForNewChapter(mangaRow.id, date);
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

    await markMangaUpdatedAtForNewChapter(mangaRow.id, date);
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

    if (added > 0) {
      invalidateForbiddenWordsCache();
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
      invalidateForbiddenWordsCache();
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

app.get(
  "/admin/teams",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const reviewInput = typeof req.query.review === "string" ? req.query.review.trim().toLowerCase() : "all";
    const review = ["all", "pending", "approved", "rejected"].includes(reviewInput) ? reviewInput : "all";
    const whereParts = [];
    const whereParams = [];

    if (review !== "all") {
      whereParts.push("t.status = ?");
      whereParams.push(review);
    }

    if (q) {
      const likeValue = `%${q}%`;
      whereParts.push(
        "(t.name ILIKE ? OR t.slug ILIKE ? OR COALESCE(creator.username, '') ILIKE ? OR COALESCE(creator.display_name, '') ILIKE ?)"
      );
      whereParams.push(likeValue, likeValue, likeValue, likeValue);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const pendingCountRow = await dbGet(
      "SELECT COUNT(*) as count FROM translation_teams WHERE status = 'pending'"
    );
    const teams = await dbAll(
      `
        SELECT
          t.id,
          t.name,
          t.slug,
          t.intro,
          t.facebook_url,
          t.discord_url,
          t.status,
          t.reject_reason,
          t.created_at,
          t.updated_at,
          creator.username as creator_username,
          creator.display_name as creator_display_name
        FROM translation_teams t
        LEFT JOIN users creator ON creator.id = t.created_by_user_id
        ${whereClause}
        ORDER BY
          CASE t.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
          t.created_at DESC,
          t.id DESC
      `,
      whereParams
    );

    return res.render("admin/teams", {
      title: "Nhóm dịch",
      status,
      q,
      review,
      pendingCount: pendingCountRow ? Number(pendingCountRow.count) || 0 : 0,
      teams: teams.map((row) => ({
        id: Number(row.id),
        name: row.name || "",
        slug: row.slug || "",
        intro: (row.intro || "").toString().trim(),
        facebookUrl: (row.facebook_url || "").toString().trim(),
        discordUrl: (row.discord_url || "").toString().trim(),
        status: (row.status || "pending").toString().trim(),
        rejectReason: (row.reject_reason || "").toString().trim(),
        createdAt: Number(row.created_at) || 0,
        updatedAt: Number(row.updated_at) || 0,
        creatorUsername: (row.creator_username || "").toString().trim(),
        creatorDisplayName: (row.creator_display_name || "").toString().trim()
      }))
    });
  })
);

app.post(
  "/admin/teams/:id/review",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const teamId = Number(req.params.id);
    if (!Number.isFinite(teamId) || teamId <= 0) {
      return res.redirect("/admin/teams?status=invalid");
    }

    const action = (req.body && req.body.action ? String(req.body.action) : "").toLowerCase().trim();
    const nextStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "";
    if (!nextStatus) {
      return res.redirect("/admin/teams?status=invalid");
    }

    const rejectReasonRaw = req.body && req.body.reject_reason ? String(req.body.reject_reason) : "";
    const rejectReason = rejectReasonRaw.replace(/\s+/g, " ").trim().slice(0, 300);
    const teamRow = await dbGet(
      "SELECT id, name, slug, status, created_by_user_id FROM translation_teams WHERE id = ? LIMIT 1",
      [Math.floor(teamId)]
    );
    if (!teamRow) {
      return res.redirect("/admin/teams?status=notfound");
    }

    const actorUserId =
      (req.session && req.session.adminUserId ? String(req.session.adminUserId) : "").trim() || null;
    const now = Date.now();

    await withTransaction(async ({ dbGet: txGet, dbRun: txRun }) => {
      await txRun(
        `
          UPDATE translation_teams
          SET
            status = ?,
            approved_by_user_id = ?,
            approved_at = ?,
            reject_reason = ?,
            updated_at = ?
          WHERE id = ?
        `,
        [nextStatus, actorUserId, nextStatus === "approved" ? now : null, nextStatus === "rejected" ? rejectReason : "", now, Math.floor(teamId)]
      );

      const memberRows = await txRun(
        `
          UPDATE translation_team_members
          SET
            status = CASE WHEN role = 'leader' AND ? = 'approved' THEN 'approved' ELSE status END,
            reviewed_at = CASE WHEN role = 'leader' THEN ? ELSE reviewed_at END,
            reviewed_by_user_id = CASE WHEN role = 'leader' THEN ? ELSE reviewed_by_user_id END
          WHERE team_id = ?
          RETURNING user_id, role, status
        `,
        [nextStatus, now, actorUserId, Math.floor(teamId)]
      );

      const members = Array.isArray(memberRows && memberRows.rows) ? memberRows.rows : [];
      for (const member of members) {
        const memberUserId = member && member.user_id ? String(member.user_id).trim() : "";
        if (!memberUserId) continue;
        if (nextStatus === "approved") {
          const role = (member.role || "member").toString().trim().toLowerCase();
          const roleLabel = role === "leader" ? `Leader ${teamRow.name || "Nhóm dịch"}` : teamRow.name || "Member";
          await txRun("UPDATE users SET badge = ?, updated_at = ? WHERE id = ?", [roleLabel, now, memberUserId]);
        }
      }

      const ownerUserId = teamRow && teamRow.created_by_user_id ? String(teamRow.created_by_user_id).trim() : "";
      if (!ownerUserId) return;

      const existingThread = await txGet(
        `
          SELECT tm1.thread_id
          FROM chat_thread_members tm1
          JOIN chat_thread_members tm2 ON tm2.thread_id = tm1.thread_id
          WHERE tm1.user_id = ? AND tm2.user_id = ?
          GROUP BY tm1.thread_id
          HAVING COUNT(*) = 2
          LIMIT 1
        `,
        [actorUserId || ownerUserId, ownerUserId]
      );

      let threadId = existingThread && existingThread.thread_id ? Number(existingThread.thread_id) : 0;
      if (!threadId) {
        const threadInsert = await txRun(
          "INSERT INTO chat_threads (created_at, updated_at, last_message_at) VALUES (?, ?, ?)",
          [now, now, now]
        );
        threadId = threadInsert && threadInsert.lastID ? Number(threadInsert.lastID) : 0;
        if (threadId) {
          await txRun(
            "INSERT INTO chat_thread_members (thread_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, NULL) ON CONFLICT DO NOTHING",
            [threadId, ownerUserId, now]
          );
          await txRun(
            "INSERT INTO chat_thread_members (thread_id, user_id, joined_at, last_read_message_id) VALUES (?, ?, ?, NULL) ON CONFLICT DO NOTHING",
            [threadId, actorUserId || ownerUserId, now]
          );
        }
      }

      if (threadId) {
        const message =
          nextStatus === "approved"
            ? `Nhóm dịch "${teamRow.name || ""}" đã được admin duyệt.`
            : `Nhóm dịch "${teamRow.name || ""}" đã bị từ chối.${rejectReason ? ` Lý do: ${rejectReason}` : ""}`;
        const insertedMessage = await txRun(
          "INSERT INTO chat_messages (thread_id, sender_user_id, content, client_request_id, created_at) VALUES (?, ?, ?, ?, ?)",
          [threadId, actorUserId || ownerUserId, message, `team-review:${teamId}:${nextStatus}:${now}`, now]
        );
        const messageId = insertedMessage && insertedMessage.lastID ? Number(insertedMessage.lastID) : 0;
        await txRun("UPDATE chat_threads SET updated_at = ?, last_message_at = ? WHERE id = ?", [now, now, threadId]);
        if (messageId > 0) {
          await txRun(
            "UPDATE chat_thread_members SET last_read_message_id = ? WHERE thread_id = ? AND user_id = ?",
            [messageId, threadId, actorUserId || ownerUserId]
          );
        }
      }
    });

    return res.redirect(`/admin/teams?status=${nextStatus}`);
  })
);
};

module.exports = registerAdminAndEngagementRoutes;
