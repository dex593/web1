const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ejs = require("ejs");
const coverHelpers = require("../src/utils/view-cover-helpers");

const readText = (filePath) => readFileSync(filePath, "utf8");
const renderTemplate = (templatePath, locals) =>
  ejs.render(readText(templatePath), locals, { filename: path.resolve(templatePath) });
const extractJsonLdList = (html) => Array.from(
  html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  (match) => JSON.parse(match[1])
);
const hasSchemaType = (schema, typeName) => {
  const schemaType = schema && schema["@type"];
  return Array.isArray(schemaType) ? schemaType.includes(typeName) : schemaType === typeName;
};
const findSchema = (schemas, typeName) => schemas.find((schema) => hasSchemaType(schema, typeName));

const liteTemplates = [
  "views/index-m.ejs",
  "views/manga-detail-m.ejs",
  "views/chapter-m.ejs",
  "views/forum-m.ejs",
  "views/forum-post-m.ejs"
];

const baseLocals = (overrides = {}) => ({
  canonicalUrl: "https://example.com/",
  webUrl: "https://example.com/",
  seo: {
    title: "Example page",
    description: "Example description",
    canonical: "https://example.com/",
    keywords: "",
    ogType: "website",
    image: "",
    twitterCard: "summary",
    jsonLd: []
  },
  siteConfig: {
    branding: {
      siteName: "Example Site",
      brandMark: "Example",
      brandSubmark: "Site",
      footerYear: "2026"
    },
    homepage: {},
    seo: {},
    contact: {}
  },
  authPublicConfig: {
    initialState: {
      signedIn: false,
      publishNav: {}
    }
  },
  newsPageEnabled: false,
  forumPageEnabled: false,
  liteSchemas: [],
  coverHelpers,
  cacheBust: (url) => url,
  formatDate: (value) => String(value || ""),
  ...overrides
});

const sampleMangaCard = {
  title: "Example Manga",
  slug: "example-manga",
  cover: "/uploads/covers/example.webp",
  coverUpdatedAt: 1,
  groupName: "Example Team",
  author: "Example Author",
  status: "Đang cập nhật",
  latestChapterNumber: 12,
  latestChapterIsOneshot: false
};

const homepageLocals = (overrides = {}) => baseLocals({
  featured: [sampleMangaCard],
  latest: [sampleMangaCard],
  forumLatestPosts: [],
  homepage: {
    notices: []
  },
  stats: {
    totalSeries: 1,
    totalChapters: 12
  },
  ...overrides
});

const mangaLocals = (overrides = {}) => baseLocals({
  canonicalUrl: "https://example.com/manga/example-manga",
  webUrl: "https://example.com/manga/example-manga",
  seo: {
    title: "Example manga",
    titleAbsolute: true,
    description: "Example manga description",
    canonical: "https://example.com/manga/example-manga",
    keywords: "",
    ogType: "article",
    image: "",
    twitterCard: "summary",
    jsonLd: []
  },
  manga: {
    title: "Example Manga",
    slug: "example-manga",
    cover: "/uploads/covers/example.webp",
    coverUpdatedAt: 1,
    author: "Example Author",
    otherNames: "",
    status: "Đang cập nhật",
    description: "Example description",
    genres: ["Drama"],
    chapters: [{ number: 12, title: "Latest", pages: 24, date: "2026-04-26", group_name: "Example Team" }],
    groupTeamLinks: []
  },
  ...overrides
});

