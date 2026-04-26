(() => {
  const DEFAULT_ENDPOINT = "/activity/reading-stream";
  const DEFAULT_MAX_ITEMS = 30;
  const DEFAULT_REFRESH_MS = 15000;
  const SCROLL_ANIMATION_NAME = "reading-activity-scroll";
  let tickerRoot = null;
  let trackEl = null;
  let interactionScopeEl = null;
  let endpoint = DEFAULT_ENDPOINT;
  let maxItems = DEFAULT_MAX_ITEMS;
  let refreshMs = DEFAULT_REFRESH_MS;

  let refreshTimer = null;
  let isLoading = false;
  let lastSignature = "";
  let requestToken = 0;
  let isInteractionPaused = false;
  let isPointerInsideTicker = false;
  let isFocusInsideTicker = false;
  let boundInteractionScopeEl = null;

  const toSafeText = (value, maxLength = 180) =>
    (value == null ? "" : String(value))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, Math.floor(maxLength)));

  const toSafeInternalPath = (value) => {
    const pathValue = (value == null ? "" : String(value)).trim();
    if (!pathValue || !pathValue.startsWith("/")) return "";
    if (/^\/\//.test(pathValue)) return "";
    return pathValue;
  };

  const toSafeAvatarUrl = (value) => {
    const raw = (value == null ? "" : String(value)).trim();
    if (!raw || raw.length > 1024) return "";

    if (raw.startsWith("/") && !/^\/\//.test(raw)) {
      return raw;
    }

    try {
      const parsed = new URL(raw, window.location.origin);
      const protocol = (parsed.protocol || "").toLowerCase();
      if (protocol !== "http:" && protocol !== "https:") return "";
      return parsed.href;
    } catch (_error) {
      return "";
    }
  };

  const toSafeInteger = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  };

  const buildUserInitials = (name) => {
    const safeName = toSafeText(name, 80);
    if (!safeName) return "?";

    const parts = safeName.split(" ").filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }

    const first = parts[0].charAt(0);
    const last = parts[parts.length - 1].charAt(0);
    return `${first}${last}`.toUpperCase();
  };

  const normalizeActivityItem = (value) => {
    const item = value && typeof value === "object" ? value : {};
    const userName = toSafeText(item.userName || item.user_name || item.userLabel, 640);
    const userUrl = toSafeInternalPath(item.userUrl || item.user_url);
    const mangaTitle = toSafeText(item.mangaTitle || item.manga_title, 1800);
    const mangaUrl = toSafeInternalPath(item.mangaUrl || item.manga_url);
    const chapterNumberText = toSafeText(item.chapterNumberText || item.chapter_number_text, 32);
    const chapterUrl = toSafeInternalPath(item.chapterUrl || item.chapter_url);
    const avatarUrl = toSafeAvatarUrl(item.avatarUrl || item.avatar_url);
    const updatedAt = toSafeInteger(item.updatedAt || item.updated_at);

    if (!userName || !userUrl || !mangaTitle || !mangaUrl) {
      return null;
    }

    return {
      userName,
      userUrl,
      mangaTitle,
      mangaUrl,
      chapterNumberText,
      chapterUrl,
      avatarUrl,
      updatedAt
    };
  };

  const clearRefreshTimer = () => {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  };

  const applyInteractionPauseState = () => {
    if (!trackEl) return;
    trackEl.style.setProperty(
      "animation-play-state",
      isInteractionPaused ? "paused" : "running",
      "important"
    );
  };

  const setInteractionPaused = (value) => {
    isInteractionPaused = Boolean(value);
    applyInteractionPauseState();
  };

  const updateInteractionPauseState = () => {
    setInteractionPaused(isPointerInsideTicker || isFocusInsideTicker);
  };

  const handleInteractionPointerEnter = () => {
    isPointerInsideTicker = true;
    updateInteractionPauseState();
  };

  const handleInteractionPointerLeave = (event) => {
    const relatedTarget = event && event.relatedTarget;
    if (
      interactionScopeEl &&
      relatedTarget instanceof Node &&
      interactionScopeEl.contains(relatedTarget)
    ) {
      return;
    }
    isPointerInsideTicker = false;
    updateInteractionPauseState();
  };

  const handleInteractionFocusIn = () => {
    isFocusInsideTicker = true;
    updateInteractionPauseState();
  };

  const handleInteractionFocusOut = (event) => {
    const relatedTarget = event && event.relatedTarget;
    if (
      interactionScopeEl &&
      relatedTarget instanceof Node &&
      interactionScopeEl.contains(relatedTarget)
    ) {
      return;
    }
    isFocusInsideTicker = false;
    updateInteractionPauseState();
  };

  const detachInteractionListeners = () => {
    if (!boundInteractionScopeEl) return;
    boundInteractionScopeEl.removeEventListener("pointerenter", handleInteractionPointerEnter);
    boundInteractionScopeEl.removeEventListener("pointerleave", handleInteractionPointerLeave);
    boundInteractionScopeEl.removeEventListener("mouseenter", handleInteractionPointerEnter);
    boundInteractionScopeEl.removeEventListener("mouseleave", handleInteractionPointerLeave);
    boundInteractionScopeEl.removeEventListener("focusin", handleInteractionFocusIn);
    boundInteractionScopeEl.removeEventListener("focusout", handleInteractionFocusOut);
    boundInteractionScopeEl = null;
    isPointerInsideTicker = false;
    isFocusInsideTicker = false;
    updateInteractionPauseState();
  };

  const attachInteractionListeners = () => {
    if (!interactionScopeEl) return;
    if (boundInteractionScopeEl === interactionScopeEl) return;

    detachInteractionListeners();

    boundInteractionScopeEl = interactionScopeEl;
    boundInteractionScopeEl.addEventListener("pointerenter", handleInteractionPointerEnter);
    boundInteractionScopeEl.addEventListener("pointerleave", handleInteractionPointerLeave);
    boundInteractionScopeEl.addEventListener("mouseenter", handleInteractionPointerEnter);
    boundInteractionScopeEl.addEventListener("mouseleave", handleInteractionPointerLeave);
    boundInteractionScopeEl.addEventListener("focusin", handleInteractionFocusIn);
    boundInteractionScopeEl.addEventListener("focusout", handleInteractionFocusOut);
  };

  const syncTickerElements = ({ resetSignature = false } = {}) => {
    const nextRoot = document.querySelector("[data-reading-activity-ticker]");
    const nextTrack = nextRoot ? nextRoot.querySelector("[data-reading-activity-track]") : null;
    const nextInteractionScope = nextRoot
      ? nextRoot.querySelector(".reading-activity-ticker__viewport") || nextRoot
      : null;
    const didRootChange =
      nextRoot !== tickerRoot ||
      nextTrack !== trackEl ||
      nextInteractionScope !== interactionScopeEl;

    tickerRoot = nextRoot || null;
    trackEl = nextTrack || null;
    interactionScopeEl = nextInteractionScope || null;

    if (!tickerRoot || !trackEl || !interactionScopeEl) {
      detachInteractionListeners();
      endpoint = DEFAULT_ENDPOINT;
      maxItems = DEFAULT_MAX_ITEMS;
      refreshMs = DEFAULT_REFRESH_MS;
      if (didRootChange || resetSignature) {
        lastSignature = "";
      }
      return false;
    }

    attachInteractionListeners();

    endpoint = (tickerRoot.dataset.activityEndpoint || DEFAULT_ENDPOINT).toString().trim();
    const maxItemsRaw = Number(tickerRoot.dataset.maxItems);
    const refreshMsRaw = Number(tickerRoot.dataset.refreshMs);
    maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? Math.floor(maxItemsRaw) : DEFAULT_MAX_ITEMS;
    refreshMs = Number.isFinite(refreshMsRaw) && refreshMsRaw >= 3000 ? Math.floor(refreshMsRaw) : DEFAULT_REFRESH_MS;

    if (didRootChange || resetSignature) {
      lastSignature = "";
    }

    applyInteractionPauseState();

    return true;
  };

  const getTrackScrollAnimation = () => {
    if (!trackEl || typeof trackEl.getAnimations !== "function") return null;
    const animations = trackEl.getAnimations();
    if (!Array.isArray(animations) || !animations.length) return null;
    return animations.find((animation) => {
      if (!animation) return false;
      if (typeof animation.animationName === "string") {
        return animation.animationName === SCROLL_ANIMATION_NAME;
      }
      return true;
    }) || null;
  };

  const readTrackScrollProgress = () => {
    const animation = getTrackScrollAnimation();
    if (!animation) return 0;

    const timing = animation.effect && typeof animation.effect.getComputedTiming === "function"
      ? animation.effect.getComputedTiming()
      : null;
    const durationMs = timing && Number.isFinite(Number(timing.duration))
      ? Number(timing.duration)
      : 0;
    const currentTime = Number(animation.currentTime);
    if (!(durationMs > 0) || !Number.isFinite(currentTime)) return 0;

    const normalizedMs = ((currentTime % durationMs) + durationMs) % durationMs;
    return normalizedMs / durationMs;
  };

  const restoreTrackScrollProgress = (progressValue) => {
    const progress = Number(progressValue);
    if (!Number.isFinite(progress) || progress <= 0) return;

    window.requestAnimationFrame(() => {
      const animation = getTrackScrollAnimation();
      if (!animation) return;

      const timing = animation.effect && typeof animation.effect.getComputedTiming === "function"
        ? animation.effect.getComputedTiming()
        : null;
      const durationMs = timing && Number.isFinite(Number(timing.duration))
        ? Number(timing.duration)
        : 0;
      if (!(durationMs > 0)) return;

      const normalizedProgress = ((progress % 1) + 1) % 1;
      animation.currentTime = normalizedProgress * durationMs;
    });
  };

  const scheduleRefresh = () => {
    clearRefreshTimer();
    if (!syncTickerElements()) return;

    refreshTimer = window.setTimeout(() => {
      if (document.visibilityState === "hidden") {
        scheduleRefresh();
        return;
      }
      fetchAndRender().catch(() => null);
    }, refreshMs);
  };

  const buildAvatarElement = (activity) => {
    const avatarLink = document.createElement("a");
    avatarLink.className = "reading-activity-ticker__avatar-link";
    avatarLink.href = activity.userUrl;
    avatarLink.setAttribute("aria-label", `Mở trang cá nhân ${activity.userName}`);

    const avatarWrap = document.createElement("span");
    avatarWrap.className = "reading-activity-ticker__avatar-wrap";

    const avatarImage = document.createElement("img");
    avatarImage.className = "reading-activity-ticker__avatar";
    avatarImage.alt = "";
    avatarImage.loading = "eager";
    avatarImage.decoding = "async";

    const avatarFallback = document.createElement("span");
    avatarFallback.className = "reading-activity-ticker__avatar-fallback";
    avatarFallback.textContent = buildUserInitials(activity.userName);

    avatarWrap.append(avatarImage, avatarFallback);
    avatarLink.appendChild(avatarWrap);

    const avatarUrl = activity.avatarUrl;
    if (avatarUrl) {
      const handleAvatarLoad = () => {
        avatarWrap.classList.add("is-loaded");
      };

      const handleAvatarError = () => {
        avatarWrap.classList.remove("is-loaded");
        avatarImage.removeAttribute("src");
      };

      avatarImage.addEventListener("load", handleAvatarLoad, { once: true });
      avatarImage.addEventListener("error", handleAvatarError, { once: true });
      avatarImage.src = avatarUrl;

      if (avatarImage.complete && avatarImage.naturalWidth > 0) {
        handleAvatarLoad();
      }
    }

    return avatarLink;
  };

  const buildActivityItemElement = (activity) => {
    const itemEl = document.createElement("li");
    itemEl.className = "reading-activity-ticker__item";

    itemEl.appendChild(buildAvatarElement(activity));

    const contentEl = document.createElement("span");
    contentEl.className = "reading-activity-ticker__content";

    const userLink = document.createElement("a");
    userLink.className = "reading-activity-ticker__link reading-activity-ticker__link--user";
    userLink.href = activity.userUrl;
    userLink.textContent = activity.userName;

    const readingText = document.createElement("span");
    readingText.className = "reading-activity-ticker__text";
    readingText.textContent = "đang đọc";

    const mangaLink = document.createElement("a");
    mangaLink.className = "reading-activity-ticker__link reading-activity-ticker__link--manga";
    mangaLink.href = activity.mangaUrl;
    mangaLink.textContent = activity.mangaTitle;
    mangaLink.title = activity.mangaTitle;

    contentEl.append(userLink, readingText, mangaLink);

    if (activity.chapterNumberText) {
      const chapterLink = document.createElement("a");
      chapterLink.className = "reading-activity-ticker__chapter";
      chapterLink.href = activity.chapterUrl || activity.mangaUrl;
      chapterLink.textContent = `Ch. ${activity.chapterNumberText}`;
      chapterLink.title = `Đến chương ${activity.chapterNumberText}`;
      contentEl.appendChild(chapterLink);
    }

    itemEl.appendChild(contentEl);
    return itemEl;
  };

  const buildLoopElement = (items) => {
    const loopEl = document.createElement("ul");
    loopEl.className = "reading-activity-ticker__loop";

    items.forEach((item) => {
      loopEl.appendChild(buildActivityItemElement(item));
    });

    return loopEl;
  };

  const renderActivities = (items) => {
    if (!syncTickerElements()) return;

    if (!Array.isArray(items) || !items.length) {
      tickerRoot.hidden = true;
      trackEl.textContent = "";
      lastSignature = "";
      return;
    }

    const normalized = [];
    for (const rawItem of items) {
      const item = normalizeActivityItem(rawItem);
      if (!item) continue;
      normalized.push(item);
      if (normalized.length >= maxItems) break;
    }

    if (!normalized.length) {
      tickerRoot.hidden = true;
      trackEl.textContent = "";
      lastSignature = "";
      return;
    }

    const nextSignature = normalized
      .map((item) => `${item.userUrl}|${item.avatarUrl}|${item.mangaUrl}|${item.chapterNumberText}|${item.updatedAt}`)
      .join("||");

    if (nextSignature === lastSignature) {
      tickerRoot.hidden = false;
      return;
    }

    lastSignature = nextSignature;
    tickerRoot.hidden = false;
    const previousProgress = readTrackScrollProgress();
    const nextContent = document.createDocumentFragment();

    const primaryLoop = buildLoopElement(normalized);
    nextContent.appendChild(primaryLoop);

    const mirrorLoop = buildLoopElement(normalized);
    mirrorLoop.setAttribute("aria-hidden", "true");
    nextContent.appendChild(mirrorLoop);

    trackEl.replaceChildren(nextContent);

    const durationSeconds = Math.max(58, Math.min(190, normalized.length * (13 / 3)));
    trackEl.style.setProperty("--reading-activity-duration", `${durationSeconds}s`);
    applyInteractionPauseState();
    restoreTrackScrollProgress(previousProgress);
  };

  const fetchAndRender = async () => {
    if (!syncTickerElements()) {
      clearRefreshTimer();
      return;
    }

    if (!endpoint || isLoading) {
      scheduleRefresh();
      return;
    }

    const currentToken = requestToken;
    isLoading = true;
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json"
        }
      });
      if (currentToken !== requestToken) return;
      const payload = await response.json().catch(() => null);
      if (currentToken !== requestToken) return;
      if (!response.ok || !payload || payload.ok !== true) {
        return;
      }

      const activities = Array.isArray(payload.activities) ? payload.activities : [];
      renderActivities(activities);
    } catch (_error) {
      // Keep current ticker content on transient errors.
    } finally {
      isLoading = false;
      scheduleRefresh();
    }
  };

  const requestRefresh = ({ force = false } = {}) => {
    syncTickerElements({ resetSignature: force });
    requestToken += 1;
    if (force) {
      lastSignature = "";
    }
    clearRefreshTimer();
    if (!tickerRoot || !trackEl) return;
    fetchAndRender().catch(() => null);
  };

  window.addEventListener("bfang:pagechange", () => {
    requestRefresh({ force: true });
  });

  document.addEventListener("bfang:homepage-refreshed", () => {
    requestRefresh({ force: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestRefresh();
    }
  });

  requestRefresh({ force: true });
})();
