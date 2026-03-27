"use strict";

require("dotenv").config();

const express = require("express");
const { getMangaDexBundle, getMangaDexChapterImages } = require("./src/providers/mangadex-provider");
const { getWeebDexBundle, getWeebDexChapterImages } = require("./src/providers/weebdex-provider");
const { clampInt, toBoolean } = require("./src/utils");

const PORT = clampInt(process.env.PORT, 3002, 1, 65535);
const VI_ONLY_LANGUAGES = ["vi"];

const asyncHandler = (handler) =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const normalizeIdParam = (value) => String(value == null ? "" : value).trim();

const getErrorStatusCode = (err) => {
  const statusCode = Number(err && err.statusCode);
  if (!Number.isFinite(statusCode)) return 502;
  if (statusCode < 400 || statusCode > 599) return 502;
  return statusCode;
};

const jsonError = (res, statusCode, message, extra = null) => {
  const payload = {
    ok: false,
    error: String(message || "Unexpected error")
  };
  if (extra && typeof extra === "object") {
    Object.assign(payload, extra);
  }
  return res.status(statusCode).json(payload);
};

const mapGroupList = (groups) =>
  (Array.isArray(groups) ? groups : [])
    .map((group) => ({
      id: group && group.id ? String(group.id) : "",
      name: group && group.name ? String(group.name).trim() : ""
    }))
    .filter((group) => group.id || group.name);

const chapterGroupLabel = (groups) => {
  const list = mapGroupList(groups);
  if (!list.length) return "Không rõ nhóm";
  return list.map((group) => group.name || group.id).join(", ");
};

const mapMangaForDesktop = (manga) => ({
  id: manga && manga.id ? String(manga.id) : "",
  title: manga && manga.title ? String(manga.title) : "",
  description: manga && manga.description ? String(manga.description) : "",
  coverUrl: manga && manga.coverUrl ? String(manga.coverUrl) : ""
});

const mapMangaDexChapterForDesktop = (chapter) => {
  const groups = mapGroupList(chapter && chapter.groups);
  return {
    chapterId: chapter && chapter.id ? String(chapter.id) : "",
    chapterNumber: chapter && chapter.chapter != null ? String(chapter.chapter) : "",
    volume: chapter && chapter.volume != null ? String(chapter.volume) : "",
    chapterTitle: chapter && chapter.title ? String(chapter.title).trim() : "",
    translatedLanguage: chapter && chapter.translatedLanguage ? String(chapter.translatedLanguage).toLowerCase() : "",
    publishAt: chapter && chapter.publishAt ? String(chapter.publishAt) : (chapter && chapter.readableAt ? String(chapter.readableAt) : ""),
    pages: chapter && Number.isFinite(Number(chapter.pages)) ? Number(chapter.pages) : 0,
    groups,
    groupLabel: chapterGroupLabel(groups)
  };
};

const mapWeebDexChapterForDesktop = (chapter) => {
  const groups = mapGroupList(chapter && chapter.groups);
  return {
    chapterId: chapter && chapter.id ? String(chapter.id) : "",
    chapterNumber: chapter && chapter.chapter != null ? String(chapter.chapter) : "",
    volume: chapter && chapter.volume != null ? String(chapter.volume) : "",
    chapterTitle: chapter && chapter.title ? String(chapter.title).trim() : "",
    translatedLanguage: chapter && chapter.translatedLanguage ? String(chapter.translatedLanguage).toLowerCase() : "",
    publishAt: chapter && chapter.publishedAt ? String(chapter.publishedAt) : "",
    pages: chapter && Number.isFinite(Number(chapter.imageCount)) ? Number(chapter.imageCount) : 0,
    groups,
    groupLabel: chapterGroupLabel(groups)
  };
};

