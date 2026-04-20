(() => {
  if (typeof window === "undefined") return;

  const isStandaloneDisplay = () => {
    try {
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
        return true;
      }
    } catch (_error) {
      // Ignore display mode errors.
    }

    return Boolean(window.navigator && window.navigator.standalone === true);
  };

  const state = {
    deferredPrompt: null,
    installed: isStandaloneDisplay()
  };

  const buildPublicState = () => ({
    canInstall: Boolean(state.deferredPrompt),
    installed: Boolean(state.installed)
  });

  const emitStateEvent = () => {
    window.dispatchEvent(
      new CustomEvent("bfang:pwa-state", {
        detail: buildPublicState()
      })
    );
  };

  const clearInstallPrompt = () => {
    state.deferredPrompt = null;
    emitStateEvent();
  };

  const promptInstall = async () => {
    const installPrompt = state.deferredPrompt;
    if (!installPrompt || typeof installPrompt.prompt !== "function") {
      return { supported: false, outcome: "unavailable" };
    }

    clearInstallPrompt();

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      const outcome = choice && choice.outcome ? String(choice.outcome).trim() : "unknown";
      if (outcome === "accepted") {
        state.installed = true;
      }

      window.dispatchEvent(
        new CustomEvent("bfang:pwa-prompt-result", {
          detail: { outcome }
        })
      );
      emitStateEvent();
      return { supported: true, outcome };
    } catch (_error) {
      emitStateEvent();
      return { supported: true, outcome: "failed" };
    }
  };

  window.__BFANG_PWA = {
    getState: () => buildPublicState(),
    isStandalone: () => isStandaloneDisplay(),
    promptInstall
  };

  window.addEventListener("beforeinstallprompt", (event) => {
    if (!event) return;
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }

    state.deferredPrompt = event;

    window.dispatchEvent(
      new CustomEvent("bfang:pwa-installable", {
        detail: buildPublicState()
      })
    );
    emitStateEvent();
  });

  window.addEventListener("appinstalled", () => {
    state.installed = true;
    clearInstallPrompt();
    window.dispatchEvent(
      new CustomEvent("bfang:pwa-installed", {
        detail: buildPublicState()
      })
    );
  });

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        emitStateEvent();
      },
      { once: true }
    );
    return;
  }

  emitStateEvent();
})();