const chapterLocals = (overrides = {}) => baseLocals({
  canonicalUrl: "https://example.com/manga/example-manga/chapters/12",
  webUrl: "https://example.com/manga/example-manga/chapters/12",
  seo: {
    title: "Example manga chapter",
    titleAbsolute: true,
    description: "Example manga chapter description",
    canonical: "https://example.com/manga/example-manga/chapters/12",
    keywords: "",
    ogType: "article",
    image: "https://img.example/page-001.webp",
    twitterCard: "summary_large_image",
    jsonLd: []
  },
  manga: {
    title: "Example Manga",
    slug: "example-manga"
  },
  chapter: {
    number: 12,
    title: "Latest",
    pages: 2,
    is_oneshot: false,
    processing_state: "",
    processing_done_pages: 0,
    processing_total_pages: 0,
    processing_percent: 0
  },
  prevChapter: { number: 11, title: "Previous", is_oneshot: false },
  nextChapter: { number: 13, title: "Next", is_oneshot: false },
  chapterList: [
    { number: 13, title: "Next", is_oneshot: false },
    { number: 12, title: "Latest", is_oneshot: false },
    { number: 11, title: "Previous", is_oneshot: false }
  ],
  pages: [1, 2],
  pageUrls: ["https://img.example/page-001.webp", "https://img.example/page-002.webp"],
  chapterLocked: false,
  chapterInteractionLocked: false,
  chapterUnlockPath: "/manga/example-manga/chapters/12/unlock",
  chapterPasswordMinLength: 1,
  chapterPasswordMaxLength: 128,
  ...overrides
});

const sampleForumPost = {
  id: 7,
  title: "Example forum topic",
  excerpt: "Example forum excerpt",
  contentText: "Example forum content",
  url: "/forum/post/7",
  createdAt: "2026-04-26T00:00:00.000Z",
  timeAgo: "hôm nay",
  likeCount: 3,
  replyCount: 2,
  isPinned: true,
  isLocked: false,
  sectionSlug: "thao-luan-chung",
  sectionLabel: "Thảo luận chung",
  author: {
    name: "Alice",
    username: "alice",
    url: "/user/alice"
  }
};

const forumLocals = (overrides = {}) => baseLocals({
  canonicalUrl: "https://example.com/forum",
  webUrl: "https://example.com/forum",
  seo: {
    title: "Forum",
    description: "Example forum description",
    canonical: "https://example.com/forum",
    keywords: "",
    ogType: "website",
    image: "",
    twitterCard: "summary",
    robots: "index,follow",
    jsonLd: []
  },
  posts: [sampleForumPost],
  sections: [
    { slug: "thao-luan-chung", label: "Thảo luận chung", url: "/forum?section=thao-luan-chung" }
  ],
  filters: {
    q: "",
    sort: "hot",
    section: "",
    sectionLabel: ""
  },
  pagination: {
    page: 1,
    perPage: 18,
    total: 20,
    totalPages: 2,
    hasPrev: false,
    hasNext: true,
    prevPage: 1,
    nextPage: 2
  },
  ...overrides
});

const forumPostLocals = (overrides = {}) => baseLocals({
  canonicalUrl: "https://example.com/forum/post/7",
  webUrl: "https://example.com/forum/post/7",
  seo: {
    title: "Example forum topic",
    description: "Example forum description",
    canonical: "https://example.com/forum/post/7",
    keywords: "",
    ogType: "article",
    image: "",
    twitterCard: "summary",
    robots: "index,follow",
    jsonLd: []
  },
  post: sampleForumPost,
  comments: [
    {
      ...sampleForumPost,
      id: 8,
      title: "Reply",
      excerpt: "Example reply",
      contentText: "Example reply",
      url: "/forum/post/7"
    }
  ],
  ...overrides
});

