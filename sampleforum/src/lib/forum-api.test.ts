import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchMentionCandidates,
  finalizeForumPostLocalImages,
  submitForumPost,
  submitForumReply,
} from "@/lib/forum-api";

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const jsonErrorResponse = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("fetchMentionCandidates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("still requests candidates when query is empty (for plain '@' mention)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMentionCandidates({ query: "", limit: 6, postId: 99 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/forum/api/mentions?");
    expect(url).not.toContain("q=");
    expect(url).toContain("limit=6");
    expect(url).toContain("postId=99");
    expect(options.method).toBe("GET");
  });

  it("passes q parameter when query has content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, users: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchMentionCandidates({ query: "phan", limit: 5 });

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

  it("throws when post id is missing", async () => {
    await expect(
      submitForumReply({
        postId: 0,
        content: "Xin chao",
        parentId: 1,
      })
    ).rejects.toThrow("Không xác định được chủ đề để phản hồi.");
  });

  it("throws when content is empty", async () => {
    await expect(
      submitForumReply({
        postId: 1,
        content: "",
        parentId: 1,
      })
    ).rejects.toThrow("Nội dung bình luận không được để trống.");
  });

  it("sends forum reply payload with parent id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await submitForumReply({
      postId: 88,
      content: "<p>Xin chao</p>",
      parentId: 88,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/forum/api/posts/88/replies");
    expect(options.method).toBe("POST");

    const bodyRaw = options.body ? String(options.body) : "{}";
    const body = JSON.parse(bodyRaw);
    expect(body.parentId).toBe(88);
    expect(typeof body.requestId).toBe("string");
    expect(body.content).toBe("<p>Xin chao</p>");
  });
});

describe("submitForumPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits post payload in one request and leaves image sync to explicit step", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ comment: { id: 321 }, commentCount: 12 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitForumPost({
      title: "Tieu de",
      content: "<p>Noi dung</p>",
      categorySlug: "gop-y",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [submitUrl, submitOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe("/forum/api/posts");
    expect(submitOptions.method).toBe("POST");
    const submitBody = JSON.parse(String(submitOptions.body || "{}"));
    expect(submitBody.title).toBe("Tieu de");
    expect(submitBody.content).toContain("<!--forum-meta:section=gop-y-->");
    expect(submitBody.content).toContain("<p>Noi dung</p>");
    expect(Object.prototype.hasOwnProperty.call(submitBody, "draftToken")).toBe(false);

    expect(result.normalizedContent).toBe(String(submitBody.content));
  });

  it("returns rate-limit errors without making extra requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonErrorResponse(429, {
          error: "Bạn đang thao tác quá nhanh.",
          code: "COMMENT_RATE_LIMITED",
          retryAfter: 10,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitForumPost({
        title: "Tieu de",
        content: "<p>Noi dung</p>",
        categorySlug: "gop-y",
      })
    ).rejects.toThrow("Bạn đang thao tác quá nhanh.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeForumPostLocalImages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips network when no local images need syncing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeForumPostLocalImages({
      postId: 123,
      content: "<p>test</p>",
      images: [],
    });

    expect(result).toEqual({ content: "<p>test</p>", uploadedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts local images to finalize endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        content: "<p><img src=\"https://cdn/forum/posts/1.webp\" /></p>",
        uploadedCount: 1,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await finalizeForumPostLocalImages({
      postId: 55,
      content: "<p><img src=\"forum-local-image://img-1\" /></p>",
      images: [
        {
          id: "img-1",
          dataUrl: "data:image/webp;base64,UklGRiQAAABXRUJQVlA4WAoAAAAQAAAAAQAAAwAAQUxQSAIAAAAASUNDUMgBAAA=",
        },
      ],
    });

    expect(result.uploadedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/forum/api/posts/55/images/finalize");
    expect(options.method).toBe("POST");

    const body = JSON.parse(String(options.body || "{}"));
    expect(Array.isArray(body.images)).toBe(true);
    expect(body.images[0].id).toBe("img-1");
    expect(body.content).toContain("forum-local-image://img-1");
  });
});
