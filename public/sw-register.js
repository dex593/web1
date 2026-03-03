(() => {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  const MANGA_DETAIL_PATH_PATTERN = /^\/manga\/[^/?#]+\/?$/i;
  const prefetchedPageUrls = new Set();
  let didBindIntentPrefetch = false;

  const { protocol, hostname } = window.location;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (protocol !== "https:" && !isLocalhost) return;

  const postSkipWaiting = (worker) => {
    if (!worker || typeof worker.postMessage !== "function") return;
    worker.postMessage({ type: "SKIP_WAITING" });
  };

  const canUseIntentPrefetch = () => {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) return true;

    if (connection.saveData) return false;
    const effectiveType = (connection.effectiveType || "").toString().toLowerCase();
    if (!effectiveType) return true;
    return !effectiveType.includes("2g");
  };

  const resolveMangaDetailUrl = (hrefValue) => {
    const rawHref = (hrefValue || "").toString().trim();
    if (!rawHref) return "";

    let resolved;
    try {
      resolved = new URL(rawHref, window.location.origin);
    } catch (_error) {
      return "";
    }

    if (resolved.origin !== window.location.origin) return "";
    if (!MANGA_DETAIL_PATH_PATTERN.test(resolved.pathname || "")) return "";
    return resolved.toString();
  };

  const postPrefetchRequest = (url) => {
    const targetUrl = (url || "").toString().trim();
    if (!targetUrl) return;

    navigator.serviceWorker.ready
      .then((registration) => {
        if (!registration) return;
        const worker = registration.active || registration.waiting || registration.installing;
        if (!worker || typeof worker.postMessage !== "function") return;
        worker.postMessage({
          type: "PREFETCH_PAGE",
          url: targetUrl
        });
      })
      .catch(() => {
        // Ignore prefetch messaging errors.
      });
  };

  const prefetchMangaDetailPage = (hrefValue) => {
    if (!canUseIntentPrefetch()) return;
    const targetUrl = resolveMangaDetailUrl(hrefValue);
    if (!targetUrl || prefetchedPageUrls.has(targetUrl)) return;

    prefetchedPageUrls.add(targetUrl);
    postPrefetchRequest(targetUrl);
  };

  const bindIntentPrefetch = () => {
    if (didBindIntentPrefetch) return;
    didBindIntentPrefetch = true;

    const handleEvent = (event) => {
      const target = event && event.target instanceof Element
        ? event.target.closest("a[href]")
        : null;
      if (!target) return;
      prefetchMangaDetailPage(target.getAttribute("href"));
    };

    document.addEventListener("pointerover", handleEvent, { passive: true, capture: true });
    document.addEventListener("focusin", handleEvent, { passive: true, capture: true });
    document.addEventListener("touchstart", handleEvent, { passive: true, capture: true });

    const warmupSoon = () => {
      const candidates = Array.from(document.querySelectorAll("a[href^='/manga/']"))
        .slice(0, 8);
      candidates.forEach((anchor) => {
        if (!(anchor instanceof HTMLAnchorElement)) return;
        prefetchMangaDetailPage(anchor.href);
      });
    };

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(
        () => {
          warmupSoon();
        },
        { timeout: 2400 }
      );
    } else {
      window.setTimeout(warmupSoon, 1200);
    }
  };

  const registerServiceWorker = async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

      if (registration.waiting) {
        postSkipWaiting(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installingWorker = registration.installing;
        if (!installingWorker) return;

        installingWorker.addEventListener("statechange", () => {
          if (installingWorker.state !== "installed") return;
          if (!navigator.serviceWorker.controller) return;
          postSkipWaiting(installingWorker);
        });
      });

      let hasReloadedOnControllerChange = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hasReloadedOnControllerChange) return;
        hasReloadedOnControllerChange = true;
        window.location.reload();
      });

      bindIntentPrefetch();
    } catch (error) {
      if (window.console && typeof window.console.warn === "function") {
        window.console.warn("Service worker registration failed.", error);
      }
    }
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(
      () => {
        registerServiceWorker();
      },
      { timeout: 3000 }
    );
    return;
  }

  window.setTimeout(() => {
    registerServiceWorker();
  }, 1200);
})();
