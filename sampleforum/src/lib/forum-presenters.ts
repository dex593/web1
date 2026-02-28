import type { Category, Comment, ForumApiComment, ForumApiPostSummary, Post } from "@/types/forum";
import { normalizeForumContentHtml, toPlainTextForUi } from "@/lib/forum-content";

const fallbackAvatar = "/logobfang.svg";

const dedupeBadges = (badgesInput: Array<{ code: string; label: string; color?: string; priority?: number }> = []) => {
  const badges = Array.isArray(badgesInput) ? badgesInput : [];
  const seen = new Set<string>();
  return badges.filter((badge) => {
    const code = String(badge && badge.code ? badge.code : "").trim().toLowerCase();
    const label = String(badge && badge.label ? badge.label : "").trim().toLowerCase();
    const key = `${code}|${label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type BasicSection = {
  slug: string;
  name: string;
  icon: string;
  postCount?: number;
};

const defaultSections: BasicSection[] = [
  { slug: "thao-luan-chung", name: "Thảo luận chung", icon: "💬" },
  { slug: "thong-bao", name: "Thông báo", icon: "📢" },
  { slug: "huong-dan", name: "Hướng dẫn", icon: "📘" },
  { slug: "tim-truyen", name: "Tìm truyện", icon: "🔎" },
  { slug: "gop-y", name: "Góp ý", icon: "🛠️" },
  { slug: "tam-su", name: "Tâm sự", icon: "💭" },
  { slug: "chia-se", name: "Chia sẻ", icon: "🤝" },
];
const FORUM_META_COMMENT_PATTERN = /<!--\s*forum-meta:([^>]*?)\s*-->/gi;

const slugToLabel = (slug: string): string => {
  const safeSlug = String(slug || "").trim();
  if (!safeSlug) return "Thảo luận";
  return safeSlug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const normalizeSectionOptions = (
  sectionOptions: Array<{ slug?: string; label?: string; icon?: string; postCount?: number }> = []
): BasicSection[] => {
  const seen = new Set<string>();
  const normalized = (Array.isArray(sectionOptions) ? sectionOptions : [])
    .map((item) => {
      const slug = normalizeSectionSlug(String(item && item.slug ? item.slug : ""));
      if (!slug || seen.has(slug)) return null;
      seen.add(slug);

      const label = String(item && item.label ? item.label : "").trim() || slugToLabel(slug);
      const icon = String(item && item.icon ? item.icon : "").trim() || "💬";
      const postCountRaw = Number(item && item.postCount);

      return {
        slug,
        name: label,
        icon,
        postCount: Number.isFinite(postCountRaw) && postCountRaw >= 0 ? Math.floor(postCountRaw) : undefined,
      } as BasicSection;
    })
    .filter((item): item is BasicSection => Boolean(item));

  if (normalized.length > 0) {
    return normalized;
  }

  return [...defaultSections];
};

const normalizeVietnamese = (value: string): string => {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
};

const normalizeSectionSlug = (value: string): string => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  const aliases: Record<string, string> = {
    "goi-y": "gop-y",
    "tin-tuc": "thong-bao",
  };
  return aliases[slug] || slug;
};

const extractForumMeta = (content: string): { sectionSlug: string; contentWithoutMeta: string } => {
  let resolvedSectionSlug = "";
  const cleanedContent = String(content || "").replace(FORUM_META_COMMENT_PATTERN, (_fullMatch, payloadText) => {
    const payload = String(payloadText || "").trim();
    if (!payload) return "";

    const pairs = payload
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const pair of pairs) {
      const equalIndex = pair.indexOf("=");
      if (equalIndex <= 0) continue;
      const key = pair.slice(0, equalIndex).trim().toLowerCase();
      const value = pair.slice(equalIndex + 1).trim();
      if (key === "section" && !resolvedSectionSlug) {
        const normalized = normalizeSectionSlug(value);
        if (normalized) {
          resolvedSectionSlug = normalized;
        }
      }
    }

    return "";
  });

  return {
    sectionSlug: resolvedSectionSlug,
    contentWithoutMeta: cleanedContent.trim(),
  };
};

const classifyPostSlug = (
  post: ForumApiPostSummary,
  sectionSlugFromMeta = "",
  sections: BasicSection[] = defaultSections
): string => {
  const availableSlugSet = new Set(sections.map((item) => item.slug));
  const fallbackSlug = sections[0] ? sections[0].slug : "thao-luan-chung";

  const normalizedSectionFromMeta = normalizeSectionSlug(sectionSlugFromMeta);
  if (normalizedSectionFromMeta) {
    return normalizedSectionFromMeta;
  }

  const normalizedSectionFromApi = normalizeSectionSlug(post.sectionSlug || "");
  if (normalizedSectionFromApi) {
    return normalizedSectionFromApi;
  }

  const contentMeta = extractForumMeta(post.content || "");
  if (contentMeta.sectionSlug) {
    return contentMeta.sectionSlug;
  }

  const haystack = normalizeVietnamese(
    [post.title, post.excerpt, post.category.name, post.manga.title].join(" ")
  );

  if (/(tim|ten|nho|name).{0,18}(truyen|manga|manhwa)|tim truyen|nho tim/.test(haystack)) {
    return availableSlugSet.has("tim-truyen") ? "tim-truyen" : fallbackSlug;
  }

  if (/(thong bao|announc|news|cap nhat|update)/.test(haystack)) {
    return availableSlugSet.has("thong-bao") ? "thong-bao" : fallbackSlug;
  }

  if (/(gop y|feedback|phan hoi|dong gop|suggest)/.test(haystack)) {
    return availableSlugSet.has("gop-y") ? "gop-y" : fallbackSlug;
  }

  if (/(tam su|tam trang|story time|nhat ky|chia buon|confess)/.test(haystack)) {
    return availableSlugSet.has("tam-su") ? "tam-su" : fallbackSlug;
  }

  if (/(huong dan|tutorial|guide|how to)/.test(haystack)) {
    return availableSlugSet.has("huong-dan") ? "huong-dan" : fallbackSlug;
  }

  if (/(chia se|share|kinh nghiem|tips|faq|help)/.test(haystack)) {
    return availableSlugSet.has("chia-se") ? "chia-se" : fallbackSlug;
  }

  return fallbackSlug;
};

const sectionBySlug = (slug: string, sections: BasicSection[]): BasicSection => {
  const found = sections.find((item) => item.slug === slug);
  if (found) return found;

  return {
    slug,
    name: slugToLabel(slug),
    icon: "💬",
  };
};

const extractEmbeddedPostHeadline = (content: string): string => {
  const raw = String(content || "").trim();
  if (!raw) return "";

  const matched = raw.match(/^\s*<p>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i);
  if (!matched) return "";
  return toPlainTextForUi(matched[1]);
};

const escapeRegex = (value: string): string => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripDuplicatedTitleFromExcerpt = (excerpt: string, title: string): string => {
  const excerptText = String(excerpt || "")
    .replace(/\s+/g, " ")
    .trim();
  const titleText = String(title || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!excerptText || !titleText) {
    return excerptText;
  }

  const escapedTitle = escapeRegex(titleText);
  const exactTitlePattern = new RegExp(`^${escapedTitle}$`, "i");
  if (exactTitlePattern.test(excerptText)) {
    return "";
  }

  const leadingTitlePattern = new RegExp(`^${escapedTitle}(?:\\s*[\\-:|\\u2013\\u2014]\\s*|\\s+)`, "i");
  if (!leadingTitlePattern.test(excerptText)) {
    return excerptText;
  }

  return excerptText.replace(leadingTitlePattern, "").trim();
};

const stripEmbeddedPostHeadline = (content: string): string => {
  const raw = String(content || "").trim();
  if (!raw) return "";

  return raw.replace(/^\s*<p>\s*<strong[^>]*>[\s\S]*?<\/strong>\s*<\/p>\s*/i, "").trim();
};

const resolveUserRole = (badges: Array<{ code?: string }> = []): "admin" | "moderator" | "member" => {
  const codes = badges.map((badge) => String(badge && badge.code ? badge.code : "").trim().toLowerCase());
  if (codes.includes("admin")) return "admin";
  if (codes.includes("mod")) return "moderator";
  return "member";
};

export const buildForumSections = (
  posts: ForumApiPostSummary[],
  sectionOptions: Array<{ slug?: string; label?: string; icon?: string; postCount?: number }> = []
): Category[] => {
  const sections = normalizeSectionOptions(sectionOptions);
  const counts = new Map<string, number>();
  for (const post of posts) {
    const sectionSlug = classifyPostSlug(post, "", sections);
    counts.set(sectionSlug, (counts.get(sectionSlug) || 0) + 1);
  }

  return sections.map((section, index) => ({
    id: index + 1,
    slug: section.slug,
    name: section.name,
    icon: section.icon,
    postCount:
      typeof section.postCount === "number" && Number.isFinite(section.postCount)
        ? Math.max(0, Math.floor(section.postCount))
        : counts.get(section.slug) || 0,
  }));
};

export const filterPostsBySection = (
  posts: ForumApiPostSummary[],
  selectedSection: string | null,
  sectionOptions: Array<{ slug?: string; label?: string; icon?: string; postCount?: number }> = []
): ForumApiPostSummary[] => {
  if (!selectedSection) {
    return posts;
  }
  const sections = normalizeSectionOptions(sectionOptions);
  return posts.filter((post) => classifyPostSlug(post, "", sections) === selectedSection);
};

export const mapApiPostToUiPost = (
  post: ForumApiPostSummary,
  sectionOptions: Array<{ slug?: string; label?: string; icon?: string; postCount?: number }> = []
): Post => {
  const sections = normalizeSectionOptions(sectionOptions);
  const normalizedPostSectionSlug = normalizeSectionSlug(post.sectionSlug || "");
  const sectionExists = normalizedPostSectionSlug
    ? sections.some((item) => item.slug === normalizedPostSectionSlug)
    : false;

  const sectionsForPost =
    normalizedPostSectionSlug && !sectionExists
      ? [
          ...sections,
          {
            slug: normalizedPostSectionSlug,
            name: String(post.sectionLabel || "").trim() || slugToLabel(normalizedPostSectionSlug),
            icon: String(post.sectionIcon || "").trim() || "💬",
          },
        ]
      : sections;

  const rawContent = post.content || post.excerpt;
  const usingExcerptFallback = !String(post.content || "").trim() && Boolean(String(post.excerpt || "").trim());
  const contentMeta = extractForumMeta(rawContent);
  const section = sectionBySlug(
    classifyPostSlug(post, contentMeta.sectionSlug, sectionsForPost),
    sectionsForPost
  );
  const contentWithoutMeta = contentMeta.contentWithoutMeta || rawContent;
  const hasEmbeddedHeadline = /^\s*<p>\s*<strong[^>]*>[\s\S]*?<\/strong>\s*<\/p>/i.test(contentWithoutMeta);
  const embeddedHeadline = extractEmbeddedPostHeadline(contentWithoutMeta);
  const normalizedApiTitle = toPlainTextForUi(post.title || "");
  const displayTitle = embeddedHeadline || normalizedApiTitle || post.manga.title || "Chủ đề";
  const displayContent = hasEmbeddedHeadline ? stripEmbeddedPostHeadline(contentWithoutMeta) : contentWithoutMeta;
  const deduplicatedContent = usingExcerptFallback
    ? stripDuplicatedTitleFromExcerpt(toPlainTextForUi(displayContent), displayTitle)
    : displayContent;
  const normalizedContent = normalizeForumContentHtml(
    deduplicatedContent,
    Array.isArray(post.mentions) ? post.mentions : []
  );

  const authorBadges = dedupeBadges(Array.isArray(post.author.badges) ? post.author.badges : []);

  return {
    id: String(post.id),
    title: displayTitle,
    content: normalizedContent,
    author: {
      id: post.author.id || String(post.author.username || "0"),
      username: post.author.username || "member",
      displayName: post.author.displayName || post.author.username || "Thành viên",
      avatar: post.author.avatarUrl || fallbackAvatar,
      profileUrl: post.author.profileUrl || "",
      badges: authorBadges,
      userColor: post.author.userColor || "",
      role: resolveUserRole(authorBadges),
    },
    category: {
      id: post.category.id || section.slug,
      name: section.name,
      slug: section.slug,
      icon: section.icon,
      postCount: 0,
    },
    tags: [],
    upvotes: post.likeCount || 0,
    downvotes: 0,
    commentCount: post.commentCount || 0,
    createdAt: post.timeAgo || "Vừa xong",
    isSticky: Boolean(post.isSticky),
    isLocked: Boolean(post.isLocked),
    isAnnouncement: section.slug === "thong-bao",
    permissions: post.permissions,
    userVote: post.liked ? "up" : null,
    saved: Boolean(post.saved),
  };
};

export const mapApiCommentToUiComment = (comment: ForumApiComment): Comment => ({
  id: String(comment.id),
  content: normalizeForumContentHtml(
    comment.content,
    Array.isArray(comment.mentions) ? comment.mentions : []
  ),
  author: (() => {
    const authorBadges = dedupeBadges(Array.isArray(comment.author.badges) ? comment.author.badges : []);
    return {
      id: comment.author.id || String(comment.author.username || "0"),
      username: comment.author.username || "member",
      displayName: comment.author.displayName || comment.author.username || "Thành viên",
      avatar: comment.author.avatarUrl || fallbackAvatar,
      profileUrl: comment.author.profileUrl || "",
      badges: authorBadges,
      userColor: comment.author.userColor || "",
      role: resolveUserRole(authorBadges),
    };
  })(),
  upvotes: comment.likeCount || 0,
  downvotes: 0,
  createdAt: comment.timeAgo || "Vừa xong",
  parentId:
    Number.isFinite(Number(comment.parentId)) && Number(comment.parentId) > 0
      ? String(Math.floor(Number(comment.parentId)))
      : undefined,
  replies: [],
  userVote: comment.liked ? "up" : null,
  permissions: comment.permissions,
});
