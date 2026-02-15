(() => {
  const widget = document.querySelector("[data-notify-widget]");
  if (!widget) return;

  const toggle = widget.querySelector("[data-notify-toggle]");
  const menu = widget.querySelector("[data-notify-menu]");
  const badge = widget.querySelector("[data-notify-badge]");
  const list = widget.querySelector("[data-notify-list]");
  const empty = widget.querySelector("[data-notify-empty]");
  const markAllBtn = widget.querySelector("[data-notify-mark-all]");
  if (!toggle || !menu || !badge || !list || !empty || !markAllBtn) return;

  let signedIn = false;
  let loading = false;
  let pollingTimer = null;
  let notifications = [];
  let unreadCount = 0;

  const hasAuthSession = (session) =>
    Boolean(
      session &&
        ((session.user && typeof session.user === "object") ||
          (session.access_token && String(session.access_token).trim()))
    );

  const getSessionSafe = async () => {
    if (window.BfangAuth && typeof window.BfangAuth.getSession === "function") {
      try {
        const session = await window.BfangAuth.getSession();
        return hasAuthSession(session) ? session : null;
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

  const NOTIFY_MENU_EDGE_GAP = 8;
  const NOTIFY_MENU_TOP_GAP = 8;
  const NOTIFY_MENU_MAX_WIDTH = 360;

  const clearNotifyMenuPosition = () => {
    menu.style.position = "";
    menu.style.left = "";
    menu.style.right = "";
    menu.style.top = "";
    menu.style.width = "";
    menu.style.maxWidth = "";
  };

  const positionNotifyMenu = () => {
    if (menu.hidden) return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewportWidth || !viewportHeight) return;

    const triggerRect = toggle.getBoundingClientRect();
    const menuWidth = Math.min(
      NOTIFY_MENU_MAX_WIDTH,
      Math.max(220, viewportWidth - NOTIFY_MENU_EDGE_GAP * 2)
    );

    menu.style.position = "fixed";
    menu.style.right = "auto";
    menu.style.width = `${Math.round(menuWidth)}px`;
    menu.style.maxWidth = `${Math.round(menuWidth)}px`;
    menu.style.left = `${NOTIFY_MENU_EDGE_GAP}px`;
    menu.style.top = `${Math.round(triggerRect.bottom + NOTIFY_MENU_TOP_GAP)}px`;

    const menuRect = menu.getBoundingClientRect();
    const preferredLeft = triggerRect.right - menuRect.width;
    const maxLeft = Math.max(
      NOTIFY_MENU_EDGE_GAP,
      viewportWidth - NOTIFY_MENU_EDGE_GAP - menuRect.width
    );
    const nextLeft = Math.min(maxLeft, Math.max(NOTIFY_MENU_EDGE_GAP, preferredLeft));

    let nextTop = triggerRect.bottom + NOTIFY_MENU_TOP_GAP;
    const maxTop = viewportHeight - NOTIFY_MENU_EDGE_GAP - menuRect.height;
    if (nextTop > maxTop) {
      const fallbackTop = triggerRect.top - NOTIFY_MENU_TOP_GAP - menuRect.height;
      if (fallbackTop >= NOTIFY_MENU_EDGE_GAP) {
        nextTop = fallbackTop;
      } else {
        nextTop = Math.max(NOTIFY_MENU_EDGE_GAP, maxTop);
      }
    }

    menu.style.left = `${Math.round(nextLeft)}px`;
    menu.style.top = `${Math.round(nextTop)}px`;
  };

  const setMenuOpen = (open) => {
    const next = Boolean(open);
    menu.hidden = !next;
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
    if (next) {
      positionNotifyMenu();
    } else {
      clearNotifyMenuPosition();
    }
  };

  const stopPolling = () => {
    if (!pollingTimer) return;
    clearInterval(pollingTimer);
    pollingTimer = null;
  };

  const startPolling = () => {
    stopPolling();
    if (!signedIn) return;
    pollingTimer = setInterval(() => {
      loadNotifications().catch(() => null);
    }, 45 * 1000);
  };

  const updateBadge = (countValue) => {
    const count = Number(countValue);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (!safeCount) {
      badge.hidden = true;
      badge.textContent = "0";
      return;
    }
    badge.hidden = false;
    badge.textContent = safeCount > 99 ? "99+" : String(safeCount);
  };

  const buildAvatar = (avatarUrl) => {
    const wrap = document.createElement("span");
    wrap.className = "notify-item__avatar";

    const raw = avatarUrl == null ? "" : String(avatarUrl).trim();
    const safe =
      raw &&
      raw.length <= 500 &&
      (/^https?:\/\//i.test(raw) || raw.startsWith("/uploads/avatars/"));
    if (safe) {
      const image = document.createElement("img");
      image.src = raw;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      wrap.appendChild(image);
      return wrap;
    }

    wrap.innerHTML = "<i class='fa-regular fa-bell' aria-hidden='true'></i>";
    return wrap;
  };

  const normalizeNotification = (rawItem) => {
    const item = rawItem && typeof rawItem === "object" ? rawItem : {};
    const id = Number(item.id);
    if (!Number.isFinite(id) || id <= 0) return null;

    const rawUrl = item.url == null ? "" : String(item.url).trim();
    const url = rawUrl && rawUrl.startsWith("/") ? rawUrl : "/";
    return {
      id: Math.floor(id),
      isRead: Boolean(item.isRead),
      actorName: item.actorName == null ? "" : String(item.actorName).trim(),
      actorAvatarUrl: item.actorAvatarUrl == null ? "" : String(item.actorAvatarUrl).trim(),
      message: item.message == null ? "" : String(item.message).trim(),
      mangaTitle: item.mangaTitle == null ? "" : String(item.mangaTitle).trim(),
      chapterLabel: item.chapterLabel == null ? "" : String(item.chapterLabel).trim(),
      preview: item.preview == null ? "" : String(item.preview).trim(),
      createdAtText: item.createdAtText == null ? "" : String(item.createdAtText).trim(),
      url
    };
  };

  const renderNotifications = () => {
    list.textContent = "";

    const hasItems = Array.isArray(notifications) && notifications.length > 0;
    if (!hasItems) {
      empty.hidden = false;
      markAllBtn.hidden = true;
      if (!menu.hidden) {
        positionNotifyMenu();
      }
      return;
    }

    empty.hidden = true;
    markAllBtn.hidden = unreadCount <= 0;

    notifications.forEach((item) => {
      const link = document.createElement("a");
      link.className = `notify-item${item.isRead ? "" : " is-unread"}`;
      link.href = item.url;
      link.dataset.notifyId = String(item.id);
      link.dataset.notifyRead = item.isRead ? "1" : "0";

      const avatar = buildAvatar(item.actorAvatarUrl);

      const body = document.createElement("span");
      body.className = "notify-item__body";

      const title = document.createElement("span");
      title.className = "notify-item__title";
      title.textContent = item.message || "Bạn có thông báo mới.";

      const context = document.createElement("span");
      context.className = "notify-item__context";
      const contextParts = [item.mangaTitle, item.chapterLabel].filter(Boolean);
      context.textContent = contextParts.join(" • ");

      body.appendChild(title);
      if (context.textContent) {
        body.appendChild(context);
      }

      if (item.preview) {
        const preview = document.createElement("span");
        preview.className = "notify-item__preview";
        preview.textContent = item.preview;
        body.appendChild(preview);
      }

      const meta = document.createElement("span");
      meta.className = "notify-item__meta";
      if (item.createdAtText) {
        const time = document.createElement("span");
        time.textContent = item.createdAtText;
        meta.appendChild(time);
      }
      if (!item.isRead) {
        const dot = document.createElement("span");
        dot.className = "notify-item__dot";
        dot.setAttribute("aria-hidden", "true");
        meta.appendChild(dot);
      }

      link.appendChild(avatar);
      link.appendChild(body);
      link.appendChild(meta);
      list.appendChild(link);
    });

    if (!menu.hidden) {
      positionNotifyMenu();
    }
  };

  const requestNotificationApi = async ({ url, method }) => {
    const token = await getAccessTokenSafe();
    if (!token) return null;

    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      credentials: "same-origin",
      body: method === "GET" ? undefined : JSON.stringify({})
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      return null;
    }
    return data;
  };

  const loadNotifications = async () => {
    if (!signedIn || loading) return;
    loading = true;
    try {
      const data = await requestNotificationApi({ url: "/notifications?limit=20", method: "GET" });
      if (!data) return;

      const items = Array.isArray(data.notifications) ? data.notifications : [];
      notifications = items.map((item) => normalizeNotification(item)).filter(Boolean);

      const unread = Number(data.unreadCount);
      unreadCount = Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0;
      updateBadge(unreadCount);
      renderNotifications();
    } finally {
      loading = false;
    }
  };

  const refreshSignedInStateFromCurrentSession = async ({ load = false } = {}) => {
    const session = await getSessionSafe();
    const hasSession = hasAuthSession(session);
    applySignedInState(hasSession);
    if (hasSession && load) {
      await loadNotifications();
    }
  };

  const markNotificationRead = async (notificationId) => {
    const id = Number(notificationId);
    if (!Number.isFinite(id) || id <= 0) return false;

    const data = await requestNotificationApi({
      url: `/notifications/${Math.floor(id)}/read`,
      method: "POST"
    });
    if (!data) return false;

    notifications = notifications.map((item) =>
      item.id === Math.floor(id)
        ? {
            ...item,
            isRead: true
          }
        : item
    );

    const unread = Number(data.unreadCount);
    unreadCount = Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0;
    updateBadge(unreadCount);
    renderNotifications();
    return true;
  };

  const markAllNotificationsRead = async () => {
    const data = await requestNotificationApi({ url: "/notifications/read-all", method: "POST" });
    if (!data) return false;

    notifications = notifications.map((item) => ({
      ...item,
      isRead: true
    }));
    unreadCount = 0;
    updateBadge(unreadCount);
    renderNotifications();
    return true;
  };

  const applySignedInState = (nextSignedIn) => {
    signedIn = Boolean(nextSignedIn);
    widget.hidden = !signedIn;

    if (!signedIn) {
      stopPolling();
      setMenuOpen(false);
      notifications = [];
      unreadCount = 0;
      updateBadge(0);
      renderNotifications();
      return;
    }

    startPolling();
  };

  toggle.addEventListener("click", () => {
    if (!signedIn) return;
    const nextOpen = menu.hidden;
    setMenuOpen(nextOpen);
    if (nextOpen) {
      loadNotifications().catch(() => null);
    }
  });

  markAllBtn.addEventListener("click", (event) => {
    event.preventDefault();
    if (!signedIn || unreadCount <= 0) return;
    markAllNotificationsRead().catch(() => null);
  });

  list.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-notify-id]");
    if (!link) return;

    const id = Number(link.dataset.notifyId);
    const isRead = link.dataset.notifyRead === "1";
    if (!Number.isFinite(id) || id <= 0 || isRead) {
      setMenuOpen(false);
      return;
    }

    event.preventDefault();
    const href = link.getAttribute("href") || "/";
    markNotificationRead(id)
      .catch(() => null)
      .finally(() => {
        window.location.href = href;
      });
  });

  document.addEventListener("click", (event) => {
    if (!menu.hidden && !widget.contains(event.target)) {
      setMenuOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      setMenuOpen(false);
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      if (!menu.hidden) {
        positionNotifyMenu();
      }
    },
    { passive: true }
  );

  window.addEventListener("resize", () => {
    if (!menu.hidden) {
      positionNotifyMenu();
    }
  });

  window.addEventListener("bfang:auth", (event) => {
    const detail = event && typeof event === "object" ? event.detail : null;
    const session = detail && detail.session ? detail.session : null;
    const hasSession = hasAuthSession(session);
    applySignedInState(hasSession);
    if (hasSession) {
      loadNotifications().catch(() => null);
    } else {
      refreshSignedInStateFromCurrentSession({ load: true }).catch(() => null);
    }
  });

  const boot = async () => {
    await refreshSignedInStateFromCurrentSession({ load: true });

    window.setTimeout(() => {
      if (signedIn) return;
      refreshSignedInStateFromCurrentSession({ load: true }).catch(() => null);
    }, 1200);
  };

  const refreshOnResume = () => {
    refreshSignedInStateFromCurrentSession({ load: true }).catch(() => null);
  };

  window.addEventListener("pageshow", refreshOnResume);
  window.addEventListener("focus", refreshOnResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refreshOnResume();
  });

  boot().catch(() => null);
})();
