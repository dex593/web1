(() => {
  const STACK_ID = "bfang-toast-stack";
  const MAX_TOASTS = 6;
  const DEFAULT_DURATION_MS = 4200;
  const DEDUPE_WINDOW_MS = 1400;
  const STATUS_SELECTORS = [
    "[data-account-status]",
    "[data-account-api-copy-status]",
    "[data-avatar-error]",
    "[data-bookmark-status]",
    "[data-reading-history-status]",
    "[data-publish-status]",
    "[data-create-team-status]",
    "[data-chat-status]",
    "[data-chat-user-status]",
    "[data-comment-user-status]",
    "[data-team-permission-status]",
    "[data-admin-sso-status]",
    "[data-admin-sso-error]",
    "[data-genre-inline-status]",
    "[data-admin-teams-inline-status]",
    "[data-admin-team-edit-status]",
    "[data-admin-team-members-status]",
    "[data-members-inline-status]",
    "[data-member-editor-status]",
    "[data-badge-inline-status]",
    "[data-forbidden-words-status]",
    "[data-team-search-error]",
    "[data-chapter-number-error]",
    "[data-draft-upload-error]",
    "[data-cover-error]",
    "[data-admin-team-member-search-error]",
    ".admin-inline-feedback",
    ".admin-error",
    ".admin-success",
    ".team-feedback",
    ".note.is-error",
    ".note.is-success",
    ".comment-form-notice"
  ];
  const STATUS_SELECTOR = STATUS_SELECTORS.join(", ");
  const recentSignatures = new Map();
  const nodeSignatures = new WeakMap();

  const normalizeWhitespace = (value) => (value || "").toString().replace(/\s+/g, " ").trim();

  const normalizeKey = (value) => normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const pruneRecentSignatures = () => {
    const now = Date.now();
    recentSignatures.forEach((at, key) => {
      if (!Number.isFinite(at) || now - at > 60000) {
        recentSignatures.delete(key);
      }
    });
  };

  const isDuplicateSignature = (signature) => {
    const now = Date.now();
    const previous = Number(recentSignatures.get(signature) || 0);
    if (now - previous <= DEDUPE_WINDOW_MS) {
      return true;
    }
    recentSignatures.set(signature, now);
    if (recentSignatures.size > 140) {
      pruneRecentSignatures();
    }
    return false;
  };

  const loadingMessagePatterns = [
    /^(dang|loading|processing|saving|updating|deleting)\b/i,
    /\bdang\b.*\b(xu\s*ly|tai|luu|kiem\s*tra|upload|tao|dong\s*bo|cap\s*nhat|xoa|gui|lay|mo)\b/i,
    /\bvui\s*long\s*cho\b/i,
    /\bxin\s*cho\b/i,
    /\bplease\s*wait\b/i,
    /\btrang\s*thai\s*se\s*tu\s*cap\s*nhat\b/i
  ];

  const errorMessagePattern = /\b(khong\s*the|that\s*bai|loi|error|failed|khong\s*hop\s*le|khong\s*tim\s*thay|khong\s*co\s*quyen)\b/i;
  const warningMessagePattern = /\b(canh\s*bao|luu\s*y|chu\s*y|qua\s*nhanh|toi\s*da|gioi\s*han|vui\s*long)\b/i;
  const successMessagePattern = /\b(thanh\s*cong|hoan\s*tat|hoan\s*thanh|da\s+(luu|xoa|go|tao|them|duyet|tu\s*choi|gui|cap\s*nhat|sao\s*chep|mo\s*khoa|ban|bookmark|xu\s*ly))\b/i;

  const kindRules = [
    { kind: "delete", pattern: /\b(xoa|go|remove|ban|kick|huy\s*bo|xoa\s*da\s*chon|giai\s*tan)\b/i },
    { kind: "save", pattern: /\b(luu|save)\b/i },
    { kind: "create", pattern: /\b(tao|them|dang\s*ky|cap\s*moi|cap\s*huy\s*hieu)\b/i },
    { kind: "update", pattern: /\b(cap\s*nhat|chinh\s*sua|sua|doi)\b/i },
    { kind: "approve", pattern: /\b(duyet|xac\s*nhan|dong\s*y|approve)\b/i },
    { kind: "reject", pattern: /\b(tu\s*choi|reject)\b/i },
    { kind: "copy", pattern: /\b(sao\s*chep|copy)\b/i },
    { kind: "send", pattern: /\b(gui|tra\s*loi|tin\s*nhan|binh\s*luan|comment)\b/i },
    { kind: "auth", pattern: /\b(dang\s*nhap|dang\s*xuat|xac\s*thuc|quyen|admin)\b/i },
    { kind: "upload", pattern: /\b(upload|tai\s*len|tap\s*tin|anh)\b/i },
    { kind: "search", pattern: /\b(tim\s*kiem|search|loc)\b/i }
  ];

  const isLikelyLoadingMessage = (messageKey) => loadingMessagePatterns.some((pattern) => pattern.test(messageKey));

  const normalizeTone = (tone) => {
    const key = normalizeKey(tone);
    if (key === "error" || key === "danger") return "error";
    if (key === "warning" || key === "warn") return "error";
    if (key === "success" || key === "ok") return "success";
    return "info";
  };

  const resolveTone = ({ messageKey, explicitTone, node }) => {
    const normalizedExplicitTone = normalizeTone(explicitTone);
    if (explicitTone) {
      return normalizedExplicitTone;
    }

    if (node && node.classList) {
      if (node.classList.contains("is-error") || node.classList.contains("admin-error")) return "error";
      if (node.classList.contains("is-success") || node.classList.contains("admin-success")) return "success";
      if (node.classList.contains("is-warning") || node.classList.contains("admin-warning")) return "error";
      if (node.classList.contains("comment-form-notice") && node.classList.contains("is-error")) return "error";
      if (node.classList.contains("comment-form-notice") && node.classList.contains("is-success")) return "success";
    }

    if (!messageKey) return "info";
    if (/\bvui\s*long\s*dang\s*nhap\b/i.test(messageKey)) return "warning";
    if (errorMessagePattern.test(messageKey)) return "error";
    if (warningMessagePattern.test(messageKey)) return "error";
    if (successMessagePattern.test(messageKey)) return "success";
    return "info";
  };

  const resolveKind = ({ messageKey, explicitKind, tone }) => {
    const directKind = normalizeKey(explicitKind);
    if (directKind) {
      if (directKind === "save") return "save";
      if (directKind === "delete" || directKind === "remove") return "delete";
      if (directKind === "create") return "create";
      if (directKind === "update") return "update";
      if (directKind === "approve") return "approve";
      if (directKind === "reject") return "reject";
      if (directKind === "copy") return "copy";
      if (directKind === "send") return "send";
      if (directKind === "auth") return "auth";
      if (directKind === "upload") return "upload";
      if (directKind === "search") return "search";
      if (directKind === "warning") return "warning";
      if (directKind === "error") return "error";
      if (directKind === "success") return "success";
      if (directKind === "info") return "info";
    }

    const key = (messageKey || "").toString();
    for (const rule of kindRules) {
      if (rule.pattern.test(key)) {
        return rule.kind;
      }
    }

    if (tone === "error") return "error";
    if (tone === "warning") return "warning";
    if (tone === "success") return "success";
    return "info";
  };

  const resolveIconClass = ({ kind, tone }) => {
    if (tone === "error") {
      if (kind === "delete") return "fa-trash-can";
      if (kind === "reject") return "fa-circle-xmark";
      if (kind === "auth") return "fa-user-lock";
      return "fa-circle-exclamation";
    }

    if (tone === "warning") {
      if (kind === "auth") return "fa-right-to-bracket";
      return "fa-triangle-exclamation";
    }

    if (kind === "save") return "fa-floppy-disk";
    if (kind === "delete") return "fa-trash-can";
    if (kind === "create") return "fa-circle-plus";
    if (kind === "update") return "fa-pen-to-square";
    if (kind === "approve") return "fa-circle-check";
    if (kind === "reject") return "fa-circle-xmark";
    if (kind === "copy") return "fa-copy";
    if (kind === "send") return "fa-paper-plane";
    if (kind === "auth") return "fa-user-shield";
    if (kind === "upload") return "fa-cloud-arrow-up";
    if (kind === "search") return "fa-magnifying-glass";
    if (kind === "warning") return "fa-triangle-exclamation";
    if (kind === "error") return "fa-circle-exclamation";
    if (kind === "success") return "fa-circle-check";
    return "fa-circle-info";
  };

  const resolveDuration = (tone, duration) => {
    const explicit = Number(duration);
    if (Number.isFinite(explicit) && explicit >= 1000) {
      return Math.floor(Math.min(12000, explicit));
    }
    if (tone === "error") return 5600;
    if (tone === "warning") return 5000;
    return DEFAULT_DURATION_MS;
  };

  const isOutcomeTone = (tone) => tone === "success" || tone === "error";

  const resolveToastHost = () => {
    const openDialogs = Array.from(document.querySelectorAll("dialog[open]"));
    if (openDialogs.length > 0) {
      return openDialogs[openDialogs.length - 1];
    }
    return document.body;
  };

  const ensureStack = () => {
    const host = resolveToastHost();
    if (!host) return null;

    let stack = document.getElementById(STACK_ID);
    if (!stack) {
      stack = document.createElement("div");
      stack.id = STACK_ID;
      stack.className = "bf-toast-stack";
      stack.setAttribute("aria-live", "polite");
      stack.setAttribute("aria-atomic", "false");
    }

    if (stack.parentElement !== host) {
      host.appendChild(stack);
    }

    return stack;
  };

  const syncStackHost = () => {
    const stack = document.getElementById(STACK_ID);
    if (!stack) return;
    const host = resolveToastHost();
    if (!host) return;
    if (stack.parentElement !== host) {
      host.appendChild(stack);
    }
  };

  const dismissToast = (toast, immediate = false) => {
    if (!toast || !(toast instanceof HTMLElement) || !toast.isConnected) return;

    const runCleanup = () => {
      const cleanup = toast.__bfCleanup;
      if (typeof cleanup !== "function") return;
      toast.__bfCleanup = null;
      try {
        cleanup();
      } catch (_error) {
        // no-op
      }
    };

    if (immediate) {
      runCleanup();
      toast.remove();
      return;
    }

    if (toast.dataset.leaving === "1") return;
    toast.dataset.leaving = "1";
    toast.classList.add("is-leaving");

    const removeNow = () => {
      runCleanup();
      if (toast.isConnected) {
        toast.remove();
      }
    };
    toast.addEventListener("animationend", removeNow, { once: true });
    window.setTimeout(removeNow, 260);
  };

  const trimStack = (stack) => {
    if (!stack) return;
    const items = Array.from(stack.querySelectorAll(".bf-toast"));
    if (items.length <= MAX_TOASTS) return;
    items.slice(0, items.length - MAX_TOASTS).forEach((item) => {
      dismissToast(item, true);
    });
  };

  const show = ({ message, tone, variant, kind, duration, dedupe = true } = {}) => {
    const text = normalizeWhitespace(message);
    if (!text) return null;

    const messageKey = normalizeKey(text);
    if (!messageKey || isLikelyLoadingMessage(messageKey)) {
      return null;
    }

    const explicitTone = normalizeTone(tone || variant);
    const hasExplicitOutcomeTone = isOutcomeTone(explicitTone);

    const resolvedTone = resolveTone({
      messageKey,
      explicitTone,
      node: null
    });
    if (!hasExplicitOutcomeTone && !isOutcomeTone(resolvedTone)) {
      return null;
    }
    if (!isOutcomeTone(resolvedTone)) {
      return null;
    }

    const resolvedKind = resolveKind({
      messageKey,
      explicitKind: kind,
      tone: resolvedTone
    });

    const signature = `${resolvedTone}|${resolvedKind}|${text}`;
    if (dedupe !== false && isDuplicateSignature(signature)) {
      return null;
    }

    const stack = ensureStack();
    if (!stack) return null;

    const toast = document.createElement("article");
    toast.className = "bf-toast";
    toast.classList.add(`bf-toast--tone-${resolvedTone}`);
    toast.classList.add(`bf-toast--kind-${resolvedKind}`);
    toast.setAttribute("role", resolvedTone === "error" ? "alert" : "status");

    const iconWrap = document.createElement("span");
    iconWrap.className = "bf-toast__icon";
    iconWrap.setAttribute("aria-hidden", "true");
    const icon = document.createElement("i");
    icon.className = `fa-solid ${resolveIconClass({ kind: resolvedKind, tone: resolvedTone })}`;
    iconWrap.appendChild(icon);

    const body = document.createElement("div");
    body.className = "bf-toast__body";
    body.textContent = text;

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "bf-toast__dismiss";
    dismissBtn.setAttribute("aria-label", "Dong thong bao");
    dismissBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    dismissBtn.addEventListener("click", () => {
      dismissToast(toast);
    });

    toast.appendChild(iconWrap);
    toast.appendChild(body);
    toast.appendChild(dismissBtn);
    stack.appendChild(toast);
    trimStack(stack);

    const ttl = resolveDuration(resolvedTone, duration);
    let timeoutId = 0;
    let intervalId = 0;

    const clearTimers = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = 0;
      }
      if (intervalId) {
        window.clearInterval(intervalId);
        intervalId = 0;
      }
    };

    const updateProgress = (value) => {
      const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      toast.style.setProperty("--bf-toast-progress", safeValue.toFixed(5));
    };

    const startCountdown = () => {
      const startedAt = performance.now();

      clearTimers();
      timeoutId = window.setTimeout(() => {
        updateProgress(0);
        dismissToast(toast);
      }, ttl);

      intervalId = window.setInterval(() => {
        if (!toast.isConnected || toast.dataset.leaving === "1") {
          clearTimers();
          return;
        }
        const elapsed = performance.now() - startedAt;
        const currentRemaining = Math.max(0, ttl - elapsed);
        updateProgress(currentRemaining / ttl);
        if (currentRemaining <= 0) {
          clearTimers();
        }
      }, 80);
    };

    updateProgress(1);
    startCountdown();

    toast.__bfCleanup = () => {
      clearTimers();
    };

    return toast;
  };

  const suppressInlineNode = (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.hasAttribute("data-toast-keep-inline")) return;
    if (!node.classList.contains("toast-inline-hidden")) {
      node.classList.add("toast-inline-hidden");
    }
    if ("hidden" in node) {
      if (!node.hidden) {
        node.hidden = true;
      }
    }
  };

  const isNodeVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.isConnected) return false;
    if (node.hidden) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;

    const style = window.getComputedStyle(node);
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;

    return true;
  };

  const consumeStatusNode = (node) => {
    if (!(node instanceof HTMLElement)) return;
    if (!node.matches(STATUS_SELECTOR)) return;

    if (!isNodeVisible(node)) {
      return;
    }

    const text = normalizeWhitespace(node.textContent);
    if (!text) {
      suppressInlineNode(node);
      nodeSignatures.delete(node);
      return;
    }

    const messageKey = normalizeKey(text);
    if (!messageKey || isLikelyLoadingMessage(messageKey)) {
      suppressInlineNode(node);
      return;
    }

    const resolvedTone = resolveTone({
      messageKey,
      explicitTone: "",
      node
    });
    const resolvedKind = resolveKind({
      messageKey,
      explicitKind: "",
      tone: resolvedTone
    });
    const signature = `${resolvedTone}|${resolvedKind}|${text}`;

    if (nodeSignatures.get(node) === signature) {
      return;
    }

    nodeSignatures.set(node, signature);
    const toast = show({
      message: text,
      tone: resolvedTone,
      kind: resolvedKind,
      dedupe: true
    });
    suppressInlineNode(node);
    if (!toast) {
      return;
    }
  };

  const scanStatusNodes = (rootNode) => {
    const root = rootNode && (rootNode instanceof Element || rootNode instanceof Document)
      ? rootNode
      : document;

    if (root instanceof Element && root.matches(STATUS_SELECTOR)) {
      consumeStatusNode(root);
    }

    if (!root.querySelectorAll) return;
    root.querySelectorAll(STATUS_SELECTOR).forEach((node) => {
      consumeStatusNode(node);
    });
  };

  const findStatusAncestor = (node) => {
    let current = node instanceof Element ? node : node && node.parentElement;
    while (current && current !== document.body) {
      if (current.matches && current.matches(STATUS_SELECTOR)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  };

  const observeStatusNodes = () => {
    if (!document.body || typeof MutationObserver !== "function") return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes") {
          const target = mutation.target;
          if (target instanceof HTMLElement && target.matches(STATUS_SELECTOR)) {
            consumeStatusNode(target);
          }
          return;
        }

        if (mutation.type === "characterData") {
          const statusNode = findStatusAncestor(mutation.target);
          if (statusNode) {
            consumeStatusNode(statusNode);
          }
          return;
        }

        if (mutation.type === "childList") {
          if (mutation.target instanceof HTMLElement && mutation.target.matches(STATUS_SELECTOR)) {
            consumeStatusNode(mutation.target);
          }
          mutation.addedNodes.forEach((node) => {
            scanStatusNodes(node);
          });
        }
      });
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-hidden", "style"]
    });
  };

  const observeDialogLayer = () => {
    if (!document.body || typeof MutationObserver !== "function") return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof HTMLDialogElement) {
            syncStackHost();
            return;
          }
          continue;
        }

        if (mutation.type === "childList") {
          const touchedDialog = Array.from(mutation.addedNodes || []).some((node) =>
            node instanceof HTMLDialogElement ||
            (node instanceof Element && Boolean(node.querySelector("dialog")))
          );
          if (touchedDialog) {
            syncStackHost();
            return;
          }
        }
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"]
    });

    document.addEventListener("close", () => {
      syncStackHost();
    }, true);
  };

  const attachAlertBridge = () => {
    if (typeof window.alert !== "function") return;

    const nativeAlert = window.alert.bind(window);
    window.__BFANG_NATIVE_ALERT__ = nativeAlert;

    window.alert = (message) => {
      const text = normalizeWhitespace(message);
      if (!text) return;

      const key = normalizeKey(text);
      const tone = resolveTone({ messageKey: key, explicitTone: "", node: null });
      const kind = resolveKind({ messageKey: key, explicitKind: "", tone });
      show({
        message: text,
        tone,
        kind,
        duration: tone === "error" ? 6000 : 5200,
        dedupe: true
      });
    };
  };

  const attachEventBridge = () => {
    window.addEventListener("bfang:toast", (event) => {
      const detail = event && event.detail && typeof event.detail === "object" ? event.detail : {};
      show({
        message: detail.message || "",
        tone: detail.tone || detail.variant || "",
        kind: detail.kind || "",
        duration: detail.duration,
        dedupe: detail.dedupe !== false
      });
    });

    window.addEventListener("bfang:pagechange", () => {
      window.setTimeout(() => {
        syncStackHost();
        scanStatusNodes(document);
      }, 40);
    });

    window.addEventListener("pageshow", () => {
      syncStackHost();
      scanStatusNodes(document);
    });
  };

  const dismissAll = () => {
    const stack = document.getElementById(STACK_ID);
    if (!stack) return;
    stack.querySelectorAll(".bf-toast").forEach((toast) => {
      dismissToast(toast, true);
    });
  };

  const init = () => {
    attachAlertBridge();
    attachEventBridge();
    observeDialogLayer();
    observeStatusNodes();
    syncStackHost();
    scanStatusNodes(document);
  };

  window.BfangToast = {
    show,
    success(message, options = {}) {
      return show({ ...(options || {}), message, tone: "success" });
    },
    error(message, options = {}) {
      return show({ ...(options || {}), message, tone: "error" });
    },
    warning(message, options = {}) {
      return show({ ...(options || {}), message, tone: "warning" });
    },
    info(message, options = {}) {
      return show({ ...(options || {}), message, tone: "info" });
    },
    dismissAll,
    scan() {
      scanStatusNodes(document);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
