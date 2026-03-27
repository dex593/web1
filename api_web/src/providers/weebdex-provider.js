"use strict";

const { requestJson } = require("../http-client");
const {
  clampInt,
  normalizeStringList,
  toBoolean,
  mapWithConcurrency
} = require("../utils");

const WEEBDEX_API_BASE_URL = String(process.env.WEEBDEX_API_BASE_URL || "https://api.weebdex.org")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_NODE_FALLBACK = String(process.env.WEEBDEX_NODE_FALLBACK || "https://srv.weebdex.net")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_COVER_BASE_URL = String(process.env.WEEBDEX_COVER_BASE_URL || "https://srv.weebdex.net/covers")
  .trim()
  .replace(/\/+$/, "");

const WEEBDEX_ORIGIN = String(process.env.WEEBDEX_ORIGIN || "https://weebdex.org").trim() || "https://weebdex.org";
const WEEBDEX_REFERER = String(process.env.WEEBDEX_REFERER || "https://weebdex.org/").trim() || "https://weebdex.org/";
const WEEBDEX_ACCESS_TOKEN = String(process.env.WEEBDEX_ACCESS_TOKEN || "").trim();
const WEEBDEX_CHAPTER_PAGE_SIZE = clampInt(process.env.WEEBDEX_CHAPTER_PAGE_SIZE, 100, 1, 100);

const buildApiUrl = (pathname, queryEntries = []) => {
  const url = new URL(`${WEEBDEX_API_BASE_URL}${pathname}`);
  (Array.isArray(queryEntries) ? queryEntries : []).forEach(([key, value]) => {
    if (!key || value == null || value === "") return;
    url.searchParams.append(String(key), String(value));
  });
  return url.toString();
};

const normalizeAuthorizationHeader = (tokenValue) => {
  const token = String(tokenValue == null ? "" : tokenValue).trim();
  if (!token) return "";
  if (/^Bearer\s+/i.test(token)) return token;
  return `Bearer ${token}`;
};

const weebdexHeaders = (includeAuth = true) => {
  const headers = {
    Origin: WEEBDEX_ORIGIN,
    Referer: WEEBDEX_REFERER,
    "User-Agent": "bfang-api-web/1.0"
  };
  if (includeAuth && WEEBDEX_ACCESS_TOKEN) {
    const authorization = normalizeAuthorizationHeader(WEEBDEX_ACCESS_TOKEN);
    if (authorization) {
      headers.Authorization = authorization;
    }
  }
  return headers;
};

const normalizePageItems = (pages) =>
  (Array.isArray(pages) ? pages : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const name = item.name ? String(item.name).trim() : "";
      if (!name) return null;
      return {
        name,
        dimensions: Array.isArray(item.dimensions)
          ? item.dimensions.map((value) => Number(value) || 0)
          : []
      };
    })
    .filter(Boolean);

const buildWeebDexImagePages = ({ node, chapterId, pages }) => {
  const baseNode = String(node || "").trim().replace(/\/+$/, "") || WEEBDEX_NODE_FALLBACK;
  if (!chapterId) return [];
  return normalizePageItems(pages).map((page) => ({
    name: page.name,
    dimensions: page.dimensions,
    url: `${baseNode}/data/${encodeURIComponent(String(chapterId))}/${encodeURIComponent(page.name)}`
  }));
};

const mapTagLikeList = (items) =>
  (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      return {
        id: item.id ? String(item.id) : "",
        name: item.name ? String(item.name) : ""
      };
    })
    .filter((item) => item && (item.id || item.name));

