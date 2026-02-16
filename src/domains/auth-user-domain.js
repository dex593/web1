const createAuthUserDomain = (deps) => {
  const {
    clearAllAuthSessionState,
    clearUserAuthSession,
    crypto,
    dbAll,
    dbGet,
    dbRun,
    formatDate,
    isServerSessionVersionMismatch,
    serverSessionVersion,
    wantsJson,
  } = deps;

const isSafeAvatarUrl = (value) => {
  const url = value == null ? "" : String(value).trim();
  if (!url) return false;
  if (url.length > 500) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith("/uploads/avatars/")) return true;
  return false;
};

const normalizeAvatarUrl = (value) => (isSafeAvatarUrl(value) ? String(value).trim() : "");

const badgeCodePattern = /^[a-z0-9_]{1,32}$/;

const normalizeBadgeCode = (value) => {
  const raw = (value || "")
    .toString()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  const code = cleaned.slice(0, 32);
  return badgeCodePattern.test(code) ? code : "";
};

const buildAutoBadgeCode = async ({ label, excludeBadgeId }) => {
  const base = normalizeBadgeCode(label);
  if (!base) return "";

  const excludeRaw = Number(excludeBadgeId);
  const excludeId = Number.isFinite(excludeRaw) && excludeRaw > 0 ? Math.floor(excludeRaw) : 0;

  for (let attempt = 0; attempt < 500; attempt += 1) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    const headMax = Math.max(1, 32 - suffix.length);
    const candidate = normalizeBadgeCode(`${base.slice(0, headMax)}${suffix}`);
    if (!candidate) continue;

    const conflict = excludeId
      ? await dbGet("SELECT id FROM badges WHERE lower(code) = lower(?) AND id <> ?", [candidate, excludeId])
      : await dbGet("SELECT id FROM badges WHERE lower(code) = lower(?)", [candidate]);
    if (!conflict) {
      return candidate;
    }
  }

  return "";
};

const hexColorPattern = /^#[0-9a-f]{6}$/i;
const shortHexColorPattern = /^#[0-9a-f]{3}$/i;

const normalizeHexColor = (value) => {
  const raw = (value || "").toString().trim();
  if (hexColorPattern.test(raw)) return raw.toLowerCase();
  if (shortHexColorPattern.test(raw)) {
    const hex = raw.slice(1);
    return `#${hex
      .split("")
      .map((c) => `${c}${c}`)
      .join("")}`.toLowerCase();
  }
  return "";
};

let cachedMemberBadgeId = 0;
let cachedMemberBadgeCheckedAt = 0;
const memberBadgeCacheTtlMs = 5 * 60 * 1000;

const getMemberBadgeId = async () => {
  const now = Date.now();
  if (cachedMemberBadgeId && now - cachedMemberBadgeCheckedAt < memberBadgeCacheTtlMs) {
    return cachedMemberBadgeId;
  }
  cachedMemberBadgeCheckedAt = now;

  const row = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  const id = row && row.id != null ? Number(row.id) : 0;
  cachedMemberBadgeId = Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
  return cachedMemberBadgeId;
};

const ensureMemberBadgeForUser = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return;
  let memberId = 0;
  try {
    memberId = await getMemberBadgeId();
  } catch (_err) {
    memberId = 0;
  }
  if (!memberId) return;
  await dbRun(
    "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [id, memberId, Date.now()]
  );
};

const resetMemberBadgeCache = () => {
  cachedMemberBadgeId = 0;
  cachedMemberBadgeCheckedAt = 0;
};

const mapBadgeRow = (row) => {
  if (!row) return null;
  const code = normalizeBadgeCode(row.code);
  const label = (row.label || "").toString().trim();
  const color = normalizeHexColor(row.color) || "";
  const priority = Number(row.priority);
  const canComment = row && row.can_comment != null ? Boolean(row.can_comment) : true;
  return {
    id: row.id,
    code: code || "badge",
    label: label || code || "Badge",
    color: color || "#f8f8f2",
    priority: Number.isFinite(priority) ? Math.floor(priority) : 0,
    canAccessAdmin: Boolean(row.can_access_admin),
    canDeleteAnyComment: Boolean(row.can_delete_any_comment),
    canComment
  };
};

