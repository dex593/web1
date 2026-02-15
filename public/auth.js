(() => {
  const authRoot = document.documentElement;

  const authConfig = window.__AUTH && typeof window.__AUTH === "object" ? window.__AUTH : {};
  const providerConfig =
    authConfig && typeof authConfig.providers === "object" && authConfig.providers
      ? authConfig.providers
      : {};

  const authHintStorageKey = "bfang_auth_hint";
  const authProviderStorageKey = "bfang_auth_provider";
  const authServerSessionVersionStorageKey = "bfang_server_session_version";
  const supportedAuthProviders = ["google", "discord"];

  const authProviderEnabled = {
    google: Boolean(providerConfig.google),
    discord: Boolean(providerConfig.discord)
  };

  const setAuthRootState = (ready, hint) => {
    if (!authRoot) return;
    const safeHint = hint === "in" ? "in" : "out";
    authRoot.setAttribute("data-auth-hint", safeHint);
    authRoot.setAttribute("data-auth-ready", ready ? "1" : "0");
  };

  const normalizeServerSessionVersion = (value) => {
    const raw = value == null ? "" : String(value).trim();
    if (!raw) return "";
    if (raw.length > 64) return "";
    if (!/^[a-z0-9._-]+$/i.test(raw)) return "";
    return raw;
  };

  const detectServerSessionVersionChange = (value) => {
    const currentVersion = normalizeServerSessionVersion(value);
    if (!currentVersion) return false;
    try {
      const previousVersion = normalizeServerSessionVersion(
        window.localStorage.getItem(authServerSessionVersionStorageKey)
      );
      window.localStorage.setItem(authServerSessionVersionStorageKey, currentVersion);
      return Boolean(previousVersion && previousVersion !== currentVersion);
    } catch (_err) {
      return false;
    }
  };

  const readAuthHint = () => {
    try {
      const hint = (window.localStorage.getItem(authHintStorageKey) || "").toString().trim().toLowerCase();
      return hint === "in" ? "in" : "out";
    } catch (_err) {
      return "out";
    }
  };

  const writeAuthHint = (signedIn) => {
    try {
      window.localStorage.setItem(authHintStorageKey, signedIn ? "in" : "out");
    } catch (_err) {
      // ignore
    }
  };

  const forceSignOutOnServerRestart = detectServerSessionVersionChange(authConfig.sessionVersion || "");
  if (forceSignOutOnServerRestart) {
    writeAuthHint(false);
  }

  setAuthRootState(false, forceSignOutOnServerRestart ? "out" : readAuthHint());

  const normalizeAuthProvider = (value) => {
    const raw = (value || "").toString().trim().toLowerCase();
    if (supportedAuthProviders.includes(raw) && authProviderEnabled[raw]) {
      return raw;
    }
    if (authProviderEnabled.google) return "google";
    if (authProviderEnabled.discord) return "discord";
    return "google";
  };

  const readPreferredAuthProvider = () => {
    try {
      return normalizeAuthProvider(window.localStorage.getItem(authProviderStorageKey));
    } catch (_err) {
      return normalizeAuthProvider("");
    }
  };

  let preferredAuthProvider = readPreferredAuthProvider();

  const storePreferredAuthProvider = (value) => {
    const provider = normalizeAuthProvider(value);
    preferredAuthProvider = provider;
    try {
      window.localStorage.setItem(authProviderStorageKey, provider);
    } catch (_err) {
      // ignore
    }
    return provider;
  };

  const authStateListeners = new Set();
  const emitAuthStateChange = (event, session) => {
    authStateListeners.forEach((listener) => {
      try {
        listener(event, session);
      } catch (_err) {
        // ignore listener failure
      }
    });
  };

  let cachedUserId = "";
  let cachedUsername = "";
  let cachedProfile = null;
  let avatarPreviewOverride = "";
  let profileFetchPromise = null;
  let sessionRequestPromise = null;
  let sessionLoaded = false;
  let lastSession = null;

  const setMeProfile = (profile) => {
    cachedProfile = profile && typeof profile === "object" ? profile : null;
    if (window.BfangAuth) {
      window.BfangAuth.me = cachedProfile;
    }
    try {
      window.dispatchEvent(new CustomEvent("bfang:me", { detail: { profile: cachedProfile } }));
    } catch (_err) {
      // ignore
    }
  };

  const setUsernameWidgets = (username) => {
    const value = (username || "").toString().trim();
    const label = value ? `@${value}` : "";
    document.querySelectorAll("[data-auth-username]").forEach((el) => {
      el.textContent = label;
    });
  };

  const normalizeAvatarCandidate = (value) => {
    const url = value == null ? "" : String(value).trim();
    if (!url) return "";
    if (url.length > 500) return "";
    if (!/^https?:\/\//i.test(url) && !url.startsWith("/uploads/avatars/")) return "";
    return url;
  };

  const readIdentityAvatar = (user, provider) => {
    const wantedProvider = (provider || "").toString().trim().toLowerCase();
    if (!wantedProvider) return "";

    const identities = user && Array.isArray(user.identities) ? user.identities : [];
    for (const identity of identities) {
      if (!identity || typeof identity !== "object") continue;
      const identityData =
        identity.identity_data && typeof identity.identity_data === "object" ? identity.identity_data : {};
      const identityProvider = (identity.provider || identity.provider_id || identityData.provider || "")
        .toString()
        .trim()
        .toLowerCase();
      if (identityProvider !== wantedProvider) continue;

      const avatarUrl = normalizeAvatarCandidate(
        identityData.avatar_url ||
          identityData.picture ||
          identityData.photo_url ||
          identityData.photoURL ||
          identityData.profile_image ||
          ""
      );
      if (avatarUrl) return avatarUrl;
    }

    return "";
  };

  const buildAvatarUrl = (user) => {
    if (!user) return "";
    const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;

    const customAvatarUrl = normalizeAvatarCandidate(meta && meta.avatar_url_custom ? meta.avatar_url_custom : "");
    if (customAvatarUrl) return customAvatarUrl;

    const googleAvatarUrl = readIdentityAvatar(user, "google");
    if (googleAvatarUrl) return googleAvatarUrl;

    const metadataAvatarUrl = normalizeAvatarCandidate(
      (meta && meta.avatar_url ? meta.avatar_url : "") || (meta && meta.picture ? meta.picture : "") || ""
    );
    if (metadataAvatarUrl) return metadataAvatarUrl;

    return readIdentityAvatar(user, "discord");
  };

  const buildDisplayName = (user) => {
    if (!user) return "";
    const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;
    const custom = meta && meta.display_name ? String(meta.display_name).trim() : "";
    const fullName = meta && meta.full_name ? String(meta.full_name).trim() : "";
    const fallbackName = meta && meta.name ? String(meta.name).trim() : "";
    const email = user.email ? String(user.email).trim() : "";
    const candidate = (custom || fullName || fallbackName || email || "").replace(/\s+/g, " ").trim();
    if (!candidate) return "";
    if (candidate.length <= 30) return candidate;
    return `${candidate.slice(0, 27)}...`;
  };

  const setAvatarPreview = (url) => {
    avatarPreviewOverride = normalizeAvatarCandidate(url);
    updateWidgets(lastSession);
  };

  const clearAvatarPreview = () => {
    avatarPreviewOverride = "";
    updateWidgets(lastSession);
  };

  const getSafeNext = () => {
    const pathname = (window.location.pathname || "").toString();
    const search = (window.location.search || "").toString();
    const hash = (window.location.hash || "").toString();
    const next = `${pathname}${search}${hash}`;
    if (!next.startsWith("/")) return "/";
    if (next.startsWith("/auth/")) return "/";
    if (next.length > 300) return "/";
    return next || "/";
  };

  const fetchMeProfile = async () => {
    const response = await fetch("/account/me", {
      headers: {
        Accept: "application/json"
      },
      credentials: "same-origin"
    }).catch(() => null);

    if (!response) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true || !data.profile) {
      return null;
    }
    return data.profile;
  };

  const refreshProfileForSession = (session) => {
    const user = session && session.user ? session.user : null;
    const userId = user && user.id ? String(user.id).trim() : "";

    if (!userId) {
      cachedUserId = "";
      cachedUsername = "";
      setMeProfile(null);
      setUsernameWidgets("");
      updateWidgets(lastSession);
      return Promise.resolve();
    }

    if (profileFetchPromise) {
      return profileFetchPromise;
    }

    if (cachedUserId === userId && cachedProfile) {
      setUsernameWidgets(cachedUsername);
      updateWidgets(lastSession);
      return Promise.resolve();
    }

    profileFetchPromise = fetchMeProfile()
      .then((profile) => {
        cachedUserId = userId;
        cachedUsername = profile && profile.username ? String(profile.username).trim() : "";
        setMeProfile(profile);
        setUsernameWidgets(cachedUsername);
        updateWidgets(lastSession);
      })
      .catch(() => {
        cachedUserId = userId;
        cachedUsername = "";
        setMeProfile(null);
        setUsernameWidgets("");
        updateWidgets(lastSession);
      })
      .finally(() => {
        profileFetchPromise = null;
      });

    return profileFetchPromise;
  };

  const updateCommentForms = (session) => {
    const signedIn = Boolean(session && session.user);
    document.querySelectorAll("[data-comment-form]").forEach((form) => {
      const textarea = form.querySelector("textarea[name='content']");
      const submit = form.querySelector("button[type='submit']");
      if (!textarea) return;

      if (signedIn) {
        textarea.disabled = false;
        if (submit) submit.disabled = false;
        textarea.setAttribute("placeholder", "Viết bình luận...");
        return;
      }

      textarea.value = "";
      textarea.disabled = true;
      if (submit) submit.disabled = true;
      textarea.setAttribute("placeholder", "Đăng nhập để bình luận...");
    });
  };

  const updateWidgets = (session) => {
    const signedIn = Boolean(session && session.user);
    const user = session && session.user ? session.user : null;
    const name = signedIn ? buildDisplayName(user) : "";
    const profileAvatarUrl =
      signedIn && cachedProfile && cachedProfile.avatarUrl
        ? normalizeAvatarCandidate(cachedProfile.avatarUrl)
        : "";
    const avatarUrl = signedIn ? avatarPreviewOverride || profileAvatarUrl || buildAvatarUrl(user) : "";

    document.querySelectorAll("[data-auth-widget]").forEach((widget) => {
      const loginButtons = widget.querySelectorAll("[data-auth-login]");
      const profile = widget.querySelector("[data-auth-profile]");
      const nameEl = widget.querySelector("[data-auth-name]");
      const avatarEl = widget.querySelector("[data-auth-avatar]");

      loginButtons.forEach((button) => {
        button.hidden = signedIn;
      });
      if (profile) profile.hidden = !signedIn;
      if (nameEl) nameEl.textContent = name || "";

      if (avatarEl) {
        if (avatarUrl) {
          if (avatarEl.src !== avatarUrl) {
            avatarEl.src = avatarUrl;
          }
          avatarEl.hidden = false;
        } else {
          avatarEl.hidden = true;
          avatarEl.removeAttribute("src");
        }
      }
    });
  };

  const applyAuthState = (session, eventName) => {
    const safeSession = session && session.user ? session : null;
    const signedIn = Boolean(safeSession && safeSession.user);
    const previousSignedIn = Boolean(lastSession && lastSession.user);
    lastSession = safeSession;
    sessionLoaded = true;

    if (!signedIn) {
      cachedUserId = "";
      cachedUsername = "";
      setMeProfile(null);
      setUsernameWidgets("");
    }

    writeAuthHint(signedIn);
    setAuthRootState(true, signedIn ? "in" : "out");
    updateWidgets(lastSession);
    updateCommentForms(lastSession);

    if (signedIn) {
      refreshProfileForSession(lastSession).catch(() => null);
    }

    const event = eventName || (signedIn ? (previousSignedIn ? "TOKEN_REFRESHED" : "SIGNED_IN") : "SIGNED_OUT");
    emitAuthStateChange(event, lastSession);

    try {
      window.dispatchEvent(
        new CustomEvent("bfang:auth", {
          detail: {
            session: lastSession,
            signedIn
          }
        })
      );
    } catch (_err) {
      // ignore
    }
  };

  const requestSession = async () => {
    const response = await fetch("/auth/session", {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      credentials: "same-origin",
      cache: "no-store"
    }).catch(() => null);

    if (!response) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      return null;
    }

    const session = data && data.session && data.session.user ? data.session : null;
    return session;
  };

  const loadSession = ({ force } = {}) => {
    const shouldForce = Boolean(force);
    if (!shouldForce && sessionLoaded) {
      return Promise.resolve(lastSession);
    }

    if (!shouldForce && sessionRequestPromise) {
      return sessionRequestPromise;
    }

    sessionRequestPromise = requestSession()
      .then((session) => {
        applyAuthState(session, shouldForce ? "TOKEN_REFRESHED" : undefined);
        return lastSession;
      })
      .catch(() => {
        applyAuthState(null, "SIGNED_OUT");
        return null;
      })
      .finally(() => {
        sessionRequestPromise = null;
      });

    return sessionRequestPromise;
  };

  const signInWithProvider = async (provider) => {
    const safeProvider = storePreferredAuthProvider(provider);
    const next = getSafeNext();
    const target = `/auth/${encodeURIComponent(safeProvider)}?next=${encodeURIComponent(next)}`;
    window.location.assign(target);
  };

  const signInWithGoogle = async () => signInWithProvider("google");
  const signInWithDiscord = async () => signInWithProvider("discord");

  const signOut = async () => {
    await fetch("/auth/logout", {
      method: "POST",
      headers: {
        Accept: "application/json"
      },
      credentials: "same-origin"
    }).catch(() => null);

    applyAuthState(null, "SIGNED_OUT");
  };

  const getSession = async () => {
    const session = await loadSession({ force: false });
    return session;
  };

  const getAccessToken = async () => {
    const session = await getSession();
    if (!session || !session.access_token) return "";
    return String(session.access_token).trim();
  };

  const refreshUi = async () => {
    return loadSession({ force: true });
  };

  const requestUpdateUser = async (payload) => {
    const response = await fetch("/auth/profile", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({ data: payload && typeof payload === "object" ? payload : {} })
    }).catch(() => null);

    if (!response) {
      return {
        data: null,
        error: { message: "Không thể kết nối hệ thống đăng nhập." }
      };
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error) {
      const message =
        data && data.error && data.error.message
          ? String(data.error.message)
          : "Không thể cập nhật tài khoản.";
      return {
        data: null,
        error: { message }
      };
    }

    const user = data && data.data && data.data.user ? data.data.user : null;
    if (user && lastSession && lastSession.user) {
      lastSession = {
        ...lastSession,
        user
      };
      updateWidgets(lastSession);
      updateCommentForms(lastSession);
      emitAuthStateChange("USER_UPDATED", lastSession);
    }

    return {
      data: data.data || null,
      error: null
    };
  };

  const client = {
    auth: {
      getSession: async () => {
        const session = await getSession();
        return {
          data: { session },
          error: null
        };
      },
      signOut: async () => {
        await signOut();
        return { error: null };
      },
      updateUser: async ({ data } = {}) => {
        return requestUpdateUser(data || {});
      },
      onAuthStateChange: (callback) => {
        if (typeof callback !== "function") {
          return {
            data: {
              subscription: {
                unsubscribe: () => {}
              }
            }
          };
        }
        authStateListeners.add(callback);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                authStateListeners.delete(callback);
              }
            }
          }
        };
      }
    }
  };

  const ensureAuthLoginDialog = () => {
    const existing = document.querySelector("[data-auth-login-dialog]");
    if (existing) return existing;

    const dialog = document.createElement("dialog");
    dialog.className = "modal auth-login-popup";
    dialog.setAttribute("data-auth-login-dialog", "");
    dialog.setAttribute("aria-label", "Chọn phương thức đăng nhập");
    dialog.innerHTML = `
      <div class="modal-card auth-login-popup__card">
        <div class="modal-head">
          <h2 class="modal-title">Đăng nhập</h2>
          <button class="modal-close" type="button" data-auth-login-close aria-label="Đóng">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <p class="modal-body">Chọn phương thức đăng nhập.</p>
        <div class="auth-login-popup__providers">
          <button
            class="button button--ghost auth-login-popup__provider auth-login-popup__provider--google"
            type="button"
            data-auth-login-provider="google"
          >
            <i class="fa-brands fa-google" aria-hidden="true"></i>
            <span>Google</span>
          </button>
          <button
            class="button button--ghost auth-login-popup__provider auth-login-popup__provider--discord"
            type="button"
            data-auth-login-provider="discord"
          >
            <i class="fa-brands fa-discord" aria-hidden="true"></i>
            <span>Discord</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);

    const googleBtn = dialog.querySelector("[data-auth-login-provider='google']");
    const discordBtn = dialog.querySelector("[data-auth-login-provider='discord']");
    if (googleBtn) googleBtn.hidden = !authProviderEnabled.google;
    if (discordBtn) discordBtn.hidden = !authProviderEnabled.discord;

    return dialog;
  };

  const loginProviderDialog = ensureAuthLoginDialog();
  const supportsLoginProviderDialog =
    Boolean(loginProviderDialog) && typeof loginProviderDialog.showModal === "function";

  const closeLoginProviderDialog = () => {
    if (!supportsLoginProviderDialog || !loginProviderDialog || !loginProviderDialog.open) return;
    loginProviderDialog.close();
  };

  const closeAuthMenus = () => {
    document.querySelectorAll("[data-auth-menu]").forEach((menu) => {
      menu.hidden = true;
    });
    document.querySelectorAll("[data-auth-menu-toggle]").forEach((toggle) => {
      toggle.setAttribute("aria-expanded", "false");
    });
    closeLoginProviderDialog();
  };

  const openLoginProviderDialog = () => {
    if (!authProviderEnabled.google && !authProviderEnabled.discord) {
      window.alert("Đăng nhập OAuth chưa được cấu hình.");
      return;
    }

    if (!supportsLoginProviderDialog || !loginProviderDialog) {
      signInWithProvider(preferredAuthProvider || "google").catch(() => {
        window.alert("Không thể mở đăng nhập. Vui lòng thử lại.");
      });
      return;
    }

    closeAuthMenus();
    loginProviderDialog.showModal();
    const firstOption = loginProviderDialog.querySelector("[data-auth-login-provider]:not([hidden])");
    if (firstOption && typeof firstOption.focus === "function") {
      firstOption.focus();
    }
  };

  const signIn = async () => {
    openLoginProviderDialog();
  };

  const confirmLogout = async () => {
    const payload = {
      title: "Đăng xuất?",
      body: "Bạn sẽ cần đăng nhập lại để tiếp tục bình luận và đồng bộ dữ liệu.",
      confirmText: "Đăng xuất",
      confirmVariant: "danger",
      fallbackText: "Bạn có chắc muốn đăng xuất không?"
    };

    if (window.BfangConfirm && typeof window.BfangConfirm.confirm === "function") {
      return window.BfangConfirm.confirm(payload);
    }

    return window.confirm(payload.fallbackText);
  };

  if (supportsLoginProviderDialog && loginProviderDialog) {
    const loginDialogCloseBtn = loginProviderDialog.querySelector("[data-auth-login-close]");
    if (loginDialogCloseBtn) {
      loginDialogCloseBtn.addEventListener("click", () => {
        closeLoginProviderDialog();
      });
    }

    loginProviderDialog.addEventListener("click", (event) => {
      if (event.target === loginProviderDialog) {
        closeLoginProviderDialog();
      }
    });

    loginProviderDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeLoginProviderDialog();
    });
  }

  document.addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-auth-menu-toggle]");
    if (toggle) {
      const container = toggle.closest("[data-auth-profile]") || toggle.parentElement;
      const menu = container ? container.querySelector("[data-auth-menu]") : null;
      if (!menu) return;
      const willOpen = menu.hidden;
      closeAuthMenus();
      if (willOpen) {
        menu.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
      }
      return;
    }

    const loginProviderBtn = event.target.closest("[data-auth-login-provider]");
    if (loginProviderBtn) {
      event.preventDefault();
      closeAuthMenus();
      const requestedProvider =
        loginProviderBtn && loginProviderBtn.getAttribute
          ? loginProviderBtn.getAttribute("data-auth-login-provider") || ""
          : "";
      signInWithProvider(requestedProvider || preferredAuthProvider || "google").catch(() => {
        window.alert("Không thể mở đăng nhập. Vui lòng thử lại.");
      });
      return;
    }

    const loginBtn = event.target.closest("[data-auth-login]");
    if (loginBtn) {
      event.preventDefault();
      openLoginProviderDialog();
      return;
    }

    const logoutBtn = event.target.closest("[data-auth-logout]");
    if (logoutBtn) {
      event.preventDefault();
      closeAuthMenus();
      const ok = await confirmLogout();
      if (!ok) return;
      signOut().catch(() => {
        window.alert("Không thể đăng xuất. Vui lòng thử lại.");
      });
      return;
    }

    if (
      !event.target.closest("[data-auth-menu]") &&
      !event.target.closest("[data-auth-menu-toggle]") &&
      !event.target.closest("[data-auth-login-dialog]")
    ) {
      closeAuthMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAuthMenus();
    }
  });

  window.BfangAuth = {
    client,
    signIn,
    signInWithProvider,
    signInWithGoogle,
    signInWithDiscord,
    signOut,
    getSession,
    getAccessToken,
    getMeProfile: () => cachedProfile,
    refreshUi,
    setAvatarPreview,
    clearAvatarPreview,
    me: null
  };

  loadSession({ force: true }).catch(() => {
    applyAuthState(null, "SIGNED_OUT");
  });
})();