const mapChapterInfoForDesktop = (chapterInfo) => {
  const info = chapterInfo && typeof chapterInfo === "object" ? chapterInfo : {};
  const groups = mapGroupList(info.groups);
  return {
    chapterNumber: info.chapterNumber != null ? String(info.chapterNumber) : "",
    chapterTitle: info.chapterTitle ? String(info.chapterTitle).trim() : "",
    volume: info.volume != null ? String(info.volume) : "",
    translatedLanguage: info.translatedLanguage ? String(info.translatedLanguage).toLowerCase() : "",
    publishAt: info.publishAt ? String(info.publishAt) : "",
    groups,
    groupLabel: chapterGroupLabel(groups)
  };
};

const createApp = () => {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept");
    if (String(req.method || "").toUpperCase() === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  });

  app.get("/", (_req, res) => {
    return res.json({
      ok: true,
      service: "api_web",
      endpoints: [
        "/health",
        "/web/mangadex/manga/:id",
        "/web/mangadex/chapter/:chapterId",
        "/web/weebdex/manga/:id",
        "/web/weebdex/chapter/:chapterId"
      ]
    });
  });

  app.get("/health", (_req, res) => {
    return res.json({
      ok: true,
      service: "api_web",
      timestamp: new Date().toISOString()
    });
  });

  app.get(
    "/web/mangadex/manga/:id",
    asyncHandler(async (req, res) => {
      const mangaId = normalizeIdParam(req.params.id);
      if (!mangaId) {
        return jsonError(res, 400, "Missing MangaDex manga id.");
      }

      const translatedLanguages = VI_ONLY_LANGUAGES.slice();
      const payload = await getMangaDexBundle({
        mangaId,
        order: String(req.query.order || "desc"),
        translatedLanguages,
        includeImages: false,
        includeDataSaver: true,
        includeExternalUrl: false,
        includeFuturePublishAt: false,
        useDevEnvironment: false,
        timeoutMs: clampInt(req.query.timeoutMs, 20000, 3000, 60000)
      });

      const languageSet = new Set(translatedLanguages.map((item) => String(item).toLowerCase()));
      const chapters = (Array.isArray(payload && payload.chapters) ? payload.chapters : [])
        .map(mapMangaDexChapterForDesktop)
        .filter((item) => item.chapterId)
        .filter((item) => !languageSet.size || languageSet.has(String(item.translatedLanguage || "").toLowerCase()));

      return res.json({
        ok: true,
        source: "mangadex",
        manga: mapMangaForDesktop(payload && payload.manga),
        chapters,
        meta: {
          fetchedAt: new Date().toISOString(),
          translatedLanguages,
          totalChapters: chapters.length
        }
      });
    })
  );

  app.get(
    "/web/mangadex/chapter/:chapterId",
    asyncHandler(async (req, res) => {
      const chapterId = normalizeIdParam(req.params.chapterId);
      if (!chapterId) {
        return jsonError(res, 400, "Missing MangaDex chapter id.");
      }

      const includeDataSaver = toBoolean(req.query.includeDataSaver, true);
      const preferDataSaver = toBoolean(req.query.preferDataSaver, true);
      const includeChapterInfo = toBoolean(req.query.info, false);

      const payload = await getMangaDexChapterImages({
        chapterId,
        useDevEnvironment: false,
        includeDataSaver,
        includeChapterInfo,
        timeoutMs: clampInt(req.query.timeoutMs, 20000, 3000, 60000)
      });

      const original = Array.isArray(payload && payload.imageUrls) ? payload.imageUrls : [];
      const runtime = Array.isArray(payload && payload.imageUrlsRuntime) ? payload.imageUrlsRuntime : [];
      const dataSaver = Array.isArray(payload && payload.imageUrlsDataSaver) ? payload.imageUrlsDataSaver : [];
      const selected = preferDataSaver && dataSaver.length ? dataSaver : original;

      const responsePayload = {
        ok: true,
        source: "mangadex",
        chapterId,
        imageUrls: selected,
        imageUrlsOriginal: original,
        imageUrlsRuntime: runtime,
        imageUrlsDataSaver: dataSaver,
        imageCount: selected.length,
        meta: {
          fetchedAt: new Date().toISOString(),
          preferDataSaver,
          includeDataSaver
        }
      };

      if (includeChapterInfo) {
        responsePayload.info = mapChapterInfoForDesktop(payload && payload.chapterInfo);
      }

      return res.json(responsePayload);
    })
  );

  app.get(
    "/web/weebdex/manga/:id",
    asyncHandler(async (req, res) => {
      const mangaId = normalizeIdParam(req.params.id);
      if (!mangaId) {
        return jsonError(res, 400, "Missing WeebDex manga id.");
      }

      const translatedLanguages = VI_ONLY_LANGUAGES.slice();
      const payload = await getWeebDexBundle({
        mangaId,
        order: String(req.query.order || "desc"),
        sort: String(req.query.sort || "name"),
        translatedLanguages,
        includeImages: false,
        preferOptimizedImages: false,
        chapterPageSize: clampInt(req.query.chapterPageSize, 100, 1, 100),
        detailConcurrency: clampInt(req.query.detailConcurrency, 4, 1, 12),
        timeoutMs: clampInt(req.query.timeoutMs, 20000, 3000, 60000)
      });

      const languageSet = new Set(translatedLanguages.map((item) => String(item).toLowerCase()));
      const chapters = (Array.isArray(payload && payload.chapters) ? payload.chapters : [])
        .map(mapWeebDexChapterForDesktop)
        .filter((item) => item.chapterId)
        .filter((item) => !languageSet.size || languageSet.has(String(item.translatedLanguage || "").toLowerCase()));

      return res.json({
        ok: true,
        source: "weebdex",
        manga: mapMangaForDesktop(payload && payload.manga),
        chapters,
        meta: {
          fetchedAt: new Date().toISOString(),
          translatedLanguages,
          totalChapters: chapters.length
        }
      });
    })
  );

  app.get(
    "/web/weebdex/chapter/:chapterId",
    asyncHandler(async (req, res) => {
      const chapterId = normalizeIdParam(req.params.chapterId);
      if (!chapterId) {
        return jsonError(res, 400, "Missing WeebDex chapter id.");
      }

      const preferOptimizedImages = toBoolean(req.query.preferOptimizedImages, true);
      const includeChapterInfo = toBoolean(req.query.info, false);

      const payload = await getWeebDexChapterImages({
        chapterId,
        preferOptimizedImages,
        includeChapterInfo,
        timeoutMs: clampInt(req.query.timeoutMs, 20000, 3000, 60000)
      });

      const original = Array.isArray(payload && payload.imageUrls) ? payload.imageUrls : [];
      const optimized = Array.isArray(payload && payload.imageUrlsOptimized) ? payload.imageUrlsOptimized : [];
      const selected = preferOptimizedImages && optimized.length ? optimized : original;

      const responsePayload = {
        ok: true,
        source: "weebdex",
        chapterId,
        imageUrls: selected,
        imageUrlsOriginal: original,
        imageUrlsOptimized: optimized,
        imageCount: selected.length,
        meta: {
          fetchedAt: new Date().toISOString(),
          preferOptimizedImages
        }
      };

      if (includeChapterInfo) {
        responsePayload.info = mapChapterInfoForDesktop(payload && payload.chapterInfo);
      }

      return res.json(responsePayload);
    })
  );

  app.use((req, res) => jsonError(res, 404, "Endpoint not found."));

  app.use((err, _req, res, _next) => {
    const statusCode = getErrorStatusCode(err);
    const message = err && err.message ? String(err.message) : "Unexpected server error";
    const debug = process.env.NODE_ENV === "production"
      ? undefined
      : {
          statusCode: Number(err && err.statusCode) || null,
          providerPayload: err && err.payload ? err.payload : undefined,
          providerUrl: err && err.url ? String(err.url) : undefined
        };

    if (statusCode >= 500) {
      console.error("[api_web] request failed", err);
    }
    return jsonError(res, statusCode, message, debug || null);
  });

  return app;
};

const startServer = async () => {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`[api_web] listening on http://127.0.0.1:${PORT}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

if (require.main === module) {
  startServer().catch((err) => {
    console.error("[api_web] failed to start", err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer
};