const getUserBadges = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return [];
  const rows = await dbAll(
    `
    SELECT
      b.id,
      b.code,
      b.label,
      b.color,
      b.priority,
      b.can_access_admin,
      b.can_delete_any_comment,
      b.can_comment
    FROM user_badges ub
    JOIN badges b ON b.id = ub.badge_id
    WHERE ub.user_id = ?
    ORDER BY b.priority DESC, b.id ASC
  `,
    [id]
  );
  return rows.map(mapBadgeRow).filter(Boolean);
};

const getUserBadgeContext = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) {
    return {
      badges: [],
      userColor: "",
      permissions: { canAccessAdmin: false, canDeleteAnyComment: false, canComment: false }
    };
  }

  const badges = await getUserBadges(id);
  const sorted = Array.isArray(badges) ? badges.slice() : [];
  sorted.sort((a, b) => {
    const diff = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (diff) return diff;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const permissions = {
    canAccessAdmin: sorted.some((badge) => Boolean(badge.canAccessAdmin)),
    canDeleteAnyComment: sorted.some((badge) => Boolean(badge.canDeleteAnyComment)),
    canComment: sorted.length ? !sorted.some((badge) => badge.canComment === false) : true
  };

  let safeBadges = sorted.map((badge) => ({
    code: badge.code,
    label: badge.label,
    color: normalizeHexColor(badge.color) || badge.color,
    priority: badge.priority
  }));

  if (safeBadges.length === 0) {
    safeBadges = [{ code: "member", label: "Member", color: "#f8f8f2", priority: 100 }];
  }

  const top = safeBadges[0];
  const userColor = top && top.color ? normalizeHexColor(top.color) || "" : "";

  return {
    badges: safeBadges,
    userColor,
    permissions
  };
};

const buildCommentAuthorFromAuthUser = (user) => {
  const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;

  const normalize = (value) => (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
  const clamp = (value, max) => {
    const text = normalize(value);
    const limit = Math.max(0, Math.floor(Number(max) || 0));
    if (!limit) return "";
    if (text.length <= limit) return text;
    if (limit <= 3) return text.slice(0, limit);
    return `${text.slice(0, limit - 3)}...`;
  };

  const customName = meta && meta.display_name ? clamp(meta.display_name, 30) : "";
  const name = meta && meta.full_name ? normalize(meta.full_name) : "";
  const fallbackName = meta && meta.name ? normalize(meta.name) : "";
  const email = user && user.email ? normalize(user.email) : "";

  const candidate = normalize(customName || name || fallbackName || email || "Người dùng");
  return clamp(candidate, 30) || "Người dùng";
};

const normalizeAuthIdentityProvider = (value) => (value == null ? "" : String(value)).trim().toLowerCase();

const readAuthIdentityAvatar = (user, provider) => {
  const wantedProvider = normalizeAuthIdentityProvider(provider);
  if (!wantedProvider) return "";

  const identities = user && Array.isArray(user.identities) ? user.identities : [];
  for (const identity of identities) {
    if (!identity || typeof identity !== "object") continue;
    const identityData =
      identity.identity_data && typeof identity.identity_data === "object" ? identity.identity_data : {};
    const identityProvider = normalizeAuthIdentityProvider(
      identity.provider || identity.provider_id || identityData.provider || ""
    );
    if (identityProvider !== wantedProvider) continue;

    const avatarUrl = normalizeAvatarUrl(
      identityData.avatar_url ||
      identityData.picture ||
      identityData.photo_url ||
      identityData.photoURL ||
      identityData.profile_image ||
      ""
    );
    if (avatarUrl) return avatarUrl;
  }

  return "";
};

const isUploadedAvatarUrl = (value) => {
  const avatarUrl = normalizeAvatarUrl(value);
  return avatarUrl.startsWith("/uploads/avatars/");
};

const isGoogleAvatarUrl = (value) => {
  const avatarUrl = normalizeAvatarUrl(value);
  if (!avatarUrl || !/^https?:\/\//i.test(avatarUrl)) return false;

  try {
    const hostname = new URL(avatarUrl).hostname.toLowerCase();
    return (
      hostname === "googleusercontent.com" ||
      hostname.endsWith(".googleusercontent.com") ||
      hostname === "ggpht.com" ||
      hostname.endsWith(".ggpht.com")
    );
  } catch (_err) {
    return false;
  }
};

const buildAvatarUrlFromAuthUser = (user, currentAvatarUrl) => {
  const meta = user && typeof user.user_metadata === "object" ? user.user_metadata : null;
  const customAvatarUrl = normalizeAvatarUrl(meta && meta.avatar_url_custom ? meta.avatar_url_custom : "");
  if (customAvatarUrl) return customAvatarUrl;

  const currentAvatar = normalizeAvatarUrl(currentAvatarUrl);
  if (currentAvatar && isUploadedAvatarUrl(currentAvatar)) {
    return currentAvatar;
  }

  const googleAvatarUrl = readAuthIdentityAvatar(user, "google");
  if (googleAvatarUrl) return googleAvatarUrl;

  if (currentAvatar && isGoogleAvatarUrl(currentAvatar)) {
    return currentAvatar;
  }

  const metadataAvatarUrl = normalizeAvatarUrl(
    (meta && meta.avatar_url ? meta.avatar_url : "") || (meta && meta.picture ? meta.picture : "") || ""
  );
  if (metadataAvatarUrl) return metadataAvatarUrl;

  const discordAvatarUrl = readAuthIdentityAvatar(user, "discord");
  if (discordAvatarUrl) return discordAvatarUrl;

  return currentAvatar;
};

const hasOwnObjectKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const normalizeProfileSocialUrl = ({ value, allowedHosts, canonicalHost, maxLength }) => {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";

  const safeMax = Math.max(1, Math.floor(Number(maxLength) || 0));
  if (safeMax && raw.length > safeMax) return "";

  const safeHosts = Array.isArray(allowedHosts)
    ? allowedHosts
      .map((item) => (item == null ? "" : String(item)).trim().toLowerCase())
      .filter(Boolean)
    : [];
  const preferredHost = (canonicalHost || safeHosts[0] || "").toString().trim().toLowerCase();
  if (!safeHosts.length || !preferredHost) return "";

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, "")}`;
  }

  let parsed = null;
  try {
    parsed = new URL(candidate);
  } catch (_err) {
    return "";
  }

  const protocol = (parsed.protocol || "").toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") return "";

  const host = (parsed.hostname || "").toLowerCase();
  if (!safeHosts.includes(host)) return "";

  const pathname = (parsed.pathname || "").replace(/\/+$/, "");
  if (!pathname || pathname === "/") return "";

  const search = parsed.search || "";
  return `https://${preferredHost}${pathname}${search}`;
};

const normalizeProfileFacebook = (value) => {
  return normalizeProfileSocialUrl({
    value,
    allowedHosts: ["facebook.com", "www.facebook.com", "m.facebook.com"],
    canonicalHost: "facebook.com",
    maxLength: 180
  });
};

const normalizeProfileDiscord = (value) => {
  return normalizeProfileSocialUrl({
    value,
    allowedHosts: ["discord.gg", "www.discord.gg"],
    canonicalHost: "discord.gg",
    maxLength: 80
  });
};

const normalizeProfileBio = (value) => {
  const raw = value == null ? "" : String(value);
  const compact = raw.replace(/\r\n/g, "\n").trim();
  if (!compact) return "";
  return compact.length <= 300 ? compact : compact.slice(0, 300).trim();
};

const normalizeProfileDisplayName = (value) => {
  const raw = value == null ? "" : String(value);
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= 30) return compact;
  return `${compact.slice(0, 27)}...`;
};

