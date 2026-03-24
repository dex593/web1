import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const forumApiLinkLabelUtilsFactoryFilePath = path.resolve(process.cwd(), "../src/routes/forum-api-link-label-utils.js");
const createForumApiLinkLabelUtils = requireFromTest(forumApiLinkLabelUtilsFactoryFilePath);

const parseInternalPathFromUrl = (url: string): string => {
  try {
    return new URL(String(url || ""), "https://moetruyen.local").pathname;
  } catch (_error) {
    return "";
  }
};

const buildUtils = (dbAll: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>) => {
  return createForumApiLinkLabelUtils({
    buildPostTitle: (row: Record<string, unknown>) => {
      const content = String((row && row.content) || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!content) return "";
      return content;
    },
    buildSqlPlaceholders: (count: number) => Array.from({ length: Math.max(0, Math.floor(count || 0)) }, () => "?").join(", "),
    dbAll,
    toText: (value: unknown) => (value == null ? "" : String(value).trim()),
  });
};

describe("forum link-label utils behavior", () => {
  it("parses forum-post/manga/chapter URL variants for label resolution", () => {
    const utils = buildUtils(async () => []);
    const urls = [
      "https://moetruyen.local/forum/post/123-bai-viet",
      "https://moetruyen.local/forum/posts/456",
      "https://moetruyen.local/manga/doraemon",
      "https://moetruyen.local/manga/doraemon/chapters/12,500",
      "https://moetruyen.local/forum/post/00012",
    ];

    const parsedLinks = utils.parseForumLinkCandidates({
      decodePathSegment: decodeURIComponent,
      parseInternalPathFromUrl,
      req: {},
      urls,
    });

    expect(parsedLinks).toEqual([
      { kind: "forum-post", url: "https://moetruyen.local/forum/post/123-bai-viet", postId: 123 },
      { kind: "forum-post", url: "https://moetruyen.local/forum/posts/456", postId: 456 },
      { kind: "manga", url: "https://moetruyen.local/manga/doraemon", mangaSlug: "doraemon" },
      {
        kind: "chapter",
        url: "https://moetruyen.local/manga/doraemon/chapters/12,500",
        mangaSlug: "doraemon",
        chapterNumberText: "12.5",
      },
    ]);
  });

  it("resolves parsed links to concrete labels for manga/chapter/forum-post", async () => {
    const utils = buildUtils(async (sql) => {
      if (sql.includes("FROM manga")) {
        return [{ slug: "doraemon", title: "Doraemon" }];
      }
      if (sql.includes("FROM comments")) {
        return [{ id: 123, content: "Bai viet forum title" }];
      }
      return [];
    });

    const parsedLinks = utils.parseForumLinkCandidates({
      decodePathSegment: decodeURIComponent,
      parseInternalPathFromUrl,
      req: {},
      urls: [
        "https://moetruyen.local/manga/doraemon",
        "https://moetruyen.local/manga/doraemon/chapters/12.5",
        "https://moetruyen.local/forum/post/123-bai-viet",
      ],
    });

    const labels = await utils.resolveParsedForumLinkLabels({
      parsedLinks,
      forumRequestIdLike: "forum-%",
    });

    expect(labels).toEqual([
      { url: "https://moetruyen.local/manga/doraemon", label: "Doraemon" },
      { url: "https://moetruyen.local/manga/doraemon/chapters/12.5", label: "Doraemon - Ch. 12.5" },
      { url: "https://moetruyen.local/forum/post/123-bai-viet", label: "Bai viet forum title" },
    ]);
  });

  it("uses forum request-id fallback query for unresolved forum-post labels", async () => {
    const utils = buildUtils(async (sql) => {
      if (sql.includes("FROM comments") && sql.includes("ILIKE ?")) {
        return [{ id: 456, content: "Fallback post title" }];
      }
      if (sql.includes("FROM comments")) {
        return [];
      }
      return [];
    });

    const parsedLinks = [
      {
        kind: "forum-post",
        url: "https://moetruyen.local/forum/posts/456",
        postId: 456,
      },
    ];

    const withoutFallback = await utils.resolveParsedForumLinkLabels({
      parsedLinks,
      forumRequestIdLike: "",
    });
    expect(withoutFallback).toEqual([]);

    const withFallback = await utils.resolveParsedForumLinkLabels({
      parsedLinks,
      forumRequestIdLike: "forum-%",
    });
    expect(withFallback).toEqual([
      {
        url: "https://moetruyen.local/forum/posts/456",
        label: "Fallback post title",
      },
    ]);
  });
});
