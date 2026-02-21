const configureCoreRuntime = (app, deps) => {
  const {
    SEO_ROBOTS_INDEX,
    SEO_ROBOTS_NOINDEX,
    appRootDir,
    adminConfig,
    asyncHandler,
    buildContentSecurityPolicy,
    buildSeoPayload,
    cacheBust,
    clearAllAuthSessionState,
    compression,
    crypto,
    cssMinifier,
    ensureLeadingSlash,
    express,
    formatDate,
    formatDateTime,
    formatTimeAgo,
    fs,
    getAuthPublicConfigForRequest,
    isJsMinifyEnabled,
    isProductionApp,
    isServerSessionVersionMismatch,
    minifyJs,
    parseEnvBoolean,
    passport,
    path,
    publicDir,
    requireSameOriginForAdminWrites,
    serverAssetVersion,
    session,
    sessionStore,
    stickersDir,
    trustProxy,
    uploadDir,
  } = deps;

app.set("view engine", "ejs");
  app.set("views", path.join(appRootDir, "views"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const shouldCompressResponse = (req, res) => {
  const pathValue = ensureLeadingSlash(req && req.path ? req.path : "/");
  const acceptHeader = (req && req.headers && req.headers.accept ? req.headers.accept : "")
    .toString()
    .toLowerCase();

  if (pathValue === "/notifications/stream" || acceptHeader.includes("text/event-stream")) {
    return false;
  }

  return compression.filter(req, res);
};

const staticImageFilePattern = /\.(avif|gif|jpe?g|png|svg|webp)$/i;
const staticImageCacheControl = "public, max-age=31536000, immutable";
const staticUploadCacheControl = "public, max-age=604800, stale-while-revalidate=86400";

app.use(
  compression({
    threshold: 1024,
    filter: shouldCompressResponse
  })
);

const forceSecureCookie = parseEnvBoolean(process.env.SESSION_COOKIE_SECURE, isProductionApp);
const enableCsp = parseEnvBoolean(process.env.CSP_ENABLED, true);
const cspReportOnly = parseEnvBoolean(process.env.CSP_REPORT_ONLY, false);
if (isProductionApp && forceSecureCookie && !trustProxy) {
  console.warn("APP_ENV=production + SESSION_COOKIE_SECURE=true; nếu chạy sau reverse proxy, hãy đặt TRUST_PROXY=1.");
}

app.use((req, res, next) => {
  const nonce = crypto.randomBytes(18).toString("base64");
  res.locals.cspNonce = nonce;

  if (enableCsp) {
    const policy = buildContentSecurityPolicy(nonce);
    if (cspReportOnly) {
      res.set("Content-Security-Policy-Report-Only", policy);
    } else {
      res.set("Content-Security-Policy", policy);
    }
  }

  if (isProductionApp && req.secure) {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
});

app.use((req, res, next) => {
  const pathValue = ensureLeadingSlash(req.path || "/");
  const isAdminPath = pathValue === "/admin" || pathValue.startsWith("/admin/");
  const isAccountPath = pathValue === "/account" || pathValue.startsWith("/account/");
  const isAuthPath = pathValue.startsWith("/auth/");
  const isPolicyPath = pathValue === "/privacy-policy" || pathValue === "/terms-of-service";
  const isPrivatePath = isAdminPath || isAccountPath || isAuthPath || isPolicyPath;
  const robotsValue = isPrivatePath ? SEO_ROBOTS_NOINDEX : SEO_ROBOTS_INDEX;

  res.locals.authPublicConfig = getAuthPublicConfigForRequest(req);
  res.locals.assetVersion = app.locals.assetVersion;

  res.locals.seo = buildSeoPayload(req, {
    canonicalPath: pathValue,
    robots: robotsValue,
    ogType: pathValue === "/" ? "website" : "article"
  });
  res.locals.requestPath = pathValue;
  res.locals.isAdminPath = isAdminPath;

  if (isPrivatePath) {
    res.set("X-Robots-Tag", SEO_ROBOTS_NOINDEX);
  }

  next();
});

app.use(
  session({
    store: sessionStore,
    name: "bfang.sid",
    secret: adminConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: trustProxy,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: forceSecureCookie,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);
app.use(passport.initialize());
app.use((req, _res, next) => {
  if (isServerSessionVersionMismatch(req)) {
    clearAllAuthSessionState(req);
  }
  next();
});
app.use(requireSameOriginForAdminWrites);
  app.use("/vendor/emoji-mart", express.static(path.join(appRootDir, "node_modules", "emoji-mart")));
  app.use(
    "/vendor/emoji-mart-data",
    express.static(path.join(appRootDir, "node_modules", "@emoji-mart", "data"))
  );
const stickerManifestFilePattern = /^([a-z0-9_-]+)\.(png|webp|gif|jpe?g|avif)$/i;

const buildStickerLabel = (code) => {
  const raw = (code || "").toString().trim();
  if (!raw) return "Sticker";

  return raw
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) {
        return part.padStart(2, "0");
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
};

const readStickerManifest = async () => {
  let entries = [];
  try {
    entries = await fs.promises.readdir(stickersDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => {
      const fileName = (entry.name || "").toString().trim();
      const matched = stickerManifestFilePattern.exec(fileName);
      if (!matched) return null;
      const code = matched[1].toLowerCase();
      return {
        code,
        label: buildStickerLabel(code),
        src: `/stickers/${fileName}`
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.code.localeCompare(right.code, "en", { numeric: true, sensitivity: "base" }));
};

app.get(
  "/stickers/manifest.json",
  asyncHandler(async (req, res) => {
    try {
      const stickers = await readStickerManifest();
      const payload = { stickers };
      const payloadText = JSON.stringify(payload);
      const etag = `"${crypto.createHash("sha1").update(payloadText).digest("hex")}"`;
      const requestEtag = (req.get("if-none-match") || "").toString();

      res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      res.set("ETag", etag);

      if (requestEtag.includes(etag)) {
        return res.status(304).end();
      }

      return res.json(payload);
    } catch (error) {
      console.warn("Cannot build sticker manifest.", error);
      return res.status(500).json({
        error: "Không thể tải danh sách sticker."
      });
    }
  })
);

app.use(
  "/stickers",
  express.static(stickersDir, {
    maxAge: "365d",
    immutable: true
  })
);

const getMinifiedStylesheetPayload = (() => {
  const stylesheetPath = path.join(publicDir, "styles.css");
  let cachedMtimeMs = -1;
  let cachedPayload = null;

  return () => {
    const stat = fs.statSync(stylesheetPath);
    const mtimeMs = Number(stat.mtimeMs || 0);
    if (cachedPayload && cachedMtimeMs === mtimeMs) {
      return cachedPayload;
    }

    const sourceCss = fs.readFileSync(stylesheetPath, "utf8");
    const result = cssMinifier.minify(sourceCss);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      throw new Error(result.errors.join("; "));
    }

    const minifiedCss = (result.styles || "").toString() || sourceCss;
    const etag = `"${crypto.createHash("sha1").update(minifiedCss).digest("hex")}"`;
    const lastModified = stat.mtime.toUTCString();
    cachedMtimeMs = mtimeMs;
    cachedPayload = {
      css: minifiedCss,
      etag,
      lastModified
    };
    return cachedPayload;
  };
})();

const minifiedScriptNamePattern = /^[a-z0-9_-]+$/i;

const getMinifiedScriptPayload = (() => {
  const scriptCache = new Map();

  return async (scriptName) => {
    const safeScriptName = (scriptName || "").toString().trim();
    if (!minifiedScriptNamePattern.test(safeScriptName)) {
      throw new Error("Invalid script name.");
    }

    const scriptPath = path.join(publicDir, `${safeScriptName}.js`);
    const stat = fs.statSync(scriptPath);
    if (!stat.isFile()) {
      throw new Error("Script file unavailable.");
    }

    const mtimeMs = Number(stat.mtimeMs || 0);
    const cached = scriptCache.get(safeScriptName);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.payload;
    }

    const sourceJs = fs.readFileSync(scriptPath, "utf8");
    const result = await minifyJs(sourceJs, {
      compress: {
        passes: 2
      },
      mangle: true,
      format: {
        comments: false
      }
    });

    const minifiedJs = ((result && result.code) || "").toString().trim() || sourceJs;
    const payload = {
      content: minifiedJs,
      etag: `"${crypto.createHash("sha1").update(minifiedJs).digest("hex")}"`,
      lastModified: stat.mtime.toUTCString()
    };

    scriptCache.set(safeScriptName, {
      mtimeMs,
      payload
    });
    return payload;
  };
})();

const listPublicScriptNamesForMinify = () => {
  const entries = fs.readdirSync(publicDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry && entry.isFile && entry.isFile())
    .map((entry) => {
      const fileName = (entry.name || "").toString().trim();
      if (!fileName.toLowerCase().endsWith(".js")) return "";
      const scriptName = fileName.slice(0, -3).trim();
      if (!minifiedScriptNamePattern.test(scriptName)) return "";
      return scriptName;
    })
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
};

const prebuildMinifiedScriptsAtStartup = async () => {
  if (!isJsMinifyEnabled) {
    return {
      enabled: false,
      total: 0,
      built: 0,
      failed: 0
    };
  }

  const scriptNames = listPublicScriptNamesForMinify();
  let built = 0;
  let failed = 0;

  for (const scriptName of scriptNames) {
    try {
      await getMinifiedScriptPayload(scriptName);
      built += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Cannot prebuild minified /${scriptName}.js at startup.`, error);
    }
  }

  return {
    enabled: true,
    total: scriptNames.length,
    built,
    failed
  };
};

if (isJsMinifyEnabled) {
  app.get(/^\/([a-z0-9_-]+)\.js$/i, (req, res, next) => {
    const scriptName = req && req.params && req.params[0] ? String(req.params[0]).trim() : "";
    if (!scriptName) {
      return next();
    }

    return getMinifiedScriptPayload(scriptName)
      .then((payload) => {
        const requestEtag = (req.get("if-none-match") || "").toString();
        const requestModifiedSince = (req.get("if-modified-since") || "").toString();

        res.type("application/javascript; charset=utf-8");
        res.set(
          "Cache-Control",
          isProductionApp ? "public, max-age=86400, stale-while-revalidate=604800" : "no-cache"
        );
        res.set("ETag", payload.etag);
        res.set("Last-Modified", payload.lastModified);
        res.set("X-Asset-Minified", "1");

        if (requestEtag.includes(payload.etag) || requestModifiedSince === payload.lastModified) {
          return res.status(304).end();
        }

        return res.send(payload.content);
      })
      .catch((error) => {
        if (error && error.code === "ENOENT") {
          return next();
        }
        console.warn(`Cannot serve minified /${scriptName}.js.`, error);
        return next();
      });
  });
}

if (isProductionApp) {
  app.get("/styles.css", (req, res, next) => {
    try {
      const payload = getMinifiedStylesheetPayload();
      const requestEtag = (req.get("if-none-match") || "").toString();
      const requestModifiedSince = (req.get("if-modified-since") || "").toString();

      res.type("text/css; charset=utf-8");
      res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.set("ETag", payload.etag);
      res.set("Last-Modified", payload.lastModified);
      res.set("X-Asset-Minified", "1");

      if (requestEtag.includes(payload.etag) || requestModifiedSince === payload.lastModified) {
        return res.status(304).end();
      }

      return res.send(payload.css);
    } catch (error) {
      console.warn("Cannot serve minified /styles.css in production.", error);
      return next();
    }
  });
}

app.use(express.static(publicDir));
app.use(
  "/uploads",
  express.static(uploadDir, {
    maxAge: isProductionApp ? "7d" : 0,
    setHeaders: (res, servedPath) => {
      if (!isProductionApp) return;
      const targetPath = (servedPath || "").toString();
      if (staticImageFilePattern.test(targetPath)) {
        res.set("Cache-Control", staticImageCacheControl);
        return;
      }
      res.set("Cache-Control", staticUploadCacheControl);
    }
  })
);

app.locals.formatDate = formatDate;
app.locals.formatDateTime = formatDateTime;
app.locals.formatTimeAgo = formatTimeAgo;
app.locals.cacheBust = cacheBust;
app.locals.assetVersion = serverAssetVersion;

  return {
    prebuildMinifiedScriptsAtStartup,
  };
};

module.exports = configureCoreRuntime;
