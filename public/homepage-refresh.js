(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof window.fetch !== "function" || typeof window.DOMParser !== "function") return;

  const SPECULATION_SELECTOR = 'script[type="speculationrules"]';
  const HOMEPAGE_REFRESH_BLOCK_ATTRIBUTE = "data-homepage-refresh-block";
  const REFRESH_DEBOUNCE_MS = 320;
  const REFRESH_IDLE_TIMEOUT_MS = 1400;
  const REFRESH_MIN_INTERVAL_MS = 2800;
  const REFRESH_INTERACTION_GUARD_MS = 900;
  const REFRESH_LIGHT_INTERACTION_SAMPLE_MS = 220;
  let refreshTimer = 0;
  let refreshIdleToken = 0;
  let refreshRafToken = 0;
  let refreshInFlight = false;
  let lastRefreshAttemptAt = 0;
  let lastInteractionAt = 0;

  const forceInstantReveal = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(".reveal").forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      element.style.opacity = "1";
      element.style.transform = "none";
      element.style.animation = "none";
    });
  };

  const applyHomepageRankingTabs = (root) => {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    const rankingPanels = scope.querySelectorAll(".homepage-side-panel--ranking");
    rankingPanels.forEach((panel) => {
      if (!(panel instanceof HTMLElement)) return;
      if ((panel.dataset.rankingTabsBound || "").toString().trim() === "1") return;

      const tabButtons = Array.from(panel.querySelectorAll(".homepage-ranking-tabs__item[data-ranking-tab]"));
      const periodSections = Array.from(panel.querySelectorAll("[data-ranking-period]"));
      if (!tabButtons.length || !periodSections.length) return;

      const activatePeriod = (periodKey) => {
        const normalizedKey = (periodKey || "").toString().trim();
        if (!normalizedKey) return;
        tabButtons.forEach((button) => {
          if (!(button instanceof HTMLButtonElement)) return;
          const buttonKey = (button.dataset.rankingTab || "").toString().trim();
          const isActive = buttonKey === normalizedKey;
          button.classList.toggle("is-active", isActive);
          button.setAttribute("aria-pressed", isActive ? "true" : "false");
        });

        periodSections.forEach((section) => {
          if (!(section instanceof HTMLElement)) return;
          const sectionKey = (section.dataset.rankingPeriod || "").toString().trim();
          const isActive = sectionKey === normalizedKey;
          section.classList.toggle("is-active", isActive);
          if (isActive) {
            section.removeAttribute("hidden");
          } else {
            section.setAttribute("hidden", "hidden");
          }
        });
      };

      tabButtons.forEach((button) => {
        if (!(button instanceof HTMLButtonElement) || button.disabled) return;
        button.addEventListener("click", () => {
          activatePeriod(button.dataset.rankingTab || "");
        });
      });

      const activeButton = tabButtons.find((button) =>
        button.classList.contains("is-active") && !button.disabled
      );
      const fallbackButton = tabButtons.find((button) => !button.disabled);
      const initialPeriodKey = activeButton
        ? (activeButton.dataset.rankingTab || "").toString().trim()
        : fallbackButton
        ? (fallbackButton.dataset.rankingTab || "").toString().trim()
        : "";
      if (initialPeriodKey) {
        activatePeriod(initialPeriodKey);
      }

      panel.dataset.rankingTabsBound = "1";
    });
  };

  const applyHomepageCommentRowLinks = (root) => {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    const commentRows = scope.querySelectorAll(".homepage-recent-comment[data-comment-row-link]");
    commentRows.forEach((row) => {
      if (!(row instanceof HTMLElement)) return;
      if ((row.dataset.commentRowBound || "").toString().trim() === "1") return;

      const href = (row.getAttribute("data-comment-row-link") || "").toString().trim();
      if (!href) return;

      const isNativeInteractiveTarget = (target) => {
        if (!(target instanceof Element) || !target.closest) return false;
        return Boolean(target.closest("a, button, input, textarea, select, label"));
      };

      const navigateToComment = () => {
        window.location.href = href;
      };

      row.addEventListener("click", (event) => {
        if (event.defaultPrevented) return;
        if (isNativeInteractiveTarget(event.target)) return;
        navigateToComment();
      });

      row.addEventListener("keydown", (event) => {
        if (event.defaultPrevented) return;
        const key = (event.key || "").toString();
        if (key !== "Enter" && key !== " ") return;
        if (isNativeInteractiveTarget(event.target)) return;
        event.preventDefault();
        navigateToComment();
      });

      row.dataset.commentRowBound = "1";
    });
  };

  const isHomepagePath = (pathname) => (pathname || window.location.pathname || "").toString() === "/";

  const getHomepageMain = () => document.querySelector("main[data-homepage-signature]");

  const readSignature = () => {
    const homepageMain = getHomepageMain();
    return homepageMain ? (homepageMain.getAttribute("data-homepage-signature") || "").toString().trim() : "";
  };

  const getHomepageRefreshBlockKey = (element) =>
    element instanceof HTMLElement
      ? (element.getAttribute(HOMEPAGE_REFRESH_BLOCK_ATTRIBUTE) || "").toString().trim()
      : "";

  const collectHomepageRefreshBlocks = (mainElement) => {
    if (!(mainElement instanceof HTMLElement)) return [];
    return Array.from(mainElement.children).filter(
      (child) => child instanceof HTMLElement && getHomepageRefreshBlockKey(child)
    );
  };

  const applyRefreshBlockPatches = (currentMain, nextMain) => {
    if (!(currentMain instanceof HTMLElement) || !(nextMain instanceof HTMLElement)) return false;

    const currentBlocks = collectHomepageRefreshBlocks(currentMain);
    const nextBlocks = collectHomepageRefreshBlocks(nextMain);
    if (!currentBlocks.length || !nextBlocks.length) return false;

    const currentByKey = new Map();
    currentBlocks.forEach((block) => {
      const key = getHomepageRefreshBlockKey(block);
      if (!key || currentByKey.has(key)) return;
      currentByKey.set(key, block);
    });

    const nextByKey = new Map();
    for (const block of nextBlocks) {
      const key = getHomepageRefreshBlockKey(block);
      if (!key || nextByKey.has(key)) {
        return false;
      }
      nextByKey.set(key, block);
    }

    const nextKeys = new Set(nextByKey.keys());
    nextBlocks.forEach((nextBlock, index) => {
      const key = getHomepageRefreshBlockKey(nextBlock);
      if (!key) return;

      const currentBlock = currentByKey.get(key);
      const importedBlock = document.importNode(nextBlock, true);

      if (currentBlock && currentBlock.isEqualNode(importedBlock)) {
        return;
      }

      forceInstantReveal(importedBlock);
      primeRandomSliceBackgrounds(importedBlock);

      if (currentBlock && currentBlock.parentNode === currentMain) {
        currentBlock.replaceWith(importedBlock);
        currentByKey.set(key, importedBlock);
        return;
      }

      let inserted = false;
      for (let cursor = index + 1; cursor < nextBlocks.length; cursor += 1) {
        const siblingKey = getHomepageRefreshBlockKey(nextBlocks[cursor]);
        if (!siblingKey) continue;
        const siblingCurrent = currentByKey.get(siblingKey);
        if (!siblingCurrent || siblingCurrent.parentNode !== currentMain) continue;
        currentMain.insertBefore(importedBlock, siblingCurrent);
        inserted = true;
        break;
      }

      if (!inserted) {
        currentMain.appendChild(importedBlock);
      }
      currentByKey.set(key, importedBlock);
    });

    currentByKey.forEach((block, key) => {
      if (nextKeys.has(key)) return;
      if (block && block.parentNode === currentMain) {
        block.parentNode.removeChild(block);
      }
    });

    return true;
  };

  const buildRefreshUrl = () => {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.set("homepage_refresh", "1");
    url.searchParams.set("__bfv", String(Date.now()));
    return url.toString();
  };

  const primeRandomSliceBackgrounds = (root) => {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    scope.querySelectorAll(".koma-stream-ranking-list a[data-bg]").forEach((sliceLink) => {
      if (!(sliceLink instanceof HTMLElement)) return;
      if ((sliceLink.dataset.bgReady || "").toString().trim() === "1") return;
      const source = (sliceLink.getAttribute("data-bg") || "").toString().trim();
      if (!source) return;
      const escapedSource = source.replace(/"/g, '\\"');
      sliceLink.style.backgroundImage = `url("${escapedSource}"), var(--koma-placeholder-image)`;
      sliceLink.dataset.bgReady = "1";
      sliceLink.removeAttribute("data-bg");
      sliceLink.classList.add("is-bg-ready");
    });
  };

  const syncSpeculationRules = (nextDocument) => {
    if (!nextDocument) return;

    const currentScript = document.querySelector(SPECULATION_SELECTOR);
    const nextScript = nextDocument.querySelector(SPECULATION_SELECTOR);

    if (!nextScript) {
      if (currentScript && currentScript.parentNode) {
        currentScript.parentNode.removeChild(currentScript);
      }
      return;
    }

    const replacement = document.createElement("script");
    replacement.type = "speculationrules";
    replacement.textContent = nextScript.textContent || "";

    const nonceHolder = document.querySelector("script[nonce]");
    const nonceValue = nonceHolder ? (nonceHolder.getAttribute("nonce") || "").toString().trim() : "";
    if (nonceValue) {
      replacement.setAttribute("nonce", nonceValue);
    }

    if (currentScript && currentScript.parentNode) {
      currentScript.parentNode.replaceChild(replacement, currentScript);
      return;
    }

    if (document.body && document.body.firstChild) {
      document.body.insertBefore(replacement, document.body.firstChild);
      return;
    }

    if (document.body) {
      document.body.appendChild(replacement);
    }
  };

  const refreshHomepage = async () => {
    if (!isHomepagePath()) return;
    if (refreshInFlight) return;

    const homepageMain = getHomepageMain();
    if (!homepageMain) return;

    refreshInFlight = true;
    const currentSignature = readSignature();

    try {
      const response = await window.fetch(buildRefreshUrl(), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "X-BFANG-Homepage-Refresh": "1"
        }
      });
      if (!response.ok) return;

      const nextSignatureHeader = (response.headers.get("X-Homepage-Signature") || "").toString().trim();
      if (nextSignatureHeader && nextSignatureHeader === currentSignature) return;

      const nextHtml = await response.text();
      if (!nextHtml) return;

      const nextDocument = new window.DOMParser().parseFromString(nextHtml, "text/html");
      const nextMain = nextDocument.querySelector("main[data-homepage-signature]");
      const currentMain = getHomepageMain();
      if (!nextMain || !currentMain || !isHomepagePath()) return;

      const nextSignature = (nextMain.getAttribute("data-homepage-signature") || nextSignatureHeader || "")
        .toString()
        .trim();
      if (nextSignature && nextSignature === currentSignature) return;

      const patchedByBlocks = applyRefreshBlockPatches(currentMain, nextMain);
      const activeMain = patchedByBlocks ? currentMain : document.importNode(nextMain, true);
      if (!patchedByBlocks) {
        forceInstantReveal(activeMain);
        currentMain.replaceWith(activeMain);
      }

      if (nextSignature) {
        activeMain.setAttribute("data-homepage-signature", nextSignature);
      }
      primeRandomSliceBackgrounds(activeMain);
      syncSpeculationRules(nextDocument);
      document.dispatchEvent(new CustomEvent("bfang:homepage-refreshed", {
        detail: {
          signature: nextSignature || nextSignatureHeader || ""
        }
      }));
    } catch (_error) {
      // Ignore silent homepage refresh failures.
    } finally {
      lastRefreshAttemptAt = Date.now();
      refreshInFlight = false;
    }
  };

  const clearScheduledRefresh = () => {
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
      refreshTimer = 0;
    }

    if (refreshIdleToken && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(refreshIdleToken);
      refreshIdleToken = 0;
    }

    if (refreshRafToken && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(refreshRafToken);
      refreshRafToken = 0;
    }
  };

  const queueRefreshRun = () => {
    const performRefresh = () => {
      refreshRafToken = 0;
      if (!isHomepagePath()) return;
      if (refreshInFlight) return;

      const now = Date.now();
      if (now - lastRefreshAttemptAt < REFRESH_MIN_INTERVAL_MS) {
        const waitMs = REFRESH_MIN_INTERVAL_MS - (now - lastRefreshAttemptAt);
        refreshTimer = window.setTimeout(() => {
          refreshTimer = 0;
          queueRefreshRun();
        }, waitMs);
        return;
      }

      if (now - lastInteractionAt < REFRESH_INTERACTION_GUARD_MS) {
        const waitMs = REFRESH_INTERACTION_GUARD_MS - (now - lastInteractionAt);
        refreshTimer = window.setTimeout(() => {
          refreshTimer = 0;
          queueRefreshRun();
        }, waitMs);
        return;
      }

      refreshHomepage().catch(() => null);
    };

    if (document.visibilityState !== "visible") {
      const handleVisibility = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", handleVisibility);
        queueRefreshRun();
      };
      document.addEventListener("visibilitychange", handleVisibility);
      return;
    }

    const runInAnimationFrame = () => {
      if (typeof window.requestAnimationFrame === "function") {
        refreshRafToken = window.requestAnimationFrame(performRefresh);
        return;
      }
      performRefresh();
    };

    if (typeof window.requestIdleCallback === "function") {
      refreshIdleToken = window.requestIdleCallback(() => {
        refreshIdleToken = 0;
        runInAnimationFrame();
      }, { timeout: REFRESH_IDLE_TIMEOUT_MS });
      return;
    }

    runInAnimationFrame();
  };

  const scheduleRefresh = (pathname) => {
    if (!isHomepagePath(pathname)) return;
    clearScheduledRefresh();
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      queueRefreshRun();
    }, REFRESH_DEBOUNCE_MS);
  };

  const primeCurrentHomepageRandomSlices = (pathname) => {
    if (!isHomepagePath(pathname)) return;
    primeRandomSliceBackgrounds(document);
  };

  primeCurrentHomepageRandomSlices(window.location.pathname);
  applyHomepageRankingTabs(document);
  applyHomepageCommentRowLinks(document);

  const markInteraction = () => {
    lastInteractionAt = Date.now();
  };
  const markLightInteraction = () => {
    const now = Date.now();
    if (now - lastInteractionAt < REFRESH_LIGHT_INTERACTION_SAMPLE_MS) return;
    lastInteractionAt = now;
  };
  window.addEventListener("touchstart", markInteraction, { passive: true });
  window.addEventListener("pointerdown", markInteraction, { passive: true });
  window.addEventListener("wheel", markInteraction, { passive: true });
  window.addEventListener("keydown", markInteraction, { passive: true });
  window.addEventListener("pointermove", markLightInteraction, { passive: true });
  window.addEventListener("scroll", markLightInteraction, { passive: true });

  if (document.readyState === "complete") {
    scheduleRefresh(window.location.pathname);
  } else {
    window.addEventListener("load", () => {
      scheduleRefresh(window.location.pathname);
    }, { once: true });
  }

  window.addEventListener("bfang:pagechange", (event) => {
    const detail = event && event.detail && typeof event.detail === "object" ? event.detail : null;
    const pathname = detail && detail.pathname ? detail.pathname : window.location.pathname;
    primeCurrentHomepageRandomSlices(pathname);
    applyHomepageRankingTabs(document);
    applyHomepageCommentRowLinks(document);
    scheduleRefresh(pathname);
  });

  document.addEventListener("bfang:homepage-refreshed", () => {
    if (!isHomepagePath()) return;
    applyHomepageRankingTabs(document);
    applyHomepageCommentRowLinks(document);
  });
})();
