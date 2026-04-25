const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");

const readProjectFile = (relativePath) =>
  fs.readFileSync(path.join(rootDir, relativePath), "utf8");

const assertBefore = (content, earlier, later, message) => {
  const earlierIndex = content.indexOf(earlier);
  const laterIndex = content.indexOf(later);

  assert.notEqual(earlierIndex, -1, `${message}: missing ${earlier}`);
  assert.notEqual(laterIndex, -1, `${message}: missing ${later}`);
  assert.ok(earlierIndex < laterIndex, message);
};

test("Google Fonts URLs use display=swap", () => {
  const files = [
    "views/partials/head.ejs",
    "src/news/views/index.ejs",
    "src/news/views/detail.ejs",
    "src/news/views/404.ejs",
    "sampleforum/src/index.css"
  ];

  files.forEach((file) => {
    const content = readProjectFile(file);
    const googleFontUrls = content.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+/g) || [];

    assert.ok(googleFontUrls.length > 0, `${file} should include a Google Fonts URL`);
    googleFontUrls.forEach((url) => {
      assert.match(url, /[?&]display=swap(?:&|$)/, `${file} Google Fonts URL should include display=swap`);
    });
  });
});

test("HTML entry points preconnect before external font stylesheets", () => {
  const htmlEntries = [
    "src/news/views/index.ejs",
    "src/news/views/detail.ejs",
    "src/news/views/404.ejs"
  ];

  htmlEntries.forEach((file) => {
    const content = readProjectFile(file);

    const googlePreconnect = '<link rel="preconnect" href="https://fonts.googleapis.com">';
    const gstaticPreconnect = '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
    const jsdelivrPreconnect = '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>';
    const googleStylesheet = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2';
    const jsdelivrStylesheet =
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css">';

    assert.match(
      content,
      /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/,
      `${file} should preconnect to fonts.googleapis.com`
    );
    assert.match(
      content,
      /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/,
      `${file} should preconnect to fonts.gstatic.com with crossorigin`
    );
    assert.match(
      content,
      /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin>/,
      `${file} should preconnect to the FontAwesome CDN with crossorigin`
    );
    assertBefore(content, googlePreconnect, googleStylesheet, `${file} should preconnect before Google Fonts CSS`);
    assertBefore(content, gstaticPreconnect, googleStylesheet, `${file} should preconnect before Google Fonts CSS`);
    assertBefore(content, jsdelivrPreconnect, jsdelivrStylesheet, `${file} should preconnect before FontAwesome CSS`);
  });
});

test("shared root and forum heads expose font preconnect hints", () => {
  const rootHeadStyles = readProjectFile("views/partials/head-styles.ejs");
  const forumIndex = readProjectFile("sampleforum/index.html");

  assert.match(rootHeadStyles, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com" \/>/);
  assert.match(rootHeadStyles, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>/);
  assert.match(rootHeadStyles, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin \/>/);

  assert.match(forumIndex, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com" \/>/);
  assert.match(forumIndex, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin \/>/);
});