const normalizeOauthProvider = (value) => {
  const raw = (value || "").toString().trim().toLowerCase();
  if (raw === "google") return "google";
  if (raw === "discord") return "discord";
  return "";
};

const normalizeOauthIdentifier = (value, maxLength) => {
  const raw = (value || "").toString().trim();
  if (!raw) return "";
  const max = Math.max(1, Math.floor(Number(maxLength) || 0));
  if (!max) return "";
  return raw.length <= max ? raw : raw.slice(0, max);
};

const normalizeOauthEmail = (value) => {
  const raw = (value || "").toString().trim().toLowerCase();
  if (!raw || raw.length > 180) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return "";
  return raw;
};

const normalizeOauthDisplayName = (value) => normalizeProfileDisplayName(value || "");

const buildIdentityDataRecord = ({ provider, email, displayName, avatarUrl }) => {
  const safeProvider = normalizeOauthProvider(provider);
  const safeEmail = normalizeOauthEmail(email);
  const safeName = normalizeOauthDisplayName(displayName);
  const safeAvatarUrl = normalizeAvatarUrl(avatarUrl);
  return {
    provider: safeProvider,
    email: safeEmail,
    full_name: safeName,
    name: safeName,
    avatar_url: safeAvatarUrl,
    picture: safeAvatarUrl
  };
};

