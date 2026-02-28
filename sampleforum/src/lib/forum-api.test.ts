import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMentionCandidates, submitForumReply } from "@/lib/forum-api";

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("fetchMentionCandidates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns empty result and skips network when manga slug is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMentionCandidates({ mangaSlug: "", query: "admin" });

    expect(result).toEqual({ ok: true, users: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still requests candidates when query is empty (for plain '@' mention)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMentionCandidates({ mangaSlug: "one-piece", query: "", limit: 6, postId: 99 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/manga/one-piece/comment-mentions?");
    expect(url).not.toContain("q=");
    expect(url).toContain("limit=6");
    expect(url).toContain("postId=99");
    expect(options.method).toBe("GET");
  });

  it("passes q parameter when query has content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMentionCandidates({ mangaSlug: "one-piece", query: "phan", limit: 5 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("q=phan");
    expect(url).toContain("limit=5");
  });
});

describe("submitForumReply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws when endpoint is missing", async () => {
    await expect(
      submitForumReply({
        endpoint: "",
        content: "Xin chao",
        parentId: 1,
      })
    ).rejects.toThrow("Không xác định được điểm gửi bình luận.");
  });

  it("throws when content is empty", async () => {
    await expect(
      submitForumReply({
        endpoint: "/manga/one-piece/comments",
        content: "",
        parentId: 1,
      })
    ).rejects.toThrow("Nội dung bình luận không được để trống.");
  });

  it("sends forum-mode payload with parent id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await submitForumReply({
      endpoint: "/manga/one-piece/comments",
      content: "<p>Xin chao</p>",
      parentId: 88,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/manga/one-piece/comments");
    expect(options.method).toBe("POST");

    const bodyRaw = options.body ? String(options.body) : "{}";
    const body = JSON.parse(bodyRaw);
    expect(body.parent_id).toBe(88);
    expect(body.forumMode).toBe(true);
    expect(typeof body.requestId).toBe("string");
    expect(body.content).toBe("<p>Xin chao</p>");
  });
});
