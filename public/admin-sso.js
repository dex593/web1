(() => {
  const card = document.querySelector("[data-admin-sso-card]");
  if (!card) return;

  const statusEl = card.querySelector("[data-admin-sso-status]");
  const errorEl = card.querySelector("[data-admin-sso-error]");
  const ADMIN_LOGOUT_SCOPE_KEY = "logout_scope";
  const ADMIN_LOGOUT_USER_KEY = "logout_user";
  const ADMIN_NEXT_KEY = "next";
  const ADMIN_FALLBACK_KEY = "fallback";

  const normalizeSafeRedirectPath = (value, fallback = "") => {
    const raw = (value == null ? "" : String(value)).trim();
    if (!raw) return (fallback || "").toString().trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
      return (fallback || "").toString().trim();
    }
    return raw.startsWith("/") ? raw : `/${raw}`;
  };

  const normalizeForumRedirectPath = (value, fallback = "") => {
    const normalized = normalizeSafeRedirectPath(value, "");
    if (!normalized || !normalized.startsWith("/forum")) {
      return normalizeSafeRedirectPath(fallback, "");
    }
    return normalized;
  };

  const resolveRedirectTargets = () => {
    const params = new URLSearchParams(window.location.search);
    const nextFromCard = card.getAttribute("data-next-target") || "";
    const fallbackFromCard = card.getAttribute("data-fallback-target") || "";
    const next = normalizeForumRedirectPath(nextFromCard || params.get(ADMIN_NEXT_KEY) || "", "");
    const fallback = normalizeForumRedirectPath(
      fallbackFromCard || params.get(ADMIN_FALLBACK_KEY) || "",
      "/forum"
    );
    return { next, fallback };
  };

  const redirectTargets = resolveRedirectTargets();

  const setText = (el, text, showWhenEmpty = false) => {
    if (!el) return;
    const message = (text || "").toString().trim();
    el.textContent = message;
    el.hidden = !message && !showWhenEmpty;
  };

  const setStatus = (text) => setText(statusEl, text);
  const setError = (text) => setText(errorEl, text);

  const getLogoutParams = () => {
    const params = new URLSearchParams(window.location.search);
    const scope = (params.get(ADMIN_LOGOUT_SCOPE_KEY) || "").toString().trim().toLowerCase();
    const userId = (params.get(ADMIN_LOGOUT_USER_KEY) || "").toString().trim();
    return {
      scope,
      userId,
      shouldLogoutWeb: scope === "web"
    };
  };

  const clearLogoutParamsFromUrl = () => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(ADMIN_LOGOUT_SCOPE_KEY) && !url.searchParams.has(ADMIN_LOGOUT_USER_KEY)) {
      return;
    }

    url.searchParams.delete(ADMIN_LOGOUT_SCOPE_KEY);
    url.searchParams.delete(ADMIN_LOGOUT_USER_KEY);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const syncWebLogoutFromAdminLogout = async () => {
    const logout = getLogoutParams();
    if (!logout.shouldLogoutWeb) {
      return;
    }

    if (!window.BfangAuth) {
      clearLogoutParamsFromUrl();
      return;
    }

    const getSession =
      typeof window.BfangAuth.getSession === "function" ? window.BfangAuth.getSession.bind(window.BfangAuth) : null;
    const signOut =
      typeof window.BfangAuth.signOut === "function" ? window.BfangAuth.signOut.bind(window.BfangAuth) : null;

    if (!getSession || !signOut) {
      clearLogoutParamsFromUrl();
      return;
    }

    const session = await getSession().catch(() => null);
    const sessionUserId =
      session && session.user && session.user.id ? String(session.user.id).trim() : "";
    const shouldSignOutWeb = sessionUserId && (!logout.userId || logout.userId === sessionUserId);

    if (shouldSignOutWeb) {
      await signOut().catch(() => null);
      setStatus("Đã đăng xuất quản trị và đăng xuất tài khoản web.");
    } else {
      setStatus("Đã đăng xuất quản trị.");
    }

    clearLogoutParamsFromUrl();
  };

  const postSso = async () => {
    const response = await fetch("/admin/sso", {
      method: "POST",
      headers: {
        Accept: "application/json"
      },
      credentials: "same-origin"
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const message = data && data.error ? String(data.error) : "Không thể đăng nhập admin.";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
  };

  const trySso = async ({ silent } = {}) => {
    const isSilent = Boolean(silent);
    setError("");
    if (!window.BfangAuth) {
      if (!isSilent) {
        setError("Không tải được hệ thống đăng nhập.");
      }
      return;
    }

    const session =
      window.BfangAuth && typeof window.BfangAuth.getSession === "function"
        ? await window.BfangAuth.getSession().catch(() => null)
        : null;
    const signedIn = Boolean(session && session.user);
    if (!signedIn) {
      if (!isSilent) {
        setStatus("Vui lòng đăng nhập Google hoặc Discord để tiếp tục.");
      }
      return;
    }

    setStatus("Đang kiểm tra quyền...");
    try {
      await postSso();
    } catch (err) {
      const status = Number(err && typeof err === "object" && "status" in err ? err.status : 0);
      if (status === 403 && redirectTargets.fallback) {
        window.location.replace(redirectTargets.fallback);
        return;
      }

      setStatus("");
      if (!isSilent) {
        setError((err && err.message) || "Không thể đăng nhập admin.");
      }
      return;
    }

    window.location.replace(redirectTargets.next || "/admin");
  };

  window.addEventListener("bfang:auth", () => {
    trySso({ silent: true }).catch(() => null);
  });

  (async () => {
    await syncWebLogoutFromAdminLogout();
    await trySso({ silent: true });
  })().catch(() => null);
})();
