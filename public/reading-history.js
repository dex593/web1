(() => {
  const HISTORY_ENDPOINT = "/account/reading-history";
  const CHAPTER_READ_ENDPOINT = "/account/manga-read-map";
  const CHAPTER_READ_STORAGE_KEY_PREFIX = "bfang:manga-read-map:v2:";
  const CHAPTER_READ_PRECHECK_TTL_MS = 2 * 60 * 1000;

  const resolveSiteName = () => {
    const config = window.__SITE_CONFIG && typeof window.__SITE_CONFIG === "object" ? window.__SITE_CONFIG : null;
    const branding = config && config.branding && typeof config.branding === "object" ? config.branding : null;
    const name = branding && branding.siteName ? String(branding.siteName).trim() : "";
    return name || "BFANG Team";
  };

  const FALLBACK_AUTHOR_NAME = resolveSiteName();

  let detailStartButtonEl = null;
  let readingProgressEl = null;
  let historyPage = null;
  let historyLockedEl = null;
  let historyContentEl = null;
  let historyStatusEl = null;
  let historyEmptyEl = null;
  let historyListEl = null;

  const captureReadingHistoryNodes = () => {
    detailStartButtonEl = document.querySelector("[data-reading-detail-start]");
    readingProgressEl = document.querySelector("[data-reading-progress]");
    historyPage = document.querySelector("[data-reading-history-page]");
    historyLockedEl = historyPage ? historyPage.querySelector("[data-reading-history-locked]") : null;
    historyContentEl = historyPage ? historyPage.querySelector("[data-reading-history-content]") : null;
    historyStatusEl = historyPage ? historyPage.querySelector("[data-reading-history-status]") : null;
    historyEmptyEl = historyPage ? historyPage.querySelector("[data-reading-history-empty]") : null;
    historyListEl = historyPage ? historyPage.querySelector("[data-reading-history-list]") : null;
  };

  captureReadingHistoryNodes();

  let historyCache = [];
  let historyMapCache = new Map();
  let historyLoadingPromise = null;
  let progressSaved = false;
  let chapterReadSynced = false;

  const toPositiveInteger = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  };

  const normalizeChapterIdArray = (value) => {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const normalized = [];

    source.forEach((item) => {
      const chapterId = toPositiveInteger(item);
      if (!chapterId) return;
      if (seen.has(chapterId)) return;
      seen.add(chapterId);
      normalized.push(chapterId);
    });

    normalized.sort((left, right) => left - right);
    return normalized;
  };

  const normalizeReadScopeToken = (value) => {
    const normalized = (value == null ? "" : String(value))
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized || "";
  };

  const resolveReadScopeFromSession = (session) => {
    const userId =
      session && session.user && session.user.id != null
        ? String(session.user.id).trim()
        : "";
    const normalizedUserId = normalizeReadScopeToken(userId);
    if (!normalizedUserId) return "guest";
    return `user-${normalizedUserId}`;
  };

  const buildChapterReadStorageKey = ({ mangaSlug, scope = "guest" }) => {
    const slug = (mangaSlug || "").toString().trim().toLowerCase();
    if (!slug) return "";
    const normalizedScope = normalizeReadScopeToken(scope) || "guest";
    return `${CHAPTER_READ_STORAGE_KEY_PREFIX}${normalizedScope}:${slug}`;
  };

  const readChapterReadMapLocal = ({ mangaSlug, scope = "guest" }) => {
    const storageKey = buildChapterReadStorageKey({ mangaSlug, scope });
    if (!storageKey) {
      return {
        chapterIds: [],
        pendingSyncChapterIds: [],
        fetchedAt: 0,
        updatedAt: 0
      };
    }

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return {
          chapterIds: [],
          pendingSyncChapterIds: [],
          fetchedAt: 0,
          updatedAt: 0
        };
      }

      const parsed = JSON.parse(raw);
      const chapterIds = normalizeChapterIdArray(parsed && parsed.chapterIds);
      const chapterIdSet = new Set(chapterIds);
      const pendingSyncChapterIds = normalizeChapterIdArray(
        parsed && parsed.pendingSyncChapterIds
      ).filter((chapterId) => chapterIdSet.has(chapterId));
      return {
        chapterIds,
        pendingSyncChapterIds,
        fetchedAt: Number(parsed && parsed.fetchedAt) || 0,
        updatedAt: Number(parsed && parsed.updatedAt) || 0
      };
    } catch (_error) {
      return {
        chapterIds: [],
        pendingSyncChapterIds: [],
        fetchedAt: 0,
        updatedAt: 0
      };
    }
  };

  const writeChapterReadMapLocal = ({ mangaSlug, scope = "guest", payload }) => {
    const storageKey = buildChapterReadStorageKey({ mangaSlug, scope });
    if (!storageKey) return;

    const safePayload = payload && typeof payload === "object" ? payload : {};
    const chapterIds = normalizeChapterIdArray(safePayload.chapterIds);
    const chapterIdSet = new Set(chapterIds);
    const pendingSyncChapterIds = normalizeChapterIdArray(
      safePayload.pendingSyncChapterIds
    ).filter((chapterId) => chapterIdSet.has(chapterId));
    const fetchedAtRaw = Number(safePayload.fetchedAt);
    const updatedAtRaw = Number(safePayload.updatedAt);
    const now = Date.now();

    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          chapterIds,
          pendingSyncChapterIds,
          fetchedAt: Number.isFinite(fetchedAtRaw) && fetchedAtRaw > 0 ? Math.floor(fetchedAtRaw) : now,
          updatedAt: Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? Math.floor(updatedAtRaw) : now
        })
      );
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const markCurrentChapterReadLocal = ({ readScope = "guest" } = {}) => {
    if (!readingProgressEl) {
      return {
        mangaSlug: "",
        chapterId: 0,
        chapterIds: [],
        pendingSyncChapterIds: [],
        fetchedAt: 0,
        needsSync: false,
        changed: false
      };
    }

    const mangaSlug = (readingProgressEl.dataset.readingMangaSlug || "").toString().trim();
    const chapterId = toPositiveInteger(readingProgressEl.dataset.readingChapterId);
    if (!mangaSlug || !chapterId) {
      return {
        mangaSlug,
        chapterId,
        chapterIds: [],
        pendingSyncChapterIds: [],
        fetchedAt: 0,
        needsSync: false,
        changed: false
      };
    }

    const localState = readChapterReadMapLocal({ mangaSlug, scope: readScope });
    const pendingSyncSet = new Set(localState.pendingSyncChapterIds || []);
    if (localState.chapterIds.includes(chapterId)) {
      return {
        mangaSlug,
        chapterId,
        chapterIds: localState.chapterIds,
        pendingSyncChapterIds: Array.from(pendingSyncSet).sort((left, right) => left - right),
        fetchedAt: localState.fetchedAt,
        needsSync: pendingSyncSet.has(chapterId),
        changed: false
      };
    }

    const merged = normalizeChapterIdArray([...localState.chapterIds, chapterId]);
    pendingSyncSet.add(chapterId);
    const pendingSyncChapterIds = Array.from(pendingSyncSet).sort((left, right) => left - right);
    writeChapterReadMapLocal({
      mangaSlug,
      scope: readScope,
      payload: {
        chapterIds: merged,
        pendingSyncChapterIds,
        updatedAt: Date.now(),
        fetchedAt: Date.now()
      }
    });

    return {
      mangaSlug,
      chapterId,
      chapterIds: merged,
      pendingSyncChapterIds,
      fetchedAt: localState.fetchedAt,
      needsSync: true,
      changed: true
    };
  };

  const escapeHtml = (value) =>
    (value == null ? "" : String(value))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const escapeAttr = (value) => escapeHtml(value).replace(/`/g, "&#96;");

  const toSafePath = (value) => {
    const text = (value || "").toString().trim();
    if (!text || !text.startsWith("/")) return "";
    return text;
  };

  const toSafeImageUrl = (value) => {
    const text = (value || "").toString().trim();
    if (!text) return "";
    if (text.startsWith("/")) return text;
    if (/^https?:\/\//i.test(text)) return text;
    return "";
  };

  const cacheBust = (url, token) => {
    const safeUrl = toSafeImageUrl(url);
    if (!safeUrl) return "";
    const separator = safeUrl.includes("?") ? "&" : "?";
    const value = token == null || token === "" ? Date.now() : token;
    return `${safeUrl}${separator}t=${encodeURIComponent(String(value))}`;
  };

  const buildCoverVariantUrl = (url, suffix) => {
    const safeUrl = toSafeImageUrl(url);
    if (!safeUrl) return "";
    const hashIndex = safeUrl.indexOf("#");
    const hashPart = hashIndex >= 0 ? safeUrl.slice(hashIndex) : "";
    const withoutHash = hashIndex >= 0 ? safeUrl.slice(0, hashIndex) : safeUrl;
    const queryIndex = withoutHash.indexOf("?");
    const queryPart = queryIndex >= 0 ? withoutHash.slice(queryIndex) : "";
    const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
    const match = basePath.match(/^(.*)\.webp$/i);
    if (!match || !match[1]) return safeUrl;
    return `${match[1]}${suffix || ""}.webp${queryPart}${hashPart}`;
  };

  const buildCoverSources = (url) => {
    const safeUrl = toSafeImageUrl(url);
    if (!safeUrl) {
      return { src: "", srcset: "", sizes: "" };
    }
    return {
      src: buildCoverVariantUrl(safeUrl, "-md"),
      srcset: `${buildCoverVariantUrl(safeUrl, "-sm")} 132w, ${buildCoverVariantUrl(safeUrl, "-md")} 262w, ${buildCoverVariantUrl(safeUrl, "")} 358w`,
      sizes: "(max-width: 760px) 47vw, 174px"
    };
  };

  const formatChapterNumber = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const normalized = Math.abs(number) < 1e-9 ? 0 : number;
    if (Math.abs(normalized - Math.round(normalized)) < 1e-9) {
      return String(Math.round(normalized));
    }
    return normalized.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  };

  const truncateCardTitle = (value) => {
    const text = (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
    if (!text) return "";

    const maxWords = 4;
    const maxChars = 24;
    const words = text.split(" ").filter(Boolean);
    let shortened = words.length > maxWords ? words.slice(0, maxWords).join(" ") : text;
    if (shortened.length > maxChars) {
      shortened = shortened.slice(0, maxChars).trimEnd();
    }

    return shortened.length < text.length ? `${shortened}...` : shortened;
  };

  const getSessionSafe = async () => {
    if (window.BfangAuth && typeof window.BfangAuth.getSession === "function") {
      try {
        const session = await window.BfangAuth.getSession();
        return session && ((session.user && typeof session.user === "object") || session.access_token) ? session : null;
      } catch (_err) {
        return null;
      }
    }
    return null;
  };

  const getAccessTokenSafe = async () => {
    const session = await getSessionSafe();
    if (session && session.access_token) {
      return String(session.access_token).trim();
    }
    return "";
  };

  const resetDetailStartButtonUi = () => {
    if (!detailStartButtonEl) return;
    const fallbackLabel = (detailStartButtonEl.dataset.startDefaultLabel || "").toString().trim() || "Đọc từ đầu";
    const fallbackUrl =
      toSafePath(detailStartButtonEl.dataset.startDefaultUrl || "") ||
      toSafePath(detailStartButtonEl.getAttribute("href") || "");
    detailStartButtonEl.textContent = fallbackLabel;
    if (fallbackUrl) {
      detailStartButtonEl.setAttribute("href", fallbackUrl);
    }
  };

  const setHistoryStatus = (text, variant) => {
    if (!historyStatusEl) return;
    const message = (text || "").toString().trim();
    if (!message) {
      historyStatusEl.hidden = true;
      historyStatusEl.textContent = "";
      historyStatusEl.classList.remove("is-error", "is-success");
      return;
    }
    historyStatusEl.hidden = false;
    historyStatusEl.textContent = message;
    historyStatusEl.classList.remove("is-error", "is-success");
    if (variant === "error") historyStatusEl.classList.add("is-error");
    if (variant === "success") historyStatusEl.classList.add("is-success");
  };

  const setHistoryLocked = (locked) => {
    if (historyLockedEl) historyLockedEl.hidden = !locked;
    if (historyContentEl) historyContentEl.hidden = locked;
  };

  const buildHistoryMap = (items) => new Map(
    (Array.isArray(items) ? items : [])
      .map((item) => {
        const slug = item && item.mangaSlug ? String(item.mangaSlug).trim() : "";
        if (!slug) return null;
        return [slug, item];
      })
      .filter(Boolean)
  );

  const fetchReadingHistory = async () => {
    const token = await getAccessTokenSafe();
    const headers = {
      Accept: "application/json"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(HISTORY_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      headers,
      credentials: "same-origin"
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true || !Array.isArray(data.history)) {
      return null;
    }

    return data.history;
  };

  const loadReadingHistory = async ({ force = false } = {}) => {
    if (!force && historyLoadingPromise) {
      return historyLoadingPromise;
    }

    historyLoadingPromise = fetchReadingHistory()
      .then((history) => {
        historyCache = Array.isArray(history) ? history : [];
        historyMapCache = buildHistoryMap(historyCache);
        return historyCache;
      })
      .finally(() => {
        historyLoadingPromise = null;
      });

    return historyLoadingPromise;
  };

  const buildContinueText = (item) => {
    if (item && item.chapterIsOneshot) {
      return "Đọc Oneshot";
    }
    const chapterText =
      item && item.chapterNumberText
        ? String(item.chapterNumberText).trim()
        : formatChapterNumber(item && item.chapterNumber);
    return chapterText ? `Đọc ch. ${chapterText}` : "Đọc từ đầu";
  };

  const renderDetailStartButtonUi = () => {
    if (!detailStartButtonEl) return;
    resetDetailStartButtonUi();

    const slug = (detailStartButtonEl.dataset.mangaSlug || "").toString().trim();
    if (!slug) return;

    const fallbackUrl =
      toSafePath(detailStartButtonEl.dataset.startDefaultUrl || "") ||
      toSafePath(detailStartButtonEl.getAttribute("href") || "");
    const item = historyMapCache.get(slug);
    const historyChapterUrl = toSafePath(item && item.chapterUrl ? item.chapterUrl : "");

    if (historyChapterUrl) {
      detailStartButtonEl.setAttribute("href", historyChapterUrl);
      detailStartButtonEl.textContent = buildContinueText(item);
      return;
    }

    if (fallbackUrl) {
      detailStartButtonEl.setAttribute("href", fallbackUrl);
    }
  };

  const renderHistoryPageUi = () => {
    if (!historyPage || !historyListEl || !historyEmptyEl) return;

    if (!historyCache.length) {
      historyListEl.innerHTML = "";
      historyEmptyEl.hidden = false;
      return;
    }

    historyEmptyEl.hidden = true;

    const rowsHtml = historyCache
      .map((item) => {
        const mangaTitle = item && item.mangaTitle ? String(item.mangaTitle).trim() : "";
        const fullTitle = mangaTitle || "Truyện";
        const cardTitle = truncateCardTitle(fullTitle);
        const mangaUrl = toSafePath(item && item.mangaUrl ? item.mangaUrl : "");
        const mangaAuthor = item && item.mangaAuthor ? String(item.mangaAuthor).trim() : "";
        const mangaGroupName = item && item.mangaGroupName ? String(item.mangaGroupName).trim() : "";
        const authorText = mangaGroupName || mangaAuthor || FALLBACK_AUTHOR_NAME;
        const chapterUrl = toSafePath(item && item.chapterUrl ? item.chapterUrl : "");
        const chapterNumberText = item && item.chapterNumberText ? String(item.chapterNumberText).trim() : "";
        const cardHref = chapterUrl || mangaUrl || "/manga";
        const status = item && item.mangaStatus ? String(item.mangaStatus).trim() : "";
        const statusText = status || "Đang theo dõi";
        const statusClass =
          status === "Hoàn thành"
            ? "is-complete"
            : status === "Tạm dừng"
            ? "is-hiatus"
            : "is-ongoing";
        const chapterBadgeLabel = item && item.chapterIsOneshot
          ? "Oneshot"
          : chapterNumberText
          ? `Ch. ${chapterNumberText}`
          : "Tiếp tục đọc";

        const coverUrl = cacheBust(
          item && item.mangaCover ? item.mangaCover : "",
          item && item.mangaCoverUpdatedAt != null ? item.mangaCoverUpdatedAt : 0
        );
        const coverSources = buildCoverSources(coverUrl);

        return `
          <article class="manga-card manga-card--list">
            <a href="${escapeAttr(cardHref)}">
              <div class="cover">
                ${coverSources.src
                  ? `<img src="${escapeAttr(coverSources.src)}" srcset="${escapeAttr(coverSources.srcset)}" sizes="${escapeAttr(coverSources.sizes)}" alt="Bìa ${escapeAttr(mangaTitle || "truyện")}" />`
                  : '<span class="cover__label">No Cover</span>'}
                <span class="manga-badge ${statusClass}">${escapeHtml(statusText)}</span>
                <span class="manga-chapter-label">${escapeHtml(chapterBadgeLabel)}</span>
              </div>
              <div class="manga-body">
                <h3 title="${escapeAttr(fullTitle)}">${escapeHtml(cardTitle)}</h3>
                <p class="manga-author">${escapeHtml(authorText)}</p>
              </div>
            </a>
          </article>
        `;
      })
      .join("");

    historyListEl.innerHTML = rowsHtml;
  };

  const saveCurrentReadingProgress = async (session) => {
    if (!readingProgressEl || progressSaved) return;

    const mangaSlug = (readingProgressEl.dataset.readingMangaSlug || "").toString().trim();
    const chapterNumberText = (readingProgressEl.dataset.readingChapterNumber || "").toString().trim();
    const chapterNumber = Number(chapterNumberText);
    if (!mangaSlug || !Number.isFinite(chapterNumber) || chapterNumber < 0) return;

    const tokenFromSession =
      session && session.access_token ? String(session.access_token).trim() : "";
    const token = tokenFromSession || (await getAccessTokenSafe());
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(HISTORY_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      keepalive: true,
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        mangaSlug,
        chapterNumber
      })
    }).catch(() => null);

    if (response && response.ok) {
      progressSaved = true;
    }
  };

  const syncCurrentChapterReadMap = async (session, localMarkState = null) => {
    if (!readingProgressEl || chapterReadSynced) return;
    const readScope = resolveReadScopeFromSession(session);

    const localMark =
      localMarkState && typeof localMarkState === "object"
        ? localMarkState
        : markCurrentChapterReadLocal({ readScope });
    if (!localMark.mangaSlug || !localMark.chapterId) return;
    if (!localMark.needsSync) {
      chapterReadSynced = true;
      return;
    }

    const tokenFromSession =
      session && session.access_token ? String(session.access_token).trim() : "";
    const token = tokenFromSession || (await getAccessTokenSafe());
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const staleOrMissingLocalSnapshot =
      !Number.isFinite(Number(localMark.fetchedAt))
      || Number(localMark.fetchedAt) <= 0
      || Date.now() - Number(localMark.fetchedAt) > CHAPTER_READ_PRECHECK_TTL_MS;

    if (localMark.needsSync && staleOrMissingLocalSnapshot) {
      const precheckUrl = `${CHAPTER_READ_ENDPOINT}?mangaSlug=${encodeURIComponent(localMark.mangaSlug)}`;
      const precheckResponse = await fetch(precheckUrl, {
        method: "GET",
        cache: "no-store",
        headers,
        credentials: "same-origin"
      }).catch(() => null);

      if (precheckResponse && precheckResponse.ok) {
        const precheckPayload = await precheckResponse.json().catch(() => null);
        if (precheckPayload && precheckPayload.ok === true && Array.isArray(precheckPayload.readMap)) {
          const serverChapterIds = normalizeChapterIdArray(precheckPayload.readMap);
          if (serverChapterIds.includes(localMark.chapterId)) {
            const pendingSyncChapterIds = normalizeChapterIdArray(
              localMark.pendingSyncChapterIds
            ).filter((chapterId) => !serverChapterIds.includes(chapterId));
            writeChapterReadMapLocal({
              mangaSlug: localMark.mangaSlug,
              scope: readScope,
              payload: {
                chapterIds: serverChapterIds,
                pendingSyncChapterIds,
                updatedAt: Number(precheckPayload.updatedAt) || Date.now(),
                fetchedAt: Date.now()
              }
            });
            chapterReadSynced = true;
            return;
          }
        }
      }
    }

    const response = await fetch(CHAPTER_READ_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      keepalive: true,
      headers,
      credentials: "same-origin",
      body: JSON.stringify({
        mangaSlug: localMark.mangaSlug,
        chapterId: localMark.chapterId
      })
    }).catch(() => null);

    if (!response || !response.ok) return;
    const payload = await response.json().catch(() => null);
    if (!payload || payload.ok !== true) return;

    if (Array.isArray(payload.readMap)) {
      const serverChapterIds = normalizeChapterIdArray(payload.readMap);
      const pendingSyncChapterIds = normalizeChapterIdArray(
        localMark.pendingSyncChapterIds
      ).filter((chapterId) => !serverChapterIds.includes(chapterId));
      writeChapterReadMapLocal({
        mangaSlug: localMark.mangaSlug,
        scope: readScope,
        payload: {
          chapterIds: serverChapterIds,
          pendingSyncChapterIds,
          updatedAt: Number(payload.updatedAt) || Date.now(),
          fetchedAt: Date.now()
        }
      });
    }

    chapterReadSynced = true;
  };

  const handleSignedOutUi = () => {
    markCurrentChapterReadLocal({ readScope: "guest" });
    historyCache = [];
    historyMapCache = new Map();
    renderDetailStartButtonUi();
    if (historyPage) {
      setHistoryLocked(true);
      setHistoryStatus("");
      if (historyListEl) historyListEl.innerHTML = "";
      if (historyEmptyEl) historyEmptyEl.hidden = true;
    }
  };

  const refreshFromSession = async (session, options = {}) => {
    const settings = options && typeof options === "object" ? options : {};
    const resolvedSession = settings.resolveSession ? await getSessionSafe() : session;
    const signedIn = Boolean(
      resolvedSession &&
        ((resolvedSession.user && typeof resolvedSession.user === "object") || resolvedSession.access_token)
    );

    if (!signedIn) {
      handleSignedOutUi();
      return;
    }

    if (historyPage) {
      setHistoryLocked(false);
      setHistoryStatus("");
    }

    const readScope = resolveReadScopeFromSession(resolvedSession);
    const localMark = markCurrentChapterReadLocal({ readScope });
    await saveCurrentReadingProgress(resolvedSession);
    await syncCurrentChapterReadMap(resolvedSession, localMark);

    const shouldLoadHistory = Boolean(detailStartButtonEl || historyPage);
    if (!shouldLoadHistory) {
      return;
    }

    const history = await loadReadingHistory({ force: settings.force === true });
    if (!Array.isArray(history)) {
      if (historyPage) {
        setHistoryStatus("Không thể tải lịch sử đọc. Vui lòng thử lại.", "error");
      }
      return;
    }

    renderDetailStartButtonUi();
    if (historyPage) {
      renderHistoryPageUi();
    }
  };

  window.addEventListener("bfang:auth", (event) => {
    chapterReadSynced = false;
    const detail = event && event.detail ? event.detail : null;
    const session = detail && detail.session ? detail.session : null;
    refreshFromSession(session, { force: true }).catch(() => null);
  });

  const refreshFromCurrentSession = () => {
    refreshFromSession(null, { resolveSession: true, force: true }).catch(() => null);
  };

  window.addEventListener("pageshow", refreshFromCurrentSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshFromCurrentSession();
  });

  window.addEventListener("bfang:pagechange", () => {
    captureReadingHistoryNodes();
    progressSaved = false;
    chapterReadSynced = false;
    refreshFromSession(null, { resolveSession: true }).catch(() => null);
  });

  refreshFromSession(null, { resolveSession: true }).catch(() => null);
})();