const mapAuthIdentityRowToUserIdentity = (row) => {
  if (!row || typeof row !== "object") return null;
  const provider = normalizeOauthProvider(row.provider);
  const providerUserId = normalizeOauthIdentifier(row.provider_user_id, 160);
  const email = normalizeOauthEmail(row.email || "");
  const displayName = normalizeOauthDisplayName(row.display_name || "");
  const avatarUrl = normalizeAvatarUrl(row.avatar_url || "");
  if (!provider || !providerUserId) return null;
  return {
    provider,
    provider_id: providerUserId,
    identity_data: buildIdentityDataRecord({
      provider,
      email,
      displayName,
      avatarUrl
    })
  };
};

const listAuthIdentityRowsForUser = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return [];
  return dbAll(
    "SELECT provider, provider_user_id, email, display_name, avatar_url, created_at, updated_at FROM auth_identities WHERE user_id = ? ORDER BY provider ASC, created_at ASC",
    [id]
  );
};

const buildSessionUserFromUserRow = (row, identityRows) => {
  if (!row) return null;
  const id = row.id ? String(row.id).trim() : "";
  if (!id) return null;

  const displayName = normalizeOauthDisplayName(row.display_name || "");
  const avatarUrl = normalizeAvatarUrl(row.avatar_url || "");
  const identities = Array.isArray(identityRows)
    ? identityRows.map(mapAuthIdentityRowToUserIdentity).filter(Boolean)
    : [];

  const meta = {
    display_name: displayName,
    full_name: displayName,
    name: displayName,
    avatar_url_custom: isUploadedAvatarUrl(avatarUrl) ? avatarUrl : "",
    avatar_url: avatarUrl,
    picture: avatarUrl,
    facebook_url: normalizeProfileFacebook(row.facebook_url || ""),
    discord_handle: normalizeProfileDiscord(row.discord_handle || ""),
    bio: normalizeProfileBio(row.bio || "")
  };

  const email = normalizeOauthEmail(row.email || "");
  const verifiedAt = email ? new Date().toISOString() : "";

  return {
    id,
    email,
    user_metadata: meta,
    identities,
    email_confirmed_at: verifiedAt,
    confirmed_at: verifiedAt
  };
};

const loadSessionUserById = async (userId) => {
  const id = (userId || "").toString().trim();
  if (!id) return null;
  const row = await dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
  if (!row) return null;
  const identityRows = await listAuthIdentityRowsForUser(id);
  return buildSessionUserFromUserRow(row, identityRows);
};

const setAuthSessionUser = (req, user, provider) => {
  if (!req || !req.session) return;
  const userId = user && user.id ? String(user.id).trim() : "";
  if (!userId) return;
  req.session.authUserId = userId;
  req.session.authProvider = normalizeOauthProvider(provider);
  req.session.sessionVersion = serverSessionVersion;
};

const readGoogleProfileData = (profile) => {
  const emails = profile && Array.isArray(profile.emails) ? profile.emails : [];
  const photos = profile && Array.isArray(profile.photos) ? profile.photos : [];
  const names = profile && typeof profile.name === "object" && profile.name ? profile.name : {};

  const primaryEmailItem = emails.find((item) => item && item.value) || null;
  const photoItem = photos.find((item) => item && item.value) || null;

  const email = normalizeOauthEmail(primaryEmailItem && primaryEmailItem.value ? primaryEmailItem.value : "");
  const emailVerified = Boolean(
    primaryEmailItem &&
      primaryEmailItem.verified !== false &&
      primaryEmailItem.verified !== "false" &&
      primaryEmailItem.verified !== 0
  );
  const displayName =
    normalizeOauthDisplayName(
      profile && profile.displayName ? profile.displayName : `${names.givenName || ""} ${names.familyName || ""}`
    ) || (email ? email.split("@")[0] : "Người dùng");
  const avatarUrl = normalizeAvatarUrl(photoItem && photoItem.value ? photoItem.value : "");

  return {
    provider: "google",
    providerUserId: normalizeOauthIdentifier(profile && profile.id ? profile.id : "", 160),
    email,
    emailVerified,
    displayName,
    avatarUrl
  };
};

