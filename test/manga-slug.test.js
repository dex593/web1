const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addKrSegmentAfterMangaId,
  hasIdPrefixedKrSegment,
} = require("../src/utils/manga-slug");

test("adds kr after numeric manga id", () => {
  assert.equal(addKrSegmentAfterMangaId("123-abc-cde"), "123-kr-abc-cde");
});

test("does not duplicate kr when slug already has id-prefixed kr segment", () => {
  assert.equal(addKrSegmentAfterMangaId("123-kr-abc-cde"), "123-kr-abc-cde");
});

test("keeps title-derived kr prefix unchanged after webtoon rule", () => {
  assert.equal(addKrSegmentAfterMangaId("123-kr-hero"), "123-kr-hero");
});

test("detects kr only when it appears immediately after numeric manga id", () => {
  assert.equal(hasIdPrefixedKrSegment("123-kr-abc-cde"), true);
  assert.equal(hasIdPrefixedKrSegment("123-abc-kr-cde"), false);
});
