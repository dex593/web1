const HTTP_URL_PATTERN = /^https?:\/\//i;

const getFirstHeaderValue = (value) => (value || "").toString().split(",")[0].trim();

const getRequestHeader = (req, name) => {
  if (!req) return "";
  if (typeof req.get === "function") return getFirstHeaderValue(req.get(name));

  const headers = req.headers && typeof req.headers === "object" ? req.headers : {};
  return getFirstHeaderValue(headers[name.toLowerCase()]);
};

const parseHostnameFromHost = (host) => {
  const raw = getFirstHeaderValue(host);
  if (!raw) return "";

  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch (_err) {
    return raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  }
};

const isLocalHostname = (hostname) => {
  const normalized = (hostname || "").toString().trim().replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.")
  );
};

const shouldForceHttpsForHost = ({ host, isProductionApp }) => {
  if (!isProductionApp) return false;
  const hostname = parseHostnameFromHost(host);
  return Boolean(hostname && !isLocalHostname(hostname));
};

const normalizeSiteOriginFromEnv = (value, options = {}) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";

  const candidate = HTTP_URL_PATTERN.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" && shouldForceHttpsForHost({
      host: parsed.host,
      isProductionApp: options.isProductionApp || options.forceHttps
    })) {
      parsed.protocol = "https:";
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    return "";
  }
};

const resolvePublicProtocol = ({ forwardedProto, requestProtocol, host, isProductionApp }) => {
  const trustedForwardedProto = getFirstHeaderValue(forwardedProto).toLowerCase();
  if (trustedForwardedProto === "https") return "https";

  if (shouldForceHttpsForHost({ host, isProductionApp })) return "https";
  if (trustedForwardedProto === "http") return "http";

  return (requestProtocol || "http").toString().toLowerCase() === "https" ? "https" : "http";
};

const getRequestOriginFromHeaders = (req, options = {}) => {
  if (!req) return "";

  const canUseForwardedHeaders = Boolean(options.trustProxy);
  const forwardedHost = canUseForwardedHeaders ? getRequestHeader(req, "x-forwarded-host") : "";
  const host = forwardedHost || getRequestHeader(req, "host");
  if (!host) return "";

  const forwardedProto = canUseForwardedHeaders ? getRequestHeader(req, "x-forwarded-proto") : "";
  const protocol = resolvePublicProtocol({
    forwardedProto,
    requestProtocol: req.protocol,
    host,
    isProductionApp: options.isProductionApp
  });
  return `${protocol}://${host}`;
};

module.exports = {
  getRequestOriginFromHeaders,
  normalizeSiteOriginFromEnv,
  resolvePublicProtocol,
  shouldForceHttpsForHost
};
