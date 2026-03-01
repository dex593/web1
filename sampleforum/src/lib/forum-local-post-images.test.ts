import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX,
  prepareForumPostContentForSubmit,
} from "@/lib/forum-local-post-images";

const SAMPLE_DATA_URL = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4WAoAAAAQAAAAAQAAAwAAQUxQSAIAAAAASUNDUMgBAAA=";

describe("prepareForumPostContentForSubmit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns original html when there is no local image", () => {
    const html = "<p>Hello forum</p>";
    const prepared = prepareForumPostContentForSubmit(html);

    expect(prepared.content).toBe(html);
    expect(prepared.images).toEqual([]);
  });

  it("extracts data URLs and replaces them with local placeholders", () => {
    const html = `<p>img</p><img src="${SAMPLE_DATA_URL}" alt="a" /><p>x</p>`;
    const prepared = prepareForumPostContentForSubmit(html);

    expect(prepared.images.length).toBe(1);
    expect(prepared.images[0].dataUrl).toBe(SAMPLE_DATA_URL);
    expect(prepared.content).not.toContain(SAMPLE_DATA_URL);
    expect(prepared.content).toContain(FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX);
  });

  it("deduplicates repeated local images", () => {
    const html = `<p>1</p><img src="${SAMPLE_DATA_URL}" /><img src="${SAMPLE_DATA_URL}" />`;
    const prepared = prepareForumPostContentForSubmit(html);

    expect(prepared.images.length).toBe(1);
    const placeholder = `${FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX}${prepared.images[0].id}`;
    expect(prepared.content.match(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(2);
  });

  it("uses regex fallback when DOMParser is unavailable", () => {
    vi.stubGlobal("DOMParser", undefined);
    const html = `<p>fallback</p><img src="${SAMPLE_DATA_URL}" />`;
    const prepared = prepareForumPostContentForSubmit(html);

    expect(prepared.images.length).toBe(1);
    expect(prepared.content).toContain(FORUM_LOCAL_IMAGE_PLACEHOLDER_PREFIX);
  });
});
