const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const requestIdPattern = /^[a-z0-9][a-z0-9._:-]{7,79}$/i;

const renderCommentsSection = (overrides = {}) => {
  const partialPath = path.join(__dirname, "..", "views", "partials", "manga-comments-section.ejs");
  return ejs.renderFile(partialPath, {
    manga: { slug: "demo-manga", title: "Demo Manga" },
    comments: [],
    commentCount: 0,
    commentPagination: { page: 1, totalPages: 1, hasNext: false, totalTopLevel: 0 },
    commentComposerEnabled: true,
    commentDeleteByTeamMember: false,
    commentScope: "chapter",
    commentBasePathOverride: "/manga/demo-manga/chapters/1",
    commentImageUploadsEnabled: false,
    assetVersion: "test",
    cacheBust: (value) => value,
    formatTimeAgo: () => "vừa xong",
    ...overrides
  });
};

test("chapter comment forms include valid request IDs for native form fallback", async () => {
  const html = await renderCommentsSection({
    commentCount: 1,
    commentPagination: { page: 1, totalPages: 1, hasNext: false, totalTopLevel: 1 },
    comments: [
      {
        id: 123,
        author: "Bạn đọc",
        authorUserId: "user-1",
        authorUsername: "reader",
        avatarUrl: "",
        badges: [],
        content: "Bình luận hợp lệ",
        createdAt: new Date().toISOString(),
        likeCount: 0,
        reportCount: 0,
        liked: false,
        reported: false,
        replies: [
          {
            id: 124,
            author: "Bạn đọc 2",
            authorUserId: "user-2",
            authorUsername: "reader2",
            avatarUrl: "",
            badges: [],
            content: "Trả lời hợp lệ",
            createdAt: new Date().toISOString(),
            likeCount: 0,
            reportCount: 0,
            liked: false,
            reported: false
          }
        ]
      }
    ]
  });

  const requestIds = [...html.matchAll(/name="requestId"\s+value="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(requestIds.length, 3);
  requestIds.forEach((requestId) => {
    assert.match(requestId, requestIdPattern);
  });
  assert.equal(new Set(requestIds).size, requestIds.length);
});
