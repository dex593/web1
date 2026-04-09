const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMangaSlug,
  buildMangaSlugForWebtoonState,
  addKrSegmentAfterMangaId,
  hasIdPrefixedKrSegment,
} = require("../src/utils/manga-slug");

test("builds base manga slug from id and title", () => {
  assert.equal(buildMangaSlug(123, "Abc Cde"), "123-abc-cde");
});

test("builds webtoon manga slug without inserting kr after manga id", () => {
  assert.equal(
    buildMangaSlugForWebtoonState({ mangaId: 123, title: "Abc Cde", isWebtoon: true }),
    "123-abc-cde"
  );
});

test("builds non-webtoon manga slug without kr segment", () => {
  assert.equal(
    buildMangaSlugForWebtoonState({ mangaId: 123, title: "Abc Cde", isWebtoon: false }),
    "123-abc-cde"
  );
});

test("keeps numeric manga slug unchanged when kr insertion is disabled", () => {
  assert.equal(addKrSegmentAfterMangaId("123-abc-cde"), "123-abc-cde");
});

test("keeps existing kr-prefixed slug unchanged", () => {
  assert.equal(addKrSegmentAfterMangaId("123-kr-abc-cde"), "123-kr-abc-cde");
});

test("keeps title-derived kr prefix unchanged after webtoon slug build", () => {
  assert.equal(
    buildMangaSlugForWebtoonState({ mangaId: 123, title: "Kr Hero", isWebtoon: true }),
    "123-kr-hero"
  );
});

test("detects kr only when it appears immediately after numeric manga id", () => {
  assert.equal(hasIdPrefixedKrSegment("123-kr-abc-cde"), true);
  assert.equal(hasIdPrefixedKrSegment("123-abc-kr-cde"), false);
});
