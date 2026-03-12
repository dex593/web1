import { getSiteBranding } from "@/lib/site-branding";

const SEO_ROBOTS_INDEX = "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1";
const SEO_ROBOTS_NOINDEX_FOLLOW = "noindex,follow";
const SEO_ROBOTS_PRIVATE = "noindex,nofollow";

const FORUM_SEO_JSONLD_ID = "forum-seo-jsonld";
const FORUM_SEO_RUNTIME_ID = "forum-seo-runtime";

const DEFAULT_SECTION_LABEL_BY_SLUG: Record<string, string> = {
  "thao-luan-chung": "Thảo luận chung",
  "thong-bao": "Thông báo",
  "huong-dan": "Hướng dẫn",
  "tim-truyen": "Tìm truyện",
  "gop-y": "Góp ý",
  "tam-su": "Tâm sự",
  "chia-se": "Chia sẻ",
};

const SECTION_ALIAS_BY_SLUG: Record<string, string> = {
  "goi-y": "gop-y",
  "tin-tuc": "thong-bao",
};

export type ForumSeoPayload = {
  title: string;
  description: string;
  canonicalPath: string;
  canonical?: string;
  robots?: string;
  ogType?: "website" | "article";
  twitterCard?: "summary" | "summary_large_image";
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
};

type RuntimeSeoPayload = {
  seo?: {
    title?: string;
    description?: string;
    canonicalPath?: string;
    canonical?: string;
    robots?: string;
    ogType?: "website" | "article";
    twitterCard?: "summary" | "summary_large_image";
    jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>;
  };
};

const normalizeSectionSlug = (value: string): string => {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw) return "";
  return SECTION_ALIAS_BY_SLUG[raw] || raw;
};

const resolveOrigin = (): string => {
  if (typeof document !== "undefined") {
    const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
    if (canonicalHref) {
      try {
        return new URL(canonicalHref, window.location.href).origin;
      } catch {
        // fall back to current window origin below
      }
    }
  }

  if (typeof window === "undefined") return "";
  return window.location.origin || "";
};

const toAbsoluteCanonical = (canonicalPath: string): string => {
  const path = String(canonicalPath || "").trim() || "/forum";
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const origin = resolveOrigin();
  return origin ? `${origin}${withLeadingSlash}` : withLeadingSlash;
};

const upsertMeta = (selector: string, createTag: () => HTMLMetaElement, content: string): void => {
  if (typeof document === "undefined") return;
  const safeContent = String(content || "").trim();
  if (!safeContent) return;
  let node = document.querySelector(selector) as HTMLMetaElement | null;
  if (!node) {
    node = createTag();
    document.head.appendChild(node);
  }
  node.setAttribute("content", safeContent);
};

const upsertCanonical = (canonicalUrl: string): void => {
  if (typeof document === "undefined") return;
  const safeCanonical = String(canonicalUrl || "").trim();
  if (!safeCanonical) return;
  let node = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!node) {
    node = document.createElement("link");
    node.setAttribute("rel", "canonical");
    document.head.appendChild(node);
  }
  node.setAttribute("href", safeCanonical);
};

const upsertJsonLd = (jsonLd: ForumSeoPayload["jsonLd"]): void => {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(FORUM_SEO_JSONLD_ID);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }

  if (!jsonLd) return;
  const script = document.createElement("script");
  script.id = FORUM_SEO_JSONLD_ID;
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(jsonLd);
  document.head.appendChild(script);
};

