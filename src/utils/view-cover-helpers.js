const truncateCardTitle = (value) => {
  const text = (value || "").toString().replace(/\s+/g, " ").trim();
  if (!text) return "";

  const maxWords = 4;
  const maxChars = 24;
  const words = text.split(" ").filter(Boolean);
  let shortened = words.length > maxWords ? words.slice(0, maxWords).join(" ") : text;
  if (shortened.length > maxChars) {
    shortened = shortened.slice(0, maxChars).trimEnd();
  }

  return shortened.length < text.length ? `${shortened}...` : shortened;
};

const COVER_VARIANT_SUFFIX_BY_MAX_WIDTH = Object.freeze([
  { maxWidth: 132, suffix: "-sm", width: 132, height: 176 },
  { maxWidth: 262, suffix: "-md", width: 262, height: 349 },
  { maxWidth: Number.POSITIVE_INFINITY, suffix: "", width: 358, height: 477 }
]);

const buildCoverVariantUrl = (url, suffix) => {
  const raw = (url || "").toString().trim();
  if (!raw) return "";

  const hashIndex = raw.indexOf("#");
  const hashPart = hashIndex >= 0 ? raw.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const queryIndex = withoutHash.indexOf("?");
  const queryPart = queryIndex >= 0 ? withoutHash.slice(queryIndex) : "";
  const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  const match = basePath.match(/^(.*)\.webp$/i);
  if (!match || !match[1]) return raw;

  const safeSuffix = (suffix || "").toString();
  return `${match[1]}${safeSuffix}.webp${queryPart}${hashPart}`;
};

const appendCoverVariant = (url, width, _height, _quality) => {
  const raw = (url || "").toString().trim();
  if (!raw) return "";

  const parsedWidth = Number(width);
  if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
    return buildCoverVariantUrl(raw, "");
  }

  const safeWidth = Math.floor(parsedWidth);
  const selected = COVER_VARIANT_SUFFIX_BY_MAX_WIDTH.find((item) => safeWidth <= item.maxWidth);
  const suffix = selected && typeof selected.suffix === "string" ? selected.suffix : "";
  return buildCoverVariantUrl(raw, suffix);
};

const resolveCoverVariantProfile = (url, width) => {
  const raw = (url || "").toString().trim();
  if (!raw) return null;

  const parsedWidth = Number(width);
  const safeWidth = Number.isFinite(parsedWidth) && parsedWidth > 0 ? Math.floor(parsedWidth) : 358;
  const selected = COVER_VARIANT_SUFFIX_BY_MAX_WIDTH.find((item) => safeWidth <= item.maxWidth);
  if (!selected) return null;

  return {
    url: buildCoverVariantUrl(raw, selected.suffix),
    width: selected.width,
    height: selected.height,
    suffix: selected.suffix
  };
};

const COVER_HEIGHT_RATIO = 4 / 3;

const buildSafeCoverSources = (baseUrl, options = {}) => {
  const slotWidths = Array.isArray(options.slotWidths) ? options.slotWidths : [];
  const dprLevels = Array.isArray(options.dprLevels) && options.dprLevels.length ? options.dprLevels : [1];
  const quality = Number.isFinite(Number(options.quality)) ? Number(options.quality) : 95;
  const maxWidth = Number.isFinite(Number(options.maxWidth)) ? Number(options.maxWidth) : 1200;
  const defaultWidthOption = Number(options.defaultWidth);
  const candidates = new Set();

  slotWidths.forEach((slotWidth) => {
    const parsedSlotWidth = Number(slotWidth);
    if (!Number.isFinite(parsedSlotWidth) || parsedSlotWidth <= 0) return;

    dprLevels.forEach((density) => {
      const parsedDensity = Number(density);
      if (!Number.isFinite(parsedDensity) || parsedDensity <= 0) return;
      const safeWidth = Math.ceil(parsedSlotWidth * parsedDensity);
      const clampedWidth = Math.min(Math.max(safeWidth, 120), maxWidth);
      candidates.add(clampedWidth);
    });
  });

  const widths = [...candidates].sort((left, right) => left - right);
  if (!widths.length) {
    return {
      src: baseUrl,
      srcset: ""
    };
  }

  const profileBySuffix = new Map();
  widths.forEach((width) => {
    const profile = resolveCoverVariantProfile(baseUrl, width);
    if (!profile) return;
    profileBySuffix.set(profile.suffix || "", profile);
  });

  const orderedProfiles = [...profileBySuffix.values()].sort((left, right) => left.width - right.width);
  const srcset = orderedProfiles.map((profile) => `${profile.url} ${profile.width}w`).join(", ");

  const defaultWidth = Number.isFinite(defaultWidthOption) && defaultWidthOption > 0 ? defaultWidthOption : widths[0];
  const defaultProfile = resolveCoverVariantProfile(baseUrl, defaultWidth) || orderedProfiles[0] || null;

  return {
    src: defaultProfile ? defaultProfile.url : baseUrl,
    srcset
  };
};

module.exports = {
  truncateCardTitle,
  appendCoverVariant,
  buildSafeCoverSources
};
