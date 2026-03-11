import { describe, expect, it } from "vitest";

import {
  buildForumAdminSeo,
  buildForumIndexSeo,
  buildForumSavedPostsSeo,
} from "@/lib/forum-seo";

describe("forum-seo canonical policy", () => {
  it("keeps /forum indexable with canonical /forum", () => {
    const seo = buildForumIndexSeo({ search: "" });
    expect(seo.canonicalPath).toBe("/forum");
    expect(seo.robots).toContain("index,follow");
  });

  it("keeps valid section indexable and canonicalized", () => {
    const seo = buildForumIndexSeo({ search: "section=thao-luan-chung&sort=hot&page=1" });
    expect(seo.canonicalPath).toBe("/forum?section=thao-luan-chung");
    expect(seo.robots).toContain("index,follow");
  });

  it("marks search query pages noindex while canonicalizing to clean landing", () => {
    const seo = buildForumIndexSeo({ search: "q=test&section=thao-luan-chung" });
    expect(seo.canonicalPath).toBe("/forum?section=thao-luan-chung");
    expect(seo.robots).toBe("noindex,follow");
  });

  it("marks non-default sort pages noindex", () => {
    const seo = buildForumIndexSeo({ search: "sort=new" });
    expect(seo.canonicalPath).toBe("/forum");
    expect(seo.robots).toBe("noindex,follow");
  });

  it("marks page > 1 as noindex", () => {
    const seo = buildForumIndexSeo({ search: "page=2&section=gop-y" });
    expect(seo.canonicalPath).toBe("/forum?section=gop-y");
    expect(seo.robots).toBe("noindex,follow");
  });

  it("marks unknown query params noindex", () => {
    const seo = buildForumIndexSeo({ search: "foo=bar" });
    expect(seo.canonicalPath).toBe("/forum");
    expect(seo.robots).toBe("noindex,follow");
  });
});

describe("forum-seo private routes", () => {
  it("forces noindex for saved posts", () => {
    const seo = buildForumSavedPostsSeo();
    expect(seo.canonicalPath).toBe("/forum/saved-posts");
    expect(seo.robots).toBe("noindex,nofollow");
  });

  it("forces noindex for admin route", () => {
    const seo = buildForumAdminSeo("/forum/admin/posts");
    expect(seo.canonicalPath).toBe("/forum/admin/posts");
    expect(seo.robots).toBe("noindex,nofollow");
  });
});