const extractDiscordProfileData = (profile, accessToken) => {
  const rawProfile = profile && typeof profile._raw === "string" ? profile._raw : "";
  let payload = null;
  if (rawProfile) {
    try {
      payload = JSON.parse(rawProfile);
    } catch (_err) {
      payload = null;
    }
  }

  const emails = profile && Array.isArray(profile.emails) ? profile.emails : [];
  const photos = profile && Array.isArray(profile.photos) ? profile.photos : [];
  const primaryEmailItem = emails.find((item) => item && item.value) || null;
  const photoItem = photos.find((item) => item && item.value) || null;
  const email = normalizeOauthEmail(
    (primaryEmailItem && primaryEmailItem.value) ||
      (payload && payload.email ? payload.email : "")
  );
  const emailVerified = Boolean(payload && payload.verified);
  const displayName =
    normalizeOauthDisplayName(
      (payload && (payload.global_name || payload.username)) ||
        (profile && profile.displayName ? profile.displayName : "")
    ) || (email ? email.split("@")[0] : "Người dùng");
  const avatarUrl = normalizeAvatarUrl(
    (photoItem && photoItem.value) || (payload && payload.avatar ? payload.avatar : "")
  );

  return {
    provider: "discord",
    providerUserId: normalizeOauthIdentifier(profile && profile.id ? profile.id : "", 160),
    email,
    emailVerified,
    displayName,
    avatarUrl,
    accessToken: normalizeOauthIdentifier(accessToken || "", 2000)
  };
};

const readUserProfileExtrasFromAuthUser = (user, currentRow) => {
  const meta = user && typeof user.user_metadata === "object" && user.user_metadata ? user.user_metadata : {};
  const row = currentRow && typeof currentRow === "object" ? currentRow : {};

  const getValueFromMeta = (keys) => {
    for (const key of keys) {
      if (hasOwnObjectKey(meta, key)) {
        return { hasValue: true, value: meta[key] };
      }
    }
    return { hasValue: false, value: null };
  };

  const facebookFromMeta = getValueFromMeta(["facebook_url", "facebook", "facebookUrl", "facebook_link"]);
  const discordFromMeta = getValueFromMeta([
    "discord_handle",
    "discord_url",
    "discord",
    "discordHandle",
    "discordUrl"
  ]);
  const bioFromMeta = getValueFromMeta(["bio", "about", "about_me"]);

  return {
    facebookUrl: facebookFromMeta.hasValue
      ? normalizeProfileFacebook(facebookFromMeta.value)
      : normalizeProfileFacebook(row.facebook_url),
    discordHandle: discordFromMeta.hasValue
      ? normalizeProfileDiscord(discordFromMeta.value)
      : normalizeProfileDiscord(row.discord_handle),
    bio: bioFromMeta.hasValue ? normalizeProfileBio(bioFromMeta.value) : normalizeProfileBio(row.bio)
  };
};