const mapWeebDexManga = (payload) => {
  const manga = payload && typeof payload === "object" ? payload : {};
  const relationships = manga && manga.relationships && typeof manga.relationships === "object"
    ? manga.relationships
    : {};
  const cover = relationships.cover && typeof relationships.cover === "object" ? relationships.cover : null;
  const coverId = cover && cover.id ? String(cover.id).trim() : "";
  const coverExtRaw = cover && cover.ext ? String(cover.ext).trim() : "";
  const coverExt = coverExtRaw ? coverExtRaw.replace(/^\./, "") : "";
  const mangaId = manga && manga.id ? String(manga.id).trim() : "";

  return {
    id: mangaId,
    title: manga.title ? String(manga.title) : "",
    description: manga.description ? String(manga.description) : "",
    status: manga.status ? String(manga.status) : "",
    state: manga.state ? String(manga.state) : "",
    contentRating: manga.content_rating ? String(manga.content_rating) : "",
    demographic: manga.demographic ? String(manga.demographic) : "",
    language: manga.language ? String(manga.language) : "",
    year: manga.year != null ? Number(manga.year) || null : null,
    lastChapter: manga.last_chapter ? String(manga.last_chapter) : "",
    lastVolume: manga.last_volume ? String(manga.last_volume) : "",
    createdAt: manga.created_at ? String(manga.created_at) : "",
    updatedAt: manga.updated_at ? String(manga.updated_at) : "",
    publishedAt: manga.published_at ? String(manga.published_at) : "",
    altTitles: manga.alt_titles && typeof manga.alt_titles === "object" ? manga.alt_titles : {},
    availableLanguages: Array.isArray(relationships.available_languages)
      ? relationships.available_languages.map((item) => String(item))
      : [],
    tags: mapTagLikeList(relationships.tags),
    authors: mapTagLikeList(relationships.authors),
    artists: mapTagLikeList(relationships.artists),
    cover: cover
      ? {
          id: coverId,
          ext: coverExt,
          volume: cover.volume ? String(cover.volume) : "",
          language: cover.language ? String(cover.language) : ""
        }
      : null,
    coverUrl: mangaId && coverId && coverExt
      ? `${WEEBDEX_COVER_BASE_URL}/${encodeURIComponent(mangaId)}/${encodeURIComponent(coverId)}.${encodeURIComponent(coverExt)}`
      : ""
  };
};

const mapWeebDexChapterBase = (chapterPayload) => {
  const chapter = chapterPayload && typeof chapterPayload === "object" ? chapterPayload : {};
  const relationships = chapter && chapter.relationships && typeof chapter.relationships === "object"
    ? chapter.relationships
    : {};

  const groups = Array.isArray(relationships.groups)
    ? relationships.groups
        .map((group) => ({
          id: group && group.id ? String(group.id) : "",
          name: group && group.name ? String(group.name) : ""
        }))
        .filter((group) => group.id || group.name)
    : [];

  const uploader = relationships.uploader && typeof relationships.uploader === "object"
    ? {
        id: relationships.uploader.id ? String(relationships.uploader.id) : "",
        username: relationships.uploader.username ? String(relationships.uploader.username) : ""
      }
    : null;

  return {
    id: chapter.id ? String(chapter.id) : "",
    chapter: chapter.chapter == null ? "" : String(chapter.chapter),
    volume: chapter.volume == null ? "" : String(chapter.volume),
    title: chapter.title ? String(chapter.title) : "",
    language: chapter.language ? String(chapter.language) : "",
    translatedLanguage: chapter.language ? String(chapter.language) : "",
    node: chapter.node ? String(chapter.node) : "",
    sourceId: chapter.source_id ? String(chapter.source_id) : "",
    isUnavailable: Boolean(chapter.is_unavailable),
    publishedAt: chapter.published_at ? String(chapter.published_at) : "",
    createdAt: chapter.created_at ? String(chapter.created_at) : "",
    updatedAt: chapter.updated_at ? String(chapter.updated_at) : "",
    groups,
    uploader,
    rawData: normalizePageItems(chapter.data),
    rawDataOptimized: normalizePageItems(chapter.data_optimized)
  };
};

const resolveChapterPages = async ({ chapter, timeoutMs }) => {
  if (!chapter || !chapter.id) return chapter;

  if ((chapter.rawData && chapter.rawData.length) || (chapter.rawDataOptimized && chapter.rawDataOptimized.length)) {
    return chapter;
  }

  const detailResponse = await requestJson(
    buildApiUrl(`/chapter/${encodeURIComponent(chapter.id)}`),
    {
      timeoutMs,
      retries: 2,
      retryDelayMs: 450,
      headers: weebdexHeaders()
    }
  );

  const detailData = detailResponse ? detailResponse.data : null;

  if (Array.isArray(detailData)) {
    return {
      ...chapter,
      rawData: normalizePageItems(detailData),
      rawDataOptimized: []
    };
  }

  const detailPayload = detailData && typeof detailData === "object"
    ? detailData
    : {};

  const fallbackNode = detailPayload.node ? String(detailPayload.node) : chapter.node;

  return {
    ...chapter,
    node: fallbackNode,
    rawData: normalizePageItems(detailPayload.data),
    rawDataOptimized: normalizePageItems(detailPayload.data_optimized)
  };
};

const buildWeebDexChapterQuery = ({ limit, page, order, safeSort, translatedLanguages }) => {
  const query = [
    ["limit", limit],
    ["page", page],
    ["order", order],
    ["sort", safeSort]
  ];
  if (translatedLanguages.length) {
    query.push(["tlang", translatedLanguages.join(",")]);
  }
  return query;
};

