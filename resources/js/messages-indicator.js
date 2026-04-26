(() => {
  const widget = document.querySelector("[data-message-widget]");
  const badge = widget ? widget.querySelector("[data-message-badge]") : null;
  if (!widget || !badge) return;

  let signedIn = false;
  let loading = false;
  let pollTimer = null;
  let stream = null;
  let refreshTimer = null;

  const MESSAGES_POLL_INTERVAL_MS = 60 * 1000;
  const MESSAGES_REFRESH_DEBOUNCE_MS = 250;
  const MESSAGES_FETCH_TIMEOUT_MS = 8000;

  const isDocumentVisible = () =>
    !document.visibilityState || document.visibilityState === "visible";

  const createAbortTimeout = (timeoutMs) => {
    const maxMs = Number(timeoutMs);
    if (!window.AbortController || !Number.isFinite(maxMs) || maxMs <= 0) {
      return { signal: undefined, cleanup: () => {} };
    }

    const controller = new window.AbortController();
    const timer = window.setTimeout(() => {
      try {
        controller.abort();
      } catch (_err) {
        // ignore
      }
    }, Math.floor(maxMs));

    return {
      signal: controller.signal,
      cleanup: () => {
        window.clearTimeout(timer);
      }
    };
  };

  const hasAuthSession = (session) =>
    Boolean(
      session &&
        ((session.user && typeof session.user === "object") ||
          (session.access_token && String(session.access_token).trim()))
    );

  const getSessionSafe = async () => {
    if (!window.BfangAuth || typeof window.BfangAuth.getSession !== "function") {
      return null;
    }

    try {
      const session = await window.BfangAuth.getSession();
      return hasAuthSession(session) ? session : null;
    } catch (_err) {
      return null;
    }
  };

  const updateBadge = (countValue) => {
    const count = Number(countValue);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (!safeCount) {
      badge.hidden = true;
      badge.textContent = "0";
      widget.setAttribute("data-has-unread", "0");
      return;
    }

    badge.hidden = false;
    badge.textContent = safeCount > 99 ? "99+" : String(safeCount);
    widget.setAttribute("data-has-unread", "1");
  };

  const loadUnreadCount = async () => {
    if (!signedIn || loading) return;
    loading = true;
    const { signal, cleanup } = createAbortTimeout(MESSAGES_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch("/messages/unread-count?format=json", {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json"
        },
        credentials: "same-origin",
        signal
      });

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) return;
      updateBadge(data.unreadCount);
    } catch (_err) {
      // ignore
    } finally {
      cleanup();
      loading = false;
    }
  };

  const scheduleRefresh = () => {
    if (!signedIn) return;
    if (refreshTimer) return;

    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      loadUnreadCount().catch(() => null);
    }, MESSAGES_REFRESH_DEBOUNCE_MS);
  };

  const stopPolling = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const startPolling = () => {
    stopPolling();
    if (!signedIn) return;
    pollTimer = setInterval(() => {
      if (!signedIn) return;
      if (document.visibilityState && document.visibilityState !== "visible") return;
      loadUnreadCount().catch(() => null);
    }, MESSAGES_POLL_INTERVAL_MS);
  };

  const stopStream = () => {
    if (!stream) return;
    try {
      stream.close();
    } catch (_err) {
      // ignore
    }
    stream = null;
  };

  const startStream = () => {
    stopStream();
    if (!signedIn || typeof window.EventSource !== "function" || !isDocumentVisible()) return;

    stream = new window.EventSource("/messages/stream");
    stream.addEventListener("ready", () => {
      scheduleRefresh();
    });
    stream.addEventListener("chat", () => {
      scheduleRefresh();
    });
    stream.addEventListener("heartbeat", () => {
      // keep alive
    });
    stream.onerror = () => {
      // EventSource handles auto reconnect.
    };
  };

  const applySignedInState = (nextSignedIn) => {
    signedIn = Boolean(nextSignedIn);
    widget.hidden = !signedIn;

    if (!signedIn) {
      stopPolling();
      stopStream();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      updateBadge(0);
      return;
    }

    startPolling();
    if (isDocumentVisible()) {
      startStream();
    }
    loadUnreadCount().catch(() => null);
  };

  const refreshSignedInStateFromCurrentSession = async ({ load = false } = {}) => {
    const session = await getSessionSafe();
    const hasSession = hasAuthSession(session);
    applySignedInState(hasSession);
    if (hasSession && load) {
      await loadUnreadCount();
    }
  };

  window.addEventListener("bfang:auth", (event) => {
    const detail = event && typeof event === "object" ? event.detail : null;
    const session = detail && detail.session ? detail.session : null;
    const hasSession = hasAuthSession(session);
    applySignedInState(hasSession);
    if (hasSession) {
      loadUnreadCount().catch(() => null);
    }
  });

  window.addEventListener("bfang:messages:viewed", () => {
    if (!signedIn) return;
    scheduleRefresh();
  });

  const refreshOnResume = () => {
    refreshSignedInStateFromCurrentSession({ load: true }).catch(() => null);
    if (signedIn && isDocumentVisible()) {
      startStream();
    }
  };

  window.addEventListener("pageshow", refreshOnResume);
  window.addEventListener("focus", refreshOnResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      stopStream();
      return;
    }
    refreshOnResume();
  });

  refreshSignedInStateFromCurrentSession({ load: true }).catch(() => null);
})();
