const mentionUsernamePattern = /^[a-z0-9_]{1,24}$/;

const escapeRegex = (value: string): string => {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const hasMentionInContent = (content: string, username: string): boolean => {
  if (!content || !username) return false;
  const escapedUsername = escapeRegex(username);
  const regex = new RegExp(`(^|[^a-z0-9_])@${escapedUsername}(?=$|[^a-z0-9_])`, "i");
  return regex.test(content);
};

export const buildForumReplyContentWithMention = (params: {
  content: string;
  username?: string;
}): string => {
  const content = String(params.content || "").trim();
  if (!content) return "";

  const username = String(params.username || "").trim().toLowerCase();
  if (!mentionUsernamePattern.test(username)) {
    return content;
  }

  if (hasMentionInContent(content, username)) {
    return content;
  }

  const mentionToken = `@${username}`;
  const hasHtmlTag = /<\/?[a-z][\s\S]*>/i.test(content);
  if (!hasHtmlTag) {
    return `${mentionToken} ${content}`.trim();
  }

  const firstParagraphMatch = content.match(/<p\b[^>]*>/i);
  if (firstParagraphMatch && firstParagraphMatch[0]) {
    const openTag = firstParagraphMatch[0];
    return content.replace(openTag, `${openTag}${mentionToken} `);
  }

  return `<p>${mentionToken}</p>${content}`;
};
