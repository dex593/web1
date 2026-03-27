"use strict";

const { requestJson } = require("../http-client");
const {
  clampInt,
  normalizeStringList,
  pickLocalizedText,
  mapWithConcurrency,
  toBoolean
} = require("../utils");

const MANGADEX_API_BASE_URL = "https://api.mangadex.org";
const MANGADEX_API_DEV_BASE_URL = String(process.env.MANGADEX_API_DEV_BASE_URL || "https://api.mangadex.dev")
  .trim()
  .replace(/\/+$/, "");
const MANGADEX_ACCESS_TOKEN = String(process.env.MANGADEX_ACCESS_TOKEN || "").trim();
const MANGADEX_USER_AGENT = String(process.env.MANGADEX_USER_AGENT || "bfang-api-web/1.0").trim() || "bfang-api-web/1.0";
const MANGADEX_REFERER = String(process.env.MANGADEX_REFERER || "https://mangadex.org/").trim() || "https://mangadex.org/";

const MANGADEX_COVER_BASE_URL = String(process.env.MANGADEX_COVER_BASE_URL || "https://uploads.mangadex.org/covers")
  .trim()
  .replace(/\/+$/, "");
const DEFAULT_AT_HOME_CONCURRENCY = clampInt(process.env.MANGADEX_AT_HOME_CONCURRENCY, 3, 1, 10);

const resolveApiBaseUrl = (useDevEnvironment) =>
  useDevEnvironment ? MANGADEX_API_DEV_BASE_URL : MANGADEX_API_BASE_URL;

const extractBaseUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}`;
  } catch (_err) {
    return "";
  }
};

const buildApiUrl = (baseUrl, pathname, queryEntries = []) => {
  const url = new URL(`${baseUrl}${pathname}`);
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

const createMangaDexHeaders = (includeAuth) => {
  const headers = {
    "User-Agent": MANGADEX_USER_AGENT,
    Referer: MANGADEX_REFERER
  };
  if (includeAuth && MANGADEX_ACCESS_TOKEN) {
    const authorization = normalizeAuthorizationHeader(MANGADEX_ACCESS_TOKEN);
    if (authorization) {
      headers.Authorization = authorization;
    }
  }
  return headers;
};

const requestMangaDexJson = async ({
  apiBaseUrl,
  pathname,
  queryEntries,
  requestOptions,
  includeAuth
}) => {
  const targetBaseUrl = String(apiBaseUrl == null ? "" : apiBaseUrl).trim() || MANGADEX_API_BASE_URL;

  const response = await requestJson(buildApiUrl(targetBaseUrl, pathname, queryEntries), {
    ...(requestOptions || {}),
    headers: {
      ...((requestOptions && requestOptions.headers) || {}),
      ...createMangaDexHeaders(includeAuth !== false)
    }
  });
  return {
    ...response,
    baseUrlUsed: targetBaseUrl
  };
};

const parseMangaDexManga = (payload) => {
  const entity = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const attributes = entity && entity.attributes && typeof entity.attributes === "object" ? entity.attributes : {};
  const relationships = Array.isArray(entity.relationships) ? entity.relationships : [];

  const title = pickLocalizedText(attributes.title);
  const description = pickLocalizedText(attributes.description);
  const altTitles = Array.isArray(attributes.altTitles)
    ? attributes.altTitles
        .map((entry) => pickLocalizedText(entry))
        .filter(Boolean)
    : [];

  const coverRelation = relationships.find((item) => item && item.type === "cover_art");
  const coverFileName = coverRelation
    && coverRelation.attributes
    && coverRelation.attributes.fileName
    ? String(coverRelation.attributes.fileName).trim()
    : "";
  const mangaId = entity && entity.id ? String(entity.id).trim() : "";
  const coverUrl = mangaId && coverFileName
    ? `${MANGADEX_COVER_BASE_URL}/${encodeURIComponent(mangaId)}/${encodeURIComponent(coverFileName)}`
    : "";

  const tags = Array.isArray(attributes.tags)
    ? attributes.tags
        .map((tag) => {
          const tagAttributes = tag && tag.attributes && typeof tag.attributes === "object" ? tag.attributes : {};
          return {
            id: tag && tag.id ? String(tag.id) : "",
            name: pickLocalizedText(tagAttributes.name)
          };
        })
        .filter((tag) => tag.name)
    : [];

  const mapRelationshipNames = (type) =>
    relationships
      .filter((item) => item && item.type === type)
      .map((item) => ({
        id: item && item.id ? String(item.id) : "",
        name: item && item.attributes && item.attributes.name ? String(item.attributes.name).trim() : ""
      }))
      .filter((item) => item.id || item.name);

  return {
    id: mangaId,
    title,
    altTitles,
    description,
    status: attributes.status ? String(attributes.status) : "",
    contentRating: attributes.contentRating ? String(attributes.contentRating) : "",
    publicationDemographic: attributes.publicationDemographic ? String(attributes.publicationDemographic) : "",
    year: attributes.year != null ? Number(attributes.year) || null : null,
    lastChapter: attributes.lastChapter ? String(attributes.lastChapter) : "",
    lastVolume: attributes.lastVolume ? String(attributes.lastVolume) : "",
    availableTranslatedLanguages: Array.isArray(attributes.availableTranslatedLanguages)
      ? attributes.availableTranslatedLanguages.map((item) => String(item))
      : [],
    originalLanguage: attributes.originalLanguage ? String(attributes.originalLanguage) : "",
    tags,
    coverUrl,
    authors: mapRelationshipNames("author"),
    artists: mapRelationshipNames("artist")
  };
};

const parseMangaDexChapter = (item) => {
  const attributes = item && item.attributes && typeof item.attributes === "object" ? item.attributes : {};
  const relationships = Array.isArray(item && item.relationships) ? item.relationships : [];
  const groups = relationships
    .filter((relation) => relation && relation.type === "scanlation_group")
    .map((relation) => ({
      id: relation && relation.id ? String(relation.id) : "",
      name: relation && relation.attributes && relation.attributes.name
        ? String(relation.attributes.name).trim()
        : ""
    }))
    .filter((group) => group.id || group.name);

  return {
    id: item && item.id ? String(item.id) : "",
    chapter: attributes.chapter == null ? "" : String(attributes.chapter),
    volume: attributes.volume == null ? "" : String(attributes.volume),
    title: attributes.title ? String(attributes.title).trim() : "",
    translatedLanguage: attributes.translatedLanguage ? String(attributes.translatedLanguage) : "",
    pages: attributes.pages != null ? Number(attributes.pages) || 0 : 0,
    publishAt: attributes.publishAt ? String(attributes.publishAt) : "",
    readableAt: attributes.readableAt ? String(attributes.readableAt) : "",
    createdAt: attributes.createdAt ? String(attributes.createdAt) : "",
    updatedAt: attributes.updatedAt ? String(attributes.updatedAt) : "",
    externalUrl: attributes.externalUrl ? String(attributes.externalUrl) : "",
    isUnavailable: Boolean(attributes.isUnavailable),
    groups
  };
};

const fetchMangaDexChapterDetails = async ({ chapterId, timeoutMs, apiBaseUrl }) => {
  const response = await requestMangaDexJson({
    apiBaseUrl,
    pathname: `/chapter/${encodeURIComponent(chapterId)}`,
    queryEntries: [
      ["includes[]", "scanlation_group"]
    ],
    requestOptions: {
      timeoutMs,
      retries: 2,
      retryDelayMs: 450
    },
    includeAuth: false
  });

  const payload = response && response.data && typeof response.data === "object" ? response.data : {};
  const chapterEntity = payload && payload.data && typeof payload.data === "object" ? payload.data : null;
  if (!chapterEntity || !chapterEntity.id) {
    const error = new Error(`Chapter with ID ${chapterId} not found.`);
    error.statusCode = 404;
    throw error;
  }

  return parseMangaDexChapter(chapterEntity);
};

const fetchMangaDexAtHomePages = async ({ chapterId, timeoutMs, apiBaseUrl }) => {
  const response = await requestMangaDexJson({
    apiBaseUrl,
    pathname: `/at-home/server/${encodeURIComponent(chapterId)}`,
    queryEntries: [],
    requestOptions: {
      timeoutMs,
      retries: 2,
      retryDelayMs: 500
    },
    includeAuth: false
  });

  const payload = response && response.data && typeof response.data === "object" ? response.data : {};
  const chapter = payload && payload.chapter && typeof payload.chapter === "object" ? payload.chapter : {};
  const hash = chapter && chapter.hash ? String(chapter.hash).trim() : "";
  const baseUrl = payload && payload.baseUrl ? String(payload.baseUrl).trim().replace(/\/+$/, "") : "";
  const dataFiles = Array.isArray(chapter.data) ? chapter.data.map((item) => String(item).trim()).filter(Boolean) : [];
  const dataSaverFiles = Array.isArray(chapter.dataSaver)
    ? chapter.dataSaver.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const buildUrls = (urlBase, folderName, fileNames) => {
    const safeBase = String(urlBase || "").trim().replace(/\/+$/, "");
    if (!safeBase || !hash) return [];
    return fileNames.map((fileName) => `${safeBase}/${folderName}/${encodeURIComponent(hash)}/${encodeURIComponent(fileName)}`);
  };

  const runtimeDataUrls = buildUrls(baseUrl, "data", dataFiles);
  const runtimeDataSaverUrls = buildUrls(baseUrl, "data-saver", dataSaverFiles);

  return {
    baseUrl,
    hash,
    requestBaseUrl: extractBaseUrl(response.baseUrlUsed || response.url),
    files: dataFiles,
    filesDataSaver: dataSaverFiles,
    imageUrls: runtimeDataUrls,
    imageUrlsDataSaver: runtimeDataSaverUrls,
    imageUrlsRuntime: runtimeDataUrls,
    imageUrlsDataSaverRuntime: runtimeDataSaverUrls
  };
};

const buildFeedQueryEntries = ({
  limit,
  offset,
  order,
  translatedLanguages,
  includeExternalUrl,
  includeFuturePublishAt
}) => {
  const queryEntries = [
    ["limit", limit],
    ["offset", offset],
    ["order[chapter]", order],
    ["includeFuturePublishAt", includeFuturePublishAt ? "1" : "0"],
    ["includes[]", "scanlation_group"]
  ];

  if (includeExternalUrl === true || includeExternalUrl === false) {
    queryEntries.push(["includeExternalUrl", includeExternalUrl ? "1" : "0"]);
  }

  normalizeStringList(translatedLanguages).forEach((language) => {
    queryEntries.push(["translatedLanguage[]", language]);
  });

  return queryEntries;
};

const fetchMangaDexChapters = async ({
  apiBaseUrl,
  mangaId,
  order,
  translatedLanguages,
  timeoutMs,
  includeExternalUrl,
  includeFuturePublishAt
}) => {
  const chapters = [];
  const baseUrlUsedSet = new Set();
  let offset = 0;
  const requestPageSize = 500;
  let total = null;

  while (true) {
    const response = await requestMangaDexJson({
      apiBaseUrl,
      pathname: `/manga/${encodeURIComponent(mangaId)}/feed`,
      queryEntries: buildFeedQueryEntries({
        limit: requestPageSize,
        offset,
        order,
        translatedLanguages,
        includeExternalUrl,
        includeFuturePublishAt
      }),
      requestOptions: {
        timeoutMs,
        retries: 2,
        retryDelayMs: 450
      },
      includeAuth: true
    });

    const baseUrlUsed = extractBaseUrl(response.baseUrlUsed || response.url);
    if (baseUrlUsed) {
      baseUrlUsedSet.add(baseUrlUsed);
    }

    const payload = response && response.data && typeof response.data === "object" ? response.data : {};
    const list = Array.isArray(payload.data) ? payload.data : [];
    const payloadTotal = Number(payload.total);
    if (Number.isFinite(payloadTotal) && payloadTotal >= 0) {
      total = payloadTotal;
    }
    if (!list.length) break;

    for (let i = 0; i < list.length; i += 1) {
      chapters.push(parseMangaDexChapter(list[i]));
    }

    offset += list.length;
    if (Number.isFinite(total) && total != null && offset >= total) break;
    if (list.length < requestPageSize) break;
  }

  return {
    chapters,
    total: Number.isFinite(total) && total != null ? total : chapters.length,
    baseUrlsUsed: Array.from(baseUrlUsedSet)
  };
};

const getMangaDexBundle = async (options = {}) => {
  const mangaId = String(options.mangaId == null ? "" : options.mangaId).trim();
  if (!mangaId) {
    const error = new Error("MangaDex manga id is required.");
    error.statusCode = 400;
    throw error;
  }

  const timeoutMs = clampInt(options.timeoutMs, 20000, 3000, 60000);
  const includeImages = toBoolean(options.includeImages, true);
  const includeDataSaver = toBoolean(options.includeDataSaver, true);
  const includeExternalUrl = options.includeExternalUrl == null
    ? null
    : toBoolean(options.includeExternalUrl, false);
  const includeFuturePublishAt = toBoolean(options.includeFuturePublishAt, false);
  const useDevEnvironment = toBoolean(options.useDevEnvironment, false);
  const atHomeConcurrency = clampInt(options.atHomeConcurrency, DEFAULT_AT_HOME_CONCURRENCY, 1, 10);
  const order = String(options.order || "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
  const translatedLanguages = normalizeStringList(options.translatedLanguages);
  const apiBaseUrl = resolveApiBaseUrl(useDevEnvironment);

  let mangaResponse;
  try {
    mangaResponse = await requestMangaDexJson({
      apiBaseUrl,
      pathname: `/manga/${encodeURIComponent(mangaId)}`,
      queryEntries: [
        ["includes[]", "cover_art"],
        ["includes[]", "author"],
        ["includes[]", "artist"],
        ["includes[]", "tag"]
      ],
      requestOptions: {
        timeoutMs,
        retries: 2,
        retryDelayMs: 450
      },
      includeAuth: true
    });
  } catch (err) {
    if (useDevEnvironment && Number(err && err.statusCode) === 404) {
      const baseMessage = String(err && err.message ? err.message : "Manga not found").replace(/\.+\s*$/, "");
      err.message = `${baseMessage}. This request is using api.mangadex.dev (localhost mode), and this manga ID may only exist on api.mangadex.org.`;
    }
    throw err;
  }

  const manga = parseMangaDexManga(mangaResponse.data || {});
  const chapterResult = await fetchMangaDexChapters({
    apiBaseUrl,
    mangaId,
    order,
    translatedLanguages,
    timeoutMs,
    includeExternalUrl,
    includeFuturePublishAt
  });

  let chapters = chapterResult.chapters;

  if (includeImages && chapters.length > 0) {
    chapters = await mapWithConcurrency(chapters, atHomeConcurrency, async (chapter) => {
      if (!chapter || !chapter.id) return chapter;
      try {
        const pages = await fetchMangaDexAtHomePages({
          chapterId: chapter.id,
          timeoutMs,
          apiBaseUrl
        });
        return {
          ...chapter,
          imageUrls: pages.imageUrls,
          imageUrlsDataSaver: includeDataSaver ? pages.imageUrlsDataSaver : [],
          imageCount: pages.imageUrls.length,
          imageDataSaverCount: includeDataSaver ? pages.imageUrlsDataSaver.length : 0,
          imageSource: {
            baseUrl: pages.baseUrl,
            hash: pages.hash,
            requestBaseUrl: pages.requestBaseUrl
          }
        };
      } catch (err) {
        return {
          ...chapter,
          imageUrls: [],
          imageUrlsDataSaver: [],
          imageCount: 0,
          imageDataSaverCount: 0,
          imageError: err && err.message ? String(err.message) : "Failed to resolve chapter images"
        };
      }
    });
  }

  const baseUrlSet = new Set();
  const mangaBaseUrl = extractBaseUrl(mangaResponse.baseUrlUsed || mangaResponse.url);
  if (mangaBaseUrl) {
    baseUrlSet.add(mangaBaseUrl);
  }
  (Array.isArray(chapterResult.baseUrlsUsed) ? chapterResult.baseUrlsUsed : []).forEach((item) => {
    const value = String(item || "").trim();
    if (value) baseUrlSet.add(value);
  });
  chapters.forEach((chapter) => {
    const value = chapter
      && chapter.imageSource
      && chapter.imageSource.requestBaseUrl
      ? String(chapter.imageSource.requestBaseUrl).trim()
      : "";
    if (value) baseUrlSet.add(value);
  });

  return {
    source: "mangadex",
    manga,
    chapters,
    meta: {
      fetchedAt: new Date().toISOString(),
      requested: {
        order,
        translatedLanguages,
        includeImages,
        includeDataSaver,
        includeExternalUrl,
        includeFuturePublishAt,
        useDevEnvironment
      },
      totalChapters: chapterResult.total,
      returnedChapters: chapters.length,
      providerBaseUrlsUsed: Array.from(baseUrlSet)
    }
  };
};

const getMangaDexChapterImages = async (options = {}) => {
  const chapterId = String(options.chapterId == null ? "" : options.chapterId).trim();
  if (!chapterId) {
    const error = new Error("MangaDex chapter id is required.");
    error.statusCode = 400;
    throw error;
  }

  const timeoutMs = clampInt(options.timeoutMs, 20000, 3000, 60000);
  const includeDataSaver = toBoolean(options.includeDataSaver, true);
  const includeChapterInfo = toBoolean(options.includeChapterInfo, false);
  const useDevEnvironment = toBoolean(options.useDevEnvironment, false);
  const apiBaseUrl = resolveApiBaseUrl(useDevEnvironment);

  const pages = await fetchMangaDexAtHomePages({
    chapterId,
    timeoutMs,
    apiBaseUrl
  });

  let chapterInfo = null;
  if (includeChapterInfo) {
    try {
      const chapter = await fetchMangaDexChapterDetails({
        chapterId,
        timeoutMs,
        apiBaseUrl
      });

      chapterInfo = {
        chapterNumber: chapter && chapter.chapter != null ? String(chapter.chapter) : "",
        chapterTitle: chapter && chapter.title ? String(chapter.title).trim() : "",
        volume: chapter && chapter.volume != null ? String(chapter.volume) : "",
        translatedLanguage: chapter && chapter.translatedLanguage ? String(chapter.translatedLanguage).toLowerCase() : "",
        publishAt: chapter && chapter.publishAt ? String(chapter.publishAt) : (chapter && chapter.readableAt ? String(chapter.readableAt) : ""),
        groups: Array.isArray(chapter && chapter.groups)
          ? chapter.groups
              .map((group) => ({
                id: group && group.id ? String(group.id) : "",
                name: group && group.name ? String(group.name).trim() : ""
              }))
              .filter((group) => group.id || group.name)
          : []
      };
    } catch (_err) {
      chapterInfo = {
        chapterNumber: "",
        chapterTitle: "",
        volume: "",
        translatedLanguage: "",
        publishAt: "",
        groups: []
      };
    }
  }

  const responsePayload = {
    source: "mangadex",
    chapterId,
    imageUrls: pages.imageUrls,
    imageUrlsRuntime: pages.imageUrlsRuntime,
    imageUrlsDataSaver: includeDataSaver ? pages.imageUrlsDataSaver : [],
    imageCount: pages.imageUrls.length,
    imageDataSaverCount: includeDataSaver ? pages.imageUrlsDataSaver.length : 0,
    meta: {
      fetchedAt: new Date().toISOString(),
      useDevEnvironment,
      providerBaseUrlsUsed: [pages.requestBaseUrl].filter(Boolean),
      imageSource: {
        baseUrl: pages.baseUrl,
        hash: pages.hash
      }
    }
  };

  if (includeChapterInfo) {
    responsePayload.chapterInfo = chapterInfo || {
      chapterNumber: "",
      chapterTitle: "",
      volume: "",
      translatedLanguage: "",
      publishAt: "",
      groups: []
    };
  }

  return responsePayload;
};

module.exports = {
  getMangaDexBundle,
  getMangaDexChapterImages
};