const extractRouteBlock = (routes, route, nextRoute) => {
  const normalizedRoutes = routes.replace(/\r\n/g, "\n");
  const startMarkers = [`app.get(\n    "${route}"`, `app.get("${route}"`];
  const endMarkers = [`app.get(\n    "${nextRoute}"`, `app.get("${nextRoute}"`];
  const start = startMarkers
    .map((marker) => normalizedRoutes.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  const end = endMarkers
    .map((marker) => normalizedRoutes.indexOf(marker, start + 1))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;

  assert.notEqual(start, -1, `${route} route should exist`);
  assert.notEqual(end, -1, `${nextRoute} route should follow ${route}`);

  return normalizedRoutes.slice(start, end);
};

const extractSourceBlock = (source, startMarker, endMarker) => {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const start = normalizedSource.indexOf(startMarker);
  const end = normalizedSource.indexOf(endMarker, start + 1);

  assert.notEqual(start, -1, `${startMarker} should exist`);
  assert.notEqual(end, -1, `${endMarker} should follow ${startMarker}`);

  return normalizedSource.slice(start, end);
};

test("/m templates are non-AMP and avoid external CSS/JS libraries", () => {
  for (const templatePath of liteTemplates) {
    const template = readText(templatePath);

    assert.doesNotMatch(template, /<html\s+amp\b/i, `${templatePath} must not be an AMP document`);
    assert.doesNotMatch(template, /ampproject|amp-boilerplate|amp-custom|<amp-/i);
    assert.doesNotMatch(template, /<script\s+[^>]*\bsrc=/i, `${templatePath} must not import scripts`);
    assert.doesNotMatch(template, /<link\s+[^>]*rel=["']stylesheet["']/i, `${templatePath} must not import stylesheets`);
    assert.doesNotMatch(template, /fonts\.googleapis|gstatic|cdn\./i, `${templatePath} must not reference external asset CDNs`);
    assert.doesNotMatch(template, /\bfetch\s*\(|XMLHttpRequest|\baxios\b/i, `${templatePath} must not use AJAX primitives`);
    assert.doesNotMatch(
      template,
      /bản nhẹ|Bản nhẹ|Forum bản nhẹ|không AJAX|không thư viện JS\/CSS ngoài|server-side|SSR|không AMP|non-AMP|Bản nhẹ không AMP/i,
      `${templatePath} must not expose implementation-detail copy`
    );
  }
});

test("/m templates render SEO metadata, social cards, and hreflang", () => {
  const socialImage = "https://example.com/social.webp";
  const imageAlt = "Ảnh đại diện Example";
  const homepageBase = homepageLocals();
  const homepageHtml = renderTemplate("views/index-m.ejs", homepageLocals({
    seo: {
      ...homepageBase.seo,
      robots: "index,follow",
      image: socialImage,
      imageAlt
    }
  }));
  const forumHtml = renderTemplate("views/forum-m.ejs", forumLocals({
    seo: {
      ...forumLocals().seo,
      image: socialImage,
      imageAlt
    }
  }));

  for (const html of [homepageHtml, forumHtml]) {
    assert.match(html, /<meta name="description" content="[^"]+" \/>/);
    assert.match(html, /<meta name="robots" content="index,follow" \/>/);
    assert.match(html, /<meta property="og:locale" content="vi_VN" \/>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/example\.com\/social\.webp" \/>/);
    assert.match(html, /<meta property="og:image:alt" content="Ảnh đại diện Example" \/>/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/example\.com\/social\.webp" \/>/);
    assert.match(html, /<meta name="twitter:image:alt" content="Ảnh đại diện Example" \/>/);
    assert.match(html, /<link rel="alternate" hreflang="vi-VN" href="https:\/\/example\.com\//);
    assert.match(html, /<link rel="alternate" hreflang="x-default" href="https:\/\/example\.com\//);
  }
});

test("/m templates render canonical main URLs and no amphtml alternates", () => {
  const homepageHtml = renderTemplate("views/index-m.ejs", homepageLocals());
  const mangaHtml = renderTemplate("views/manga-detail-m.ejs", mangaLocals());
  const chapterHtml = renderTemplate("views/chapter-m.ejs", chapterLocals());
  const forumHtml = renderTemplate("views/forum-m.ejs", forumLocals());
  const forumPostHtml = renderTemplate("views/forum-post-m.ejs", forumPostLocals());
  const assertNoLiteSeoUrl = (html) => {
    assert.doesNotMatch(html, /(?:href|content)="https:\/\/example\.com\/m(?:\/|")/i);
  };

  assert.match(homepageHtml, /<link rel="canonical" href="https:\/\/example\.com\/" \/>/);
  assert.doesNotMatch(homepageHtml, /<link\s+rel="amphtml"\b/i);
  assert.doesNotMatch(homepageHtml, /media="only screen and \(max-width: 640px\)"/i);
  assertNoLiteSeoUrl(homepageHtml);
  assert.doesNotMatch(homepageHtml, /href="\/m\/manga\//i);

  assert.match(mangaHtml, /<link rel="canonical" href="https:\/\/example\.com\/manga\/example-manga" \/>/);
  assert.doesNotMatch(mangaHtml, /<link\s+rel="amphtml"\b/i);
  assert.doesNotMatch(mangaHtml, /media="only screen and \(max-width: 640px\)"/i);
  assertNoLiteSeoUrl(mangaHtml);
  assert.doesNotMatch(mangaHtml, /href="\/m\/manga\//i);

  assert.match(chapterHtml, /<link rel="canonical" href="https:\/\/example\.com\/manga\/example-manga\/chapters\/12" \/>/);
  assert.doesNotMatch(chapterHtml, /<link\s+rel="amphtml"\b/i);
  assert.doesNotMatch(chapterHtml, /media="only screen and \(max-width: 640px\)"/i);
  assertNoLiteSeoUrl(chapterHtml);
  assert.doesNotMatch(chapterHtml, /href="\/m\/manga\//i);

  assert.match(forumHtml, /<link rel="canonical" href="https:\/\/example\.com\/forum" \/>/);
  assert.doesNotMatch(forumHtml, /<link\s+rel="amphtml"\b/i);
  assert.doesNotMatch(forumHtml, /media="only screen and \(max-width: 640px\)"/i);
  assertNoLiteSeoUrl(forumHtml);
  assert.doesNotMatch(forumHtml, /href="\/m\/forum/i);

  assert.match(forumPostHtml, /<link rel="canonical" href="https:\/\/example\.com\/forum\/post\/7" \/>/);
  assert.doesNotMatch(forumPostHtml, /<link\s+rel="amphtml"\b/i);
  assert.doesNotMatch(forumPostHtml, /media="only screen and \(max-width: 640px\)"/i);
  assertNoLiteSeoUrl(forumPostHtml);
  assert.doesNotMatch(forumPostHtml, /href="\/m\/forum/i);
});

test("/m templates use small responsive covers and LCP hints", () => {
  const homepageHtml = renderTemplate("views/index-m.ejs", homepageLocals());
  const mangaHtml = renderTemplate("views/manga-detail-m.ejs", mangaLocals());
  const chapterHtml = renderTemplate("views/chapter-m.ejs", chapterLocals());

  assert.match(homepageHtml, /rel="preload"/);
  assert.match(homepageHtml, /fetchpriority="high"/);
  assert.match(homepageHtml, /src="\/uploads\/covers\/example-sm\.webp"/);
  assert.match(homepageHtml, /srcset="[^"]*example-sm\.webp 132w[^"]*example-md\.webp 262w/);
  assert.match(homepageHtml, /width="132"\s+height="176"/);
  assert.match(homepageHtml, /loading="eager"/);
  assert.match(homepageHtml, /loading="lazy"/);

  assert.match(mangaHtml, /rel="preload"/);
  assert.match(mangaHtml, /src="\/uploads\/covers\/example-md\.webp"/);
  assert.match(mangaHtml, /width="262"\s+height="349"/);
  assert.match(mangaHtml, /fetchpriority="high"/);

  assert.match(chapterHtml, /rel="preload"[\s\S]*href="https:\/\/img\.example\/page-001\.webp"[\s\S]*fetchpriority="high"/);
  assert.match(chapterHtml, /src="https:\/\/img\.example\/page-001\.webp"[\s\S]*width="960"\s+height="1440"/);
  assert.match(chapterHtml, /loading="eager"/);
  assert.match(chapterHtml, /loading="lazy"/);
  assert.match(chapterHtml, /decoding="sync"/);
});

test("/m templates emit page-matched schema markup", () => {
  const homepageHtml = renderTemplate("views/index-m.ejs", homepageLocals({
    seo: {
      ...homepageLocals().seo,
      image: "https://example.com/social.webp",
      imageAlt: "Ảnh đại diện Example"
    }
  }));
  const mangaHtml = renderTemplate("views/manga-detail-m.ejs", mangaLocals());
  const chapterHtml = renderTemplate("views/chapter-m.ejs", chapterLocals());
  const forumHtml = renderTemplate("views/forum-m.ejs", forumLocals());
  const forumPostHtml = renderTemplate("views/forum-post-m.ejs", forumPostLocals());

  const homepageSchema = findSchema(extractJsonLdList(homepageHtml), "WebPage");
  assert.equal(homepageSchema.url, "https://example.com/");
  assert.equal(homepageSchema.inLanguage, "vi-VN");
  assert.equal(homepageSchema["@id"], "https://example.com/#webpage");
  assert.equal(homepageSchema.primaryImageOfPage.url, "https://example.com/social.webp");

  const mangaSchema = findSchema(extractJsonLdList(mangaHtml), "ComicSeries");
  assert.equal(mangaSchema.url, "https://example.com/manga/example-manga");
  assert.equal(mangaSchema.mainEntityOfPage, "https://example.com/manga/example-manga");
  assert.equal(mangaSchema.inLanguage, "vi-VN");

  const chapterSchema = findSchema(extractJsonLdList(chapterHtml), "ComicIssue");
  assert.equal(chapterSchema.url, "https://example.com/manga/example-manga/chapters/12");
  assert.equal(chapterSchema.mainEntityOfPage, "https://example.com/manga/example-manga/chapters/12");
  assert.equal(chapterSchema.isPartOf["@type"], "ComicSeries");
  assert.equal(chapterSchema.inLanguage, "vi-VN");

  const forumSchemas = extractJsonLdList(forumHtml);
  const forumCollectionSchema = findSchema(forumSchemas, "CollectionPage");
  const forumItemListSchema = findSchema(forumSchemas, "ItemList");
  assert.equal(forumCollectionSchema.url, "https://example.com/forum");
  assert.equal(forumCollectionSchema.inLanguage, "vi-VN");
  assert.equal(forumItemListSchema.itemListElement[0].name, "Example forum topic");
  assert.equal(forumItemListSchema.itemListElement[0].url, "https://example.com/forum/post/7");

  const forumPostSchemas = extractJsonLdList(forumPostHtml);
  const forumPostSchema = findSchema(forumPostSchemas, "DiscussionForumPosting");
  const breadcrumbSchema = findSchema(forumPostSchemas, "BreadcrumbList");
  assert.equal(forumPostSchema.url, "https://example.com/forum/post/7");
  assert.equal(forumPostSchema.mainEntityOfPage, "https://example.com/forum/post/7");
  assert.equal(forumPostSchema.commentCount, 2);
  assert.equal(forumPostSchema.comment[0]["@type"], "Comment");
  assert.equal(forumPostSchema.inLanguage, "vi-VN");
  assert.equal(breadcrumbSchema.itemListElement[2].item, "https://example.com/forum/post/7");
});

test("/m noindex pages suppress fallback structured data", () => {
  const forumHtml = renderTemplate("views/forum-m.ejs", forumLocals({
    seo: {
      ...forumLocals().seo,
      robots: "noindex,follow",
      jsonLd: []
    }
  }));
  const chapterHtml = renderTemplate("views/chapter-m.ejs", chapterLocals({
    seo: {
      ...chapterLocals().seo,
      robots: "noindex,follow",
      jsonLd: []
    }
  }));

  assert.equal(extractJsonLdList(forumHtml).length, 0);
  assert.equal(extractJsonLdList(chapterHtml).length, 0);
});

test("/m route handlers render lightweight templates with standard canonical SEO", () => {
  const routes = readText("src/routes/site-routes.js");
  const appSource = readText("app.js");
  const homepageRoute = extractRouteBlock(routes, "/m", "/user/:identifier");
  const mangaRoute = extractRouteBlock(routes, "/m/manga/:slug", "/m/manga/:slug/chapters/:number");
  const chapterRoute = extractRouteBlock(routes, "/m/manga/:slug/chapters/:number", "/manga/:slug/chapters/:number/processing-status");
  const forumRoute = extractRouteBlock(appSource, "/m/forum", "/m/forum/post/:id");
  const forumPostRoute = extractSourceBlock(appSource, 'app.get("/m/forum/post/:id"', "const sendForumIndex");

  assert.match(homepageRoute, /res\.render\("index-m"/);
  assert.match(homepageRoute, /canonicalPath:\s*"\/"/);
  assert.doesNotMatch(homepageRoute, /ampHtml:/);
  assert.doesNotMatch(homepageRoute, /liteUrl/);

  assert.match(mangaRoute, /res\.render\("manga-detail-m"/);
  assert.match(mangaRoute, /const canonicalLitePath = `\/m\/manga\/\$\{encodeURIComponent\(mangaRow\.slug\)\}`/);
  assert.match(mangaRoute, /const canonicalPath = `\/manga\/\$\{encodeURIComponent\(mangaRow\.slug\)\}`/);
  assert.doesNotMatch(mangaRoute, /ampHtml:/);
  assert.doesNotMatch(mangaRoute, /liteUrl/);

  assert.match(chapterRoute, /res\.render\("chapter-m"/);
  assert.match(chapterRoute, /const chapterPath = `\/manga\/\$\{encodeURIComponent\(mangaRow\.slug\)\}\/chapters\//);
  assert.match(chapterRoute, /res\.redirect\(301,\s*`\/m\/manga\/\$\{encodeURIComponent\(mangaRow\.slug\)\}\/chapters\//);
  assert.match(chapterRoute, /canonicalPath:\s*chapterPath/);
  assert.match(chapterRoute, /chapterUnlockPath:\s*`\$\{chapterPath\}\/unlock`/);
  assert.doesNotMatch(chapterRoute, /ampHtml:/);
  assert.doesNotMatch(chapterRoute, /liteUrl/);

  assert.match(forumRoute, /res\.render\("forum-m"/);
  assert.match(forumRoute, /canonicalUrl:\s*seoPayload\.canonical/);
  assert.doesNotMatch(forumRoute, /liteUrl/);
  assert.doesNotMatch(forumRoute, /ampHtml:/);

  assert.match(forumPostRoute, /res\.render\("forum-post-m"/);
  assert.match(forumPostRoute, /canonicalUrl:\s*seoPayload\.canonical/);
  assert.doesNotMatch(forumPostRoute, /liteUrl/);
  assert.doesNotMatch(forumPostRoute, /ampHtml:/);

  assert.doesNotMatch(routes, /mobileAlternate:/);
  assert.doesNotMatch(appSource, /mobileAlternate:/);
  assert.doesNotMatch(appSource, /buildForumMobileAlternate/);
});

test("/m chapter and forum templates keep internal links on standard routes", () => {
  const chapterHtml = renderTemplate("views/chapter-m.ejs", chapterLocals());
  const forumHtml = renderTemplate("views/forum-m.ejs", forumLocals());
  const forumPostHtml = renderTemplate("views/forum-post-m.ejs", forumPostLocals());
  const appSource = readText("app.js");

  assert.match(chapterHtml, /href="\/manga\/example-manga"/);
  assert.match(chapterHtml, /href="\/manga\/example-manga\/chapters\/11"/);
  assert.match(chapterHtml, /href="\/manga\/example-manga\/chapters\/13"/);
  assert.doesNotMatch(chapterHtml, /href="\/m\/manga\//);

  assert.match(forumHtml, /href="\/forum\/post\/7"/);
  assert.match(forumHtml, /href="\/forum\?section=thao-luan-chung"/);
  assert.match(forumHtml, /href="\/forum\?page=2"/);
  assert.match(forumHtml, /<link rel="next" href="https:\/\/example\.com\/forum\?page=2" \/>/);
  assert.doesNotMatch(forumHtml, /href="\/m\/forum/);

  assert.match(forumPostHtml, /href="\/forum\/post\/7"/);
  assert.match(forumPostHtml, /href="\/forum"/);
  assert.doesNotMatch(forumPostHtml, /href="\/m\/forum/);

  assert.match(appSource, /url:\s*safeId \? `\/forum\/post\/\$\{encodeURIComponent/);
  assert.match(appSource, /url:\s*`\/forum\?section=\$\{encodeURIComponent\(slug\)\}`/);
});
