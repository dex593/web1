(() => {
  const statusEl = document.querySelector("[data-auth-callback-status]");

  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = (text || "").toString();
  };

  const readErrorText = (error) => {
    if (!error) return "";
    const message = error && error.message ? String(error.message).trim() : "";
    const description =
      error && error.error_description ? String(error.error_description).trim() : "";
    const status =
      error && error.status != null && Number.isFinite(Number(error.status))
        ? `HTTP ${Math.floor(Number(error.status))}`
        : "";

    return [message, description, status].filter(Boolean).join(" | ");
  };

  const buildFriendlyError = (error) => {
    const text = readErrorText(error);
    const lowered = text.toLowerCase();

    if (lowered.includes("code verifier") || lowered.includes("pkce")) {
      return "Phiên đăng nhập trên trình duyệt đã bị mất. Vui lòng quay lại trang chính và bấm đăng nhập lại.";
    }
    if (lowered.includes("invalid_grant") || lowered.includes("invalid grant")) {
      return "Phiên xác thực đã hết hạn hoặc đã được dùng trước đó. Vui lòng đăng nhập lại.";
    }
    if (lowered.includes("redirect") || lowered.includes("redirect_to")) {
      return "Cấu hình đường dẫn callback chưa đúng. Vui lòng liên hệ quản trị viên.";
    }

    return "Đăng nhập thất bại. Vui lòng thử lại.";
  };

  const isAbortLikeError = (error) => {
    if (!error) return false;
    const name = error && error.name ? String(error.name).toLowerCase() : "";
    const text = readErrorText(error).toLowerCase();
    return (
      name === "aborterror" ||
      text.includes("aborterror") ||
      text.includes("signal is aborted") ||
      text.includes("aborted without reason")
    );
  };

  const logAuthError = (scope, error) => {
    if (!error) return;
    try {
      console.error(`[auth-callback] ${scope}`, error);
    } catch (_err) {
      // ignore
    }
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const runAuthStep = async (scope, task, options) => {
    const allowAbortRetry = Boolean(options && options.allowAbortRetry);
    const maxAttempts = allowAbortRetry ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await task();
        const error = result && result.error ? result.error : null;
        if (!error) {
          return { ok: true, error: null };
        }
        lastError = error;
      } catch (error) {
        lastError = error;
      }

      if (!isAbortLikeError(lastError) || attempt >= maxAttempts) {
        break;
      }

      await sleep(120);
    }

    logAuthError(scope, lastError);
    return { ok: false, error: lastError };
  };

  const config = window.__SUPABASE || null;
  if (!config || !config.url || !config.anonKey) {
    setStatus("Hệ thống đăng nhập chưa được cấu hình.");
    return;
  }

  const client =
    window.supabase && typeof window.supabase.createClient === "function"
      ? window.supabase.createClient(config.url, config.anonKey, {
          auth: {
            flowType: "pkce",
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false
          }
        })
      : null;

  if (!client || !client.auth) {
    setStatus("Không tải được thư viện đăng nhập. Vui lòng thử lại.");
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const code = (params.get("code") || "").toString().trim().replace(/ /g, "+");
  let nextRaw = (params.get("next") || "").toString();
  if (!nextRaw) {
    try {
      const stored = (window.localStorage.getItem("bfang_auth_next") || "").toString();
      const storedTs = Number(window.localStorage.getItem("bfang_auth_next_ts") || 0);
      const fresh = Number.isFinite(storedTs) && Date.now() - storedTs < 30 * 60 * 1000;
      if (stored && stored.startsWith("/") && !stored.startsWith("//") && fresh) {
        nextRaw = stored;
      }
    } catch (_err) {
      // ignore
    }
  }

  const next = nextRaw && nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";

  const errorDesc = (params.get("error_description") || params.get("error") || "")
    .toString()
    .trim();
  if (errorDesc) {
    setStatus(`Đăng nhập thất bại: ${errorDesc}`);
    return;
  }

  (async () => {
    let exchangeError = null;
    let exchanged = false;

    if (code && typeof client.auth.exchangeCodeForSession === "function") {
      const result = await runAuthStep(
        "exchangeCodeForSession",
        () => client.auth.exchangeCodeForSession(code),
        { allowAbortRetry: true }
      );
      if (result.ok) {
        exchanged = true;
      } else {
        exchangeError = result.error;
      }
    }

    if (!exchanged && typeof client.auth.getSessionFromUrl === "function") {
      const result = await runAuthStep(
        "getSessionFromUrl",
        () => client.auth.getSessionFromUrl({ storeSession: true }),
        { allowAbortRetry: true }
      );
      if (result.ok) {
        exchanged = true;
      } else {
        exchangeError = result.error;
      }
    }

    const { data } = await client.auth.getSession().catch(() => ({ data: null }));
    if (!data || !data.session) {
      setStatus(buildFriendlyError(exchangeError));
      return;
    }

    try {
      window.localStorage.removeItem("bfang_auth_next");
      window.localStorage.removeItem("bfang_auth_next_ts");
    } catch (_err) {
      // ignore
    }

    window.location.replace(next || "/");
  })().catch((error) => {
    logAuthError("fatal", error);
    setStatus(buildFriendlyError(error));
  });
})();
