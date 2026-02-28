import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const routeFilePath = path.resolve(process.cwd(), "../src/routes/site-routes.js");
const forumApiRouteFilePath = path.resolve(process.cwd(), "../src/routes/forum-api-routes.js");
const mentionDomainFilePath = path.resolve(process.cwd(), "../src/domains/mention-notification-domain.js");
const engagementRouteFilePath = path.resolve(process.cwd(), "../src/routes/engagement-routes.js");
const appFilePath = path.resolve(process.cwd(), "../app.js");

const getRouteBlock = (source: string, routePath: string): string => {
  const marker = `"${routePath}"`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Cannot find route marker: ${marker}`);
  }

  const nextRouteStart = source.indexOf("\napp.post(", start + marker.length);
  return source.slice(start, nextRouteStart > 0 ? nextRouteStart : source.length);
};

describe("forum backend regression checks", () => {
  it("declares isForumRequest before cooldown guard in both forum comment routes", () => {
    const source = fs.readFileSync(routeFilePath, "utf8");

    const rootCommentRoute = getRouteBlock(source, "/manga/:slug/comments");
    const chapterCommentRoute = getRouteBlock(source, "/manga/:slug/chapters/:number/comments");

    for (const block of [rootCommentRoute, chapterCommentRoute]) {
      const declareIndex = block.indexOf("const isForumRequest = isForumCommentRequest(req, commentRequestId);");
      const useIndex = block.indexOf("...(isForumRequest");

      expect(declareIndex).toBeGreaterThan(-1);
      expect(useIndex).toBeGreaterThan(-1);
      expect(declareIndex).toBeLessThan(useIndex);
    }
  });

  it("resolves forum reply parent context and uses root comment id for mentions", () => {
    const source = fs.readFileSync(routeFilePath, "utf8");

    const rootCommentRoute = getRouteBlock(source, "/manga/:slug/comments");
    const chapterCommentRoute = getRouteBlock(source, "/manga/:slug/chapters/:number/comments");

    for (const block of [rootCommentRoute, chapterCommentRoute]) {
      expect(block).toContain("const parentContext = await resolveCommentParentContext({");
      expect(block).toContain("const rootCommentId = parentContext.rootCommentId;");
      expect(block).toContain("rootCommentId: rootCommentId || undefined");
    }
  });

  it("keeps forum API mention metadata wiring for posts and replies", () => {
    const source = fs.readFileSync(forumApiRouteFilePath, "utf8");

    expect(source).toContain("const buildMentionMapForRows = async ({ rows, rootCommentId }) => {");
    expect(source).toContain("mentions: Array.isArray(mentions) ? mentions : []");
    expect(source).toContain("const mentionByCommentId = await buildMentionMapForRows({ rows: postRows });");
    expect(source).toContain("const mentionByCommentId = await buildMentionMapForRows({\n        rows: [postRow, ...replyRows],");
  });

  it("accepts host aliases when resolving forum link labels", () => {
    const source = fs.readFileSync(forumApiRouteFilePath, "utf8");

    expect(source).toContain('const hasSameHostContext = (targetUrl, baseUrl) => {');
    expect(source).toContain('replace(/^www\\./, "")');
    expect(source).toContain("if (parsed.host && !hasSameHostContext(parsed, base)) {");
  });

  it("includes nested forum replies when resolving mention candidates and colors", () => {
    const source = fs.readFileSync(mentionDomainFilePath, "utf8");

    expect(source).toContain("OR c.parent_id IN (");
    expect(source).toContain("WHERE c1.parent_id = ?");
    expect(source).toContain("AND c1.status = 'visible'");
  });

  it("keeps manga comment tree isolated from forum threads", () => {
    const source = fs.readFileSync(appFilePath, "utf8");

    expect(source).toContain('const FORUM_COMMENT_REQUEST_PREFIX = "forum-";');
    expect(source).toContain("AND COALESCE(client_request_id, '') NOT ILIKE ?");
    expect(source).toContain("AND COALESCE(c.client_request_id, '') NOT ILIKE ?");
    expect(source).toContain("AND COALESCE(child.client_request_id, '') NOT ILIKE ?");
  });

  it("keeps forum API feeds scoped to forum-created comments only", () => {
    const source = fs.readFileSync(forumApiRouteFilePath, "utf8");

    expect(source).toContain('const FORUM_REQUEST_ID_PREFIX = "forum-";');
    expect(source).toContain("const FORUM_REQUEST_ID_LIKE = `${FORUM_REQUEST_ID_PREFIX}%`;");
    expect(source).toContain("COALESCE(c.client_request_id, '') ILIKE ?");
    expect(source).toContain("COALESCE(r.client_request_id, '') ILIKE ?");
  });

  it("keeps hot ranking buckets and pagination constraints in forum home API", () => {
    const source = fs.readFileSync(forumApiRouteFilePath, "utf8");

    expect(source).toContain("const MAX_PER_PAGE = 20;");
    expect(source).toContain("const HOT_RECENT_LIMIT = 5;");
    expect(source).toContain("const HOT_COMMENT_ACTIVITY_LIMIT = 10;");
    expect(source).toContain("const normalizeForumSort = (value) => {");
    expect(source).toContain("WITH base_posts AS (");
    expect(source).toContain("recent_picks");
    expect(source).toContain("comment_picks");
    expect(source).toContain("hot_bucket");
  });

  it("resolves forum notifications to forum post permalinks", () => {
    const mentionSource = fs.readFileSync(mentionDomainFilePath, "utf8");
    const engagementSource = fs.readFileSync(engagementRouteFilePath, "utf8");

    expect(mentionSource).toContain("const resolveForumCommentPermalinkForNotification = async ({ commentId }) => {");
    expect(mentionSource).toContain("return `/forum/post/${postId}#comment-${safeCommentId}`;");
    expect(engagementSource).toContain("resolveForumCommentPermalinkForNotification,");
    expect(engagementSource).toContain("comment_row.client_request_id as comment_client_request_id");
    expect(engagementSource).toContain("const isForumCommentNotification = commentRequestId.startsWith(\"forum-\");");
    expect(engagementSource).toContain(
      'if (notificationType === "forum_post_comment" || (notificationType === "mention" && isForumCommentNotification)) {'
    );
  });
});
