import { describe, expect, it } from "vitest";

import { buildForumReplyContentWithMention } from "@/lib/forum-reply";

describe("buildForumReplyContentWithMention", () => {
  it("prefixes plain-text replies with @username", () => {
    const content = buildForumReplyContentWithMention({
      content: "Cam on ban",
      username: "phanthehien150196",
    });

    expect(content).toBe("@phanthehien150196 Cam on ban");
  });

  it("injects mention into the first paragraph for rich HTML replies", () => {
    const content = buildForumReplyContentWithMention({
      content: "<p>Noi dung tra loi</p>",
      username: "mod_linh",
    });

    expect(content).toBe("<p>@mod_linh Noi dung tra loi</p>");
  });

  it("does not duplicate mention when content already has target mention", () => {
    const content = buildForumReplyContentWithMention({
      content: "<p>@mod_linh Da co mention roi</p>",
      username: "mod_linh",
    });

    expect(content).toBe("<p>@mod_linh Da co mention roi</p>");
  });

  it("skips auto-mention for unsupported usernames", () => {
    const content = buildForumReplyContentWithMention({
      content: "<p>Noi dung</p>",
      username: "display-name-with-dash",
    });

    expect(content).toBe("<p>Noi dung</p>");
  });
});