const requireAuthUserForComments = async (req, res) => {
  if (isServerSessionVersionMismatch(req)) {
    clearAllAuthSessionState(req);
    const message = "Phiên đăng nhập đã hết hiệu lực sau khi máy chủ khởi động lại. Vui lòng đăng nhập lại.";
    if (wantsJson(req)) {
      res.status(401).json({ error: message, code: "server_restart_reauth" });
      return null;
    }
    res.status(401).send(message);
    return null;
  }

  const authUserId =
    (req && req.session && req.session.authUserId ? req.session.authUserId : "").toString().trim();
  if (!authUserId) {
    const message = "Vui lòng đăng nhập bằng Google hoặc Discord.";
    if (wantsJson(req)) {
      res.status(401).json({ error: message });
      return null;
    }
    res.status(401).send(message);
    return null;
  }

  const user = await loadSessionUserById(authUserId);

  if (!user || !user.id) {
    clearUserAuthSession(req);
    const message = "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.";
    if (wantsJson(req)) {
      res.status(401).json({ error: message });
      return null;
    }
    res.status(401).send(message);
    return null;
  }

  try {
    const userRow = await ensureUserRowFromAuthUser(user);
    const canonicalUserId = userRow && userRow.id ? String(userRow.id).trim() : "";
    if (canonicalUserId) {
      user.id = canonicalUserId;
      if (req && req.session) {
        req.session.authUserId = canonicalUserId;
      }
    }
    user.bfangAvatarUrl = userRow && userRow.avatar_url ? String(userRow.avatar_url).trim() : "";
    if (req && req.session) {
      req.session.sessionVersion = serverSessionVersion;
    }
  } catch (err) {
    console.warn("Failed to ensure local user row from auth user", err);
    const message = "Không thể đồng bộ tài khoản. Vui lòng thử lại.";
    if (wantsJson(req)) {
      res.status(503).json({ error: message });
      return null;
    }
    res.status(503).send(message);
    return null;
  }

  return user;
};

const normalizeUsernameBase = (value) => {
  const raw = (value || "").toString().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "");
  const trimmed = cleaned.slice(0, 24);
  return trimmed || "user";
};

const buildUsernameCandidate = (base, suffix) => {
  const rawBase = (base || "").toString().trim();
  const safeBase = normalizeUsernameBase(rawBase);
  const suffixText = suffix == null ? "" : String(suffix);
  const max = 24;
  const head = safeBase.slice(0, Math.max(1, max - suffixText.length));
  const candidate = `${head}${suffixText}`;
  return normalizeUsernameBase(candidate);
};

const isAuthUserEmailVerified = (user) => {
  const email = user && user.email ? String(user.email).trim() : "";
  if (!email) return false;
  const emailConfirmedAt = user && user.email_confirmed_at ? String(user.email_confirmed_at).trim() : "";
  const confirmedAt = user && user.confirmed_at ? String(user.confirmed_at).trim() : "";
  return Boolean(emailConfirmedAt || confirmedAt);
};

const ensureUserRowFromAuthUser = async (user) => {
  const id = user && user.id ? String(user.id).trim() : "";
  const emailText = user && user.email ? String(user.email).trim() : "";
  const email = emailText || null;
  const canLinkByEmail = Boolean(emailText) && isAuthUserEmailVerified(user);
  if (!id) {
    throw new Error("Không xác định được người dùng.");
  }

  const existing = await dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
  if (existing) {
    try {
      await ensureMemberBadgeForUser(id);
    } catch (err) {
      console.warn("Failed to ensure member badge", err);
    }
    return existing;
  }

  if (canLinkByEmail) {
    const existingByEmail = await dbGet(
      "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE lower(email) = lower(?)",
      [emailText]
    );
    if (existingByEmail) {
      try {
        await ensureMemberBadgeForUser(existingByEmail.id);
      } catch (err) {
        console.warn("Failed to ensure member badge", err);
      }
      return existingByEmail;
    }
  }

  const localPart = emailText && emailText.includes("@") ? emailText.split("@")[0] : emailText;
  const base = normalizeUsernameBase(localPart);
  const now = Date.now();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(attempt);
    const username = buildUsernameCandidate(base, suffix);
    try {
      await dbRun(
        "INSERT INTO users (id, email, username, display_name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, email, username, "", "", now, now]
      );
      break;
    } catch (err) {
      if (err && err.code === "23505") {
        const rowById = await dbGet(
          "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
          [id]
        );
        if (rowById) {
          try {
            await ensureMemberBadgeForUser(rowById.id);
          } catch (ensureErr) {
            console.warn("Failed to ensure member badge", ensureErr);
          }
          return rowById;
        }

        if (canLinkByEmail) {
          const rowByEmail = await dbGet(
            "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE lower(email) = lower(?)",
            [emailText]
          );
          if (rowByEmail) {
            try {
              await ensureMemberBadgeForUser(rowByEmail.id);
            } catch (ensureErr) {
              console.warn("Failed to ensure member badge", ensureErr);
            }
            return rowByEmail;
          }
        }

        continue;
      }
      throw err;
    }
  }

  const created = await dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
  if (!created) {
    throw new Error("Không tạo được tài khoản.");
  }
  try {
    await ensureMemberBadgeForUser(id);
  } catch (err) {
    console.warn("Failed to ensure member badge", err);
  }
  return created;
};

