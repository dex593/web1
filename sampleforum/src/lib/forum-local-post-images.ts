export const FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX = "forum-local-image://";

export interface ForumLocalPostImage {
  id: string;
  dataUrl: string;
}

export interface PreparedForumPostLocalImages {
  content: string;
  images: ForumLocalPostImage[];
}

const LOCAL_IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const normalizeLocalImageId = (value: string): string => {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-");
  if (!LOCAL_IMAGE_ID_PATTERN.test(normalized)) return "";
  return normalized;
};

const createLocalImageId = (index: number): string => {
  const safeIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
  const seed = `${Date.now().toString(36)}-${safeIndex.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return normalizeLocalImageId(`img-${seed}`) || `img-${safeIndex}`;
};

const isDataImageUrl = (value: string): boolean => /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(String(value || "").trim());

export const buildForumLocalImagePlaceholder = (id: string): string => {
  const safeId = normalizeLocalImageId(id);
  if (!safeId) return "";
  return `${FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX}${safeId}`;
};

const prepareWithDomParser = (rawHtml: string): PreparedForumPostLocalImages => {
  if (typeof DOMParser !== "function") {
    return {
      content: rawHtml,
      images: [],
    };
  }

  const doc = new DOMParser().parseFromString(String(rawHtml || ""), "text/html");
  const body = doc && doc.body ? doc.body : null;
  if (!body) {
    return {
      content: String(rawHtml || ""),
      images: [],
    };
  }

  const imageNodes = Array.from(body.querySelectorAll("img[src]"));
  if (!imageNodes.length) {
    return {
      content: String(rawHtml || ""),
      images: [],
    };
  }

  let imageIndex = 0;
  const images: ForumLocalPostImage[] = [];
  const idByDataUrl = new Map<string, string>();

  imageNodes.forEach((node) => {
    const source = String(node.getAttribute("src") || "").trim();
    if (!isDataImageUrl(source)) return;

    let imageId = idByDataUrl.get(source) || "";
    if (!imageId) {
      imageIndex += 1;
      imageId = createLocalImageId(imageIndex);
      idByDataUrl.set(source, imageId);
      images.push({ id: imageId, dataUrl: source });
    }

    const placeholder = buildForumLocalImagePlaceholder(imageId);
    if (placeholder) {
      node.setAttribute("src", placeholder);
    }
  });

  if (!images.length) {
    return {
      content: String(rawHtml || ""),
      images: [],
    };
  }

  return {
    content: body.innerHTML,
    images,
  };
};

const prepareWithRegexFallback = (rawHtml: string): PreparedForumPostLocalImages => {
  let imageIndex = 0;
  const images: ForumLocalPostImage[] = [];
  const idByDataUrl = new Map<string, string>();

  const content = String(rawHtml || "").replace(
    /(<img\b[^>]*\bsrc\s*=\s*["'])(data:image\/[a-z0-9.+-]+;base64,[^"']+)(["'][^>]*>)/gi,
    (full, start, source, end) => {
      const dataUrl = String(source || "").trim();
      if (!isDataImageUrl(dataUrl)) return full;

      let imageId = idByDataUrl.get(dataUrl) || "";
      if (!imageId) {
        imageIndex += 1;
        imageId = createLocalImageId(imageIndex);
        idByDataUrl.set(dataUrl, imageId);
        images.push({ id: imageId, dataUrl });
      }

      const placeholder = buildForumLocalImagePlaceholder(imageId);
      if (!placeholder) return full;
      return `${start}${placeholder}${end}`;
    }
  );

  return {
    content,
    images,
  };
};

export const prepareForumPostContentForSubmit = (rawHtml: string): PreparedForumPostLocalImages => {
  const source = String(rawHtml || "");
  if (!source || source.indexOf("data:image/") === -1) {
    return {
      content: source,
      images: [],
    };
  }

  const prepared = prepareWithDomParser(source);
  if (prepared.images.length > 0) {
    return prepared;
  }

  return prepareWithRegexFallback(source);
};