const fetchWeebDexChapters = async ({ mangaId, timeoutMs, order, safeSort, translatedLanguages, pageSize }) => {
  const chapters = [];
  let total = null;
  let page = 1;
  let lastLimit = pageSize;

  while (true) {
    const chapterFeedResponse = await requestJson(
      buildApiUrl(
        `/manga/${encodeURIComponent(mangaId)}/chapters`,
        buildWeebDexChapterQuery({
          limit: pageSize,
          page,
          order,
          safeSort,
          translatedLanguages
        })
      ),
      {
        timeoutMs,
        retries: 2,
        retryDelayMs: 450,
        headers: weebdexHeaders()
      }
    );

    const chapterFeed = chapterFeedResponse && chapterFeedResponse.data && typeof chapterFeedResponse.data === "object"
      ? chapterFeedResponse.data
      : {};
    const chapterItems = Array.isArray(chapterFeed.data) ? chapterFeed.data : [];
    const parsedTotal = Number(chapterFeed.total);
    if (Number.isFinite(parsedTotal) && parsedTotal >= 0) {
      total = parsedTotal;
    }

    const parsedLimit = Number(chapterFeed.limit);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      lastLimit = clampInt(parsedLimit, pageSize, 1, 100);
    }

    if (!chapterItems.length) {
      break;
    }

    chapterItems.forEach((item) => {
      chapters.push(mapWeebDexChapterBase(item));
    });

    if (Number.isFinite(total) && total != null && chapters.length >= total) {
      break;
    }
    if (chapterItems.length < lastLimit) {
      break;
    }

    page += 1;
  }

  return {
    chapters,
    totalChapters: Number.isFinite(total) && total != null ? total : chapters.length,
    pageSize: lastLimit
  };
};

const getWeebDexBundle = async (options = {}) => {
  const mangaId = String(options.mangaId == null ? "" : options.mangaId).trim();
  if (!mangaId) {
    const error = new Error("WeebDex manga id is required.");
    error.statusCode = 400;
    throw error;
  }

  const timeoutMs = clampInt(options.timeoutMs, 20000, 3000, 60000);
  const includeImages = toBoolean(options.includeImages, false);
  const preferOptimizedImages = toBoolean(options.preferOptimizedImages, false);
  const detailConcurrency = clampInt(options.detailConcurrency, 4, 1, 12);
  const chapterPageSize = clampInt(options.chapterPageSize, WEEBDEX_CHAPTER_PAGE_SIZE, 1, 100);
  const order = String(options.order || "desc").trim().toLowerCase() === "asc" ? "asc" : "desc";
  const sort = String(options.sort || "name").trim();
  const safeSort = sort === "publishedAt" ? "publishedAt" : "name";
  const translatedLanguages = normalizeStringList(options.translatedLanguages);

  const mangaResponse = await requestJson(
    buildApiUrl(`/manga/${encodeURIComponent(mangaId)}`),
    {
      timeoutMs,
      retries: 2,
      retryDelayMs: 450,
      headers: weebdexHeaders()
    }
  );

  const manga = mapWeebDexManga(mangaResponse.data || {});

  const chapterFeed = await fetchWeebDexChapters({
    mangaId,
    timeoutMs,
    order,
    safeSort,
    translatedLanguages,
    pageSize: chapterPageSize
  });
  let chapters = chapterFeed.chapters;

  if (includeImages && chapters.length > 0) {
    chapters = await mapWithConcurrency(chapters, detailConcurrency, async (chapter) => {
      try {
        const chapterWithData = await resolveChapterPages({
          chapter,
          timeoutMs
        });

        const images = buildWeebDexImagePages({
          node: chapterWithData.node,
          chapterId: chapterWithData.id,
          pages: preferOptimizedImages && chapterWithData.rawDataOptimized.length
            ? chapterWithData.rawDataOptimized
            : chapterWithData.rawData
        });

        const optimizedImages = buildWeebDexImagePages({
          node: chapterWithData.node,
          chapterId: chapterWithData.id,
          pages: chapterWithData.rawDataOptimized
        });

        return {
          ...chapterWithData,
          imageUrls: images.map((item) => item.url),
          imageUrlsOptimized: optimizedImages.map((item) => item.url),
          imagePages: images,
          imagePagesOptimized: optimizedImages,
          imageCount: images.length,
          imageOptimizedCount: optimizedImages.length,
          rawData: undefined,
          rawDataOptimized: undefined
        };
      } catch (err) {
        return {
          ...chapter,
          imageUrls: [],
          imageUrlsOptimized: [],
          imagePages: [],
          imagePagesOptimized: [],
          imageCount: 0,
          imageOptimizedCount: 0,
          imageError: err && err.message ? String(err.message) : "Failed to resolve chapter images",
          rawData: undefined,
          rawDataOptimized: undefined
        };
      }
    });
  } else {
    chapters = chapters.map((chapter) => ({
      ...chapter,
      imageUrls: [],
      imageUrlsOptimized: [],
      imagePages: [],
      imagePagesOptimized: [],
      imageCount: 0,
      imageOptimizedCount: 0,
      rawData: undefined,
      rawDataOptimized: undefined
    }));
  }

  return {
    source: "weebdex",
    manga,
    chapters,
    meta: {
      fetchedAt: new Date().toISOString(),
      requested: {
        order,
        sort: safeSort,
        chapterPageSize,
        translatedLanguages,
        includeImages,
        preferOptimizedImages
      },
      totalChapters: chapterFeed.totalChapters,
      returnedChapters: chapters.length,
      limit: chapterFeed.pageSize
    }
  };
};