const upsertAuthIdentityForUser = async ({ provider, providerUserId, userId, email, displayName, avatarUrl }) => {
  const safeProvider = normalizeOauthProvider(provider);
  const safeProviderUserId = normalizeOauthIdentifier(providerUserId, 160);
  const safeUserId = (userId || "").toString().trim();
  const safeEmail = normalizeOauthEmail(email);
  const safeDisplayName = normalizeOauthDisplayName(displayName);
  const safeAvatarUrl = normalizeAvatarUrl(avatarUrl);
  if (!safeProvider || !safeProviderUserId || !safeUserId) {
    throw new Error("OAuth identity không hợp lệ.");
  }

  const now = Date.now();
  await dbRun(
    `
    INSERT INTO auth_identities (provider, provider_user_id, user_id, email, display_name, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, provider_user_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      updated_at = EXCLUDED.updated_at
  `,
    [
      safeProvider,
      safeProviderUserId,
      safeUserId,
      safeEmail || null,
      safeDisplayName,
      safeAvatarUrl,
      now,
      now
    ]
  );
};

const generateLocalUserId = () => `u_${crypto.randomUUID().replace(/-/g, "")}`;

const resolveOrCreateUserFromOauthProfile = async (oauthProfile) => {
  const provider = normalizeOauthProvider(oauthProfile && oauthProfile.provider ? oauthProfile.provider : "");
  const providerUserId = normalizeOauthIdentifier(
    oauthProfile && oauthProfile.providerUserId ? oauthProfile.providerUserId : "",
    160
  );
  const email = normalizeOauthEmail(oauthProfile && oauthProfile.email ? oauthProfile.email : "");
  const emailVerified = Boolean(oauthProfile && oauthProfile.emailVerified);
  const displayName = normalizeOauthDisplayName(
    oauthProfile && oauthProfile.displayName ? oauthProfile.displayName : ""
  );
  const avatarUrl = normalizeAvatarUrl(oauthProfile && oauthProfile.avatarUrl ? oauthProfile.avatarUrl : "");

  if (!provider || !providerUserId) {
    throw new Error("OAuth profile không hợp lệ.");
  }

  const identityRow = await dbGet(
    "SELECT user_id FROM auth_identities WHERE provider = ? AND provider_user_id = ? LIMIT 1",
    [provider, providerUserId]
  );
  const seededUserId =
    identityRow && identityRow.user_id ? String(identityRow.user_id).trim() : generateLocalUserId();

  const user = {
    id: seededUserId,
    email: email || "",
    email_confirmed_at: emailVerified && email ? new Date().toISOString() : "",
    confirmed_at: emailVerified && email ? new Date().toISOString() : "",
    user_metadata: {
      display_name: displayName,
      full_name: displayName,
      name: displayName,
      avatar_url: avatarUrl,
      picture: avatarUrl
    },
    identities: [
      {
        provider,
        provider_id: providerUserId,
        identity_data: buildIdentityDataRecord({
          provider,
          email,
          displayName,
          avatarUrl
        })
      }
    ]
  };

  const userRow = await ensureUserRowFromAuthUser(user);
  const canonicalUserId = userRow && userRow.id ? String(userRow.id).trim() : "";
  if (!canonicalUserId) {
    throw new Error("Không thể tạo tài khoản nội bộ.");
  }

  await upsertAuthIdentityForUser({
    provider,
    providerUserId,
    userId: canonicalUserId,
    email,
    displayName,
    avatarUrl
  });

  const identityRows = await listAuthIdentityRowsForUser(canonicalUserId);
  const syncedUser = {
    ...user,
    id: canonicalUserId,
    email: email || (userRow && userRow.email ? String(userRow.email).trim() : ""),
    identities: identityRows.map(mapAuthIdentityRowToUserIdentity).filter(Boolean)
  };

  const profileRow = await upsertUserProfileFromAuthUser(syncedUser);
  const sessionUser = buildSessionUserFromUserRow(profileRow || userRow, identityRows);
  return {
    userRow: profileRow || userRow,
    sessionUser,
    provider
  };
};

