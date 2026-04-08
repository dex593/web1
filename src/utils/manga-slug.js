const slugifyMangaTitle = (value) => {
  if (!value) return "";
  return value
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
};

const buildMangaSlug = (mangaId, title) => {
  const id = Number(mangaId);
  const base = slugifyMangaTitle(title) || "manga";
  if (!Number.isFinite(id) || id <= 0) return base;
  return `${Math.floor(id)}-${base}`;
};

const hasIdPrefixedKrSegment = (slugInput) => {
  const text = (slugInput == null ? "" : String(slugInput)).trim().toLowerCase();
  if (!text) return false;
  return /^\d+-kr(?:-|$)/.test(text);
};

const addKrSegmentAfterMangaId = (slugInput) => {
  const text = (slugInput == null ? "" : String(slugInput)).trim();
  if (!text) return "";
  if (hasIdPrefixedKrSegment(text)) return text;

  const match = text.match(/^(\d+)(?:-(.+))?$/);
  if (!match) return text;

  const mangaId = match[1] || "";
  const remainder = (match[2] || "").trim();
  if (!remainder) {
    return `${mangaId}-kr`;
  }
  return `${mangaId}-kr-${remainder}`;
};

const buildMangaSlugForWebtoonState = ({ mangaId, title, isWebtoon }) => {
  const baseSlug = buildMangaSlug(mangaId, title);
  if (!isWebtoon) return baseSlug;
  return addKrSegmentAfterMangaId(baseSlug);
};

module.exports = {
  buildMangaSlug,
  buildMangaSlugForWebtoonState,
  addKrSegmentAfterMangaId,
  hasIdPrefixedKrSegment,
  slugifyMangaTitle,
};
