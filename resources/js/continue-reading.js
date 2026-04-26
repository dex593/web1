(() => {
  const ACTIVE_SESSION_ENDPOINT = "/account/active-reading-session";
  const CLEAR_SESSION_ENDPOINT = "/account/active-reading-session/clear";
  const ACTIVE_SESSION_STORAGE_KEY = "bfang:active-reading-session:v1";
  const CLEAR_PENDING_STORAGE_KEY = "bfang:active-reading-clear-pending:v1";
  const CHAPTER_PATH_PATTERN = /^\/manga\/[^/]+\/chapters\/[^/?#]+\/?$/i;
  const MANGA_PATH_PATTERN = /^\/manga\/[^/?#]+(?:\/[^?#]*)?$/i;
  const CLEAR_PENDING_TTL_MS = 30 * 1000;
  const NON_CHAPTER_SYNC_INTERVAL_MS = 5 * 1000;
  const POPUP_STYLE_ID = "bfang-continue-reading-style";

  let currentAuthSession = null;
  let currentScope = "";
  let syncTimer = null;
  let nonChapterSyncIntervalTimer = null;
  let syncToken = 0;
  let dismissedChapterId = 0;
  let popupSessionChapterId = 0;
  let popupRootEl = null;
  let clearedByMangaDetailEntry = false;

  const toPositiveInteger = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  };

  const normalizeScopeToken = (value) =>
    (value == null ? "" : String(value))
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");

  const resolveScopeFromSession = (session) => {
    const userId = session && session.user && session.user.id != null
      ? String(session.user.id).trim()
      : "";
    const normalizedUserId = normalizeScopeToken(userId);
    return normalizedUserId ? `user-${normalizedUserId}` : "";
  };

  const normalizeChapterNumberText = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "";
    if (Math.abs(parsed - Math.round(parsed)) < 1e-9) {
      return String(Math.round(parsed));
    }
    return parsed.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  };

  const toSafePath = (value) => {
    const text = (value || "").toString().trim();
    if (!text || !text.startsWith("/")) return "";
    return text;
  };

  const buildChapterPath = ({ mangaSlug, chapterNumberText }) => {
    const safeSlug = (mangaSlug || "").toString().trim();
    const safeChapterNumber = (chapterNumberText || "").toString().trim();
    if (!safeSlug || !safeChapterNumber) return "";
    return `/manga/${encodeURIComponent(safeSlug)}/chapters/${encodeURIComponent(safeChapterNumber)}`;
  };

  const buildChapterLabel = (payload) => {
    if (payload && payload.chapterIsOneshot) return "Oneshot";
    const chapterNumberText = payload && payload.chapterNumberText
      ? String(payload.chapterNumberText).trim()
      : "";
    return chapterNumberText ? `Ch. ${chapterNumberText}` : "Chương";
  };

  const normalizeActiveSessionPayload = (value) => {
    const source = value && typeof value === "object" ? value : {};
    const chapterId = toPositiveInteger(source.chapterId || source.chapter_id);
    const mangaId = toPositiveInteger(source.mangaId || source.manga_id);
    const mangaSlug = (source.mangaSlug || source.manga_slug || "").toString().trim();
    const mangaTitle = (source.mangaTitle || source.manga_title || "").toString().trim();
    const chapterTitle = (source.chapterTitle || source.chapter_title || "").toString().trim();
    const chapterIsOneshot = Boolean(source.chapterIsOneshot || source.chapter_is_oneshot);

    const chapterNumberRaw = source.chapterNumber != null
      ? source.chapterNumber
      : source.chapter_number;
    const chapterNumberTextRaw = source.chapterNumberText != null
      ? source.chapterNumberText
      : source.chapter_number_text;
    const chapterNumberText = normalizeChapterNumberText(
      chapterNumberTextRaw != null && String(chapterNumberTextRaw).trim()
        ? chapterNumberTextRaw
        : chapterNumberRaw
    );

    const chapterUrl = toSafePath(
      source.chapterUrl
      || source.chapter_url
      || buildChapterPath({ mangaSlug, chapterNumberText })
    );

    const updatedAtRaw = Number(source.updatedAt != null ? source.updatedAt : source.updated_at);
    const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
      ? Math.floor(updatedAtRaw)
      : Date.now();

    if (!chapterId || !mangaSlug || !chapterUrl) {
      return null;
    }

    return {
      mangaId,
      mangaSlug,
      mangaTitle,
      chapterId,
      chapterNumberText,
      chapterTitle,
      chapterIsOneshot,
      chapterLabel: buildChapterLabel({
        chapterIsOneshot,
        chapterNumberText
      }),
      chapterUrl,
      updatedAt
    };
  };

  const readActiveSessionLocal = () => {
    try {
      const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const scope = parsed && parsed.scope ? normalizeScopeToken(parsed.scope) : "";
      const session = normalizeActiveSessionPayload(
        parsed && parsed.session && typeof parsed.session === "object"
          ? parsed.session
          : parsed
      );
      if (!scope || !session) return null;
      return { scope, session };
    } catch (_error) {
      return null;
    }
  };

  const writeActiveSessionLocal = ({ scope, session }) => {
    const safeScope = normalizeScopeToken(scope);
    const safeSession = normalizeActiveSessionPayload(session);
    if (!safeScope || !safeSession) return;

    try {
      window.localStorage.setItem(
        ACTIVE_SESSION_STORAGE_KEY,
        JSON.stringify({
          scope: safeScope,
          session: safeSession,
          updatedAt: Date.now()
        })
      );
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const clearActiveSessionLocal = ({ scope } = {}) => {
    const safeScope = normalizeScopeToken(scope);
    const current = readActiveSessionLocal();
    if (safeScope && current && current.scope && current.scope !== safeScope) return;

    try {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const readPendingClear = ({ scope } = {}) => {
    const expectedScope = normalizeScopeToken(scope);
    try {
      const raw = window.sessionStorage.getItem(CLEAR_PENDING_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const pendingScope = normalizeScopeToken(parsed && parsed.scope);
      const chapterId = toPositiveInteger(parsed && parsed.chapterId);
      const clearAll = Boolean(parsed && parsed.clearAll);
      const createdAtRaw = Number(parsed && parsed.createdAt);
      const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0
        ? Math.floor(createdAtRaw)
        : 0;
      if ((!chapterId && !clearAll) || !createdAt || !pendingScope) return null;
      if (expectedScope && pendingScope !== expectedScope) return null;
      if (Date.now() - createdAt > CLEAR_PENDING_TTL_MS) return null;
      return { scope: pendingScope, chapterId, clearAll, createdAt };
    } catch (_error) {
      return null;
    }
  };

  const writePendingClear = ({ chapterId, scope, clearAll = false }) => {
    const safeChapterId = toPositiveInteger(chapterId);
    const safeScope = normalizeScopeToken(scope);
    const shouldClearAll = Boolean(clearAll);
    if ((!safeChapterId && !shouldClearAll) || !safeScope) return;
    try {
      window.sessionStorage.setItem(
        CLEAR_PENDING_STORAGE_KEY,
        JSON.stringify({
          scope: safeScope,
          chapterId: safeChapterId || 0,
          clearAll: shouldClearAll,
          createdAt: Date.now()
        })
      );
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const clearPendingClear = () => {
    try {
      window.sessionStorage.removeItem(CLEAR_PENDING_STORAGE_KEY);
    } catch (_error) {
      // Ignore storage failures.
    }
  };

  const getSessionSafe = async () => {
    if (window.BfangAuth && typeof window.BfangAuth.getSession === "function") {
      try {
        const session = await window.BfangAuth.getSession();
        return session && session.user && session.user.id ? session : null;
      } catch (_error) {
        return null;
      }
    }
    return null;
  };

  const buildAuthHeaders = (session, baseHeaders = {}) => {
    const headers = { ...baseHeaders };
    const token = session && session.access_token ? String(session.access_token).trim() : "";
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  };

  const fetchCurrentActiveSession = async (session) => {
    const response = await fetch(ACTIVE_SESSION_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: buildAuthHeaders(session, {
        Accept: "application/json"
      })
    }).catch(() => null);

    if (!response) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) return null;
    return normalizeActiveSessionPayload(payload.session);
  };

  const upsertActiveSession = async ({ session, chapterId }) => {
    const safeChapterId = toPositiveInteger(chapterId);
    if (!safeChapterId) return null;

    const response = await fetch(ACTIVE_SESSION_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      keepalive: true,
      headers: buildAuthHeaders(session, {
        "Content-Type": "application/json",
        Accept: "application/json"
      }),
      body: JSON.stringify({
        chapterId: safeChapterId
      })
    }).catch(() => null);

    if (!response) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok !== true) return null;
    return normalizeActiveSessionPayload(payload.session);
  };

  const requestClearActiveSession = ({ session, chapterId, clearAll = false, useBeacon = false }) => {
    const safeChapterId = toPositiveInteger(chapterId);
    const shouldClearAll = Boolean(clearAll) || !safeChapterId;
    const payload = JSON.stringify(
      shouldClearAll
        ? {}
        : { chapterId: safeChapterId }
    );
    if (useBeacon && navigator.sendBeacon) {
      try {
        const blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon(CLEAR_SESSION_ENDPOINT, blob);
      } catch (_error) {
        // Continue with fetch fallback.
      }
    }

    fetch(CLEAR_SESSION_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      keepalive: true,
      headers: buildAuthHeaders(session, {
        "Content-Type": "application/json",
        Accept: "application/json"
      }),
      body: payload
    }).catch(() => null);
  };

  const stopNonChapterSyncLoop = () => {
    if (nonChapterSyncIntervalTimer) {
      window.clearInterval(nonChapterSyncIntervalTimer);
      nonChapterSyncIntervalTimer = null;
    }
  };

  const ensureNonChapterSyncLoop = () => {
    if (nonChapterSyncIntervalTimer) return;
    nonChapterSyncIntervalTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      scheduleSync(0);
    }, NON_CHAPTER_SYNC_INTERVAL_MS);
  };

  const getChapterContext = () => {
    const readingProgressEl = document.querySelector("[data-reading-progress]");
    if (!readingProgressEl) return null;

    const chapterId = toPositiveInteger(readingProgressEl.dataset.readingChapterId);
    const mangaSlug = (readingProgressEl.dataset.readingMangaSlug || "").toString().trim();
    const chapterNumberText = normalizeChapterNumberText(readingProgressEl.dataset.readingChapterNumber);
    const mangaTitle = (readingProgressEl.dataset.readingMangaTitle || "").toString().trim();
    const chapterTitle = (readingProgressEl.dataset.readingChapterTitle || "").toString().trim();
    const chapterUrlFromDataset = toSafePath(readingProgressEl.dataset.readingChapterUrl || "");
    const chapterUrl = chapterUrlFromDataset || buildChapterPath({ mangaSlug, chapterNumberText });

    if (!chapterId || !mangaSlug || !chapterUrl) return null;

    return {
      chapterId,
      mangaSlug,
      mangaTitle,
      chapterTitle,
      chapterNumberText,
      chapterUrl
    };
  };

  const isChapterPath = (pathname) => {
    const path = (pathname == null ? window.location.pathname : pathname).toString().trim();
    return CHAPTER_PATH_PATTERN.test(path);
  };

  const isMangaPath = (pathname) => {
    const path = (pathname == null ? window.location.pathname : pathname).toString().trim();
    return MANGA_PATH_PATTERN.test(path);
  };

  const buildLocalPayloadFromChapterContext = (chapterContext) => {
    const context = chapterContext && typeof chapterContext === "object" ? chapterContext : {};
    const chapterId = toPositiveInteger(context.chapterId);
    const mangaSlug = (context.mangaSlug || "").toString().trim();
    const chapterUrl = toSafePath(context.chapterUrl || "");
    if (!chapterId || !mangaSlug || !chapterUrl) return null;

    const chapterNumberText = normalizeChapterNumberText(context.chapterNumberText);
    const chapterIsOneshot = chapterNumberText === "";

    return normalizeActiveSessionPayload({
      chapterId,
      mangaSlug,
      mangaTitle: context.mangaTitle || "",
      chapterTitle: context.chapterTitle || "",
      chapterNumberText,
      chapterIsOneshot,
      chapterUrl,
      updatedAt: Date.now()
    });
  };

  const ensurePopupStyles = () => {
    if (document.getElementById(POPUP_STYLE_ID)) return;

    const styleEl = document.createElement("style");
    styleEl.id = POPUP_STYLE_ID;
    styleEl.textContent = `
      .bfang-continue-reading-popup {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1200;
        width: min(360px, calc(100vw - 24px));
        background: linear-gradient(135deg, rgba(17, 24, 39, 0.96), rgba(2, 6, 23, 0.98));
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 14px;
        padding: 0.9rem 0.95rem;
        box-shadow: 0 16px 42px rgba(2, 6, 23, 0.42);
        opacity: 0;
        transform: translateY(14px);
        transition: opacity 0.22s ease, transform 0.22s ease;
      }

      .bfang-continue-reading-popup.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      .bfang-continue-reading-popup__title {
        margin: 0;
        font-size: 1rem;
        font-weight: 700;
        line-height: 1.35;
      }

      .bfang-continue-reading-popup__meta {
        margin: 0.42rem 0 0;
        font-size: 0.92rem;
        color: rgba(226, 232, 240, 0.92);
        line-height: 1.45;
      }

      .bfang-continue-reading-popup__actions {
        margin-top: 0.72rem;
        display: flex;
        align-items: center;
        gap: 0.45rem;
      }

      .bfang-continue-reading-popup__cta,
      .bfang-continue-reading-popup__dismiss {
        appearance: none;
        border: 0;
        border-radius: 999px;
        font-size: 0.86rem;
        font-weight: 700;
        line-height: 1.2;
        padding: 0.45rem 0.78rem;
        cursor: pointer;
        text-decoration: none;
      }

      .bfang-continue-reading-popup__cta {
        color: #04111f;
        background: #facc15;
      }

      .bfang-continue-reading-popup__dismiss {
        color: #e2e8f0;
        background: rgba(15, 23, 42, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.32);
      }

      .bfang-continue-reading-popup__close {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 50%;
        background: rgba(15, 23, 42, 0.72);
        color: #e2e8f0;
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
      }

      @media (max-width: 540px) {
        .bfang-continue-reading-popup {
          right: 10px;
          bottom: 10px;
          width: calc(100vw - 20px);
        }
      }
    `;
    document.head.appendChild(styleEl);
  };

  const ensurePopup = () => {
    if (popupRootEl && document.body.contains(popupRootEl)) {
      return popupRootEl;
    }

    const root = document.createElement("aside");
    root.className = "bfang-continue-reading-popup";
    root.setAttribute("data-continue-reading-popup", "1");
    root.setAttribute("aria-live", "polite");
    root.hidden = true;
    root.innerHTML = `
      <button type="button" class="bfang-continue-reading-popup__close" data-continue-reading-close aria-label="Đóng">×</button>
      <p class="bfang-continue-reading-popup__title" data-continue-reading-title>Đọc tiếp chương đang dở</p>
      <p class="bfang-continue-reading-popup__meta" data-continue-reading-meta></p>
      <div class="bfang-continue-reading-popup__actions">
        <a class="bfang-continue-reading-popup__cta" data-continue-reading-link href="/">Đọc tiếp</a>
        <button type="button" class="bfang-continue-reading-popup__dismiss" data-continue-reading-dismiss>Để sau</button>
      </div>
    `;

    root.querySelector("[data-continue-reading-close]")?.addEventListener("click", () => {
      dismissedChapterId = 0;
      clearActiveSessionNow({
        clearAll: true,
        useBeacon: false
      });
    });

    root.querySelector("[data-continue-reading-dismiss]")?.addEventListener("click", () => {
      dismissedChapterId = 0;
      clearActiveSessionNow({
        clearAll: true,
        useBeacon: false
      });
    });

    document.body.appendChild(root);
    popupRootEl = root;
    return root;
  };

  const hidePopup = () => {
    if (!popupRootEl) return;
    popupRootEl.classList.remove("is-visible");
    popupRootEl.hidden = true;
    popupSessionChapterId = 0;
  };

  const showPopup = (sessionPayload) => {
    const safePayload = normalizeActiveSessionPayload(sessionPayload);
    if (!safePayload) {
      hidePopup();
      return;
    }

    if (dismissedChapterId && safePayload.chapterId === dismissedChapterId) {
      return;
    }

    if (dismissedChapterId && safePayload.chapterId !== dismissedChapterId) {
      dismissedChapterId = 0;
    }

    ensurePopupStyles();
    const root = ensurePopup();

    const titleEl = root.querySelector("[data-continue-reading-title]");
    const metaEl = root.querySelector("[data-continue-reading-meta]");
    const linkEl = root.querySelector("[data-continue-reading-link]");

    const mangaTitle = safePayload.mangaTitle || "Truyện";
    const chapterLabel = safePayload.chapterLabel || buildChapterLabel(safePayload);
    const chapterTitle = safePayload.chapterTitle ? ` — ${safePayload.chapterTitle}` : "";

    if (titleEl) {
      titleEl.textContent = "Đọc tiếp chương đang dở";
    }
    if (metaEl) {
      metaEl.textContent = `${mangaTitle} • ${chapterLabel}${chapterTitle}`;
    }
    if (linkEl) {
      linkEl.setAttribute("href", safePayload.chapterUrl);
      linkEl.textContent = `Đọc tiếp ${chapterLabel}`;
    }

    popupSessionChapterId = safePayload.chapterId;
    root.hidden = false;
    requestAnimationFrame(() => {
      root.classList.add("is-visible");
    });
  };

  const clearActiveSessionNow = ({ chapterId, clearAll = false, useBeacon = false } = {}) => {
    const safeChapterId = toPositiveInteger(chapterId);
    const shouldClearAll = Boolean(clearAll) || !safeChapterId;
    const localSession = readActiveSessionLocal();
    const scopeForClear = normalizeScopeToken(currentScope || (localSession && localSession.scope));

    if (scopeForClear) {
      writePendingClear({
        chapterId: safeChapterId,
        clearAll: shouldClearAll,
        scope: scopeForClear
      });
      clearActiveSessionLocal({ scope: scopeForClear });
    } else {
      clearActiveSessionLocal();
    }

    hidePopup();
    requestClearActiveSession({
      session: currentAuthSession,
      chapterId: safeChapterId,
      clearAll: shouldClearAll,
      useBeacon
    });
  };

  const clearForExplicitNavigation = (chapterContext, { clearAll = false } = {}) => {
    const context = chapterContext && typeof chapterContext === "object" ? chapterContext : null;
    const chapterId = context && context.chapterId ? context.chapterId : 0;
    clearActiveSessionNow({
      chapterId,
      clearAll,
      useBeacon: true
    });
  };

  const shouldIgnoreAnchorNavigation = (event, anchor) => {
    if (!anchor || !anchor.href) return true;
    if (event.defaultPrevented) return true;
    if (typeof event.button === "number" && event.button !== 0) return true;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;

    const target = (anchor.getAttribute("target") || "").toString().trim().toLowerCase();
    if (target && target !== "_self") return true;
    if (anchor.hasAttribute("download")) return true;

    return false;
  };

  const resolveNavigationTargetFromEvent = (event) => {
    if (!event || event.defaultPrevented) return null;
    if (typeof event.button === "number" && event.button !== 0) return null;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

    const targetEl = event.target && typeof event.target.closest === "function"
      ? event.target
      : null;
    if (!targetEl) return null;

    const anchor = targetEl.closest("a[href]");
    if (anchor && !shouldIgnoreAnchorNavigation(event, anchor)) {
      return {
        href: anchor.href,
        target: (anchor.getAttribute("target") || "").toString().trim().toLowerCase()
      };
    }

    const dataHrefEl = targetEl.closest("[data-href], [data-start-default-url]");
    if (!dataHrefEl) return null;

    const dataHref = (
      (dataHrefEl.getAttribute("data-href") || "")
      || (dataHrefEl.getAttribute("data-start-default-url") || "")
    )
      .toString()
      .trim();
    if (!dataHref) return null;

    return {
      href: dataHref,
      target: "_self"
    };
  };

  const handleClickNavigation = (event) => {
    const navigationTarget = resolveNavigationTargetFromEvent(event);
    if (!navigationTarget) return;
    if (navigationTarget.target && navigationTarget.target !== "_self") return;

    let nextUrl = null;
    try {
      nextUrl = new URL(navigationTarget.href, window.location.href);
    } catch (_error) {
      return;
    }

    if (nextUrl.origin !== window.location.origin) return;

    const isSamePath = nextUrl.pathname === window.location.pathname
      && nextUrl.search === window.location.search;
    if (isSamePath) return;

    if (isMangaPath(nextUrl.pathname)) {
      clearActiveSessionNow({
        clearAll: true,
        useBeacon: true
      });
      return;
    }

    const chapterContext = getChapterContext();
    if (!chapterContext) return;
    if (isChapterPath(nextUrl.pathname)) return;

    clearForExplicitNavigation(chapterContext, { clearAll: true });
  };

  const handleFormNavigation = (event) => {
    const chapterContext = getChapterContext();
    if (!chapterContext) return;
    if (event.defaultPrevented) return;

    const form = event.target;
    if (!form || typeof form.getAttribute !== "function") return;

    const method = (form.getAttribute("method") || "GET").toString().trim().toUpperCase();
    if (method !== "GET" && method !== "POST") return;

    const action = (form.getAttribute("action") || "").toString().trim();
    if (!action) return;

    let nextUrl = null;
    try {
      nextUrl = new URL(action, window.location.href);
    } catch (_error) {
      return;
    }

    if (nextUrl.origin !== window.location.origin) return;
    if (isChapterPath(nextUrl.pathname)) return;

    clearForExplicitNavigation(chapterContext, { clearAll: true });
  };

  const syncContinueReadingState = async () => {
    const currentSyncToken = ++syncToken;
    const session = await getSessionSafe();
    if (currentSyncToken !== syncToken) return;

    currentAuthSession = session;
    const scope = resolveScopeFromSession(session);
    currentScope = scope;

    if (!scope) {
      stopNonChapterSyncLoop();
      clearActiveSessionLocal();
      clearPendingClear();
      hidePopup();
      return;
    }

    if (!isChapterPath() && isMangaPath() && !clearedByMangaDetailEntry) {
      clearedByMangaDetailEntry = true;
      clearActiveSessionNow({
        clearAll: true,
        useBeacon: false
      });
    }

    const chapterContext = getChapterContext();
    if (chapterContext) {
      stopNonChapterSyncLoop();
      const localPayload = buildLocalPayloadFromChapterContext(chapterContext);
      if (localPayload) {
        writeActiveSessionLocal({
          scope,
          session: localPayload
        });
      }

      const syncedPayload = await upsertActiveSession({
        session,
        chapterId: chapterContext.chapterId
      });
      if (currentSyncToken !== syncToken) return;

      if (syncedPayload) {
        writeActiveSessionLocal({
          scope,
          session: syncedPayload
        });
      }

      clearPendingClear();
      hidePopup();
      return;
    }

    ensureNonChapterSyncLoop();

    const serverPayload = await fetchCurrentActiveSession(session);
    if (currentSyncToken !== syncToken) return;

    const pendingClear = readPendingClear({ scope });
    const shouldRetryPendingClear = Boolean(
      pendingClear
      && serverPayload
      && (
        pendingClear.clearAll
        || (pendingClear.chapterId && pendingClear.chapterId === serverPayload.chapterId)
      )
    );
    if (shouldRetryPendingClear) {
      clearActiveSessionLocal({ scope });
      requestClearActiveSession({
        session,
        chapterId: pendingClear.chapterId,
        clearAll: pendingClear.clearAll,
        useBeacon: false
      });
      clearPendingClear();
      hidePopup();
      return;
    }

    if (serverPayload) {
      clearPendingClear();
      writeActiveSessionLocal({
        scope,
        session: serverPayload
      });
      showPopup(serverPayload);
      return;
    }

    clearPendingClear();
    clearActiveSessionLocal({ scope });
    hidePopup();
  };

  const scheduleSync = (delayMs = 0) => {
    if (syncTimer) {
      window.clearTimeout(syncTimer);
      syncTimer = null;
    }
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      syncContinueReadingState().catch(() => null);
    }, Math.max(0, Number(delayMs) || 0));
  };

  document.addEventListener("click", handleClickNavigation, true);
  document.addEventListener("submit", handleFormNavigation, true);

  window.addEventListener("bfang:auth", (event) => {
    const detail = event && event.detail ? event.detail : null;
    currentAuthSession = detail && detail.session ? detail.session : null;
    dismissedChapterId = 0;
    clearedByMangaDetailEntry = false;
    scheduleSync(0);
  });

  window.addEventListener("pageshow", () => {
    clearedByMangaDetailEntry = false;
    scheduleSync(0);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      stopNonChapterSyncLoop();
      return;
    }
    scheduleSync(120);
  });

  window.addEventListener("bfang:pagechange", () => {
    dismissedChapterId = 0;
    clearedByMangaDetailEntry = false;
    scheduleSync(0);
  });

  scheduleSync(0);
})();
