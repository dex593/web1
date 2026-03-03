(() => {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  const MANGA_DETAIL_PATH_PATTERN = /^\/manga\/[^/?#]+\/?$/i;
  const prefetchedPageUrls = new Set();
  const viewportPrefetchedUrls = new Set();
  const prefetchLinkByUrl = new Map();
  let didBindIntentPrefetch = false;
  let didRegisterServiceWorker = false;

  const { protocol, hostname } = window.location;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (protocol !== "https:" && !isLocalhost) return;

  const supportsPrefetchLink = (() => {
    try {
      const link = document.createElement("link");
      return Boolean(link && link.relList && typeof link.relList.supports === "function" && link.relList.supports("prefetch"));
    } catch (_error) {
      return false;
    }
  })();

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

  const prefetchViaHintLink = (url) => {
    if (!supportsPrefetchLink) return;
    if (!document.head) return;

    const targetUrl = (url || "").toString().trim();
    if (!targetUrl || prefetchLinkByUrl.has(targetUrl)) return;

    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "document";
    link.href = targetUrl;
    link.setAttribute("data-prefetch-page", "1");

    prefetchLinkByUrl.set(targetUrl, link);
    document.head.appendChild(link);
  };

  const prefetchViaFetch = (url) => {
    const targetUrl = (url || "").toString().trim();
    if (!targetUrl || typeof window.fetch !== "function") return;

    window
      .fetch(targetUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "force-cache",
        headers: {
          Accept: "text/html,application/xhtml+xml"
        }
      })
      .catch(() => {
        // Ignore network warmup failures.
      });
  };

  const prefetchMangaDetailPage = (hrefValue) => {
    if (!canUseIntentPrefetch()) return;
    const targetUrl = resolveMangaDetailUrl(hrefValue);
    if (!targetUrl || prefetchedPageUrls.has(targetUrl)) return;

    prefetchedPageUrls.add(targetUrl);
    postPrefetchRequest(targetUrl);

    if (!navigator.serviceWorker.controller) {
      prefetchViaHintLink(targetUrl);
      prefetchViaFetch(targetUrl);
    }
  };

  const collectMangaDetailAnchors = () =>
    Array.from(document.querySelectorAll("a[href^='/manga/']")).filter((anchor) => {
      if (!(anchor instanceof HTMLAnchorElement)) return false;
      const targetUrl = resolveMangaDetailUrl(anchor.getAttribute("href") || "");
      return Boolean(targetUrl);
    });

  const warmupVisibleMangaLinks = (limit) => {
    const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 8;
    const anchors = collectMangaDetailAnchors();
    anchors.slice(0, max).forEach((anchor) => {
      prefetchMangaDetailPage(anchor.href);
    });
  };

  const bindViewportPrefetch = () => {
    if (!("IntersectionObserver" in window)) {
      warmupVisibleMangaLinks(12);
      return;
    }

    const anchors = collectMangaDetailAnchors();
    if (!anchors.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry || !entry.isIntersecting) return;
          const anchor = entry.target;
          if (!(anchor instanceof HTMLAnchorElement)) return;
          const href = anchor.href;
          if (viewportPrefetchedUrls.has(href)) {
            observer.unobserve(anchor);
            return;
          }
          viewportPrefetchedUrls.add(href);
          prefetchMangaDetailPage(href);
          observer.unobserve(anchor);
        });
      },
      {
        root: null,
        rootMargin: "280px 0px 340px 0px",
        threshold: 0.01
      }
    );

    anchors.slice(0, 24).forEach((anchor) => {
      observer.observe(anchor);
    });

    window.setTimeout(() => {
      observer.disconnect();
    }, 20000);
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
    document.addEventListener("pointerdown", handleEvent, { passive: true, capture: true });
    document.addEventListener("focusin", handleEvent, { passive: true, capture: true });
    document.addEventListener("touchstart", handleEvent, { passive: true, capture: true });

    const warmupSoon = () => {
      warmupVisibleMangaLinks(12);
      bindViewportPrefetch();
    };

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          warmupSoon();
        },
        { once: true }
      );
    } else {
      warmupSoon();
    }

    window.addEventListener(
      "pageshow",
      () => {
        warmupVisibleMangaLinks(8);
      },
      { once: true }
    );
  };

  const registerServiceWorker = async () => {
    if (didRegisterServiceWorker) return;
    didRegisterServiceWorker = true;

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
      didRegisterServiceWorker = false;
      if (window.console && typeof window.console.warn === "function") {
        window.console.warn("Service worker registration failed.", error);
      }
    }
  };

  bindIntentPrefetch();

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        registerServiceWorker();
      },
      { once: true }
    );
    return;
  }

  registerServiceWorker();
})();
