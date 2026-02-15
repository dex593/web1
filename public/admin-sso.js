(() => {
  const card = document.querySelector("[data-admin-sso-card]");
  if (!card) return;

  const statusEl = card.querySelector("[data-admin-sso-status]");
  const errorEl = card.querySelector("[data-admin-sso-error]");
  const ADMIN_LOGOUT_SCOPE_KEY = "logout_scope";
  const ADMIN_LOGOUT_USER_KEY = "logout_user";

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
      throw new Error(message);
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
      setStatus("");
      if (!isSilent) {
        setError((err && err.message) || "Không thể đăng nhập admin.");
      }
      return;
    }

    window.location.replace("/admin");
  };

  window.addEventListener("bfang:auth", () => {
    trySso({ silent: true }).catch(() => null);
  });

  (async () => {
    await syncWebLogoutFromAdminLogout();
    await trySso({ silent: true });
  })().catch(() => null);
})();
