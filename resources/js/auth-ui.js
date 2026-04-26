(() => {
  if (typeof window === "undefined") return;

  window.BfangAuthModules = window.BfangAuthModules || {};

  window.BfangAuthModules.createUi = ({ authProviderEnabled, getPreferredAuthProvider, signInWithProvider, signOut }) => {
    const consumeAuthLoginIntentFromUrl = () => {
      try {
        const currentUrl = new URL(window.location.href);
        const authValue = (currentUrl.searchParams.get("auth") || "").toString().trim().toLowerCase();
        const loginValue = (currentUrl.searchParams.get("login") || "").toString().trim().toLowerCase();
        const loginErrorCode = (currentUrl.searchParams.get("login_error") || "")
          .toString()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, "_")
          .replace(/^_+|_+$/g, "");
        const shouldOpen =
          authValue === "login" ||
          loginValue === "1" ||
          loginValue === "true" ||
          loginValue === "login";

        if (!shouldOpen && !loginErrorCode) {
          return {
            shouldOpen: false,
            loginErrorCode: ""
          };
        }

        currentUrl.searchParams.delete("auth");
        currentUrl.searchParams.delete("login");
        currentUrl.searchParams.delete("login_error");
        const nextUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}` || "/";

        if (window.history && typeof window.history.replaceState === "function") {
          window.history.replaceState(window.history.state || null, document.title, nextUrl);
        }

        return {
          shouldOpen,
          loginErrorCode
        };
      } catch (_err) {
        return {
          shouldOpen: false,
          loginErrorCode: ""
        };
      }
    };

    const resolveLoginErrorMessage = (code) => {
      const safeCode = (code || "").toString().trim().toLowerCase();
      if (safeCode === "email_domain_not_allowed") {
        return "Email của bạn không thuộc danh sách tên miền được phép đăng nhập.";
      }
      if (safeCode === "email_required") {
        return "Tài khoản chưa có email hợp lệ nên không thể đăng nhập.";
      }
      if (safeCode === "email_not_verified") {
        return "Email của tài khoản chưa được xác minh nên không thể đăng nhập.";
      }
      return "";
    };

    const showLoginErrorMessage = (message) => {
      const safeMessage = (message || "").toString().trim();
      if (!safeMessage) return;
      if (window.BfangToast && typeof window.BfangToast.show === "function") {
        window.BfangToast.show({
          message: safeMessage,
          tone: "error",
          kind: "auth"
        });
        return;
      }
      window.alert(safeMessage);
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
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12" />
                <path d="M18 6l-12 12" />
              </svg>
            </button>
          </div>
          <p class="modal-body">Chọn phương thức đăng nhập.</p>
          <div class="auth-login-popup__providers">
            <button
              class="button button--ghost auth-login-popup__provider auth-login-popup__provider--google"
              type="button"
              data-auth-login-provider="google"
            >
              <img class="auth-login-popup__provider-icon-image" src="/images/google.svg" alt="" aria-hidden="true" />
              <span>Google</span>
            </button>
            <button
              class="button button--ghost auth-login-popup__provider auth-login-popup__provider--discord"
              type="button"
              data-auth-login-provider="discord"
            >
              <img class="auth-login-popup__provider-icon-image" src="/images/discord.svg" alt="" aria-hidden="true" />
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
    const authLoginIntent = consumeAuthLoginIntentFromUrl();
    const shouldAutoOpenLoginDialogFromUrl = Boolean(authLoginIntent && authLoginIntent.shouldOpen);
    const loginErrorMessageFromUrl = resolveLoginErrorMessage(
      authLoginIntent && authLoginIntent.loginErrorCode ? authLoginIntent.loginErrorCode : ""
    );

    if (loginErrorMessageFromUrl) {
      window.setTimeout(() => {
        showLoginErrorMessage(loginErrorMessageFromUrl);
      }, 0);
    }

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

    const headerNavToggle = document.querySelector("[data-header-nav-toggle]");
    const headerNav = document.getElementById("site-nav-links");

    const setHeaderNavOpen = (open) => {
      if (!headerNav || !headerNavToggle) return;
      const shouldOpen = Boolean(open);
      headerNav.classList.toggle("hidden", !shouldOpen);
      headerNavToggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    };

    const closeHeaderNav = () => {
      setHeaderNavOpen(false);
    };

    if (headerNav && headerNavToggle) {
      const initialOpen = !headerNav.classList.contains("hidden");
      headerNavToggle.setAttribute("aria-expanded", initialOpen ? "true" : "false");
    }

    const openLoginProviderDialog = ({ silent } = {}) => {
      const shouldSilenceAlert = Boolean(silent);

      if (!authProviderEnabled.google && !authProviderEnabled.discord) {
        if (!shouldSilenceAlert) {
          window.alert("Đăng nhập OAuth chưa được cấu hình.");
        }
        return;
      }

      if (!supportsLoginProviderDialog || !loginProviderDialog) {
        signInWithProvider(getPreferredAuthProvider() || "google").catch(() => {
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
      const headerToggle = event.target.closest("[data-header-nav-toggle]");
      if (headerToggle && headerNav) {
        event.preventDefault();
        const willOpen = headerNav.classList.contains("hidden");
        closeAuthMenus();
        setHeaderNavOpen(willOpen);
        return;
      }

      const headerNavLink = event.target.closest("#site-nav-links a");
      if (headerNavLink) {
        closeAuthMenus();
        closeHeaderNav();
        return;
      }

      const authMenuNavLink = event.target.closest("[data-auth-menu] a[href]");
      if (authMenuNavLink) {
        closeAuthMenus();
        closeHeaderNav();
        return;
      }

      const toggle = event.target.closest("[data-auth-menu-toggle]");
      if (toggle) {
        const container = toggle.closest("[data-auth-profile]") || toggle.parentElement;
        const menu = container ? container.querySelector("[data-auth-menu]") : null;
        if (!menu) return;
        const willOpen = menu.hidden;
        closeHeaderNav();
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
        signInWithProvider(requestedProvider || getPreferredAuthProvider() || "google").catch(() => {
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

      if (!event.target.closest("#site-nav-links") && !event.target.closest("[data-header-nav-toggle]")) {
        closeHeaderNav();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAuthMenus();
        closeHeaderNav();
      }
    });

    return {
      signIn,
      openLoginProviderDialog,
      shouldAutoOpenLoginDialogFromUrl
    };
  };
})();
