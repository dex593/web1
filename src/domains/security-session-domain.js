const createSecuritySessionDomain = (deps) => {
  const {
    isProductionApp,
    serverSessionVersion,
    wantsJson,
  } = deps;

const createRateLimiter = ({ windowMs, max, keyPrefix }) => {
  const store = new Map();
  const ttl = Math.max(1000, Number(windowMs) || 60 * 1000);
  const limit = Math.max(1, Number(max) || 20);
  const prefix = (keyPrefix || "global").toString().trim() || "global";

  return (req, res, next) => {
    const now = Date.now();
    const ip = (req.ip || req.socket?.remoteAddress || "unknown").toString().trim() || "unknown";
    const key = `${prefix}:${ip}`;

    if (store.size > 5000) {
      for (const [entryKey, entry] of store.entries()) {
        if (!entry || now >= entry.resetAt) {
          store.delete(entryKey);
        }
      }
    }

    const existing = store.get(key);
    if (!existing || now >= existing.resetAt) {
      store.set(key, { count: 1, resetAt: now + ttl });
      return next();
    }

    existing.count += 1;
    if (existing.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.set("Retry-After", String(retryAfter));
      if (wantsJson(req)) {
        return res.status(429).json({ ok: false, error: "Quá nhiều yêu cầu, vui lòng thử lại sau." });
      }
      return res.status(429).send("Quá nhiều yêu cầu, vui lòng thử lại sau.");
    }

    store.set(key, existing);
    return next();
  };
};

const adminLoginRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: isProductionApp ? 20 : 80,
  keyPrefix: "admin-login"
});

const adminSsoRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: isProductionApp ? 40 : 140,
  keyPrefix: "admin-sso"
});

const readSessionVersion = (req) =>
  (req && req.session && req.session.sessionVersion ? req.session.sessionVersion : "")
    .toString()
    .trim();

const isServerSessionVersionMismatch = (req) => {
  const version = readSessionVersion(req);
  return Boolean(version && version !== serverSessionVersion);
};

const clearUserAuthSession = (req) => {
  if (!req || !req.session) return;
  delete req.session.authUserId;
  delete req.session.authProvider;
};

const clearAdminAuthSession = (req) => {
  if (!req || !req.session) return;
  req.session.isAdmin = false;
  delete req.session.adminAuth;
  delete req.session.adminUserId;
  delete req.session.adminAuthUserId;
  delete req.session.adminTeamId;
  delete req.session.adminTeamName;
  delete req.session.adminTeamSlug;
  delete req.session.adminTeamRole;
  delete req.session.adminTeamPermissions;
};

const clearAllAuthSessionState = (req) => {
  clearUserAuthSession(req);
  clearAdminAuthSession(req);
  if (req && req.session) {
    delete req.session.sessionVersion;
  }
};

  return {
    adminLoginRateLimiter,
    adminSsoRateLimiter,
    clearAdminAuthSession,
    clearAllAuthSessionState,
    clearUserAuthSession,
    createRateLimiter,
    isServerSessionVersionMismatch,
    readSessionVersion,
  };
};

module.exports = createSecuritySessionDomain;