export const applyForumSeo = (payload: ForumSeoPayload): void => {
  if (typeof document === "undefined") return;
  const siteName = getSiteBranding().siteName || "BFANG Team";
  const title = String(payload.title || `${siteName} Forum`).trim() || `${siteName} Forum`;
  const description =
    String(payload.description || `Forum thảo luận cộng đồng ${siteName}`).trim() ||
    `Forum thảo luận cộng đồng ${siteName}`;
  const canonicalUrl = toAbsoluteCanonical(payload.canonical || payload.canonicalPath);
  const robots = String(payload.robots || SEO_ROBOTS_INDEX).trim() || SEO_ROBOTS_INDEX;
  const ogType = payload.ogType === "article" ? "article" : "website";
  const twitterCard = payload.twitterCard === "summary_large_image" ? "summary_large_image" : "summary";

  document.title = title;
  upsertMeta(
    'meta[name="description"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "description");
      return meta;
    },
    description
  );
  upsertMeta(
    'meta[name="robots"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      return meta;
    },
    robots
  );
  upsertMeta(
    'meta[property="og:title"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:title");
      return meta;
    },
    title
  );
  upsertMeta(
    'meta[property="og:description"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:description");
      return meta;
    },
    description
  );
  upsertMeta(
    'meta[property="og:url"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:url");
      return meta;
    },
    canonicalUrl
  );
  upsertMeta(
    'meta[property="og:type"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("property", "og:type");
      return meta;
    },
    ogType
  );
  upsertMeta(
    'meta[name="twitter:title"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "twitter:title");
      return meta;
    },
    title
  );
  upsertMeta(
    'meta[name="twitter:description"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "twitter:description");
      return meta;
    },
    description
  );
  upsertMeta(
    'meta[name="twitter:card"]',
    () => {
      const meta = document.createElement("meta");
      meta.setAttribute("name", "twitter:card");
      return meta;
    },
    twitterCard
  );
  upsertCanonical(canonicalUrl);
  upsertJsonLd(payload.jsonLd);
};

export const readForumRuntimeSeo = (): ForumSeoPayload | null => {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const script = document.getElementById(FORUM_SEO_RUNTIME_ID);
  if (!script || !script.textContent) return null;

  try {
    const parsed = JSON.parse(script.textContent) as RuntimeSeoPayload;
    const seo = parsed && parsed.seo ? parsed.seo : null;
    if (!seo || !seo.title || !seo.description || !seo.canonicalPath) return null;
    return {
      title: String(seo.title || "").trim(),
      description: String(seo.description || "").trim(),
      canonicalPath: String(seo.canonicalPath || "").trim() || "/forum",
      canonical: String(seo.canonical || "").trim(),
      robots: String(seo.robots || "").trim() || SEO_ROBOTS_INDEX,
      ogType: seo.ogType === "article" ? "article" : "website",
      twitterCard: seo.twitterCard === "summary_large_image" ? "summary_large_image" : "summary",
      jsonLd: seo.jsonLd,
    };
  } catch {
    return null;
  }
};

const parsePositivePage = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.floor(parsed);
};

const normalizeSort = (value: string): "hot" | "new" | "most-commented" => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "new" || raw === "most-commented") return raw;
  return "hot";
};

export const buildForumIndexSeo = (params: {
  search: string;
  availableSectionSlugs?: string[];
  sectionLabelsBySlug?: Record<string, string>;
}): ForumSeoPayload => {
  const siteName = getSiteBranding().siteName || "BFANG Team";
  const searchParams = new URLSearchParams(params.search || "");
  const q = String(searchParams.get("q") || "").trim();
  const sort = normalizeSort(searchParams.get("sort") || "hot");
  const page = parsePositivePage(searchParams.get("page") || "1");
  const allowedQueryKeys = new Set(["page", "q", "section", "sort"]);
  const hasUnknownQueryParam = Array.from(searchParams.keys()).some((key) => !allowedQueryKeys.has(String(key || "").trim()));
  const sectionLabelsBySlug: Record<string, string> = {
    ...DEFAULT_SECTION_LABEL_BY_SLUG,
  };
  Object.entries(params.sectionLabelsBySlug || {}).forEach(([slug, label]) => {
    const normalizedSlug = normalizeSectionSlug(slug);
    const safeLabel = String(label || "").trim();
    if (!normalizedSlug || !safeLabel) return;
    sectionLabelsBySlug[normalizedSlug] = safeLabel;
  });

  const availableSet = new Set<string>(Object.keys(sectionLabelsBySlug));
  (params.availableSectionSlugs || []).forEach((slug) => {
    const normalized = normalizeSectionSlug(slug);
    if (normalized) availableSet.add(normalized);
  });

  const normalizedSection = normalizeSectionSlug(searchParams.get("section") || "");
  const validSectionSlug = normalizedSection && availableSet.has(normalizedSection) ? normalizedSection : "";
  const sectionLabel = validSectionSlug ? sectionLabelsBySlug[validSectionSlug] || "" : "";
  const canonicalPath = validSectionSlug
    ? `/forum?section=${encodeURIComponent(validSectionSlug)}`
    : "/forum";
  const shouldNoindex = Boolean(q) || sort !== "hot" || page > 1 || hasUnknownQueryParam;
  const title = sectionLabel ? `${sectionLabel} | ${siteName} Forum` : `${siteName} Forum`;
  const description = sectionLabel
    ? `Khám phá các chủ đề trong mục ${sectionLabel} tại cộng đồng ${siteName}.`
    : `Forum thảo luận cộng đồng ${siteName}`;

  return {
    title,
    description,
    canonicalPath,
    robots: shouldNoindex ? SEO_ROBOTS_NOINDEX_FOLLOW : SEO_ROBOTS_INDEX,
    ogType: "website",
    twitterCard: "summary",
    jsonLd: shouldNoindex
      ? []
      : {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: title,
          description,
          url: toAbsoluteCanonical(canonicalPath),
          inLanguage: "vi",
        },
  };
};

