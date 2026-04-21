const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const createAuthUserDomain = require("../src/domains/auth-user-domain");

const normalizeAvatarStoragePath = (value) => {
  const raw = (value == null ? "" : String(value)).trim();
  if (!raw) return "";

  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname || "";
    } catch (_err) {
      return "";
    }
  }

  const compact = pathname
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/+/g, "/");
  if (!compact) return "";
  const lower = compact.toLowerCase();
  if (lower !== "uploads/avatars" && !lower.startsWith("uploads/avatars/")) return "";
  return `/${compact}`;
};

const resolvePublicAvatarUrl = (value) => {
  const stored = normalizeAvatarStoragePath(value);
  if (stored) return stored;

  const raw = (value == null ? "" : String(value)).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const protocol = (parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    const pathname = parsed.pathname || "/";
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search || ""}${parsed.hash || ""}`;
  } catch (_err) {
    return "";
  }
};

const createDomain = () =>
  createAuthUserDomain({
    apiKeySecret: "",
    authAllowedEmailDomains: [],
    clearUserAuthSession: () => {},
    crypto,
    dbAll: async () => [],
    dbGet: async () => null,
    dbRun: async () => ({ changes: 0 }),
    formatDate: () => "",
    normalizeAvatarStoragePath,
    resolvePublicAvatarUrl,
    serverSessionVersion: "test",
    wantsJson: () => true,
  });

test("normalizeAvatarUrl keeps Google avatar URLs", () => {
  const domain = createDomain();
  const avatar = "https://lh3.googleusercontent.com/a/ACg8ocJf3W6Y7Z?sz=96";
  assert.equal(domain.normalizeAvatarUrl(avatar), avatar);
});

test("buildAvatarUrlFromAuthUser falls back to OAuth identity avatar", () => {
  const domain = createDomain();
  const googleAvatar = "https://lh3.googleusercontent.com/a/ACg8ocJf3W6Y7Z?sz=96";
  const user = {
    user_metadata: {},
    identities: [
      {
        provider: "google",
        identity_data: {
          avatar_url: googleAvatar,
        },
      },
    ],
  };

  assert.equal(domain.buildAvatarUrlFromAuthUser(user, ""), googleAvatar);
});

test("buildAvatarUrlFromAuthUser preserves uploaded custom avatar", () => {
  const domain = createDomain();
  const customAvatar = "/uploads/avatars/user-custom.webp";
  const user = {
    user_metadata: {
      avatar_url_custom: customAvatar,
    },
    identities: [
      {
        provider: "google",
        identity_data: {
          avatar_url: "https://lh3.googleusercontent.com/a/ACg8ocJf3W6Y7Z?sz=96",
        },
      },
    ],
  };

  assert.equal(domain.buildAvatarUrlFromAuthUser(user, ""), customAvatar);
});

test("buildSessionUserFromUserRow adds cache-bust token for uploaded avatar", () => {
  const domain = createDomain();
  const updatedAt = 1711111111111;
  const user = domain.buildSessionUserFromUserRow(
    {
      id: "user-1",
      email: "user@example.com",
      display_name: "User One",
      avatar_url: "/uploads/avatars/user-1.webp",
      facebook_url: "",
      discord_handle: "",
      bio: "",
      updated_at: updatedAt,
    },
    []
  );

  assert.ok(user);
  assert.equal(user.user_metadata.avatar_url_custom, `/uploads/avatars/user-1.webp?t=${updatedAt}`);
  assert.equal(user.user_metadata.avatar_url, `/uploads/avatars/user-1.webp?t=${updatedAt}`);
  assert.equal(user.user_metadata.picture, `/uploads/avatars/user-1.webp?t=${updatedAt}`);
});

test("mapPublicUserRow adds cache-bust token for uploaded avatar", () => {
  const domain = createDomain();
  const updatedAt = 1711111111111;
  const profile = domain.mapPublicUserRow({
    id: "user-1",
    email: "user@example.com",
    username: "user1",
    display_name: "User One",
    avatar_url: "/uploads/avatars/user-1.webp",
    facebook_url: "",
    discord_handle: "",
    bio: "",
    created_at: updatedAt,
    updated_at: updatedAt,
  });

  assert.ok(profile);
  assert.equal(profile.avatarUrl, `/uploads/avatars/user-1.webp?t=${updatedAt}`);
});
