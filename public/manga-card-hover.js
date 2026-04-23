(() => {
  "use strict";

  const CARD_SELECTOR = ".manga-card--has-hover";
  const POPUP_SELECTOR = ".manga-hover-popup";
  const CARD_BOUND_ATTR = "data-manga-hover-bound";
  const HOVER_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 761px)";
  const EDGE_GAP = 14;
  const CURSOR_GAP = 18;
  const CURSOR_TOP_OFFSET = 42;
  const ARROW_EDGE_GAP = 26;

  const hoverMedia = window.matchMedia ? window.matchMedia(HOVER_QUERY) : null;
  let activeCard = null;
  let activePopup = null;
  let lastPointerEvent = null;
  let frameId = 0;
  let globalListenersBound = false;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  const isHoverReady = () => !hoverMedia || hoverMedia.matches;

  const isFinePointerEvent = (event) => {
    if (!event || !event.pointerType) return true;
    return event.pointerType === "mouse" || event.pointerType === "pen";
  };

  const clearPopupPosition = (popup) => {
    if (!popup) return;
    popup.style.removeProperty("--manga-hover-left");
    popup.style.removeProperty("--manga-hover-top");
    popup.style.removeProperty("--manga-hover-arrow-y");
    popup.style.removeProperty("max-width");
    popup.classList.remove("manga-hover-popup--left", "manga-hover-popup--right");
  };

  const hideCard = (card) => {
    if (!card) return;
    card.classList.remove("is-hovering");
    clearPopupPosition(card.querySelector(POPUP_SELECTOR));
  };

  const hideActive = () => {
    if (frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    hideCard(activeCard);
    activeCard = null;
    activePopup = null;
    lastPointerEvent = null;
  };

  const positionPopup = (event, popup, card) => {
    if (!event || !popup || !card) return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!viewportWidth || !viewportHeight) return;

    popup.style.removeProperty("max-width");

    const cardRect = card.getBoundingClientRect();
    const desiredPopupWidth = popup.offsetWidth || 280;
    const pointerX = clamp(event.clientX, EDGE_GAP, viewportWidth - EDGE_GAP);
    const pointerY = clamp(event.clientY, EDGE_GAP, viewportHeight - EDGE_GAP);
    const cardCenterX = cardRect.left + (cardRect.width / 2);
    const spaceRight = viewportWidth - cardRect.right - CURSOR_GAP - EDGE_GAP;
    const spaceLeft = cardRect.left - CURSOR_GAP - EDGE_GAP;

    let side = cardCenterX < viewportWidth / 2 ? "right" : "left";
    const rightFits = spaceRight >= desiredPopupWidth;
    const leftFits = spaceLeft >= desiredPopupWidth;

    if (side === "right" && !rightFits && (leftFits || spaceLeft > spaceRight)) side = "left";
    if (side === "left" && !leftFits && (rightFits || spaceRight > spaceLeft)) side = "right";

    const availableWidth = Math.max(1, side === "right" ? spaceRight : spaceLeft);
    popup.style.maxWidth = `${Math.floor(availableWidth)}px`;

    const popupWidth = popup.offsetWidth || Math.min(desiredPopupWidth, availableWidth);
    const popupHeight = popup.offsetHeight || 230;
    const left = side === "right"
      ? cardRect.right + CURSOR_GAP
      : cardRect.left - popupWidth - CURSOR_GAP;

    const preferredTop = pointerY - CURSOR_TOP_OFFSET;
    const maxTop = Math.max(EDGE_GAP, viewportHeight - popupHeight - EDGE_GAP);
    const top = clamp(preferredTop, EDGE_GAP, maxTop);
    const arrowY = clamp(pointerY - top, ARROW_EDGE_GAP, Math.max(ARROW_EDGE_GAP, popupHeight - ARROW_EDGE_GAP));

    popup.style.setProperty("--manga-hover-left", `${Math.round(left)}px`);
    popup.style.setProperty("--manga-hover-top", `${Math.round(top)}px`);
    popup.style.setProperty("--manga-hover-arrow-y", `${Math.round(arrowY)}px`);
    popup.classList.toggle("manga-hover-popup--right", side === "right");
    popup.classList.toggle("manga-hover-popup--left", side === "left");
  };

  const schedulePosition = (event) => {
    if (!activePopup) return;
    lastPointerEvent = event;
    if (frameId) return;

    frameId = window.requestAnimationFrame(() => {
      frameId = 0;
      if (activePopup && lastPointerEvent) {
        positionPopup(lastPointerEvent, activePopup, activeCard);
      }
    });
  };

  const showCard = (card, event) => {
    if (!card || !isHoverReady() || !isFinePointerEvent(event)) return;

    const popup = card.querySelector(POPUP_SELECTOR);
    if (!popup) return;

    if (activeCard && activeCard !== card) hideCard(activeCard);

    activeCard = card;
    activePopup = popup;
    positionPopup(event, popup, card);
    card.classList.add("is-hovering");
  };

  const bindCard = (card) => {
    if (!card || card.getAttribute(CARD_BOUND_ATTR) === "1") return;

    card.addEventListener("pointerenter", (event) => showCard(card, event));
    card.addEventListener("pointermove", (event) => {
      if (activeCard !== card || !isFinePointerEvent(event)) return;
      schedulePosition(event);
    });
    card.addEventListener("pointerleave", () => {
      if (activeCard === card) hideActive();
      else hideCard(card);
    });
    card.addEventListener("pointercancel", hideActive);
    card.setAttribute(CARD_BOUND_ATTR, "1");
  };

  const bindGlobalListeners = () => {
    if (globalListenersBound) return;

    window.addEventListener("resize", hideActive);
    window.addEventListener("scroll", hideActive, true);

    if (hoverMedia && typeof hoverMedia.addEventListener === "function") {
      hoverMedia.addEventListener("change", hideActive);
    } else if (hoverMedia && typeof hoverMedia.addListener === "function") {
      hoverMedia.addListener(hideActive);
    }

    globalListenersBound = true;
  };

  const init = (root) => {
    const scope = root && root.querySelectorAll ? root : document;
    const cards = scope.querySelectorAll(CARD_SELECTOR);
    if (!cards.length) return;

    cards.forEach(bindCard);
    bindGlobalListeners();
  };

  window.BfangMangaCardHover = window.BfangMangaCardHover || {};
  window.BfangMangaCardHover.init = init;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init(document), { once: true });
  } else {
    init(document);
  }

  window.addEventListener("bfang:pagechange", () => init(document));
  document.addEventListener("bfang:homepage-refreshed", () => init(document));
})();
