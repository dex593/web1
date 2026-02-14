const readerFloat = document.querySelector("[data-reader-float]");
const fixedNavs = Array.from(document.querySelectorAll("[data-reader-fixed]"));
const commentsSection = document.querySelector("#comments");
const quickTop = document.querySelector("[data-reader-top]");
const quickComments = document.querySelector("[data-reader-comments]");
const dropdowns = Array.from(document.querySelectorAll("[data-reader-dropdown]"));

const isElementVisible = (element) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
};

const isCommentsVisible = () => {
  if (!commentsSection) return false;
  return isElementVisible(commentsSection);
};

const isFixedVisible = () => fixedNavs.some(isElementVisible);

const initDropdown = (dropdown, closeAll) => {
  const toggle = dropdown.querySelector("[data-reader-toggle]");
  const panel = dropdown.querySelector("[data-reader-panel]");
  const list = dropdown.querySelector("[data-reader-list]");
  const scrollButtons = dropdown.querySelectorAll("[data-reader-scroll]");

  const setOpen = (open) => {
    if (open) {
      dropdown.classList.add("is-open");
    } else {
      dropdown.classList.remove("is-open");
    }
  };

  dropdown._setOpen = setOpen;

  if (toggle) {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = dropdown.classList.contains("is-open");
      closeAll(dropdown);
      setOpen(!isOpen);
    });
  }

  if (list) {
    list.addEventListener("click", (event) => {
      const option = event.target.closest("[data-reader-option]");
      if (!option) return;
      const href = option.dataset.href;
      if (href) {
        window.location.href = href;
      }
    });
  }

  scrollButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (!list) return;
      const direction = button.dataset.readerScroll;
      const amount = direction === "up" ? -160 : 160;
      list.scrollBy({ top: amount, behavior: "smooth" });
    });
  });

  if (panel) {
    panel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }
};

const closeAllDropdowns = (except) => {
  dropdowns.forEach((dropdown) => {
    if (dropdown !== except && dropdown._setOpen) {
      dropdown._setOpen(false);
    }
  });
};

dropdowns.forEach((dropdown) => initDropdown(dropdown, closeAllDropdowns));

if (readerFloat) {
  let lastScroll = window.scrollY;
  let ticking = false;
  const threshold = 8;
  const floatDropdown = readerFloat.querySelector("[data-reader-dropdown]");

  const setVisible = (visible) => {
    if (visible) {
      readerFloat.classList.add("is-visible");
    } else {
      readerFloat.classList.remove("is-visible");
    }
  };

  const updateVisibility = () => {
    const current = window.scrollY;
    const diff = current - lastScroll;
    const commentsVisible = isCommentsVisible();
    const fixedVisible = isFixedVisible();
    const floatOpen = floatDropdown && floatDropdown.classList.contains("is-open");

    if (commentsVisible || fixedVisible) {
      setVisible(false);
      if (floatOpen && floatDropdown._setOpen) {
        floatDropdown._setOpen(false);
      }
    } else if (floatOpen) {
      setVisible(true);
    } else if (diff < -threshold) {
      setVisible(true);
    } else if (diff > threshold) {
      setVisible(false);
    }

    if (!commentsVisible && !fixedVisible && current < 120) {
      setVisible(true);
    }

    lastScroll = current;
    ticking = false;
  };

  window.addEventListener("scroll", () => {
    if (!ticking) {
      window.requestAnimationFrame(updateVisibility);
      ticking = true;
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target.closest("[data-reader-dropdown]")) {
      closeAllDropdowns();
    }
  });

  updateVisibility();
}

