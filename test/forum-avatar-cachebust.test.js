const test = require("node:test");
const assert = require("node:assert/strict");

const createForumApiPresenterUtils = require("../src/routes/forum-api-presenter-utils");

const createPresenter = () =>
  createForumApiPresenterUtils({
    buildCommentPermissions: () => ({
      canEdit: false,
      canDelete: false,
      canReport: false,
      canReply: true,
      isOwner: false,
    }),
    buildExcerpt: (value) => String(value || "").trim(),
    buildForumSectionLabelFromSlug: (slug) => slug || "forum",
    defaultSectionLabelBySlug: new Map(),
    extractForumSectionSlug: () => "",
    extractTopicHeadline: () => "",
    formatTimeAgo: () => "now",
    normalizeAvatarUrl: (value) => String(value || "").trim(),
    resolveAvatarUrlForClient: (value, token) => {
      const avatarUrl = String(value || "").trim();
      if (!avatarUrl) return "";
      if (!avatarUrl.startsWith("/uploads/avatars/")) return avatarUrl;
      const cacheToken = Number(token);
      if (!Number.isFinite(cacheToken) || cacheToken <= 0) return avatarUrl;
      return `${avatarUrl}?t=${Math.floor(cacheToken)}`;
    },
    normalizeForumSectionSlug: (value) => String(value || "").trim(),
    normalizeUploadedImageUrl: (value) => String(value || "").trim(),
    toIso: (value) => String(value || "").trim(),
    toText: (value) => String(value == null ? "" : value).trim(),
  });

test("forum presenter cache-busts uploaded user avatars with user updated_at", () => {
  const { normalizeAuthorAvatar } = createPresenter();

  assert.equal(
    normalizeAuthorAvatar({
      user_avatar_url: "/uploads/avatars/user-1.webp",
      user_avatar_updated_at: 1711111111111,
      author_avatar_url: "/uploads/avatars/legacy.webp",
    }),
    "/uploads/avatars/user-1.webp?t=1711111111111"
  );
});

test("forum presenter cache-busts direct avatar rows used by mention/admin paths", () => {
  const { normalizeAuthorAvatar } = createPresenter();

  assert.equal(
    normalizeAuthorAvatar({
      avatar_url: "/uploads/avatars/user-2.webp",
      avatar_updated_at: 1712222222222,
    }),
    "/uploads/avatars/user-2.webp?t=1712222222222"
  );
});
