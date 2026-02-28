import { describe, expect, it } from "vitest";

import { mapApiCommentToUiComment, mapApiPostToUiPost } from "@/lib/forum-presenters";
import type { ForumApiComment, ForumApiPostSummary } from "@/types/forum";

const basePermissions = {
  canEdit: false,
  canDelete: false,
  canReport: true,
  canReply: true,
  isOwner: false,
};

const makePost = (overrides: Partial<ForumApiPostSummary> = {}): ForumApiPostSummary => ({
  id: 101,
  title: "Test title",
  excerpt: "Test excerpt",
  content: "<p>Noi dung</p>",
  createdAt: "2026-02-27T10:00:00.000Z",
  timeAgo: "Vừa xong",
  likeCount: 2,
  reportCount: 0,
  commentCount: 1,
  author: {
    id: "u-1",
    username: "phanthehien150196",
    displayName: "Phan The Hien",
    avatarUrl: "",
    profileUrl: "/user/phanthehien150196",
    badges: [
      { code: "admin", label: "Admin", color: "#ef4444", priority: 999 },
      { code: "admin", label: "Admin", color: "#ef4444", priority: 999 },
    ],
    userColor: "#ef4444",
  },
  manga: {
    id: 11,
    slug: "one-piece",
    title: "One Piece",
    cover: "",
    url: "/manga/one-piece",
  },
  chapter: {
    number: "",
    title: "",
    label: "",
    url: "/manga/one-piece",
  },
  category: {
    id: 1,
    name: "Thảo luận",
    slug: "thao-luan-chung",
  },
  sectionSlug: "thao-luan-chung",
  permissions: basePermissions,
  liked: false,
  saved: false,
  ...overrides,
});

const makeComment = (overrides: Partial<ForumApiComment> = {}): ForumApiComment => ({
  id: 202,
  content: "<p>Xin chao</p>",
  createdAt: "2026-02-27T10:00:00.000Z",
  timeAgo: "Vừa xong",
  likeCount: 1,
  reportCount: 0,
  author: {
    id: "u-2",
    username: "mod_linh",
    displayName: "Mod Linh",
    avatarUrl: "",
    profileUrl: "/user/mod_linh",
    badges: [
      { code: "mod", label: "Mod", color: "#3b82f6", priority: 500 },
      { code: "mod", label: "Mod", color: "#3b82f6", priority: 500 },
    ],
    userColor: "#3b82f6",
  },
  permissions: basePermissions,
  liked: false,
  ...overrides,
});

describe("forum-presenters", () => {
  it("maps post author with deduped badges and fallback avatar", () => {
    const mapped = mapApiPostToUiPost(makePost());

    expect(mapped.author.avatar).toBe("/logobfang.svg");
    expect(mapped.author.profileUrl).toBe("/user/phanthehien150196");
    expect(mapped.author.badges).toHaveLength(1);
    expect(mapped.author.badges?.[0]?.code).toBe("admin");
    expect(mapped.author.role).toBe("admin");
  });

  it("maps comment author with deduped badges and role from highest badge", () => {
    const mapped = mapApiCommentToUiComment(makeComment());

    expect(mapped.author.avatar).toBe("/logobfang.svg");
    expect(mapped.author.badges).toHaveLength(1);
    expect(mapped.author.badges?.[0]?.code).toBe("mod");
    expect(mapped.author.role).toBe("moderator");
  });

  it("keeps member role when no elevated badge exists", () => {
    const mapped = mapApiCommentToUiComment(
      makeComment({
        author: {
          id: "u-3",
          username: "normal_user",
          displayName: "Normal User",
          avatarUrl: "",
          profileUrl: "/user/normal_user",
          badges: [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }],
          userColor: "",
        },
      })
    );

    expect(mapped.author.role).toBe("member");
    expect(mapped.author.badges).toHaveLength(1);
  });

  it("renders mention with display name for post content", () => {
    const mapped = mapApiPostToUiPost(
      makePost({
        content: "<p>Tra loi @mod_linh</p>",
        mentions: [
          {
            userId: "u-2",
            username: "mod_linh",
            name: "Mod Linh",
            userColor: "#3b82f6",
          },
        ],
      })
    );

    const body = new DOMParser().parseFromString(mapped.content, "text/html").body;
    const mention = body.querySelector("a.mention[data-mention-username='mod_linh']");

    expect(mention).not.toBeNull();
    expect(mention?.textContent).toBe("Mod Linh");
  });

  it("renders mention with display name for comment content", () => {
    const mapped = mapApiCommentToUiComment(
      makeComment({
        content: "<p>Xin chao @phanthehien150196</p>",
        mentions: [
          {
            userId: "u-1",
            username: "phanthehien150196",
            name: "Phan The Hien",
            userColor: "#ef4444",
          },
        ],
      })
    );

    const body = new DOMParser().parseFromString(mapped.content, "text/html").body;
    const mention = body.querySelector("a.mention[data-mention-username='phanthehien150196']");

    expect(mention).not.toBeNull();
    expect(mention?.textContent).toBe("Phan The Hien");
  });

  it("removes duplicated title when rendering excerpt fallback", () => {
    const mapped = mapApiPostToUiPost(
      makePost({
        title: "Tiêu đề bị lặp",
        content: "",
        excerpt: "Tiêu đề bị lặp Nội dung phần thân hiển thị ở danh sách.",
      })
    );

    expect(mapped.title).toBe("Tiêu đề bị lặp");
    expect(mapped.content).not.toContain("Tiêu đề bị lặp Nội dung");
    expect(mapped.content).toContain("Nội dung phần thân hiển thị ở danh sách.");
  });
});