if (quickTop) {
  quickTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

if (quickComments) {
  quickComments.addEventListener("click", () => {
    if (commentsSection) {
      commentsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

(() => {
  const prevLink = document.querySelector('a[aria-label="Chương trước"][href]');
  const nextLink = document.querySelector('a[aria-label="Chương sau"][href]');
  if (!prevLink && !nextLink) return;

  const isTextEditingContext = () => {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLElement)) return false;

    const tag = (active.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (active.getAttribute("type") || "text").toLowerCase();
      return type !== "checkbox" && type !== "radio" && type !== "button";
    }
    if (active.isContentEditable) return true;
    return false;
  };

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (isTextEditingContext()) return;

    const key = (event.key || "").toString();
    let targetHref = "";

    if (key === "ArrowRight") {
      targetHref = nextLink ? (nextLink.getAttribute("href") || "").toString().trim() : "";
    } else if (key === "ArrowLeft") {
      targetHref = prevLink ? (prevLink.getAttribute("href") || "").toString().trim() : "";
    } else {
      return;
    }

    if (!targetHref) return;
    event.preventDefault();
    window.location.href = targetHref;
  });
})();

(() => {
  const pagesRoot = document.querySelector("[data-reader-lazy-pages]");
  if (!pagesRoot) return;

  const allImages = Array.from(pagesRoot.querySelectorAll(".page-media--lazy"));
  if (!allImages.length) return;

  const resolvePageIndex = (img, fallbackIndex) => {
    const raw = Number(img && img.dataset ? img.dataset.pageIndex : NaN);
    if (Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    return fallbackIndex;
  };

  const orderedImages = allImages
    .map((img, index) => ({ img, pageIndex: resolvePageIndex(img, index) }))
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((entry) => entry.img);

  const tinyPlaceholder = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  const placeholderSrc = (orderedImages[0].getAttribute("src") || "").toString() || tinyPlaceholder;

  const connection =
    (navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection)) || null;
  const saveData = Boolean(connection && connection.saveData);
  const retryDelayMs = saveData ? 1800 : 1100;
  const maxRetryCount = saveData ? 1 : 2;
  const lookAheadCount = 3;
  const maxConcurrentLookAheadLoads = saveData ? 1 : 3;

  let chapterFullyLoaded = false;
  let triggerNextChapterPrefetch = () => {};
  let activePageIndex = 0;
  let lookAheadTimer = null;
  let viewSyncTicking = false;

  const queuedImages = [];
  const queuedImageSet = new Set();

  const getLazyState = (img) => (img && img.dataset ? (img.dataset.lazyState || "").toString() : "");

  const getLoadingCount = () =>
    orderedImages.reduce((count, img) => (getLazyState(img) === "loading" ? count + 1 : count), 0);

  const isChapterReady = () => orderedImages.every((img) => getLazyState(img) === "loaded");

  const updateChapterReadyState = () => {
    if (chapterFullyLoaded) return;
    chapterFullyLoaded = isChapterReady();
    if (chapterFullyLoaded) {
      triggerNextChapterPrefetch();
    }
  };

  const markLoaded = (img) => {
    img.dataset.lazyState = "loaded";
    img.classList.remove("is-placeholder", "is-error", "lazyerror", "lazyload");
    img.classList.add("is-loaded");
  };

  const markError = (img) => {
    img.dataset.lazyState = "error";
    img.classList.remove("is-loaded", "is-placeholder", "lazyload");
    img.classList.add("is-error");
  };

  const getRetryCount = (img) => {
    const raw = Number(img && img.dataset ? img.dataset.lazyRetryCount : NaN);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.floor(raw);
  };

  const resetRetry = (img) => {
    if (!img || !img.dataset) return;
    delete img.dataset.lazyRetryCount;
  };

  const withRetryQuery = (url, retryToken) => {
    const raw = (url || "").toString().trim();
    if (!raw) return "";

    try {
      const parsed = new URL(raw, window.location.href);
      parsed.searchParams.set("lr", String(retryToken));
      return parsed.toString();
    } catch (_err) {
      const separator = raw.includes("?") ? "&" : "?";
      return `${raw}${separator}lr=${encodeURIComponent(String(retryToken))}`;
    }
  };

  const requestUnveil = (img) => {
    if (!img) return;
    if (img.dataset) {
      img.dataset.lazyState = "loading";
    }
    const src = (img.dataset.src || "").toString().trim();
    if (!src) return;
    img.classList.remove("lazyload");
    img.src = src;
  };

  const scheduleLookAheadDrain = (delayMs) => {
    if (!queuedImages.length) return;
    if (lookAheadTimer) return;

    const delay = Number.isFinite(Number(delayMs))
      ? Math.max(0, Math.min(2500, Math.floor(Number(delayMs))))
      : 80;

    lookAheadTimer = window.setTimeout(() => {
      lookAheadTimer = null;
      drainLookAheadQueue();
    }, delay);
  };

  function drainLookAheadQueue() {
    if (!queuedImages.length) return;

    let capacity = maxConcurrentLookAheadLoads - getLoadingCount();
    if (!Number.isFinite(capacity) || capacity <= 0) {
      scheduleLookAheadDrain(220);
      return;
    }

    while (capacity > 0 && queuedImages.length) {
      const img = queuedImages.shift();
      queuedImageSet.delete(img);
      if (!img || !img.isConnected) continue;

      const state = getLazyState(img);
      if (state === "loaded" || state === "loading" || state === "error") continue;

      const src = (img.dataset && img.dataset.src ? img.dataset.src : "").toString().trim();
      if (!src) continue;

      requestUnveil(img);
      capacity -= 1;
    }

    if (queuedImages.length) {
      scheduleLookAheadDrain(220);
    }
  }

  const enqueueImageForLookAhead = (img) => {
    if (!img || !img.dataset) return;
    if (queuedImageSet.has(img)) return;

    const state = getLazyState(img);
    if (state === "loaded" || state === "loading" || state === "error") return;

    const src = (img.dataset.src || "").toString().trim();
    if (!src) return;

    queuedImageSet.add(img);
    queuedImages.push(img);
  };

  const queueLookAheadWindow = (fromIndex) => {
    if (!orderedImages.length) return;

    const start = Math.max(0, Math.min(orderedImages.length - 1, Math.floor(Number(fromIndex) || 0)));
    const end = Math.min(orderedImages.length - 1, start + lookAheadCount);

    for (let index = start; index <= end; index += 1) {
      enqueueImageForLookAhead(orderedImages[index]);
    }

    drainLookAheadQueue();
  };

  const resolveActivePageIndex = () => {
    if (!orderedImages.length) return 0;

    const viewportHeight = window.innerHeight || 0;
    if (!viewportHeight) return activePageIndex;

    const focusLine = viewportHeight * 0.38;

    for (let index = 0; index < orderedImages.length; index += 1) {
      const rect = orderedImages[index].getBoundingClientRect();
      if (rect.top <= focusLine && rect.bottom >= focusLine) {
        return index;
      }
    }

    let visibleBestIndex = -1;
    let visibleBestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < orderedImages.length; index += 1) {
      const rect = orderedImages[index].getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= viewportHeight) continue;

      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - focusLine);
      if (distance < visibleBestDistance) {
        visibleBestDistance = distance;
        visibleBestIndex = index;
      }
    }
    if (visibleBestIndex >= 0) {
      return visibleBestIndex;
    }

    for (let index = 0; index < orderedImages.length; index += 1) {
      const rect = orderedImages[index].getBoundingClientRect();
      if (rect.bottom > 0) {
        return index;
      }
    }

    return orderedImages.length - 1;
  };

  const syncActiveWindow = () => {
    activePageIndex = resolveActivePageIndex();
    queueLookAheadWindow(activePageIndex);
  };

  const scheduleActiveWindowSync = () => {
    if (viewSyncTicking) return;
    viewSyncTicking = true;
    window.requestAnimationFrame(() => {
      viewSyncTicking = false;
      syncActiveWindow();
    });
  };

  const retryLazyImage = (img) => {
    if (!img || !img.dataset) return;
    const retries = getRetryCount(img);
    if (retries >= maxRetryCount) {
      markError(img);
      drainLookAheadQueue();
      return;
    }

    const nextRetry = retries + 1;
    img.dataset.lazyRetryCount = String(nextRetry);
    img.dataset.lazyState = "idle";
    img.classList.remove("is-error", "lazyerror", "lazyloaded");
    img.classList.add("is-placeholder");

    const originalSrc =
      (img.dataset.lazyOriginalSrc || img.dataset.src || "").toString().trim();
    if (originalSrc) {
      img.dataset.lazyOriginalSrc = originalSrc;
      img.dataset.src = withRetryQuery(originalSrc, `${Date.now()}-${nextRetry}`);
    }

    img.src = "";
    if (placeholderSrc) {
      img.src = placeholderSrc;
    }

    window.setTimeout(() => {
      if (!img.isConnected) return;
      const state = (img.dataset.lazyState || "").toString();
      if (state === "loaded") return;
      requestUnveil(img);
      scheduleLookAheadDrain(240);
    }, retryDelayMs * nextRetry);
  };

  orderedImages.forEach((img) => {
    if (!img.dataset.lazyState) {
      img.dataset.lazyState = img.classList.contains("is-loaded") ? "loaded" : "idle";
    }

    const originalSrc = (img.dataset.src || "").toString().trim();
    if (originalSrc) {
      img.dataset.lazyOriginalSrc = originalSrc;
      img.classList.remove("lazyload");
    }

    if (img.classList.contains("is-loaded") || (img.complete && img.naturalWidth > 0)) {
      markLoaded(img);
    }

    img.addEventListener("lazybeforeunveil", () => {
      img.dataset.lazyState = "loading";
      img.classList.remove("is-error");
    });

    img.addEventListener("load", () => {
      resetRetry(img);
      markLoaded(img);
      updateChapterReadyState();
      drainLookAheadQueue();
    });

    img.addEventListener("lazyloaded", () => {
      resetRetry(img);
      markLoaded(img);
      updateChapterReadyState();
      drainLookAheadQueue();
    });

    img.addEventListener("error", () => {
      const state = (img.dataset.lazyState || "").toString();
      if (state === "loaded") return;
      retryLazyImage(img);
    });

    img.addEventListener("click", () => {
      const state = (img.dataset.lazyState || "").toString();
      if (state !== "error") return;
      img.dataset.lazyRetryCount = "0";
      retryLazyImage(img);
    });
  });

  chapterFullyLoaded = isChapterReady();
  syncActiveWindow();

  window.addEventListener("scroll", scheduleActiveWindowSync, { passive: true });
  window.addEventListener("resize", scheduleActiveWindowSync, { passive: true });

  const nextChapterPrefetchUrls = (() => {
    const encoded = (pagesRoot.dataset.readerNextPrefetch || "").toString().trim();
    if (!encoded) return [];

    let parsed = null;
    try {
      parsed = JSON.parse(decodeURIComponent(encoded));
    } catch (_err) {
      parsed = null;
    }

    const list = Array.isArray(parsed) ? parsed : [];
    return list
      .map((value) => (value == null ? "" : String(value)).trim())
      .filter((value) => value && value.length <= 2000)
      .filter((value) => value.startsWith("/") || /^https?:\/\//i.test(value));
  })();

  const nextPrefetchConcurrency = saveData ? 0 : 1;
  if (!nextPrefetchConcurrency || !nextChapterPrefetchUrls.length) return;

  const prefetchQueue = Array.from(new Set(nextChapterPrefetchUrls));
  const prefetchedSet = new Set();
  const prefetchRefs = [];
  let prefetchInFlight = 0;
  let prefetchTimer = null;

  const canPrefetchNow = () => {
    if (document.hidden) return false;
    if (!prefetchQueue.length) return false;

    if (!chapterFullyLoaded) return false;
    if (getLoadingCount() > 0) return false;

    return true;
  };

  const schedulePrefetch = (delayMs) => {
    if (!prefetchQueue.length) return;
    if (prefetchTimer) return;

    const delay = Number.isFinite(Number(delayMs))
      ? Math.max(200, Math.min(6000, Math.floor(Number(delayMs))))
      : 900;

    prefetchTimer = window.setTimeout(() => {
      prefetchTimer = null;
      drainPrefetch();
    }, delay);
  };

  const prefetchUrl = (url) => {
    const normalized = (url || "").toString().trim();
    if (!normalized || prefetchedSet.has(normalized)) return;
    prefetchedSet.add(normalized);

    prefetchInFlight += 1;

    const image = new Image();
    prefetchRefs.push(image);
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    try {
      image.fetchPriority = "low";
    } catch (_err) {
      // ignore
    }

    const done = () => {
      image.onload = null;
      image.onerror = null;
      prefetchInFlight = Math.max(0, prefetchInFlight - 1);
      if (prefetchQueue.length) {
        schedulePrefetch(900);
      }
    };

    image.onload = done;
    image.onerror = done;
    image.src = normalized;
  };

  function drainPrefetch() {
    if (!canPrefetchNow()) {
      if (prefetchQueue.length) {
        schedulePrefetch(1800);
      }
      return;
    }

    while (prefetchInFlight < nextPrefetchConcurrency && prefetchQueue.length) {
      const url = prefetchQueue.shift();
      if (!url) continue;
      prefetchUrl(url);
    }

    if (prefetchQueue.length) {
      schedulePrefetch(1200);
    }
  }

  triggerNextChapterPrefetch = () => {
    if (!prefetchQueue.length) return;
    schedulePrefetch(420);
  };

  if (chapterFullyLoaded) {
    triggerNextChapterPrefetch();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      schedulePrefetch(420);
    }
  });
})();