const getWeebDexChapterImages = async (options = {}) => {
  const chapterId = String(options.chapterId == null ? "" : options.chapterId).trim();
  if (!chapterId) {
    const error = new Error("WeebDex chapter id is required.");
    error.statusCode = 400;
    throw error;
  }

  const timeoutMs = clampInt(options.timeoutMs, 20000, 3000, 60000);
  const preferOptimizedImages = toBoolean(options.preferOptimizedImages, false);
  const includeChapterInfo = toBoolean(options.includeChapterInfo, false);

  const detailResponse = await requestJson(
    buildApiUrl(`/chapter/${encodeURIComponent(chapterId)}`),
    {
      timeoutMs,
      retries: 2,
      retryDelayMs: 450,
      headers: weebdexHeaders()
    }
  );

  const detailData = detailResponse ? detailResponse.data : null;

  let chapterWithData;
  if (Array.isArray(detailData)) {
    chapterWithData = {
      id: chapterId,
      node: WEEBDEX_NODE_FALLBACK,
      rawData: normalizePageItems(detailData),
      rawDataOptimized: []
    };
  } else {
    const detailPayload = detailData && typeof detailData === "object" ? detailData : {};
    chapterWithData = await resolveChapterPages({
      chapter: mapWeebDexChapterBase(detailPayload),
      timeoutMs
    });
  }

  const originalImages = buildWeebDexImagePages({
    node: chapterWithData.node,
    chapterId: chapterWithData.id,
    pages: chapterWithData.rawData
  });

  const optimizedImages = buildWeebDexImagePages({
    node: chapterWithData.node,
    chapterId: chapterWithData.id,
    pages: chapterWithData.rawDataOptimized
  });

  const selectedImages = preferOptimizedImages && optimizedImages.length
    ? optimizedImages
    : originalImages;

  const responsePayload = {
    source: "weebdex",
    chapterId: chapterWithData.id || chapterId,
    imageUrls: originalImages.map((item) => item.url),
    imageUrlsOptimized: optimizedImages.map((item) => item.url),
    imageUrlsSelected: selectedImages.map((item) => item.url),
    imagePages: originalImages,
    imagePagesOptimized: optimizedImages,
    imagePagesSelected: selectedImages,
    imageCount: originalImages.length,
    imageOptimizedCount: optimizedImages.length,
    imageSelectedCount: selectedImages.length,
    meta: {
      fetchedAt: new Date().toISOString(),
      preferOptimizedImages,
      node: chapterWithData.node || ""
    }
  };

  if (includeChapterInfo) {
    responsePayload.chapterInfo = {
      chapterNumber: chapterWithData && chapterWithData.chapter != null ? String(chapterWithData.chapter) : "",
      chapterTitle: chapterWithData && chapterWithData.title ? String(chapterWithData.title).trim() : "",
      volume: chapterWithData && chapterWithData.volume != null ? String(chapterWithData.volume) : "",
      translatedLanguage: chapterWithData && chapterWithData.translatedLanguage
        ? String(chapterWithData.translatedLanguage).toLowerCase()
        : "",
      publishAt: chapterWithData && chapterWithData.publishedAt ? String(chapterWithData.publishedAt) : "",
      groups: Array.isArray(chapterWithData && chapterWithData.groups)
        ? chapterWithData.groups
            .map((group) => ({
              id: group && group.id ? String(group.id) : "",
              name: group && group.name ? String(group.name).trim() : ""
            }))
            .filter((group) => group.id || group.name)
        : []
    };
  }

  return responsePayload;
};

module.exports = {
  getWeebDexBundle,
  getWeebDexChapterImages
};
