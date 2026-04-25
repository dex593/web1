const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeHomepageBannerLink } = require("../src/utils/homepage-banner-link");

test("normalizeHomepageBannerLink allows safe absolute and in-site links", () => {
  assert.equal(
    normalizeHomepageBannerLink(" https://example.com/path?q=1#top "),
    "https://example.com/path?q=1#top"
  );
  assert.equal(normalizeHomepageBannerLink("/manga/demo"), "/manga/demo");
  assert.equal(normalizeHomepageBannerLink("#forum"), "#forum");
});

test("normalizeHomepageBannerLink rejects unsafe or ambiguous links", () => {
  assert.equal(normalizeHomepageBannerLink("javascript:alert(1)"), "");
  assert.equal(normalizeHomepageBannerLink("//evil.example/path"), "");
  assert.equal(normalizeHomepageBannerLink("mailto:test@example.com"), "");
  assert.equal(normalizeHomepageBannerLink("https://example.com/\nnext"), "");
});
