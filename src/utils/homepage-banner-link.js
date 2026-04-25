const controlCharacterPattern = /[\u0000-\u001F\u007F]/;

const normalizeHomepageBannerLink = (value, { maxLength = 1000 } = {}) => {
  const raw = value == null ? "" : String(value).trim();
  if (!raw || raw.length > maxLength || controlCharacterPattern.test(raw)) return "";

  if (raw.startsWith("#")) {
    return raw;
  }

  if (raw.startsWith("/")) {
    return raw.startsWith("//") ? "" : raw;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch (_err) {
    return "";
  }
};

module.exports = {
  normalizeHomepageBannerLink
};
