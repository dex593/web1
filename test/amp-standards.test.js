const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const readText = (path) => readFileSync(path, "utf8");

const ampTemplates = [
  "views/index-amp.ejs",
  "views/manga-detail-amp.ejs"
];

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