export const buildForumSavedPostsSeo = (): ForumSeoPayload => {
  const siteName = getSiteBranding().siteName || "BFANG Team";
  return {
    title: `Bài viết đã lưu | ${siteName} Forum`,
    description: "Trang bài viết đã lưu dành cho tài khoản cá nhân.",
    canonicalPath: "/forum/saved-posts",
    robots: SEO_ROBOTS_PRIVATE,
    ogType: "website",
    twitterCard: "summary",
    jsonLd: [],
  };
};

export const buildForumAdminSeo = (pathname: string): ForumSeoPayload => {
  const siteName = getSiteBranding().siteName || "BFANG Team";
  const safePath = String(pathname || "").trim() || "/forum/admin";
  return {
    title: `Quản trị forum | ${siteName}`,
    description: "Khu vực quản trị forum chỉ dành cho quản trị viên.",
    canonicalPath: safePath,
    robots: SEO_ROBOTS_PRIVATE,
    ogType: "website",
    twitterCard: "summary",
    jsonLd: [],
  };
};

export const buildForumNotFoundSeo = (): ForumSeoPayload => {
  const siteName = getSiteBranding().siteName || "BFANG Team";
  return {
    title: `Không tìm thấy trang | ${siteName} Forum`,
    description: "Trang diễn đàn bạn truy cập không tồn tại hoặc đã bị xóa.",
    canonicalPath: "/forum",
    robots: SEO_ROBOTS_NOINDEX_FOLLOW,
    ogType: "website",
    twitterCard: "summary",
    jsonLd: [],
  };
};

export const buildForumPostSeo = (params: {
  postId: string;
  title: string;
  description: string;
  authorName?: string;
  sectionLabel?: string;
  createdAt?: string;
}): ForumSeoPayload => {
  const siteName = getSiteBranding().siteName || "BFANG Team";
  const safePostId = String(params.postId || "").trim();
  const postTitle = String(params.title || "").trim() || `Chủ đề #${safePostId || "?"}`;
  const canonicalPath = safePostId ? `/forum/post/${encodeURIComponent(safePostId)}` : "/forum";
  const description = String(params.description || "").trim() || `Thảo luận mới tại ${siteName} Forum.`;

  return {
    title: `${postTitle} | ${siteName} Forum`,
    description,
    canonicalPath,
    robots: SEO_ROBOTS_INDEX,
    ogType: "article",
    twitterCard: "summary",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "DiscussionForumPosting",
      headline: postTitle,
      description,
      url: toAbsoluteCanonical(canonicalPath),
      articleSection: String(params.sectionLabel || "").trim() || undefined,
      datePublished: String(params.createdAt || "").trim() || undefined,
      author: {
        "@type": "Person",
        name: String(params.authorName || "").trim() || "Thành viên",
      },
      inLanguage: "vi",
    },
  };
};

export const extractSeoDescriptionFromHtml = (content: string, maxLength = 190): string => {
  const plainText = String(content || "")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plainText.length <= maxLength) return plainText;
  return `${plainText.slice(0, Math.max(1, maxLength - 1)).trim()}...`;
};
