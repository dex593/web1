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

module.exports = {
  addKrSegmentAfterMangaId,
  hasIdPrefixedKrSegment,
};
