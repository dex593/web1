const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");

const renderLazyLoaderScript = async () => {
  const partialPath = path.join(__dirname, "..", "views", "partials", "comments-lazy-loader.ejs");
  const html = await ejs.renderFile(partialPath, { cspNonce: "test-nonce" });
  const match = html.match(/<script[^>]*>([\s\S]*)<\/script>/i);
  assert.ok(match, "comments lazy loader should render an inline script");
  return match[1];
};

const createDocumentHarness = () => {
  const documentListeners = new Map();
  const appendedScripts = [];
  let nativeSubmitted = false;
  let replayedSubmit = false;

  const addDocumentListener = (type, listener, capture) => {
    const listeners = documentListeners.get(type) || [];
    listeners.push({ listener, capture: Boolean(capture) });
    documentListeners.set(type, listeners);
  };

  const removeDocumentListener = (type, listener, capture) => {
    const listeners = documentListeners.get(type) || [];
    documentListeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener || entry.capture !== Boolean(capture))
    );
  };

  const dispatchDocumentEvent = (type, event) => {
    const listeners = documentListeners.get(type) || [];
    for (const entry of listeners.slice()) {
      if (event.immediatePropagationStopped) break;
      entry.listener(event);
    }
  };

  const commentsRoot = {
    attributes: new Map([
      ["data-comment-script-src", "/comments.js?t=test"],
      ["data-comment-lazy", ""]
    ]),
    getAttribute(name) {
      return this.attributes.get(name) || "";
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    }
  };

  const textarea = {};
  const form = {
    isConnected: true,
    action: "/comments",
    closest(selector) {
      return selector === "#comments" ? commentsRoot : null;
    },
    querySelector(selector) {
      return selector === "textarea[name='content']" ? textarea : null;
    },
    getAttribute(name) {
      return name === "action" ? "/comments" : "";
    },
    dispatchEvent(event) {
      replayedSubmit = true;
      event.target = form;
      dispatchDocumentEvent(event.type, event);
      return !event.defaultPrevented;
    },
    submit() {
      nativeSubmitted = true;
    }
  };

  const document = {
    querySelector(selector) {
      if (selector === "#comments") return commentsRoot;
      if (selector === 'script[src="/comments.js?t=test"]') {
        return appendedScripts[0] || null;
      }
      return null;
    },
    addEventListener: addDocumentListener,
    removeEventListener: removeDocumentListener,
    createElement(tagName) {
      assert.equal(tagName, "script");
      const scriptListeners = new Map();
      return {
        src: "",
        defer: false,
        nonce: "",
        addEventListener(type, listener) {
          scriptListeners.set(type, listener);
        },
        dispatchLoad() {
          const listener = scriptListeners.get("load");
          if (listener) listener();
        },
        dispatchError() {
          const listener = scriptListeners.get("error");
          if (listener) listener();
        }
      };
    },
    head: {
      appendChild(script) {
        appendedScripts.push(script);
      }
    }
  };

  const window = {
    location: { hash: "" },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout(callback) {
      callback();
      return 1;
    }
  };

  return {
    appendedScripts,
    commentsRoot,
    dispatchDocumentEvent,
    document,
    form,
    wasNativeSubmitted: () => nativeSubmitted,
    wasReplayedSubmit: () => replayedSubmit,
    window
  };
};

test("comments lazy loader prevents native submit until AJAX handler is ready", async () => {
  const script = await renderLazyLoaderScript();
  const harness = createDocumentHarness();
  let ajaxHandled = false;

  const context = {
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    Event: class Event {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
        this.cancelable = Boolean(options.cancelable);
        this.defaultPrevented = false;
        this.immediatePropagationStopped = false;
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      }
    },
    IntersectionObserver: class IntersectionObserver {
      observe() {}
      disconnect() {}
    },
    document: harness.document,
    window: harness.window
  };

  vm.runInNewContext(script, context);

  harness.dispatchDocumentEvent("pointerdown", {
    target: {
      closest(selector) {
        return selector === "#comments" ? harness.commentsRoot : null;
      }
    }
  });
  assert.equal(harness.appendedScripts.length, 1);

  const firstSubmit = {
    target: harness.form,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }
  };
  harness.dispatchDocumentEvent("submit", firstSubmit);

  assert.equal(firstSubmit.defaultPrevented, true);
  assert.equal(harness.appendedScripts.length, 1);
  assert.equal(harness.wasNativeSubmitted(), false);
  assert.equal(harness.commentsRoot.getAttribute("data-comment-auto-hydrate"), "1");

  harness.document.addEventListener("submit", () => {
    throw new Error("main submit listener should not be needed after lazy-loader delegation");
  });
  harness.window.BfangComments = {
    refresh() {},
    submit(form) {
      ajaxHandled = form === harness.form;
      return true;
    }
  };
  harness.appendedScripts[0].dispatchLoad();

  assert.equal(harness.wasReplayedSubmit(), true);
  assert.equal(ajaxHandled, true);
  assert.equal(harness.wasNativeSubmitted(), false);
});


test("comments lazy loader delegates ready comment submits to AJAX API", async () => {
  const script = await renderLazyLoaderScript();
  const harness = createDocumentHarness();
  let ajaxHandled = false;
  let downstreamSubmitSeen = false;

  harness.window.BfangComments = {
    refresh() {},
    submit(form) {
      ajaxHandled = form === harness.form;
      return true;
    }
  };

  const context = {
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    Event: class Event {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
        this.cancelable = Boolean(options.cancelable);
        this.defaultPrevented = false;
        this.immediatePropagationStopped = false;
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
      stopImmediatePropagation() {
        this.immediatePropagationStopped = true;
      }
    },
    IntersectionObserver: class IntersectionObserver {
      observe() {}
      disconnect() {}
    },
    document: harness.document,
    window: harness.window
  };

  vm.runInNewContext(script, context);
  harness.document.addEventListener("submit", () => {
    downstreamSubmitSeen = true;
  });

  const submitEvent = {
    target: harness.form,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    }
  };
  harness.dispatchDocumentEvent("submit", submitEvent);

  assert.equal(submitEvent.defaultPrevented, true);
  assert.equal(submitEvent.immediatePropagationStopped, true);
  assert.equal(ajaxHandled, true);
  assert.equal(downstreamSubmitSeen, false);
  assert.equal(harness.wasNativeSubmitted(), false);
});
