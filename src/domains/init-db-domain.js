const createInitDbDomain = (deps) => {
  const {
    ONESHOT_GENRE_NAME,
    dbAll,
    dbGet,
    dbRun,
    ensureHomepageDefaults,
    migrateLegacyGenres,
    migrateMangaSlugs,
    migrateMangaStatuses,
    resetMemberBadgeCache,
    team,
  } = deps;

  const TEAM_LEADER_BADGE_COLOR = "#ef4444";
  const TEAM_MEMBER_BADGE_COLOR = "#3b82f6";
  const TEAM_LEADER_BADGE_PRIORITY_FALLBACK = 55;
  const TEAM_MEMBER_BADGE_PRIORITY_FALLBACK = 45;

  const buildTeamBadgeCode = (teamId, role) => {
    const id = Number(teamId);
    if (!Number.isFinite(id) || id <= 0) return "";
    const safeRole = (role || "").toString().trim().toLowerCase() === "leader" ? "leader" : "member";
    return `team_${Math.floor(id)}_${safeRole}`;
  };

  const resolveTeamBadgePriority = async () => {
    const row = await dbGet(
      `
        SELECT
          MAX(CASE WHEN lower(code) = 'admin' THEN priority END) as admin_priority,
          MAX(CASE WHEN lower(code) = 'mod' THEN priority END) as mod_priority,
          MAX(CASE WHEN lower(code) NOT IN ('admin', 'mod') THEN priority END) as other_priority
        FROM badges
      `
    );

    const adminPriority = row && row.admin_priority != null ? Number(row.admin_priority) : NaN;
    const modPriority = row && row.mod_priority != null ? Number(row.mod_priority) : NaN;
    const otherPriority = row && row.other_priority != null ? Number(row.other_priority) : NaN;
    const safeOtherPriority = Number.isFinite(otherPriority)
      ? Math.floor(otherPriority)
      : TEAM_MEMBER_BADGE_PRIORITY_FALLBACK;

    let leaderPriority = Number.isFinite(modPriority)
      ? Math.floor(modPriority) - 1
      : Number.isFinite(adminPriority)
        ? Math.floor(adminPriority) - 1
        : TEAM_LEADER_BADGE_PRIORITY_FALLBACK;
    if (leaderPriority <= safeOtherPriority) {
      leaderPriority = safeOtherPriority + 1;
    }
    if (Number.isFinite(modPriority) && leaderPriority > Math.floor(modPriority)) {
      leaderPriority = Math.floor(modPriority);
    }
    if (!Number.isFinite(modPriority) && Number.isFinite(adminPriority) && leaderPriority > Math.floor(adminPriority)) {
      leaderPriority = Math.floor(adminPriority);
    }

    let memberPriority = safeOtherPriority + 1;
    if (memberPriority >= leaderPriority) {
      memberPriority = Math.max(1, leaderPriority - 1);
    }

    return {
      leaderPriority: Number.isFinite(leaderPriority) ? Math.floor(leaderPriority) : TEAM_LEADER_BADGE_PRIORITY_FALLBACK,
      memberPriority: Number.isFinite(memberPriority) ? Math.floor(memberPriority) : TEAM_MEMBER_BADGE_PRIORITY_FALLBACK
    };
  };

  const upsertTeamRoleBadge = async ({ teamId, teamName, role }) => {
    const safeTeamId = Number(teamId);
    if (!Number.isFinite(safeTeamId) || safeTeamId <= 0) return 0;

    const safeRole = (role || "").toString().trim().toLowerCase() === "leader" ? "leader" : "member";
    const safeTeamName = (teamName || "").toString().trim() || "Nhóm dịch";
    const code = buildTeamBadgeCode(safeTeamId, safeRole);
    if (!code) return 0;

    const now = Date.now();
    const label = safeRole === "leader" ? `Leader ${safeTeamName}` : safeTeamName;
    const color = safeRole === "leader" ? TEAM_LEADER_BADGE_COLOR : TEAM_MEMBER_BADGE_COLOR;
    const priorities = await resolveTeamBadgePriority();
    const priority = safeRole === "leader" ? priorities.leaderPriority : priorities.memberPriority;

    const result = await dbRun(
      `
        INSERT INTO badges (
          code,
          label,
          color,
          priority,
          can_access_admin,
          can_delete_any_comment,
          can_comment,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, false, false, true, ?, ?)
        ON CONFLICT (code)
        DO UPDATE SET
          label = EXCLUDED.label,
          color = EXCLUDED.color,
          priority = EXCLUDED.priority,
          can_access_admin = false,
          can_delete_any_comment = false,
          can_comment = true,
          updated_at = EXCLUDED.updated_at
        RETURNING id
      `,
      [code, label, color, priority, now, now]
    );

    const id = result && Array.isArray(result.rows) && result.rows[0] ? Number(result.rows[0].id) : 0;
    if (Number.isFinite(id) && id > 0) {
      return Math.floor(id);
    }

    const row = await dbGet("SELECT id FROM badges WHERE lower(code) = lower(?) LIMIT 1", [code]);
    const fallbackId = row && row.id != null ? Number(row.id) : 0;
    return Number.isFinite(fallbackId) && fallbackId > 0 ? Math.floor(fallbackId) : 0;
  };

  const clearTeamBadgesForUser = async ({ teamId, userId }) => {
    const safeTeamId = Number(teamId);
    const safeUserId = (userId || "").toString().trim();
    if (!Number.isFinite(safeTeamId) || safeTeamId <= 0 || !safeUserId) return;

    const leaderCode = buildTeamBadgeCode(safeTeamId, "leader");
    const memberCode = buildTeamBadgeCode(safeTeamId, "member");
    if (!leaderCode || !memberCode) return;

    await dbRun(
      `
        DELETE FROM user_badges ub
        USING badges b
        WHERE ub.badge_id = b.id
          AND ub.user_id = ?
          AND (lower(b.code) = lower(?) OR lower(b.code) = lower(?))
      `,
      [safeUserId, leaderCode, memberCode]
    );
  };

  const syncTeamBadgeForMember = async ({ teamId, teamName, userId, role, isApproved }) => {
    const safeTeamId = Number(teamId);
    const safeUserId = (userId || "").toString().trim();
    if (!Number.isFinite(safeTeamId) || safeTeamId <= 0 || !safeUserId) return;

    await clearTeamBadgesForUser({ teamId: safeTeamId, userId: safeUserId });
    if (!isApproved) return;

    const safeRole = (role || "").toString().trim().toLowerCase() === "leader" ? "leader" : "member";
    const badgeId = await upsertTeamRoleBadge({ teamId: safeTeamId, teamName, role: safeRole });
    if (!badgeId) return;

    await dbRun(
      "INSERT INTO user_badges (user_id, badge_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      [safeUserId, badgeId, Date.now()]
    );

    const safeTeamName = (teamName || "").toString().trim() || "Member";
    const roleLabel = safeRole === "leader" ? `Leader ${safeTeamName}` : safeTeamName;
    await dbRun("UPDATE users SET badge = ? WHERE id = ?", [roleLabel, safeUserId]);
  };

const initDb = async () => {
  await dbGet("SELECT 1 as ok");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS web_sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_web_sessions_expire_at ON web_sessions(expire_at)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS manga (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      author TEXT NOT NULL,
      genres TEXT,
      status TEXT,
      description TEXT,
      cover TEXT,
      archive TEXT,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      group_name TEXT,
      other_names TEXT,
      cover_updated_at BIGINT,
      is_oneshot BOOLEAN NOT NULL DEFAULT false,
      oneshot_locked BOOLEAN NOT NULL DEFAULT false
    )
  `
  );

  // Safety migrations for older schemas.
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS group_name TEXT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS other_names TEXT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS cover_updated_at BIGINT");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS is_oneshot BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE manga ADD COLUMN IF NOT EXISTS oneshot_locked BOOLEAN NOT NULL DEFAULT false");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_manga_visible_updated ON manga (is_hidden, updated_at DESC, id DESC)");

  await dbRun(
    `
    UPDATE manga
    SET group_name = author
    WHERE (group_name IS NULL OR TRIM(group_name) = '')
      AND author IS NOT NULL
      AND TRIM(author) <> ''
  `
  );

  const coverStamp = Date.now();
  await dbRun(
    "UPDATE manga SET cover_updated_at = ? WHERE cover IS NOT NULL AND TRIM(cover) <> '' AND cover_updated_at IS NULL",
    [coverStamp]
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      number NUMERIC(10, 3) NOT NULL,
      title TEXT NOT NULL,
      pages INTEGER NOT NULL,
      date TEXT NOT NULL,
      group_name TEXT,
      pages_prefix TEXT,
      pages_ext TEXT,
      pages_updated_at BIGINT,
      is_oneshot BOOLEAN NOT NULL DEFAULT false,
      processing_state TEXT,
      processing_error TEXT,
      processing_draft_token TEXT,
      processing_pages_json TEXT,
      processing_updated_at BIGINT
    )
  `
  );

  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS group_name TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_prefix TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_ext TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS pages_updated_at BIGINT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS is_oneshot BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_state TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_error TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_draft_token TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_pages_json TEXT");
  await dbRun("ALTER TABLE chapters ADD COLUMN IF NOT EXISTS processing_updated_at BIGINT");

  await dbRun(
    `
    UPDATE manga
    SET is_oneshot = true
    WHERE COALESCE(is_oneshot, false) = false
      AND id IN (
        SELECT c.manga_id
        FROM chapters c
        GROUP BY c.manga_id
        HAVING COUNT(*) = 1
           AND SUM(CASE WHEN COALESCE(c.is_oneshot, false) THEN 1 ELSE 0 END) = 1
      )
  `
  );

  // Enforce unique chapter number per manga.
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_manga_number ON chapters (manga_id, number)"
  );

  await dbRun(
    `
    UPDATE chapters
    SET group_name = (
      SELECT COALESCE(NULLIF(TRIM(m.group_name), ''), NULLIF(TRIM(m.author), ''), ?)
      FROM manga m
      WHERE m.id = chapters.manga_id
    )
    WHERE (group_name IS NULL OR TRIM(group_name) = '')
  `,
    [team.name]
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chapter_drafts (
      token TEXT PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      pages_prefix TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_chapter_drafts_updated_at ON chapter_drafts(updated_at)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_chapter_drafts_manga_id ON chapter_drafts(manga_id)"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      chapter_number NUMERIC(10, 3),
      parent_id INTEGER,
      author TEXT NOT NULL,
      author_user_id TEXT,
      author_email TEXT,
      author_avatar_url TEXT,
      client_request_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'visible',
      like_count INTEGER NOT NULL DEFAULT 0,
      report_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `
  );

  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS report_count INTEGER NOT NULL DEFAULT 0");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_user_id TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_email TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_avatar_url TEXT");
  await dbRun("ALTER TABLE comments ADD COLUMN IF NOT EXISTS client_request_id TEXT");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_comments_manga_chapter_status_created ON comments (manga_id, chapter_number, status, created_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comments_author_user_id ON comments(author_user_id)");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_comments_author_created_at ON comments(author_user_id, created_at DESC, id DESC)"
  );
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_author_request_id ON comments(author_user_id, client_request_id) WHERE client_request_id IS NOT NULL AND author_user_id IS NOT NULL"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS forbidden_words (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      word TEXT NOT NULL,
      normalized_word TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS word TEXT");
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS normalized_word TEXT");
  await dbRun("ALTER TABLE forbidden_words ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("UPDATE forbidden_words SET word = '' WHERE word IS NULL");
  await dbRun("UPDATE forbidden_words SET normalized_word = lower(regexp_replace(trim(word), '\\s+', ' ', 'g'))");
  await dbRun("UPDATE forbidden_words SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("DELETE FROM forbidden_words WHERE TRIM(word) = ''");
  await dbRun(
    "DELETE FROM forbidden_words fw USING forbidden_words other WHERE fw.id > other.id AND fw.normalized_word = other.normalized_word"
  );
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN word SET NOT NULL");
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN normalized_word SET NOT NULL");
  await dbRun("ALTER TABLE forbidden_words ALTER COLUMN created_at SET NOT NULL");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_forbidden_words_normalized ON forbidden_words(normalized_word)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      facebook_url TEXT,
      discord_handle TEXT,
      bio TEXT,
      badge TEXT NOT NULL DEFAULT 'Member',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_url TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_handle TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS badge TEXT");
  await dbRun("UPDATE users SET badge = 'Member' WHERE badge IS NULL OR TRIM(badge) = ''");
  await dbRun("ALTER TABLE users ALTER COLUMN badge SET DEFAULT 'Member'");
  await dbRun("ALTER TABLE users ALTER COLUMN badge SET NOT NULL");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users ((lower(email)))");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS translation_teams (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      intro TEXT NOT NULL DEFAULT '',
      facebook_url TEXT,
      discord_url TEXT,
      avatar_url TEXT,
      cover_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at BIGINT,
      reject_reason TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS name TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS slug TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS intro TEXT NOT NULL DEFAULT ''");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS facebook_url TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS discord_url TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS avatar_url TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS cover_url TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS created_by_user_id TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS approved_at BIGINT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS reject_reason TEXT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE translation_teams ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("UPDATE translation_teams SET intro = '' WHERE intro IS NULL");
  await dbRun("UPDATE translation_teams SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''");
  await dbRun("UPDATE translation_teams SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("UPDATE translation_teams SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_teams_slug_lower ON translation_teams((lower(slug)))");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_translation_teams_status_created ON translation_teams(status, created_at DESC, id DESC)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS translation_team_members (
      team_id INTEGER NOT NULL REFERENCES translation_teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at BIGINT NOT NULL,
      reviewed_at BIGINT,
      reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (team_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS requested_at BIGINT");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS reviewed_at BIGINT");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS reviewed_by_user_id TEXT");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_add_manga BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_edit_manga BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_delete_manga BOOLEAN NOT NULL DEFAULT false");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_add_chapter BOOLEAN NOT NULL DEFAULT true");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_edit_chapter BOOLEAN NOT NULL DEFAULT true");
  await dbRun("ALTER TABLE translation_team_members ADD COLUMN IF NOT EXISTS can_delete_chapter BOOLEAN NOT NULL DEFAULT true");
  await dbRun("UPDATE translation_team_members SET role = 'member' WHERE role IS NULL OR TRIM(role) = ''");
  await dbRun("UPDATE translation_team_members SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''");
  await dbRun("UPDATE translation_team_members SET requested_at = ? WHERE requested_at IS NULL", [Date.now()]);
  await dbRun("UPDATE translation_team_members SET can_add_manga = false WHERE can_add_manga IS NULL");
  await dbRun("UPDATE translation_team_members SET can_edit_manga = false WHERE can_edit_manga IS NULL");
  await dbRun("UPDATE translation_team_members SET can_delete_manga = false WHERE can_delete_manga IS NULL");
  await dbRun("UPDATE translation_team_members SET can_add_chapter = true WHERE can_add_chapter IS NULL");
  await dbRun("UPDATE translation_team_members SET can_edit_chapter = true WHERE can_edit_chapter IS NULL");
  await dbRun("UPDATE translation_team_members SET can_delete_chapter = true WHERE can_delete_chapter IS NULL");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_translation_team_members_user_status ON translation_team_members(user_id, status)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_translation_team_members_team_status ON translation_team_members(team_id, status)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_message_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS last_message_at BIGINT");
  await dbRun("UPDATE chat_threads SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("UPDATE chat_threads SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
  await dbRun("UPDATE chat_threads SET last_message_at = COALESCE(last_message_at, updated_at, created_at, ?)", [Date.now()]);
  await dbRun("CREATE INDEX IF NOT EXISTS idx_chat_threads_last_message ON chat_threads(last_message_at DESC, id DESC)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chat_thread_members (
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL,
      last_read_message_id INTEGER,
      PRIMARY KEY (thread_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS joined_at BIGINT");
  await dbRun("ALTER TABLE chat_thread_members ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER");
  await dbRun("UPDATE chat_thread_members SET joined_at = ? WHERE joined_at IS NULL", [Date.now()]);
  await dbRun("CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      client_request_id TEXT,
      created_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS client_request_id TEXT");
  await dbRun("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("UPDATE chat_messages SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created ON chat_messages(thread_id, id DESC)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_created ON chat_messages(sender_user_id, created_at DESC)");
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_sender_request_id ON chat_messages(sender_user_id, client_request_id) WHERE client_request_id IS NOT NULL"
  );
  await dbRun(
    `
      DELETE FROM chat_messages m
      WHERE m.id IN (
        SELECT id
        FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id DESC) as rn
          FROM chat_messages
        ) ranked
        WHERE ranked.rn > 200
      )
    `
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS auth_identities (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (provider, provider_user_id)
    )
  `
  );
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS provider TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS provider_user_id TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS user_id TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS email TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS display_name TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS avatar_url TEXT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE auth_identities ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun(
    "UPDATE auth_identities SET provider = lower(trim(provider)) WHERE provider IS NOT NULL"
  );
  await dbRun("UPDATE auth_identities SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("UPDATE auth_identities SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
  await dbRun(
    "DELETE FROM auth_identities WHERE provider IS NULL OR TRIM(provider) = '' OR provider_user_id IS NULL OR TRIM(provider_user_id) = '' OR user_id IS NULL OR TRIM(user_id) = ''"
  );
  await dbRun("ALTER TABLE auth_identities ALTER COLUMN provider SET NOT NULL");
  await dbRun("ALTER TABLE auth_identities ALTER COLUMN provider_user_id SET NOT NULL");
  await dbRun("ALTER TABLE auth_identities ALTER COLUMN user_id SET NOT NULL");
  await dbRun("ALTER TABLE auth_identities ALTER COLUMN created_at SET NOT NULL");
  await dbRun("ALTER TABLE auth_identities ALTER COLUMN updated_at SET NOT NULL");
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_subject ON auth_identities(provider, provider_user_id)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS reading_history (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      chapter_number NUMERIC(10, 3) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, manga_id)
    )
  `
  );
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS user_id TEXT");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS manga_id INTEGER");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS chapter_number NUMERIC(10, 3)");
  await dbRun("ALTER TABLE reading_history ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("DELETE FROM reading_history WHERE user_id IS NULL OR TRIM(user_id) = ''");
  await dbRun("DELETE FROM reading_history WHERE manga_id IS NULL");
  await dbRun("DELETE FROM reading_history WHERE chapter_number IS NULL");
  await dbRun("UPDATE reading_history SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
  await dbRun("ALTER TABLE reading_history ALTER COLUMN user_id SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN manga_id SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN chapter_number SET NOT NULL");
  await dbRun("ALTER TABLE reading_history ALTER COLUMN updated_at SET NOT NULL");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_reading_history_user_updated ON reading_history(user_id, updated_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_reading_history_manga_id ON reading_history(manga_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comment_likes (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE comment_likes ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_likes_user_id ON comment_likes(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS comment_reports (
      comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    )
  `
  );
  await dbRun("ALTER TABLE comment_reports ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_reports_user_id ON comment_reports(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_comment_reports_comment_id ON comment_reports(comment_id)");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_user_id TEXT,
      manga_id INTEGER REFERENCES manga(id) ON DELETE CASCADE,
      team_id INTEGER,
      chapter_number NUMERIC(10, 3),
      comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
      content_preview TEXT,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at BIGINT NOT NULL,
      read_at BIGINT
    )
  `
  );
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_user_id TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS manga_id INTEGER");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS chapter_number NUMERIC(10, 3)");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id INTEGER");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS team_id INTEGER");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS content_preview TEXT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at BIGINT");
  await dbRun("DELETE FROM notifications WHERE user_id IS NULL OR TRIM(user_id) = ''");
  await dbRun("UPDATE notifications SET type = 'mention' WHERE type IS NULL OR TRIM(type) = ''");
  await dbRun("UPDATE notifications SET is_read = false WHERE is_read IS NULL");
  await dbRun("UPDATE notifications SET created_at = ? WHERE created_at IS NULL", [Date.now()]);
  await dbRun("ALTER TABLE notifications ALTER COLUMN user_id SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN type SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN created_at SET NOT NULL");
  await dbRun("ALTER TABLE notifications ALTER COLUMN is_read SET DEFAULT false");
  await dbRun("ALTER TABLE notifications ALTER COLUMN is_read SET NOT NULL");
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC)"
  );
  await dbRun("CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)");
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_comment_type ON notifications(user_id, comment_id, type)"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS badges (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      color TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      can_access_admin BOOLEAN NOT NULL DEFAULT false,
      can_delete_any_comment BOOLEAN NOT NULL DEFAULT false,
      can_comment BOOLEAN NOT NULL DEFAULT true,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `
  );
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS code TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS label TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS color TEXT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS priority INTEGER");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_access_admin BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_delete_any_comment BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS can_comment BOOLEAN");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("ALTER TABLE badges ADD COLUMN IF NOT EXISTS updated_at BIGINT");
  await dbRun("UPDATE badges SET priority = 0 WHERE priority IS NULL");
  await dbRun("UPDATE badges SET can_access_admin = false WHERE can_access_admin IS NULL");
  await dbRun("UPDATE badges SET can_delete_any_comment = false WHERE can_delete_any_comment IS NULL");
  await dbRun("UPDATE badges SET can_comment = true WHERE can_comment IS NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN priority SET DEFAULT 0");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_access_admin SET DEFAULT false");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_delete_any_comment SET DEFAULT false");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_comment SET DEFAULT true");
  await dbRun("ALTER TABLE badges ALTER COLUMN priority SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_access_admin SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_delete_any_comment SET NOT NULL");
  await dbRun("ALTER TABLE badges ALTER COLUMN can_comment SET NOT NULL");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_badges_code_lower ON badges ((lower(code)))");

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, badge_id)
    )
  `
  );
  await dbRun("ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS created_at BIGINT");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_user_badges_user_id ON user_badges(user_id)");
  await dbRun("CREATE INDEX IF NOT EXISTS idx_user_badges_badge_id ON user_badges(badge_id)");

  const badgeCountRow = await dbGet("SELECT COUNT(*) as count FROM badges");
  if (!badgeCountRow || Number(badgeCountRow.count) === 0) {
    const now = Date.now();
    const defaults = [
      {
        code: "admin",
        label: "Admin",
        color: "#ff6b6b",
        priority: 500,
        canAccessAdmin: true,
        canDeleteAnyComment: true,
        canComment: true
      },
      {
        code: "mod",
        label: "Mod",
        color: "#33d17a",
        priority: 400,
        canAccessAdmin: false,
        canDeleteAnyComment: true,
        canComment: true
      },
      {
        code: "translator",
        label: "Translator",
        color: "#5aa7ff",
        priority: 300,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "editor",
        label: "Editor",
        color: "#d79a4a",
        priority: 200,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "vip",
        label: "VIP",
        color: "#f7d154",
        priority: 150,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "member",
        label: "Member",
        color: "#f8f8f2",
        priority: 100,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: true
      },
      {
        code: "banned",
        label: "Banned",
        color: "#8f95a3",
        priority: 10,
        canAccessAdmin: false,
        canDeleteAnyComment: false,
        canComment: false
      }
    ];

    for (const badge of defaults) {
      await dbRun(
        "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          badge.code,
          badge.label,
          badge.color,
          badge.priority,
          Boolean(badge.canAccessAdmin),
          Boolean(badge.canDeleteAnyComment),
          badge.canComment !== false,
          now,
          now
        ]
      );
    }
  }

  const ensuredMemberBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  if (!ensuredMemberBadgeRow) {
    const now = Date.now();
    await dbRun(
      "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["member", "Member", "#f8f8f2", 100, false, false, true, now, now]
    );
    resetMemberBadgeCache();
  }

  const ensuredBannedBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'banned' LIMIT 1");
  if (!ensuredBannedBadgeRow) {
    const now = Date.now();
    await dbRun(
      "INSERT INTO badges (code, label, color, priority, can_access_admin, can_delete_any_comment, can_comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["banned", "Banned", "#8f95a3", 10, false, false, false, now, now]
    );
  } else {
    await dbRun("UPDATE badges SET can_comment = false WHERE lower(code) = 'banned' AND can_comment <> false");
  }

  // Migrate legacy single-badge users.badge -> user_badges (best-effort).
  const badgeMigrationNow = Date.now();
  await dbRun(
    `
    INSERT INTO user_badges (user_id, badge_id, created_at)
    SELECT u.id, b.id, ?
    FROM users u
    JOIN badges b ON lower(b.label) = lower(u.badge)
    WHERE u.badge IS NOT NULL AND TRIM(u.badge) <> ''
      AND b.code !~* '^team_[0-9]+_(leader|member)$'
    ON CONFLICT DO NOTHING
  `,
    [badgeMigrationNow]
  );

  // Ensure every user has at least Member.
  const memberBadgeRow = await dbGet("SELECT id FROM badges WHERE lower(code) = 'member' LIMIT 1");
  if (memberBadgeRow && memberBadgeRow.id) {
    await dbRun(
      `
      INSERT INTO user_badges (user_id, badge_id, created_at)
      SELECT u.id, ?, ?
      FROM users u
      WHERE u.id IS NOT NULL AND TRIM(u.id) <> ''
      ON CONFLICT DO NOTHING
    `,
      [memberBadgeRow.id, Date.now()]
    );
  }

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS homepage (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      notice_title_1 TEXT,
      notice_body_1 TEXT,
      notice_title_2 TEXT,
      notice_body_2 TEXT,
      featured_ids TEXT,
      updated_at TEXT NOT NULL
    )
  `
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS genres (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL
    )
  `
  );
  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_genres_name_lower ON genres ((lower(name)))"
  );

  await dbRun(
    `
    CREATE TABLE IF NOT EXISTS manga_genres (
      manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,
      genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
      PRIMARY KEY (manga_id, genre_id)
    )
  `
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_manga_genres_genre_id ON manga_genres(genre_id)"
  );
  await dbRun(
    "CREATE INDEX IF NOT EXISTS idx_manga_genres_manga_id ON manga_genres(manga_id)"
  );

  const oneshotGenreRow = await dbGet(
    "SELECT id FROM genres WHERE lower(name) = lower(?) LIMIT 1",
    [ONESHOT_GENRE_NAME]
  );
  const oneshotGenreId = oneshotGenreRow && oneshotGenreRow.id ? Number(oneshotGenreRow.id) : 0;
  if (Number.isFinite(oneshotGenreId) && oneshotGenreId > 0) {
    await dbRun(
      `
      INSERT INTO manga_genres (manga_id, genre_id)
      SELECT id, ?
      FROM manga
      WHERE COALESCE(is_oneshot, false) = true
      ON CONFLICT DO NOTHING
    `,
      [oneshotGenreId]
    );
  }
  await migrateLegacyGenres();
  await ensureHomepageDefaults();
  await migrateMangaStatuses();
  await migrateMangaSlugs();

  const defaultTeamLeader = await dbGet(
    "SELECT id FROM users WHERE lower(username) = lower(?) LIMIT 1",
    ["phanthehien150196"]
  );
  const leaderUserId = defaultTeamLeader && defaultTeamLeader.id ? String(defaultTeamLeader.id).trim() : "";
  if (leaderUserId) {
    const teamName = "BFANG team";
    const teamSlug = "bfang-team";
    const now = Date.now();
    let createdTeam = false;
    const existingTeam = await dbGet(
      "SELECT id FROM translation_teams WHERE lower(slug) = lower(?) LIMIT 1",
      [teamSlug]
    );

    let teamId = existingTeam && existingTeam.id ? Number(existingTeam.id) : 0;
    if (!teamId) {
      const inserted = await dbRun(
        `
          INSERT INTO translation_teams (
            name,
            slug,
            intro,
            facebook_url,
            discord_url,
            status,
            created_by_user_id,
            approved_by_user_id,
            approved_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
        `,
        [teamName, teamSlug, "Nhóm dịch chính thức của BFANG.", "", "", leaderUserId, leaderUserId, now, now, now]
      );
      teamId = inserted && inserted.lastID ? Number(inserted.lastID) : 0;
      createdTeam = Boolean(teamId);
    } else {
      await dbRun(
        `
          UPDATE translation_teams
          SET name = ?, status = 'approved', approved_by_user_id = COALESCE(approved_by_user_id, ?), approved_at = COALESCE(approved_at, ?), updated_at = ?
          WHERE id = ?
        `,
        [teamName, leaderUserId, now, now, teamId]
      );
    }

    if (teamId) {
      if (createdTeam) {
        await dbRun(
          `
            INSERT INTO translation_team_members (team_id, user_id, role, status, requested_at, reviewed_at, reviewed_by_user_id)
            VALUES (?, ?, 'leader', 'approved', ?, ?, ?)
            ON CONFLICT (team_id, user_id)
            DO UPDATE SET
              role = 'leader',
              status = 'approved',
              reviewed_at = EXCLUDED.reviewed_at,
              reviewed_by_user_id = EXCLUDED.reviewed_by_user_id
          `,
          [teamId, leaderUserId, now, now, leaderUserId]
        );
      } else {
        await dbRun(
          `
            INSERT INTO translation_team_members (team_id, user_id, role, status, requested_at, reviewed_at, reviewed_by_user_id)
            VALUES (?, ?, 'member', 'approved', ?, ?, ?)
            ON CONFLICT (team_id, user_id)
            DO NOTHING
          `,
          [teamId, leaderUserId, now, now, leaderUserId]
        );

        const otherApprovedLeader = await dbGet(
          `
            SELECT user_id
            FROM translation_team_members
            WHERE team_id = ?
              AND role = 'leader'
              AND status = 'approved'
              AND user_id <> ?
            LIMIT 1
          `,
          [teamId, leaderUserId]
        );

        if (otherApprovedLeader && otherApprovedLeader.user_id) {
          await dbRun(
            `
              UPDATE translation_team_members
              SET role = 'member', reviewed_at = ?, reviewed_by_user_id = ?
              WHERE team_id = ?
                AND user_id = ?
                AND role = 'leader'
            `,
            [now, leaderUserId, teamId, leaderUserId]
          );
        }
      }

    }
  }

  await dbRun(
    `
      WITH ranked AS (
        SELECT
          team_id,
          user_id,
          ROW_NUMBER() OVER (
            PARTITION BY team_id
            ORDER BY COALESCE(reviewed_at, requested_at, 0) DESC, requested_at DESC, user_id ASC
          ) AS rn
        FROM translation_team_members
        WHERE role = 'leader'
          AND status = 'approved'
      )
      UPDATE translation_team_members tm
      SET role = 'member'
      FROM ranked r
      WHERE tm.team_id = r.team_id
        AND tm.user_id = r.user_id
        AND r.rn > 1
    `
  );

  await dbRun(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_team_single_approved_leader ON translation_team_members(team_id) WHERE role = 'leader' AND status = 'approved'"
  );

  await dbRun(
    `
      DELETE FROM user_badges ub
      USING badges b
      WHERE ub.badge_id = b.id
        AND b.code ~* '^team_[0-9]+_(leader|member)$'
    `
  );

  const membershipRows = await dbAll(
    `
      SELECT
        tm.team_id,
        tm.user_id,
        tm.role,
        tm.status as member_status,
        t.name as team_name,
        t.status as team_status
      FROM translation_team_members tm
      JOIN translation_teams t ON t.id = tm.team_id
      WHERE tm.user_id IS NOT NULL
        AND TRIM(tm.user_id) <> ''
    `
  );

  for (const row of membershipRows) {
    const teamId = row && row.team_id != null ? Number(row.team_id) : 0;
    const userId = row && row.user_id ? String(row.user_id).trim() : "";
    if (!Number.isFinite(teamId) || teamId <= 0 || !userId) continue;

    const teamStatus = (row && row.team_status ? String(row.team_status) : "").trim().toLowerCase();
    const memberStatus = (row && row.member_status ? String(row.member_status) : "").trim().toLowerCase();
    const isApproved = teamStatus === "approved" && memberStatus === "approved";
    await syncTeamBadgeForMember({
      teamId: Math.floor(teamId),
      teamName: row && row.team_name ? row.team_name : "",
      userId,
      role: row && row.role ? row.role : "member",
      isApproved
    });
  }
};

  return {
    initDb,
  };
};

module.exports = createInitDbDomain;
