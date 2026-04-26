const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getRequestOriginFromHeaders,
  normalizeSiteOriginFromEnv
} = require("../src/utils/public-origin");

const createRequest = ({
  host = "",
  protocol = "http",
  forwardedHost = "",
  forwardedProto = ""
} = {}) => ({
  protocol,
  get(name) {
    const headers = {
      host,
      "x-forwarded-host": forwardedHost,
      "x-forwarded-proto": forwardedProto
    };
    return headers[(name || "").toString().toLowerCase()] || "";
  }
});

test("normalizes production public origins to HTTPS for non-local hosts", () => {
  assert.equal(
    normalizeSiteOriginFromEnv("http://moetruyen.net", { isProductionApp: true }),
    "https://moetruyen.net"
  );
  assert.equal(
    normalizeSiteOriginFromEnv("moetruyen.net", { isProductionApp: true }),
    "https://moetruyen.net"
  );
  assert.equal(
    normalizeSiteOriginFromEnv("http://moetruyen.net/path?utm=1", { isProductionApp: true }),
    "https://moetruyen.net"
  );
});

test("keeps local HTTP origins available for development and local production checks", () => {
  assert.equal(
    normalizeSiteOriginFromEnv("http://localhost:3000", { isProductionApp: true }),
    "http://localhost:3000"
  );
  assert.equal(
    normalizeSiteOriginFromEnv("http://127.0.0.1:3000", { isProductionApp: true }),
    "http://127.0.0.1:3000"
  );
  assert.equal(
    normalizeSiteOriginFromEnv("http://localhost:3000", { isProductionApp: false }),
    "http://localhost:3000"
  );
});

test("forces request origins to HTTPS for production public hosts without proxy trust", () => {
  const req = createRequest({ host: "moetruyen.net", protocol: "http" });

  assert.equal(
    getRequestOriginFromHeaders(req, { isProductionApp: true, trustProxy: false }),
    "https://moetruyen.net"
  );
});

test("respects trusted forwarded HTTPS host and protocol values", () => {
  const req = createRequest({
    host: "internal.local:8080",
    protocol: "http",
    forwardedHost: "moetruyen.net, internal.local:8080",
    forwardedProto: "https, http"
  });

  assert.equal(
    getRequestOriginFromHeaders(req, { isProductionApp: true, trustProxy: true }),
    "https://moetruyen.net"
  );
});

test("preserves trusted forwarded HTTP for non-production origins", () => {
  const req = createRequest({
    host: "internal.local:8080",
    protocol: "https",
    forwardedHost: "preview.moetruyen.test",
    forwardedProto: "http"
  });

  assert.equal(
    getRequestOriginFromHeaders(req, { isProductionApp: false, trustProxy: true }),
    "http://preview.moetruyen.test"
  );
});

test("keeps development localhost request origins on HTTP", () => {
  const req = createRequest({ host: "localhost:3000", protocol: "http" });

  assert.equal(
    getRequestOriginFromHeaders(req, { isProductionApp: false, trustProxy: false }),
    "http://localhost:3000"
  );
});
