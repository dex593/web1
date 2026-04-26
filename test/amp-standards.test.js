const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ejs = require("ejs");

const readText = (filePath) => readFileSync(filePath, "utf8");
const renderTemplate = (templatePath, locals) =>
  ejs.render(readText(templatePath), locals, { filename: path.resolve(templatePath) });

const ampTemplates = [
  "views/index-amp.ejs",
  "views/manga-detail-amp.ejs"
];

const createAmpBaseLocals = (overrides = {}) => ({
  canonicalUrl: "https://example.com/",
  webUrl: "https://example.com/",
  ampUrl: "https://example.com/amp",
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
  ampSchemas: [],
  cacheBust: (url) => url,
  formatDate: (value) => String(value || ""),
  ...overrides
});

const createHomepageAmpLocals = (overrides = {}) => createAmpBaseLocals({
  featured: [],
  latest: [],
  forumLatestPosts: [],
  homepage: {
    notices: []
  },
  stats: {
    totalSeries: 0,
    totalChapters: 0
  },
  ...overrides
});

const createMangaAmpLocals = (overrides = {}) => createAmpBaseLocals({
  canonicalUrl: "https://example.com/manga/example-manga",
  webUrl: "https://example.com/manga/example-manga",
  ampUrl: "https://example.com/amp/manga/example-manga",
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
    cover: "",
    coverUpdatedAt: "",
    author: "",
    otherNames: "",
    status: "Đang cập nhật",
    description: "",
    genres: [],
    chapters: [],
    groupTeamLinks: []
  },
  ...overrides
});

test("AMP templates keep AMP discovery and omit robots meta", () => {
  for (const templatePath of ampTemplates) {
    const template = readText(templatePath);

    assert.match(template, /<html\s+amp\b/i, `${templatePath} must be an AMP document`);
    assert.match(template, /<script\s+async\s+src="https:\/\/cdn\.ampproject\.org\/v0\.js"/i);
    assert.match(template, /<style\s+amp-boilerplate>/i);
    assert.match(template, /<style\s+amp-custom>/i);
    assert.match(template, /<link\s+rel="canonical"\s+href="<%=\s*seoCanonical\s*%>"/i);
    assert.match(template, /type="application\/ld\+json"/i);
    assert.doesNotMatch(template, /<meta\s+name=["'](?:robots|googlebot)["']/i);
  }
});

test("rendered canonical pages expose amphtml alternates", () => {
  const html = renderTemplate("views/partials/head-meta.ejs", {
    fullTitle: "Example page",
    seoDescription: "Example description",
    seoKeywords: "",
    seoRobots: "index,follow",
    omitRobotsMeta: true,
    siteName: "Example Site",
    seoCanonical: "https://example.com/manga/example-manga",
    seoAmpHtml: "https://example.com/amp/manga/example-manga",
    ogType: "article",
    seoKeywordList: [],
    ogImage: "",
    twitterCard: "summary",
    jsonLdList: [],
    safeJsonForScript: JSON.stringify,
    assetUrl: (url) => url,
    cspNonce: ""
  });

  assert.match(html, /<link rel="canonical" href="https:\/\/example\.com\/manga\/example-manga" \/>/);
  assert.match(html, /<link rel="amphtml" href="https:\/\/example\.com\/amp\/manga\/example-manga" \/>/);
});

test("rendered AMP pages canonicalize to their standard pages and never emit amphtml", () => {
  const homepageHtml = renderTemplate("views/index-amp.ejs", createHomepageAmpLocals());
  const mangaHtml = renderTemplate("views/manga-detail-amp.ejs", createMangaAmpLocals());

  assert.match(homepageHtml, /<link rel="canonical" href="https:\/\/example\.com\/" \/>/);
  assert.doesNotMatch(homepageHtml, /<link\s+rel="amphtml"\b/i);

  assert.match(mangaHtml, /<link rel="canonical" href="https:\/\/example\.com\/manga\/example-manga" \/>/);
  assert.doesNotMatch(mangaHtml, /<link\s+rel="amphtml"\b/i);
});

test("standalone AMP render falls back to a self-referencing canonical", () => {
  const homepageHtml = renderTemplate("views/index-amp.ejs", createHomepageAmpLocals({
    canonicalUrl: "   ",
    webUrl: "",
    ampUrl: "https://example.com/amp",
    seo: {
      title: "Standalone AMP",
      description: "Standalone AMP description",
      canonical: "",
      keywords: "",
      ogType: "website",
      image: "",
      twitterCard: "summary",
      jsonLd: []
    }
  }));
  const mangaHtml = renderTemplate("views/manga-detail-amp.ejs", createMangaAmpLocals({
    canonicalUrl: "",
    webUrl: "   ",
    ampUrl: "https://example.com/amp/manga/example-manga",
    seo: {
      title: "Standalone AMP manga",
      titleAbsolute: true,
      description: "Standalone AMP manga description",
      canonical: "",
      keywords: "",
      ogType: "article",
      image: "",
      twitterCard: "summary",
      jsonLd: []
    }
  }));

  assert.match(homepageHtml, /<link rel="canonical" href="https:\/\/example\.com\/amp" \/>/);
  assert.doesNotMatch(homepageHtml, /<link\s+rel="amphtml"\b/i);
  assert.match(mangaHtml, /<link rel="canonical" href="https:\/\/example\.com\/amp\/manga\/example-manga" \/>/);
  assert.doesNotMatch(mangaHtml, /<link\s+rel="amphtml"\b/i);
});

test("canonical pages with AMP alternates suppress robots meta and keep amphtml links", () => {
  const head = readText("views/partials/head.ejs");
  const headMeta = readText("views/partials/head-meta.ejs");
  const routes = readText("src/routes/site-routes.js");

  assert.match(head, /const omitRobotsMeta = Boolean\(seoAmpHtml\)/);
  assert.match(headMeta, /if \(!omitRobotsMeta\)/);
  assert.match(headMeta, /<meta name="robots" content="<%= seoRobots %>" \/>/);
  assert.match(headMeta, /<meta name="googlebot" content="<%= seoRobots %>" \/>/);

  assert.match(routes, /ampHtml:\s*"\/amp"/);
  assert.match(routes, /const ampPath = `\/amp\/manga\/\$\{encodeURIComponent\(mangaRow\.slug\)\}`;/);
  assert.match(routes, /ampHtml:\s*shouldNoIndexMangaDetail\s*\?\s*""\s*:\s*ampPath/);
});

test("robots.txt route does not block AMP paths", () => {
  const routes = readText("src/routes/site-routes.js");
  const disallowPathsMatch = routes.match(/const disallowPaths = \[([\s\S]*?)\n\s*\];/);

  assert.ok(disallowPathsMatch, "robots.txt disallowPaths block should exist");
  assert.doesNotMatch(disallowPathsMatch[1], /["']\/amp(?:\/)?["']/);
});

test("AMP route handlers do not send X-Robots-Tag headers", () => {
  const routes = readText("src/routes/site-routes.js");
  const ampRouteChecks = [
    { route: "\"/amp\"", render: "res.render(\"index-amp\"" },
    { route: "\"/amp/manga/:slug\"", render: "res.render(\"manga-detail-amp\"" }
  ];

  for (const { route, render } of ampRouteChecks) {
    const routeStart = routes.indexOf(route);
    const renderStart = routes.indexOf(render, routeStart);

    assert.notEqual(routeStart, -1, `${route} route should exist`);
    assert.notEqual(renderStart, -1, `${route} route should render its AMP template`);
    assert.doesNotMatch(routes.slice(routeStart, renderStart), /X-Robots-Tag/i);
  }
});
