(() => {
  const authRoot = document.documentElement;

  const setAuthRootState = (ready, hint) => {
    if (!authRoot) return;
    const safeHint = hint === "in" ? "in" : "out";
    authRoot.setAttribute("data-auth-hint", safeHint);
    authRoot.setAttribute("data-auth-ready", ready ? "1" : "0");
  };

  const readAuthSessionHint = (supabaseUrl) => {
    const rawUrl = (supabaseUrl || "").toString().trim();
    if (!rawUrl) return null;

    let projectRef = "";
    try {
      const parsedUrl = new URL(rawUrl);
      projectRef = (parsedUrl.hostname || "").split(".")[0] || "";
    } catch (_err) {
      projectRef = "";
    }
    if (!projectRef) return null;

    const storageKey = `sb-${projectRef}-auth-token`;

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      const source = parsed && typeof parsed === "object" ? parsed : null;
      if (!source) return null;

      const candidates = [];
      if (source.currentSession && typeof source.currentSession === "object") {
        candidates.push(source.currentSession);
      }
      if (source.session && typeof source.session === "object") {
        candidates.push(source.session);
      }
      candidates.push(source);

      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const accessToken =
          candidate && candidate.access_token ? String(candidate.access_token).trim() : "";
        if (!accessToken) continue;

        const expiresAt = Number(candidate && candidate.expires_at != null ? candidate.expires_at : NaN);
        if (Number.isFinite(expiresAt) && expiresAt <= nowSeconds) {
          continue;
        }

        const user = candidate && typeof candidate.user === "object" && candidate.user ? candidate.user : {};
        return {
          session: {
            user,
            access_token: accessToken,
            expires_at: expiresAt
          },
          storageKey
        };
      }
    } catch (_err) {
      return null;
    }

    return null;
  };

  const authServerSessionVersionStorageKey = "bfang_server_session_version";

  const normalizeServerSessionVersion = (value) => {
    const raw = value == null ? "" : String(value).trim();
    if (!raw) return "";
    if (raw.length > 64) return "";
    if (!/^[a-z0-9._-]+$/i.test(raw)) return "";
    return raw;
  };

  const detectServerSessionVersionChange = (version) => {
    const currentVersion = normalizeServerSessionVersion(version);
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

  const config = window.__SUPABASE || null;
  const forceSignOutOnServerRestart = detectServerSessionVersionChange(
    config && config.sessionVersion ? config.sessionVersion : ""
  );
  const hintPayload = readAuthSessionHint(config && config.url ? config.url : "");
  let hintedSession = hintPayload && hintPayload.session ? hintPayload.session : null;
  let hintedStorageKey = hintPayload && hintPayload.storageKey ? String(hintPayload.storageKey) : "";
  let hintedSignedIn = Boolean(hintedSession && hintedSession.access_token);

  if (forceSignOutOnServerRestart) {
    hintedSession = null;
    hintedSignedIn = false;
  }

  if (!config || !config.url || !config.anonKey) {
    setAuthRootState(true, "out");
    return;
  }

  setAuthRootState(false, hintedSignedIn ? "in" : "out");

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    setAuthRootState(true, "out");
    return;
  }

  const clearAuthSessionHint = () => {
    hintedSession = null;
    hintedSignedIn = false;

    if (!hintedStorageKey) return;
    try {
      window.localStorage.removeItem(hintedStorageKey);
    } catch (_err) {
      // ignore
    }
    hintedStorageKey = "";
  };

  if (forceSignOutOnServerRestart) {
    clearAuthSessionHint();
  }

  const authProviderStorageKey = "bfang_auth_provider";
  const supportedAuthProviders = new Set(["google", "discord"]);

  const normalizeAuthProvider = (value) => {
    const provider = (value || "").toString().trim().toLowerCase();
    if (supportedAuthProviders.has(provider)) {
      return provider;
    }
    return "google";
  };

  const readPreferredAuthProvider = () => {
    try {
      return normalizeAuthProvider(window.localStorage.getItem(authProviderStorageKey));
    } catch (_err) {
      return "google";
    }
  };

  let preferredAuthProvider = readPreferredAuthProvider();

  const storePreferredAuthProvider = (provider) => {
    const safeProvider = normalizeAuthProvider(provider);
    preferredAuthProvider = safeProvider;
    try {
      window.localStorage.setItem(authProviderStorageKey, safeProvider);
    } catch (_err) {
      // ignore
    }
    return safeProvider;
  };

  const client = window.supabase.createClient(config.url, config.anonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  });

  const initialSignOutPromise = forceSignOutOnServerRestart
    ? client.auth
        .signOut({ scope: "local" })
        .catch(() => client.auth.signOut().catch(() => null))
    : Promise.resolve();

  let cachedUserId = "";
  let cachedUsername = "";
  let cachedProfile = null;
  let profileFetchPromise = null;

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

  const fetchMeProfile = async (accessToken) => {
    const token = (accessToken || "").toString().trim();
    if (!token) return null;
    const response = await fetch("/account/me", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      credentials: "same-origin"
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      return null;
    }

    return data.profile || null;
  };

  const refreshMeProfile = async (session) => {
    const user = session && session.user ? session.user : null;
    const userId = user && user.id ? String(user.id).trim() : "";
    const token = session && session.access_token ? String(session.access_token).trim() : "";
    if (!userId || !token) {
      cachedUserId = "";
      cachedUsername = "";
      setMeProfile(null);
      setUsernameWidgets("");
      return;
    }

    if (userId === cachedUserId && cachedUsername) {
      setUsernameWidgets(cachedUsername);
      if (cachedProfile) {
        setMeProfile(cachedProfile);
      }
      return;
    }

    if (profileFetchPromise) {
      await profileFetchPromise;
      setUsernameWidgets(cachedUsername);
      if (cachedProfile) {
        setMeProfile(cachedProfile);
      }
      return;
    }

    profileFetchPromise = fetchMeProfile(token)
      .then((profile) => {
        cachedUserId = userId;
        cachedUsername = profile && profile.username ? String(profile.username).trim() : "";
        setMeProfile(profile);
        updateWidgets(lastSession);
      })
      .catch(() => {
        cachedUserId = userId;
        cachedUsername = "";
        setMeProfile(null);
        updateWidgets(lastSession);
      })
      .finally(() => {
        profileFetchPromise = null;
      });

    await profileFetchPromise;
    setUsernameWidgets(cachedUsername);
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
    return dialog;
  };

  const loginProviderDialog = ensureAuthLoginDialog();
  const supportsLoginProviderDialog =
    Boolean(loginProviderDialog) && typeof loginProviderDialog.showModal === "function";

  const closeLoginProviderDialog = () => {
    if (!supportsLoginProviderDialog || !loginProviderDialog || !loginProviderDialog.open) return;
    loginProviderDialog.close();
  };

  const openLoginProviderDialog = () => {
    if (!supportsLoginProviderDialog || !loginProviderDialog) {
      signIn().catch(() => {
        window.alert("Không thể mở đăng nhập. Vui lòng thử lại.");
      });
      return;
    }

    closeAuthMenus();
    loginProviderDialog.showModal();
    const firstOption = loginProviderDialog.querySelector("[data-auth-login-provider]");
    if (firstOption && typeof firstOption.focus === "function") {
      firstOption.focus();
    }
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

  const buildDisplayName = (user) => {
    if (!user) return "";
    const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;
    const custom = meta && meta.display_name ? String(meta.display_name).trim() : "";
    const fullName = meta && meta.full_name ? String(meta.full_name).trim() : "";
    const name = meta && meta.name ? String(meta.name).trim() : "";
    const email = user.email ? String(user.email).trim() : "";
    const candidate = (custom || fullName || name || email || "").replace(/\s+/g, " ").trim();
    if (!candidate) return "";
    if (candidate.length <= 30) return candidate;
    return `${candidate.slice(0, 27)}...`;
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

  let avatarPreviewOverride = "";
  let lastSession = null;

  const setAvatarPreview = (value) => {
    const url = (value || "").toString().trim();
    if (!url) {
      avatarPreviewOverride = "";
      updateWidgets(lastSession);
      return;
    }

    const safe = url.startsWith("blob:") || url.startsWith("data:image/");
    if (!safe) return;
    avatarPreviewOverride = url;
    updateWidgets(lastSession);
  };

  const clearAvatarPreview = () => {
    avatarPreviewOverride = "";
    updateWidgets(lastSession);
  };

  const refreshUi = async () => {
    const session = await getSession().catch(() => null);
    applyAuthState(session);
  };

  const getSafeNext = () => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (!next || typeof next !== "string") return "/";
    if (!next.startsWith("/") || next.startsWith("//")) return "/";
    return next;
  };

  const readLocationOrigin = () => {
    try {
      const origin =
        window.location && window.location.origin ? String(window.location.origin).trim() : "";
      if (!/^https?:\/\//i.test(origin)) return "";
      return origin.replace(/\/+$/, "");
    } catch (_err) {
      return "";
    }
  };

  const isLoopbackHost = (value) => {
    const raw = (value || "").toString().trim();
    if (!raw) return false;
    try {
      const parsed = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
      const hostname = (parsed.hostname || "").toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch (_err) {
      return false;
    }
  };

  const readConfiguredAuthRedirectTo = () => {
    const raw = config && config.redirectTo != null ? String(config.redirectTo).trim() : "";
    if (!raw || !/^https?:\/\//i.test(raw)) return "";
    try {
      const parsed = new URL(raw);
      const pathname = parsed.pathname || "/";
      return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search || ""}${parsed.hash || ""}`;
    } catch (_err) {
      return "";
    }
  };

  const buildAuthRedirectTo = (nextPath) => {
    const locationOrigin = readLocationOrigin();
    const localFallback = locationOrigin ? `${locationOrigin}/auth/callback` : "";

    try {
      let parsed = new URL(readConfiguredAuthRedirectTo() || localFallback);
      if (locationOrigin) {
        const sameOrigin = parsed.origin.toLowerCase() === locationOrigin.toLowerCase();
        const isCallbackPath = ((parsed.pathname || "").replace(/\/+$/, "") || "/") === "/auth/callback";
        const shouldFallback =
          !sameOrigin ||
          (isLoopbackHost(parsed.origin) && !isLoopbackHost(locationOrigin)) ||
          !isCallbackPath;
        if (shouldFallback && localFallback) {
          parsed = new URL(localFallback);
        }
      }

      parsed.pathname = "/auth/callback";
      parsed.search = "";
      parsed.hash = "";

      const safeNext = (nextPath || "").toString();
      if (safeNext && safeNext !== "/") {
        parsed.searchParams.set("next", safeNext);
      }
      return parsed.toString();
    } catch (_err) {
      return localFallback || "";
    }
  };

  const signInWithProvider = async (provider) => {
    const safeProvider = storePreferredAuthProvider(provider || preferredAuthProvider);
    const next = getSafeNext();
    try {
      window.localStorage.setItem("bfang_auth_next", next);
      window.localStorage.setItem("bfang_auth_next_ts", String(Date.now()));
    } catch (_err) {
      // ignore
    }

    const redirectTo = buildAuthRedirectTo(next) || `${window.location.origin}/auth/callback`;
    const oauthOptions = {
      redirectTo
    };
    if (safeProvider === "discord") {
      oauthOptions.scopes = "identify email";
    }

    const { error } = await client.auth.signInWithOAuth({
      provider: safeProvider,
      options: oauthOptions
    });
    if (error) {
      throw error;
    }
  };

  const signInWithGoogle = async () => signInWithProvider("google");

  const signInWithDiscord = async () => signInWithProvider("discord");

  const signIn = async () => signInWithProvider(preferredAuthProvider || "google");

  const signOut = async () => {
    const { error } = await client.auth.signOut();
    if (error) {
      throw error;
    }
  };

  const getSession = async () => {
    const { data, error } = await client.auth.getSession();
    if (error) {
      throw error;
    }
    return data && data.session ? data.session : null;
  };

  const getAccessToken = async () => {
    const session = await getSession().catch(() => null);
    return session && session.access_token ? String(session.access_token) : "";
  };

  const updateCommentForms = (session) => {
    const signedIn = Boolean(session && session.user);
    const forms = document.querySelectorAll("#comments form");
    forms.forEach((form) => {
      const textarea = form.querySelector("textarea[name='content']");
      if (!textarea) return;
      const submit = form.querySelector("button[type='submit']");
      if (textarea.dataset.placeholderOriginal == null) {
        textarea.dataset.placeholderOriginal = (textarea.getAttribute("placeholder") || "").toString();
      }

      if (signedIn) {
        textarea.disabled = false;
        if (submit) submit.disabled = false;
        textarea.setAttribute("placeholder", textarea.dataset.placeholderOriginal || "");
        return;
      }

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

      if (avatarEl && avatarEl instanceof HTMLImageElement) {
        if (avatarUrl) {
          avatarEl.src = avatarUrl;
          avatarEl.hidden = false;
        } else {
          avatarEl.removeAttribute("src");
          avatarEl.hidden = true;
        }
      }
    });
  };

  const applyAuthHintState = (sessionHint) => {
    if (!sessionHint || !sessionHint.access_token) return;

    const hintSession = {
      user: sessionHint.user && typeof sessionHint.user === "object" ? sessionHint.user : {},
      access_token: String(sessionHint.access_token),
      expires_at: sessionHint.expires_at
    };

    lastSession = hintSession;
    updateWidgets(hintSession);
    updateCommentForms(hintSession);
    closeAuthMenus();
  };

  const applyAuthState = (session) => {
    if (!session || !session.user) {
      avatarPreviewOverride = "";
      if (hintedSignedIn) {
        clearAuthSessionHint();
      }
    } else if (session && session.access_token) {
      hintedSession = {
        user: session.user,
        access_token: String(session.access_token),
        expires_at: session.expires_at
      };
      hintedSignedIn = true;
    }
    lastSession = session;
    updateWidgets(session);
    updateCommentForms(session);
    closeAuthMenus();
    void refreshMeProfile(session);

    setAuthRootState(true, session && session.user ? "in" : "out");

    try {
      window.dispatchEvent(new CustomEvent("bfang:auth", { detail: { session } }));
    } catch (_err) {
      // ignore
    }
  };

  const confirmLogout = async () => {
    const payload = {
      title: "Đăng xuất?",
      body: "Bạn có chắc muốn đăng xuất khỏi tài khoản này?",
      confirmText: "Đăng xuất",
      confirmVariant: "danger",
      metaItems: [],
      fallbackText: "Bạn có chắc muốn đăng xuất?"
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
      const requestedProvider =
        loginBtn && loginBtn.getAttribute
          ? loginBtn.getAttribute("data-auth-provider") || ""
          : "";
      if (requestedProvider) {
        closeAuthMenus();
        signInWithProvider(requestedProvider).catch(() => {
          window.alert("Không thể mở đăng nhập. Vui lòng thử lại.");
        });
      } else {
        openLoginProviderDialog();
      }
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

    if (!event.target.closest("[data-auth-menu]") && !event.target.closest("[data-auth-menu-toggle]") && !event.target.closest("[data-auth-login-dialog]")) {
      closeAuthMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAuthMenus();
    }
  });

  if (hintedSignedIn) {
    applyAuthHintState(hintedSession);
  } else {
    updateCommentForms(null);
  }

  initialSignOutPromise
    .then(() => client.auth.getSession())
    .then(({ data }) => {
      applyAuthState(data && data.session ? data.session : null);
    })
    .catch(() => {
      applyAuthState(null);
    });

  client.auth.onAuthStateChange((_event, session) => {
    applyAuthState(session);
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
    clearAvatarPreview
  };
})();
