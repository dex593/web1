(() => {
  const dialog = document.querySelector("[data-public-confirm-dialog]");
  const supportsDialog = Boolean(dialog && typeof dialog.showModal === "function");

  const titleEl = dialog ? dialog.querySelector("[data-public-confirm-title]") : null;
  const bodyEl = dialog ? dialog.querySelector("[data-public-confirm-body]") : null;
  const metaEl = dialog ? dialog.querySelector("[data-public-confirm-meta]") : null;
  const okBtn = dialog ? dialog.querySelector("[data-public-confirm-ok]") : null;
  const cancelBtn = dialog ? dialog.querySelector("[data-public-confirm-cancel]") : null;
  const closeBtn = dialog ? dialog.querySelector("[data-public-confirm-close]") : null;

  let pendingResolve = null;

  const renderMeta = (items) => {
    if (!metaEl) return;
    metaEl.innerHTML = "";
    (items || [])
      .filter((value) => typeof value === "string" && value.trim())
      .slice(0, 6)
      .forEach((text) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = text;
        metaEl.appendChild(chip);
      });
  };

  const resetButtons = () => {
    if (!okBtn) return;
    okBtn.className = "button";
  };

  const close = (result) => {
    if (supportsDialog && dialog && dialog.open) {
      dialog.close();
    }
    const resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(Boolean(result));
  };

  const confirm = (config) => {
    const payload = config && typeof config === "object" ? config : {};
    const title = (payload.title || "Xác nhận").toString();
    const body = (payload.body || "Bạn có chắc muốn thực hiện thao tác này?").toString();
    const metaItems = Array.isArray(payload.metaItems) ? payload.metaItems : [];
    const confirmText = (payload.confirmText || "Xác nhận").toString();
    const variant = (payload.confirmVariant || "default").toString();

    if (!supportsDialog || !dialog) {
      return Promise.resolve(window.confirm(payload.fallbackText || body));
    }

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body;
    renderMeta(metaItems);

    resetButtons();
    if (okBtn) {
      okBtn.textContent = confirmText;
      if (variant === "danger") {
        okBtn.classList.add("button--danger");
      }
    }

    return new Promise((resolve) => {
      pendingResolve = resolve;
      dialog.showModal();
      if (okBtn) okBtn.focus();
    });
  };

  if (okBtn) {
    okBtn.addEventListener("click", () => close(true));
  }
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => close(false));
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => close(false));
  }

  if (supportsDialog && dialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        close(false);
      }
    });

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close(false);
    });

    dialog.addEventListener("close", () => {
      close(false);
    });
  }

  window.BfangConfirm = {
    confirm
  };
})();
