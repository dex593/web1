(() => {
  const facebook = document.querySelector("[data-share-facebook]");
  const instagram = document.querySelector("[data-share-instagram]");
  if (!facebook && !instagram) return;

  const getUrl = () => window.location.href.split("#")[0];
  const getTitle = () => {
    const h1 = document.querySelector(".detail-info h1") || document.querySelector("h1");
    const text = h1 ? (h1.textContent || "").trim() : "";
    return text || document.title;
  };

  const copyText = async (value) => {
    const text = (value || "").toString();
    if (!text) return false;

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_err) {
        // ignore
      }
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return Boolean(ok);
    } catch (_err) {
      return false;
    }
  };

  if (facebook) {
    facebook.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(getUrl())}`;
    facebook.target = "_blank";
    facebook.rel = "noopener";
  }

  if (instagram) {
    const label = instagram.querySelector("[data-share-label]");
    const getLabel = () => {
      const target = label || instagram;
      return (target.textContent || "Instagram").trim() || "Instagram";
    };
    const setLabel = (value) => {
      const text = (value || "").toString();
      if (label) {
        label.textContent = text;
        return;
      }
      instagram.textContent = text;
    };
    const original = getLabel();

    instagram.addEventListener("click", async (event) => {
      event.preventDefault();
      const url = getUrl();
      const title = getTitle();

      if (navigator.share) {
        try {
          await navigator.share({ title, url });
          return;
        } catch (_err) {
          // user cancelled or share failed
        }
      }

      const copied = await copyText(url);
      setLabel(copied ? "\u0110\u00e3 copy link" : "Kh\u00f4ng copy \u0111\u01b0\u1ee3c");
      window.setTimeout(() => {
        setLabel(original);
      }, 1400);
    });
  }
})();

(() => {
  const wrapper = document.querySelector("[data-description-wrap]");
  if (!wrapper) return;

  const content = wrapper.querySelector("[data-description-content]");
  const toggle = wrapper.querySelector("[data-description-toggle]");
  if (!content || !toggle) return;

  const fullText = (content.textContent || "").replace(/\r\n?/g, "\n").trim();
  if (!fullText) {
    toggle.hidden = true;
    toggle.removeAttribute("aria-expanded");
    return;
  }

  const getMax = () => {
    const base = Number(wrapper.dataset.descriptionMax) || 280;
    const mobile = Number(wrapper.dataset.descriptionMaxMobile) || Math.round(base * 0.72);
    if (window.matchMedia && window.matchMedia("(max-width: 560px)").matches) {
      return mobile;
    }
    return base;
  };

  const truncate = (text, max) => {
    if (text.length <= max) {
      return { text, truncated: false };
    }

    const slice = text.slice(0, max).trimEnd();
    let lastBreak = -1;
    for (let index = slice.length - 1; index >= 0; index -= 1) {
      const char = slice[index];
      if (/\s/.test(char)) {
        lastBreak = index;
        break;
      }
    }
    const cut = lastBreak > Math.floor(max * 0.6) ? slice.slice(0, lastBreak).trimEnd() : slice;
    return { text: cut, truncated: true };
  };

  const setState = (expanded) => {
    wrapper.classList.toggle("is-expanded", expanded);
    wrapper.classList.toggle("is-collapsed", !expanded);
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.textContent = expanded ? "Thu g\u1ecdn" : "Xem th\u00eam";
  };

  const collapse = () => {
    const max = getMax();
    const result = truncate(fullText, max);

    if (!result.truncated) {
      content.textContent = fullText;
      toggle.hidden = true;
      wrapper.classList.remove("is-expanded", "is-collapsed");
      toggle.removeAttribute("aria-expanded");
      return;
    }

    content.textContent = `${result.text}...`;
    toggle.hidden = false;
    setState(false);
  };

  const expand = () => {
    content.textContent = fullText;
    toggle.hidden = false;
    setState(true);
  };

  toggle.addEventListener("click", () => {
    if (wrapper.classList.contains("is-expanded")) {
      collapse();
      return;
    }
    expand();
  });

  window.addEventListener("resize", () => {
    if (wrapper.classList.contains("is-expanded")) return;
    collapse();
  });

  window.requestAnimationFrame(() => {
    collapse();
  });
})();

(() => {
  const list = document.querySelector("[data-mobile-chapter-list]");
  const actions = document.querySelector("[data-chapter-mobile-actions]");
  const toggle = actions ? actions.querySelector("[data-chapter-mobile-toggle]") : null;
  if (!list || !actions || !toggle) return;

  const items = Array.from(list.querySelectorAll("[data-chapter-item]"));
  const limitValue = Number(list.dataset.mobileLimit);
  const mobileLimit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 10;
  if (items.length <= mobileLimit) {
    actions.hidden = true;
    return;
  }

  let expanded = false;

  const isMobileViewport = () =>
    Boolean(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);

  const applyState = () => {
    const mobile = isMobileViewport();
    const shouldCollapse = mobile && !expanded;

    items.forEach((item, index) => {
      item.hidden = shouldCollapse && index >= mobileLimit;
    });

    actions.hidden = !mobile || expanded;
    toggle.setAttribute("aria-expanded", shouldCollapse ? "false" : "true");
  };

  toggle.addEventListener("click", () => {
    expanded = true;
    applyState();
  });

  window.addEventListener("resize", () => {
    applyState();
  });

  applyState();
})();
