import { describe, expect, it } from "vitest";

import { normalizeForumContentHtml } from "@/lib/forum-content";

const getBody = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

describe("normalizeForumContentHtml", () => {
  it("decorates @username mentions into profile links", () => {
    const html = normalizeForumContentHtml("<p>Xin chao @phanthehien150196</p>");
    const body = getBody(html);
    const mention = body.querySelector("a.mention[data-mention-username='phanthehien150196']");

    expect(mention).not.toBeNull();
    expect(mention?.getAttribute("href")).toBe("/user/phanthehien150196");
    expect(mention?.textContent).toBe("@phanthehien150196");
  });

  it("keeps mentions inside code blocks as plain text", () => {
    const html = normalizeForumContentHtml("<p><code>@phanthehien150196</code> va @admin_user</p>");
    const body = getBody(html);

    expect(body.querySelector("code")?.textContent).toBe("@phanthehien150196");
    const mentionLinks = body.querySelectorAll("a.mention");
    expect(mentionLinks.length).toBe(1);
    expect(mentionLinks[0]?.textContent).toBe("@admin_user");
  });

  it("does not wrap mentions already inside links", () => {
    const html = normalizeForumContentHtml("<p><a href='/user/old_user'>@old_user</a> va @new_user</p>");
    const body = getBody(html);

    const anchors = Array.from(body.querySelectorAll("a"));
    expect(anchors.length).toBe(2);
    expect(anchors[0]?.getAttribute("href")).toBe("/user/old_user");
    expect(anchors[0]?.classList.contains("mention")).toBe(false);
    expect(anchors[1]?.getAttribute("href")).toBe("/user/new_user");
    expect(anchors[1]?.classList.contains("mention")).toBe(true);
  });

  it("supports mention decoration for markdown content", () => {
    const html = normalizeForumContentHtml("Chao @mod_linh");
    const body = getBody(html);
    const mention = body.querySelector("a.mention[data-mention-username='mod_linh']");

    expect(mention).not.toBeNull();
    expect(mention?.getAttribute("href")).toBe("/user/mod_linh");
  });

  it("renders mention display names when mention metadata is provided", () => {
    const html = normalizeForumContentHtml("<p>Xin chao @mod_linh</p>", [
      {
        userId: "u-2",
        username: "mod_linh",
        name: "Mod Linh",
        userColor: "#3b82f6",
      },
    ]);
    const body = getBody(html);
    const mention = body.querySelector("a.mention[data-mention-username='mod_linh']");

    expect(mention).not.toBeNull();
    expect(mention?.getAttribute("href")).toBe("/user/mod_linh");
    expect(mention?.textContent).toBe("Mod Linh");
    expect(mention?.getAttribute("style") || "").toContain("59, 130, 246");
  });
});
