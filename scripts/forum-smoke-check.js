const { spawn, spawnSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const externalBaseUrl = String(process.env.FORUM_BASE_URL || "").trim().replace(/\/+$/, "");
const localSmokePort = Number(process.env.FORUM_SMOKE_PORT) || 3110;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_err) {
    json = null;
  }
  return { response, json, text };
};

const hasDuplicateBadges = (badges) => {
  const items = Array.isArray(badges) ? badges : [];
  const seen = new Set();
  for (const badge of items) {
    const code = String(badge && badge.code ? badge.code : "").trim().toLowerCase();
    const label = String(badge && badge.label ? badge.label : "").trim().toLowerCase();
    const key = `${code}|${label}`;
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
};

const checkHomePayload = (json) => {
  if (!json || json.ok !== true) {
    throw new Error("/forum/api/home trả payload không hợp lệ.");
  }
  if (!Array.isArray(json.posts)) {
    throw new Error("/forum/api/home thiếu mảng posts.");
  }

  json.posts.forEach((post) => {
    if (!post || typeof post !== "object") {
      throw new Error("/forum/api/home có post không hợp lệ.");
    }
    if (!Object.prototype.hasOwnProperty.call(post, "mentions")) {
      throw new Error(`Post id=${post && post.id} thiếu trường mentions.`);
    }
    if (!Array.isArray(post.mentions)) {
      throw new Error(`Post id=${post && post.id} có mentions không phải mảng.`);
    }
  });
};

const checkPostDetailPayload = (json) => {
  if (!json || json.ok !== true || !json.post) {
    throw new Error("/forum/api/posts/:id trả payload không hợp lệ.");
  }

  const profileUrl = String(json.post.author && json.post.author.profileUrl ? json.post.author.profileUrl : "");
  if (!profileUrl) {
    throw new Error("Thiếu post.author.profileUrl.");
  }
  if (!profileUrl.startsWith("/user/") && !profileUrl.startsWith("/comments/users/")) {
    throw new Error(`post.author.profileUrl không đúng định dạng: ${profileUrl}`);
  }

  if (!Object.prototype.hasOwnProperty.call(json.post, "mentions")) {
    throw new Error("post thiếu trường mentions.");
  }
  if (!Array.isArray(json.post.mentions)) {
    throw new Error("post.mentions không phải mảng.");
  }

  if (hasDuplicateBadges(json.post.author && json.post.author.badges)) {
    throw new Error("post.author.badges bị trùng.");
  }

  const comments = Array.isArray(json.comments) ? json.comments : [];
  for (const comment of comments) {
    if (!Object.prototype.hasOwnProperty.call(comment || {}, "mentions")) {
      throw new Error(`comment id=${comment && comment.id} thiếu trường mentions.`);
    }
    if (!Array.isArray(comment && comment.mentions)) {
      throw new Error(`comment id=${comment && comment.id} có mentions không phải mảng.`);
    }
    if (hasDuplicateBadges(comment && comment.author && comment.author.badges)) {
      throw new Error(`comment.author.badges bị trùng ở comment id=${comment && comment.id}`);
    }
  }
};

const isServerReady = async (baseUrl) => {
  const homeUrl = `${String(baseUrl || "").replace(/\/+$/, "")}/forum/api/home`;
  try {
    const { response, json } = await fetchJson(homeUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return response.ok && json && json.ok === true;
  } catch (_err) {
    return false;
  }
};

const waitForServerReady = async (baseUrl, timeoutMs = 45000) => {
  const homeUrl = `${String(baseUrl || "").replace(/\/+$/, "")}/forum/api/home`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReady(baseUrl)) return;
    await delay(1200);
  }
  throw new Error(`Không thể kết nối server tại ${homeUrl} trong ${timeoutMs}ms.`);
};

const stopServerProcess = (child) => {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
};

const runSmokeChecks = async (baseUrl) => {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("Thiếu base URL cho smoke test forum.");
  }
  const homeUrl = `${normalizedBaseUrl}/forum/api/home`;
  const home = await fetchJson(homeUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!home.response.ok) {
    throw new Error(`/forum/api/home lỗi HTTP ${home.response.status}`);
  }
  checkHomePayload(home.json);

  const posts = home.json.posts;
  if (!posts.length) {
    console.log("[forum-smoke] Không có post để test chi tiết, bỏ qua bước /forum/api/posts/:id");
    return;
  }

  const firstPostId = Number(posts[0] && posts[0].id);
  if (!Number.isFinite(firstPostId) || firstPostId <= 0) {
    throw new Error("Post đầu tiên có id không hợp lệ.");
  }

  const detailUrl = `${normalizedBaseUrl}/forum/api/posts/${encodeURIComponent(String(Math.floor(firstPostId)))}`;
  const detail = await fetchJson(detailUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!detail.response.ok) {
    throw new Error(`/forum/api/posts/:id lỗi HTTP ${detail.response.status}`);
  }
  checkPostDetailPayload(detail.json);

  const slug = String(detail.json && detail.json.post && detail.json.post.manga && detail.json.post.manga.slug
    ? detail.json.post.manga.slug
    : "").trim();
  if (slug) {
    const mentionUrl = `${normalizedBaseUrl}/manga/${encodeURIComponent(slug)}/comment-mentions?q=a&limit=5&postId=${encodeURIComponent(
      String(Math.floor(firstPostId))
    )}`;
    const mention = await fetchJson(mentionUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (![200, 401, 403].includes(mention.response.status)) {
      throw new Error(`/manga/:slug/comment-mentions trả status bất thường: ${mention.response.status}`);
    }
  }
};

const main = async () => {
  let spawnedServer = null;
  let baseUrl = externalBaseUrl;

  if (!baseUrl) {
    baseUrl = `http://127.0.0.1:${localSmokePort}`;
    console.log(`[forum-smoke] Khởi động server local cho smoke test tại ${baseUrl} ...`);
    spawnedServer = spawn("node", ["server.js"], {
      cwd: projectRoot,
      stdio: "ignore",
      detached: false,
      env: {
        ...process.env,
        PORT: String(localSmokePort),
      },
    });
    await waitForServerReady(baseUrl);
  } else {
    console.log(`[forum-smoke] Dùng server chỉ định sẵn: ${baseUrl}`);
  }

  try {
    await runSmokeChecks(baseUrl);
    console.log("[forum-smoke] PASS: Forum API smoke checks OK");
  } finally {
    if (spawnedServer) {
      stopServerProcess(spawnedServer);
    }
  }
};

main().catch((error) => {
  console.error("[forum-smoke] FAIL:", error && error.message ? error.message : error);
  process.exit(1);
});
