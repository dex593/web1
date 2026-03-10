(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (typeof window.fetch !== "function" || typeof window.DOMParser !== "function") return;

  const SPECULATION_SELECTOR = 'script[type="speculationrules"]';
  let refreshTimer = 0;
  let refreshInFlight = false;

  const isHomepagePath = (pathname) => (pathname || window.location.pathname || "").toString() === "/";

  const getHomepageMain = () => document.querySelector("main[data-homepage-signature]");

  const readSignature = () => {
    const homepageMain = getHomepageMain();
    return homepageMain ? (homepageMain.getAttribute("data-homepage-signature") || "").toString().trim() : "";
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

      currentMain.innerHTML = nextMain.innerHTML;
      if (nextSignature) {
        currentMain.setAttribute("data-homepage-signature", nextSignature);
      }
      primeRandomSliceBackgrounds(currentMain);
      syncSpeculationRules(nextDocument);
      document.dispatchEvent(new CustomEvent("bfang:homepage-refreshed", {
        detail: {
          signature: nextSignature || nextSignatureHeader || ""
        }
      }));
    } catch (_error) {
      // Ignore silent homepage refresh failures.
    } finally {
      refreshInFlight = false;
    }
  };

  const scheduleRefresh = (pathname) => {
    if (!isHomepagePath(pathname)) return;
    if (refreshTimer) {
      window.clearTimeout(refreshTimer);
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refreshHomepage().catch(() => null);
    }, 250);
  };

  const primeCurrentHomepageRandomSlices = (pathname) => {
    if (!isHomepagePath(pathname)) return;
    primeRandomSliceBackgrounds(document);
  };

  primeCurrentHomepageRandomSlices(window.location.pathname);

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
    scheduleRefresh(pathname);
  });
})();
