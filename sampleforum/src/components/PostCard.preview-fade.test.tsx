import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PostCard } from "@/components/PostCard";
import type { Post } from "@/types/forum";

const makePost = (overrides: Partial<Post> = {}): Post => ({
  id: "101",
  title: "Bài viết dài",
  content: `<p>${"Dòng nội dung ".repeat(24)}</p>`,
  author: {
    id: "u-1",
    username: "tester",
    displayName: "Tester",
    avatar: "/logobfang.svg",
    profileUrl: "/user/tester",
    badges: [],
    role: "member",
  },
  category: {
    id: 1,
    name: "Thảo luận",
    slug: "thao-luan-chung",
    icon: "💬",
    postCount: 0,
  },
  tags: [],
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "Vừa xong",
  permissions: {
    canEdit: false,
    canDelete: false,
    canReport: true,
    canReply: true,
    isOwner: false,
  },
  ...overrides,
});

const renderPostCard = (postOverrides: Partial<Post> = {}) =>
  render(
    <MemoryRouter>
      <PostCard post={makePost(postOverrides)} />
    </MemoryRouter>
  );

describe("PostCard preview fade", () => {
  it("shows fade teaser for long collapsed previews", () => {
    const { container } = renderPostCard();

    expect(container.querySelector(".forum-card-preview-fade")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /xem thêm/i })).toBeNull();
  });

  it("keeps teaser state without preview action buttons", () => {
    const { container } = renderPostCard();

    expect(container.querySelector(".forum-card-preview-fade")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /thu gọn/i })).toBeNull();
  });

  it("does not show fade teaser for short previews", () => {
    const { container } = renderPostCard({ content: "<p>Ngắn gọn</p>" });

    expect(container.querySelector(".forum-card-preview-fade")).toBeNull();
    expect(screen.queryByRole("button", { name: /xem thêm/i })).toBeNull();
  });
});