const upsertUserProfileFromAuthUser = async (user) => {
  const row = await ensureUserRowFromAuthUser(user);
  const id = String(row.id).trim();
  const email = user && user.email ? String(user.email).trim() : row.email || null;
  const userMeta = user && typeof user.user_metadata === "object" && user.user_metadata ? user.user_metadata : {};
  const displayNameFromAuth = normalizeProfileDisplayName(buildCommentAuthorFromAuthUser(user));
  const currentDisplayName = normalizeProfileDisplayName(row && row.display_name ? row.display_name : "");
  const displayName = currentDisplayName ||
    (hasOwnObjectKey(userMeta, "display_name") ? displayNameFromAuth : "");
  const avatarUrl = buildAvatarUrlFromAuthUser(user, row && row.avatar_url ? row.avatar_url : "");
  const extras = readUserProfileExtrasFromAuthUser(user, row);
  const now = Date.now();

  await dbRun(
    "UPDATE users SET email = ?, display_name = ?, avatar_url = ?, facebook_url = ?, discord_handle = ?, bio = ?, updated_at = ? WHERE id = ?",
    [
      email,
      displayName,
      avatarUrl,
      extras.facebookUrl,
      extras.discordHandle,
      extras.bio,
      now,
      id
    ]
  );

  return dbGet(
    "SELECT id, email, username, display_name, avatar_url, facebook_url, discord_handle, bio, badge, created_at, updated_at FROM users WHERE id = ?",
    [id]
  );
};

const mapPublicUserRow = (row) => {
  if (!row) return null;
  const createdAt = row.created_at == null ? null : row.created_at;
  const createdAtDate = createdAt == null || createdAt === "" ? null : new Date(createdAt);
  const joinedAtText =
    createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? formatDate(createdAtDate) : "";
  return {
    id: row.id,
    email: row.email || "",
    username: row.username || "",
    displayName: row.display_name || "",
    avatarUrl: normalizeAvatarUrl(row.avatar_url || ""),
    joinedAtText,
    facebookUrl: normalizeProfileFacebook(row.facebook_url),
    discordUrl: normalizeProfileDiscord(row.discord_handle),
    discordHandle: normalizeProfileDiscord(row.discord_handle),
    bio: normalizeProfileBio(row.bio)
  };
};

  return {
    badgeCodePattern,
    buildAutoBadgeCode,
    buildAvatarUrlFromAuthUser,
    buildCommentAuthorFromAuthUser,
    buildIdentityDataRecord,
    buildSessionUserFromUserRow,
    buildUsernameCandidate,
    ensureMemberBadgeForUser,
    ensureUserRowFromAuthUser,
    extractDiscordProfileData,
    generateLocalUserId,
    getMemberBadgeId,
    getUserBadgeContext,
    getUserBadges,
    hasOwnObjectKey,
    hexColorPattern,
    isAuthUserEmailVerified,
    isGoogleAvatarUrl,
    isSafeAvatarUrl,
    isUploadedAvatarUrl,
    listAuthIdentityRowsForUser,
    loadSessionUserById,
    mapAuthIdentityRowToUserIdentity,
    mapBadgeRow,
    mapPublicUserRow,
    memberBadgeCacheTtlMs,
    normalizeAuthIdentityProvider,
    normalizeAvatarUrl,
    normalizeBadgeCode,
    normalizeHexColor,
    normalizeOauthDisplayName,
    normalizeOauthEmail,
    normalizeOauthIdentifier,
    normalizeOauthProvider,
    normalizeProfileBio,
    normalizeProfileDiscord,
    normalizeProfileDisplayName,
    normalizeProfileFacebook,
    normalizeProfileSocialUrl,
    normalizeUsernameBase,
    readAuthIdentityAvatar,
    readGoogleProfileData,
    readUserProfileExtrasFromAuthUser,
    resetMemberBadgeCache,
    requireAuthUserForComments,
    resolveOrCreateUserFromOauthProfile,
    setAuthSessionUser,
    shortHexColorPattern,
    upsertAuthIdentityForUser,
    upsertUserProfileFromAuthUser,
  };
};

module.exports = createAuthUserDomain;
