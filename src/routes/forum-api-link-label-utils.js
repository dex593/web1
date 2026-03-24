const createForumApiLinkLabelUtils = ({
  buildPostTitle,
  buildSqlPlaceholders,
  dbAll,
  toText,
}) => {
  const readText =
    typeof toText === "function"
      ? (value) => toText(value)
      : (value) => (value == null ? "" : String(value)).trim();

  const mangaSlugPattern = /^[a-z0-9][a-z0-9_-]{0,199}$/;
  const forumPostIdPattern = /^[1-9][0-9]{0,11}$/;

  const normalizeChapterNumberLabel = (value) => {
    const raw = readText(value).replace(/,/g, ".");
    if (!raw) return "";

    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) {
      return raw;
    }

    const rounded = Math.round(numeric * 1000) / 1000;
    if (Number.isInteger(rounded)) {
      return String(rounded);
    }
    return rounded.toString();
  };

  const normalizeLinkLabelUrls = (rawUrls) =>
    Array.from(
      new Set(
        (Array.isArray(rawUrls) ? rawUrls : [])
          .map((value) => readText(value))
          .filter(Boolean)
      )
    ).slice(0, 80);

  const parseForumLinkCandidates = ({ decodePathSegment, parseInternalPathFromUrl, req, urls }) => {
    const safeUrls = Array.isArray(urls) ? urls : [];
    const parsedLinks = [];

    safeUrls.forEach((url) => {
      const path = parseInternalPathFromUrl(url, req);
      if (!path) return;

      let match = null;

      match = path.match(/^\/manga\/([^/]+)\/chapters\/([^/]+)$/i);
      if (match) {
        const mangaSlug = decodePathSegment(match[1]).toLowerCase();
        const chapterNumberText = normalizeChapterNumberLabel(decodePathSegment(match[2]));
        if (!mangaSlugPattern.test(mangaSlug) || !chapterNumberText) return;
        parsedLinks.push({ kind: "chapter", url, mangaSlug, chapterNumberText });
        return;
      }

      match = path.match(/^\/manga\/([^/]+)$/i);
      if (match) {
        const mangaSlug = decodePathSegment(match[1]).toLowerCase();
        if (!mangaSlugPattern.test(mangaSlug)) return;
        parsedLinks.push({ kind: "manga", url, mangaSlug });
        return;
      }

      match = path.match(/^\/user\/([^/]+)$/i);
      if (match) {
        const username = decodePathSegment(match[1]).toLowerCase();
        if (!username) return;
        parsedLinks.push({ kind: "user", url, username });
        return;
      }

      match = path.match(/^\/comments\/users\/([^/]+)$/i);
      if (match) {
        const userId = decodePathSegment(match[1]);
        if (!userId) return;
        parsedLinks.push({ kind: "user-id", url, userId });
        return;
      }

      match = path.match(/^\/(?:forum\/)?posts?\/([1-9][0-9]{0,11})(?:-[^/?#]+)?$/i);
      if (match) {
        const safePostId = readText(match[1]);
        if (!forumPostIdPattern.test(safePostId)) return;
        parsedLinks.push({ kind: "forum-post", url, postId: Math.floor(Number(safePostId)) });
        return;
      }

      match = path.match(/^\/team\/(\d+)\/([^/]+)$/i);
      if (match) {
        const teamId = Number(match[1]);
        const teamSlug = decodePathSegment(match[2]).toLowerCase();
        const safeTeamId = Number.isFinite(teamId) && teamId > 0 ? Math.floor(teamId) : 0;
        if (!safeTeamId && !teamSlug) return;
        parsedLinks.push({ kind: "team", url, teamId: safeTeamId, teamSlug });
      }
    });

    return parsedLinks;
  };

  const resolveParsedForumLinkLabels = async ({ parsedLinks, forumRequestIdLike }) => {
    const links = Array.isArray(parsedLinks) ? parsedLinks : [];
    if (!links.length) return [];

    const mangaSlugSet = new Set();
    const usernameSet = new Set();
    const userIdSet = new Set();
    const postIdSet = new Set();
    const teamIdSet = new Set();
    const teamSlugSet = new Set();

    links.forEach((item) => {
      if (!item || typeof item !== "object") return;
      if (item.kind === "manga" || item.kind === "chapter") {
        const mangaSlug = readText(item.mangaSlug).toLowerCase();
        if (mangaSlug) mangaSlugSet.add(mangaSlug);
        return;
      }
      if (item.kind === "user") {
        const username = readText(item.username).toLowerCase();
        if (username) usernameSet.add(username);
        return;
      }
      if (item.kind === "user-id") {
        const userId = readText(item.userId);
        if (userId) userIdSet.add(userId);
        return;
      }
      if (item.kind === "forum-post") {
        const postId = Number(item.postId);
        if (Number.isFinite(postId) && postId > 0) {
          postIdSet.add(Math.floor(postId));
        }
        return;
      }
      if (item.kind === "team") {
        const teamId = Number(item.teamId);
        const teamSlug = readText(item.teamSlug).toLowerCase();
        if (Number.isFinite(teamId) && teamId > 0) {
          teamIdSet.add(Math.floor(teamId));
        }
        if (teamSlug) {
          teamSlugSet.add(teamSlug);
        }
      }
    });

    const usernameLabelByUsername = new Map();
    const usernameLabelByUserId = new Map();
    const postTitleById = new Map();
    const teamNameById = new Map();
    const teamNameBySlug = new Map();
    const mangaTitleBySlug = new Map();

    if (mangaSlugSet.size) {
      const mangaSlugs = Array.from(mangaSlugSet);
      const placeholders = buildSqlPlaceholders(mangaSlugs.length);
      const rows = await dbAll(
        `
          SELECT slug, title
          FROM manga
          WHERE COALESCE(is_hidden, 0) = 0
            AND LOWER(slug) IN (${placeholders})
        `,
        mangaSlugs
      );

      rows.forEach((row) => {
        const mangaSlug = readText(row && row.slug).toLowerCase();
        const title = readText(row && row.title).replace(/\s+/g, " ").trim();
        if (!mangaSlug || !title) return;
        mangaTitleBySlug.set(mangaSlug, title);
      });
    }

    if (usernameSet.size) {
      const usernames = Array.from(usernameSet);
      const placeholders = buildSqlPlaceholders(usernames.length);
      const rows = await dbAll(
        `
          SELECT username, display_name
          FROM users
          WHERE LOWER(username) IN (${placeholders})
        `,
        usernames
      );
      rows.forEach((row) => {
        const username = readText(row && row.username).toLowerCase();
        if (!username) return;
        const label = readText(row && row.display_name) || readText(row && row.username);
        if (!label) return;
        usernameLabelByUsername.set(username, label);
      });
    }

    if (userIdSet.size) {
      const userIds = Array.from(userIdSet);
      const placeholders = buildSqlPlaceholders(userIds.length);
      const rows = await dbAll(
        `
          SELECT id, username, display_name
          FROM users
          WHERE id IN (${placeholders})
        `,
        userIds
      );
      rows.forEach((row) => {
        const userId = readText(row && row.id);
        if (!userId) return;
        const label = readText(row && row.display_name) || readText(row && row.username);
        if (!label) return;
        usernameLabelByUserId.set(userId, label);
      });
    }

    if (postIdSet.size) {
      const ids = Array.from(postIdSet);
      const placeholders = buildSqlPlaceholders(ids.length);
      const rows = await dbAll(
        `
          SELECT
            c.id,
            c.content
          FROM comments c
          WHERE c.id IN (${placeholders})
            AND c.parent_id IS NULL
            AND c.status = 'visible'
        `,
        ids
      );
      rows.forEach((row) => {
        const id = Number(row && row.id);
        if (!Number.isFinite(id) || id <= 0) return;
        const title = buildPostTitle(row);
        if (!title) return;
        postTitleById.set(Math.floor(id), title);
      });

      if (forumRequestIdLike && postTitleById.size < ids.length) {
        const unresolvedIds = ids.filter((id) => !postTitleById.has(id));
        if (unresolvedIds.length) {
          const unresolvedPlaceholders = buildSqlPlaceholders(unresolvedIds.length);
          const fallbackRows = await dbAll(
            `
              SELECT
                c.id,
                c.content
              FROM comments c
              WHERE c.id IN (${unresolvedPlaceholders})
                AND c.parent_id IS NULL
                AND c.status = 'visible'
                AND COALESCE(c.client_request_id, '') ILIKE ?
            `,
            [...unresolvedIds, forumRequestIdLike]
          );
          fallbackRows.forEach((row) => {
            const id = Number(row && row.id);
            if (!Number.isFinite(id) || id <= 0) return;
            const title = buildPostTitle(row);
            if (!title) return;
            postTitleById.set(Math.floor(id), title);
          });
        }
      }
    }

    if (teamIdSet.size || teamSlugSet.size) {
      const teamIds = Array.from(teamIdSet);
      const teamSlugs = Array.from(teamSlugSet);
      const idPlaceholders = buildSqlPlaceholders(teamIds.length);
      const slugPlaceholders = buildSqlPlaceholders(teamSlugs.length);

      const whereParts = [];
      const whereParams = [];
      if (teamIds.length) {
        whereParts.push(`id IN (${idPlaceholders})`);
        whereParams.push(...teamIds);
      }
      if (teamSlugs.length) {
        whereParts.push(`LOWER(slug) IN (${slugPlaceholders})`);
        whereParams.push(...teamSlugs);
      }

      if (whereParts.length) {
        const rows = await dbAll(
          `
            SELECT id, slug, name
            FROM translation_teams
            WHERE ${whereParts.join(" OR ")}
          `,
          whereParams
        );
        rows.forEach((row) => {
          const id = Number(row && row.id);
          const slug = readText(row && row.slug).toLowerCase();
          const name = readText(row && row.name);
          if (!name) return;
          if (Number.isFinite(id) && id > 0) {
            teamNameById.set(Math.floor(id), name);
          }
          if (slug) {
            teamNameBySlug.set(slug, name);
          }
        });
      }
    }

    const labels = [];
    links.forEach((item) => {
      let label = "";

      if (item.kind === "manga") {
        label = readText(mangaTitleBySlug.get(item.mangaSlug));
      } else if (item.kind === "chapter") {
        const title = readText(mangaTitleBySlug.get(item.mangaSlug));
        if (title && item.chapterNumberText) {
          label = `${title} - Ch. ${item.chapterNumberText}`;
        }
      } else if (item.kind === "user") {
        label = readText(usernameLabelByUsername.get(item.username));
      } else if (item.kind === "user-id") {
        label = readText(usernameLabelByUserId.get(item.userId));
      } else if (item.kind === "forum-post") {
        label = readText(postTitleById.get(item.postId));
      } else if (item.kind === "team") {
        label =
          readText(item.teamId ? teamNameById.get(item.teamId) : "") ||
          readText(item.teamSlug ? teamNameBySlug.get(item.teamSlug) : "");
      }

      if (!label) return;
      labels.push({
        url: item.url,
        label,
      });
    });

    return labels;
  };

  return {
    normalizeLinkLabelUrls,
    parseForumLinkCandidates,
    resolveParsedForumLinkLabels,
  };
};

module.exports = createForumApiLinkLabelUtils;
