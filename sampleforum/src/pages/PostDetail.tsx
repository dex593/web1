import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { RoleBadge } from "@/components/UserInfo";
import { CommentThread } from "@/components/CommentThread";
import { CommentInput } from "@/components/CommentInput";
import { ForumRichContent } from "@/components/ForumRichContent";
import { RichTextEditor } from "@/components/RichTextEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  deleteComment,
  editComment,
  fetchAuthSession,
  fetchCommentReactions,
  fetchForumPostDetail,
  finalizeForumPostLocalImages,
  reportComment,
  setForumPostLocked,
  setForumPostPinned,
  submitForumReply,
  toggleCommentLike,
  toggleForumPostBookmark,
} from "@/lib/forum-api";
import { openAuthProviderDialog } from "@/lib/auth-login";
import { prepareForumPostContentForSubmit, type ForumLocalPostImage } from "@/lib/forum-local-post-images";
import {
  FORUM_COMMENT_MAX_LENGTH,
  FORUM_POST_MAX_LENGTH,
  FORUM_POST_TITLE_MAX_LENGTH,
} from "@/lib/forum-limits";
import { mapApiCommentToUiComment, mapApiPostToUiPost } from "@/lib/forum-presenters";
import { measureForumTextLength, normalizeForumContentHtml } from "@/lib/forum-content";
import type { AuthSessionUser, Comment as UiComment, ForumPostDetailResponse } from "@/types/forum";
import {
  MessageSquare,
  Bookmark,
  Share2,
  Flag,
  MoreHorizontal,
  ArrowLeft,
  Pin,
  Lock,
  Megaphone,
  Trash2,
  Edit3,
} from "lucide-react";

const basicCategories = [
  { id: "thao-luan-chung", name: "Thảo luận chung", icon: "💬" },
  { id: "thong-bao", name: "Thông báo", icon: "📢" },
  { id: "huong-dan", name: "Hướng dẫn", icon: "📘" },
  { id: "tim-truyen", name: "Tìm truyện", icon: "🔎" },
  { id: "gop-y", name: "Góp ý", icon: "🛠️" },
  { id: "tam-su", name: "Tâm sự", icon: "💭" },
  { id: "chia-se", name: "Chia sẻ", icon: "🤝" },
];

const FORUM_META_COMMENT_PATTERN = /<!--\s*forum-meta:([^>]*?)\s*-->/gi;
const FORUM_USERNAME_PATTERN = /^[a-z0-9_]{1,24}$/;
const ROOT_COMMENTS_PAGE_SIZE = 10;

const normalizeForumSectionSlug = (value: string): string => {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  const aliasMap: Record<string, string> = {
    "goi-y": "gop-y",
    "tin-tuc": "thong-bao",
  };
  return aliasMap[slug] || slug;
};

const buildForumMetaMarker = (sectionSlug: string): string => {
  const safeSection = normalizeForumSectionSlug(sectionSlug);
  if (!safeSection) return "";
  return `<!--forum-meta:section=${safeSection}-->`;
};

const extractForumMetaFromContent = (
  value: string
): { sectionSlug: string; contentWithoutMeta: string } => {
  let resolvedSectionSlug = "";

  const contentWithoutMeta = String(value || "").replace(
    FORUM_META_COMMENT_PATTERN,
    (_fullMatch, payloadText) => {
      const payload = String(payloadText || "").trim();
      if (!payload) return "";

      const pairs = payload
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean);
      for (const pair of pairs) {
        const equalIndex = pair.indexOf("=");
        if (equalIndex <= 0) continue;

        const key = pair.slice(0, equalIndex).trim().toLowerCase();
        const rawValue = pair.slice(equalIndex + 1).trim();
        if (!rawValue) continue;

        if (key === "section" && !resolvedSectionSlug) {
          resolvedSectionSlug = normalizeForumSectionSlug(rawValue);
        }
      }

      return "";
    }
  );

  return {
    sectionSlug: resolvedSectionSlug,
    contentWithoutMeta: contentWithoutMeta.trim(),
  };
};

const escapeHtml = (value: string): string => {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const decodeHtmlEntities = (value: string): string => {
  if (typeof window === "undefined") {
    return String(value || "");
  }

  const textarea = window.document.createElement("textarea");
  textarea.innerHTML = String(value || "");
  return textarea.value;
};

const splitPostTitleAndBody = (rawContent: string, fallbackTitle: string) => {
  const content = String(rawContent || "").trim();
  const titleFallback = String(fallbackTitle || "").trim();

  if (!content) {
    return { title: titleFallback, body: "", sectionSlug: "" };
  }

  const titleBlockMatch = content.match(/^\s*<p>\s*<strong[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i);
  if (!titleBlockMatch) {
    const extracted = extractForumMetaFromContent(content);
    return {
      title: titleFallback,
      body: extracted.contentWithoutMeta,
      sectionSlug: extracted.sectionSlug,
    };
  }

  const parsedTitle = decodeHtmlEntities(titleBlockMatch[1]).replace(/\s+/g, " ").trim();
  const body = content.slice(titleBlockMatch[0].length).trim();
  const extracted = extractForumMetaFromContent(body);
  return {
    title: parsedTitle || titleFallback,
    body: extracted.contentWithoutMeta,
    sectionSlug: extracted.sectionSlug,
  };
};

const FORUM_MANAGED_IMAGE_HINTS = [
  "/forum/posts/",
  "/forum/tmp/posts/",
  "/chapters/forum-posts/",
  "/chapters/tmp/forum-posts/",
  "forum/posts/",
  "forum/tmp/posts/",
  "chapters/forum-posts/",
  "chapters/tmp/forum-posts/",
];

const isManagedForumImageRef = (value: string): boolean => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  return FORUM_MANAGED_IMAGE_HINTS.some((hint) => raw.includes(hint));
};

const extractForumManagedImageRefs = (html: string): string[] => {
  const refs = new Set<string>();
  const source = String(html || "");
  if (!source) return [];

  const pushRef = (rawSrc: string) => {
    const src = String(rawSrc || "").trim();
    if (!src) return;
    if (!isManagedForumImageRef(src)) return;
    refs.add(src);
  };

  if (typeof DOMParser === "function") {
    try {
      const doc = new DOMParser().parseFromString(source, "text/html");
      const nodes = Array.from(doc.querySelectorAll("img[src]"));
      nodes.forEach((node) => {
        pushRef(String(node.getAttribute("src") || ""));
      });
    } catch {
      // fallback regex below
    }
  }

  if (!refs.size) {
    source.replace(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_fullMatch, srcValue) => {
      pushRef(String(srcValue || ""));
      return "";
    });
  }

  return Array.from(refs);
};

const getRemovedForumManagedImageRefs = (beforeContent: string, nextContent: string): string[] => {
  const previousRefs = extractForumManagedImageRefs(beforeContent);
  if (!previousRefs.length) return [];

  const nextRefSet = new Set(extractForumManagedImageRefs(nextContent));
  return previousRefs.filter((src) => !nextRefSet.has(src));
};

const getTimestamp = (value: string): number => {
  const parsed = new Date(String(value || "")).getTime();
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return NaN;
};

const getCommentSortValue = (comment: UiComment): number => {
  const timestamp = getTimestamp(comment && comment.createdAt ? String(comment.createdAt) : "");
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  const idValue = Number(comment && comment.id ? comment.id : 0);
  if (Number.isFinite(idValue) && idValue > 0) {
    return Math.floor(idValue);
  }

  if (comment && comment.isPending) {
    return Number.MAX_SAFE_INTEGER;
  }

  return 0;
};

const buildCommentTree = (params: {
  comments: UiComment[];
  sortMode: "best" | "new" | "old";
  rootPostId: string;
  pinnedReplyIdSet?: Set<string>;
}): UiComment[] => {
  const items = Array.isArray(params.comments)
    ? params.comments.map((item) => ({
        ...item,
        parentId: item.parentId ? String(item.parentId).trim() : "",
        replies: [],
      }))
    : [];

  if (!items.length) return [];

  const byId = new Map<string, UiComment>();
  items.forEach((item) => {
    byId.set(String(item.id), item);
  });

  const rootComments: UiComment[] = [];
  items.forEach((item) => {
    const parentId = String(item.parentId || "").trim();
    if (!parentId || parentId === params.rootPostId) {
      rootComments.push(item);
      return;
    }

    const parentItem = byId.get(parentId);
    if (parentItem) {
      parentItem.replies.push(item);
      return;
    }

    rootComments.push(item);
  });

  const sortRootComments = (a: UiComment, b: UiComment) => {
    if (params.sortMode === "best") {
      const byScore = (b.upvotes || 0) - (a.upvotes || 0);
      if (byScore !== 0) return byScore;
      return getCommentSortValue(b) - getCommentSortValue(a);
    }
    if (params.sortMode === "new") {
      return getCommentSortValue(b) - getCommentSortValue(a);
    }
    return getCommentSortValue(a) - getCommentSortValue(b);
  };

  const sortReplies = (list: UiComment[]) => {
    const pinnedSet = params.pinnedReplyIdSet instanceof Set ? params.pinnedReplyIdSet : new Set<string>();

    const pendingReplies = list
      .filter((item) => item && item.isPending)
      .sort((a, b) => getCommentSortValue(b) - getCommentSortValue(a));

    const pinnedReplies = list
      .filter((item) => !item.isPending && pinnedSet.has(String(item.id)))
      .sort((a, b) => getCommentSortValue(b) - getCommentSortValue(a));

    const persistedReplies = list
      .filter((item) => !item.isPending && !pinnedSet.has(String(item.id)))
      .sort((a, b) => getCommentSortValue(a) - getCommentSortValue(b));

    list.splice(0, list.length, ...pendingReplies, ...pinnedReplies, ...persistedReplies);

    list.forEach((item) => {
      if (item.replies.length) {
        sortReplies(item.replies);
      }
    });
  };

  rootComments.sort(sortRootComments);
  rootComments.forEach((item) => {
    if (item.replies.length) {
      sortReplies(item.replies);
    }
  });

  return rootComments;
};

const PostDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [detail, setDetail] = useState<ForumPostDetailResponse | null>(null);
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const [bookmarked, setBookmarked] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [sortComments, setSortComments] = useState<"best" | "new" | "old">("best");
  const [visibleRootCommentCount, setVisibleRootCommentCount] = useState(ROOT_COMMENTS_PAGE_SIZE);
  const [submitting, setSubmitting] = useState(false);
  const [optimisticComments, setOptimisticComments] = useState<UiComment[]>([]);
  const [tempPinnedReplyIds, setTempPinnedReplyIds] = useState<Set<string>>(new Set());
  const [forceExpandedReplyParentIds, setForceExpandedReplyParentIds] = useState<Set<string>>(new Set());
  const [forceVisibleReplyCountByParentId, setForceVisibleReplyCountByParentId] = useState<Record<string, number>>({});
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());
  const [pendingActionIds, setPendingActionIds] = useState<Set<string>>(new Set());
  const [confirmDialog, setConfirmDialog] = useState<{
    action: "delete" | "report";
    targetId: string;
    title: string;
    description: string;
    confirmText: string;
  } | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editDialogTitle, setEditDialogTitle] = useState("Chỉnh sửa bình luận");
  const [editDialogTargetId, setEditDialogTargetId] = useState("");
  const [editDialogPostTitle, setEditDialogPostTitle] = useState("");
  const [editDialogContent, setEditDialogContent] = useState("");
  const [editDialogCategory, setEditDialogCategory] = useState("");
  const [editDialogOriginalContent, setEditDialogOriginalContent] = useState("");
  const [editDialogSaving, setEditDialogSaving] = useState(false);
  const [editDialogSavePhase, setEditDialogSavePhase] = useState<"idle" | "saving" | "uploading">("idle");
  const [editDialogImageSyncProgress, setEditDialogImageSyncProgress] = useState<{
    uploaded: number;
    total: number;
  } | null>(null);
  const optimisticCommentRef = useRef<string>("");
  const hashScrollDoneRef = useRef<string>("");
  const forumBackPath = useMemo(() => {
    const source = new URLSearchParams(location.search || "");
    const next = new URLSearchParams();

    const rawSection = String(source.get("section") || "").trim();
    const normalizedSection = normalizeForumSectionSlug(rawSection);
    if (normalizedSection) {
      next.set("section", normalizedSection);
    }

    const sort = String(source.get("sort") || "").trim();
    if (sort) {
      next.set("sort", sort);
    }

    const q = String(source.get("q") || "").trim();
    if (q) {
      next.set("q", q);
    }

    const pageValue = Number(source.get("page") || "");
    if (Number.isFinite(pageValue) && pageValue > 1) {
      next.set("page", String(Math.floor(pageValue)));
    }

    const query = next.toString();
    return `/${query ? `?${query}` : ""}`;
  }, [location.search]);

  const navigateBackToForum = () => {
    navigate(forumBackPath);
  };

  const currentPostId = String(detail?.post?.id || "").trim();
  const isEditTargetPost = Boolean(currentPostId) && String(editDialogTargetId || "").trim() === currentPostId;
  const normalizedEditBody = (editDialogContent || "").toString().trim();
  const normalizedEditPostTitle = (editDialogPostTitle || "").toString().trim();
  const editDialogForumMetaMarker = isEditTargetPost ? buildForumMetaMarker(editDialogCategory) : "";
  const editDialogPostContent = normalizedEditPostTitle
    ? `<p><strong>${escapeHtml(normalizedEditPostTitle)}</strong></p>${editDialogForumMetaMarker}${
        normalizedEditBody ? normalizedEditBody : ""
      }`
    : `${editDialogForumMetaMarker}${normalizedEditBody}`;
  const editDialogContentLength = measureForumTextLength(normalizedEditBody);
  const overEditDialogLimit = isEditTargetPost
    ? editDialogContentLength > FORUM_POST_MAX_LENGTH
    : editDialogContentLength > FORUM_COMMENT_MAX_LENGTH;

  useEffect(() => {
    let cancelled = false;
    const postId = String(id || "").trim();
    setOptimisticComments([]);
    setTempPinnedReplyIds(new Set());
    setForceExpandedReplyParentIds(new Set());
    setForceVisibleReplyCountByParentId({});
    optimisticCommentRef.current = "";
    hashScrollDoneRef.current = "";

    const load = async () => {
      if (!postId) {
        setLoadError("Mã chủ đề không hợp lệ.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadError(null);
      setActionNotice(null);
      try {
        const payload = await fetchForumPostDetail(postId);
        if (!cancelled) {
          setDetail(payload);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Không thể tải chi tiết chủ đề.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;

    const loadSession = async () => {
      try {
        const payload = await fetchAuthSession();
        if (!cancelled) {
          setSessionUser(payload && payload.session && payload.session.user ? payload.session.user : null);
        }
      } catch (_error) {
        if (!cancelled) {
          setSessionUser(null);
        }
      }
    };

    loadSession();

    const onAuthChanged = () => {
      loadSession();
    };

    window.addEventListener("bfang:auth", onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("bfang:auth", onAuthChanged);
    };
  }, []);

  const sectionOptionsForDetail = useMemo(
    () =>
      (detail?.sections || []).map((section) => ({
        slug: section.slug,
        label: section.label,
        icon: section.icon,
      })),
    [detail?.sections]
  );

  const post = detail ? mapApiPostToUiPost(detail.post, sectionOptionsForDetail) : null;
  const isAuthenticated = Boolean(sessionUser && sessionUser.id);
  const canInteract = Boolean(isAuthenticated && (detail?.viewer?.canComment ?? true));
  const postId = detail && detail.post && detail.post.id ? String(detail.post.id) : "";
  const canModerateForum = Boolean(detail?.viewer?.canModerateForum || detail?.viewer?.canDeleteAnyComment);
  const canCreateAnnouncement = Boolean(detail?.viewer?.canCreateAnnouncement);
  const canLockPost = Boolean((detail?.post?.permissions?.isOwner || canModerateForum) && detail?.post?.id);
  const canPinPost = Boolean(canModerateForum && detail?.post?.id);
  const postLiked = Boolean(postId && likedIds.has(postId));
  const postReported = Boolean(postId && reportedIds.has(postId));
  const postActionBusy = Boolean(postId && pendingActionIds.has(postId));
  const hasPostMenuActions = Boolean(
    detail?.post?.permissions?.canEdit ||
    detail?.post?.permissions?.canReport ||
    detail?.post?.permissions?.canDelete ||
    canLockPost ||
    canPinPost
  );
  const availableEditCategories = useMemo(() => {
    const source = Array.isArray(detail?.sections) && detail?.sections.length
      ? detail.sections
      : basicCategories.map((item, index) => ({
          id: index + 1,
          slug: item.id,
          label: item.name,
          icon: item.icon,
          visible: true,
          isSystem: true,
        }));

    return source
      .map((item) => {
        const slug = normalizeForumSectionSlug(String(item?.slug || "").trim());
        const name = String(item?.label || "").trim();
        const icon = String(item?.icon || "").trim() || "💬";
        if (!slug || !name) return null;
        return {
          id: slug,
          name,
          icon,
        };
      })
      .filter((item): item is { id: string; name: string; icon: string } => Boolean(item))
      .filter((cat) => cat.id !== "thong-bao" || canCreateAnnouncement);
  }, [canCreateAnnouncement, detail?.sections]);

  useEffect(() => {
    if (canCreateAnnouncement) return;
    if (editDialogCategory !== "thong-bao") return;
    const fallbackCategoryId = availableEditCategories[0]?.id || "thao-luan-chung";
    setEditDialogCategory(fallbackCategoryId);
  }, [availableEditCategories, canCreateAnnouncement, editDialogCategory]);

  useEffect(() => {
    if (editDialogOpen) return;
    setEditDialogSavePhase("idle");
    setEditDialogImageSyncProgress(null);
    setEditDialogOriginalContent("");
  }, [editDialogOpen]);

  const sessionMeta =
    sessionUser && sessionUser.user_metadata && typeof sessionUser.user_metadata === "object"
      ? sessionUser.user_metadata
      : null;
  const sessionDisplayName =
    (sessionMeta && (sessionMeta.display_name || sessionMeta.full_name || sessionMeta.name)
      ? String(sessionMeta.display_name || sessionMeta.full_name || sessionMeta.name).trim()
      : "") || "Bạn";
  const sessionUsername =
    (sessionMeta && (sessionMeta as Record<string, unknown>).username
      ? String((sessionMeta as Record<string, unknown>).username || "")
          .trim()
          .toLowerCase()
      : "") ||
    (sessionMeta && (sessionMeta as Record<string, unknown>).preferred_username
      ? String((sessionMeta as Record<string, unknown>).preferred_username || "")
          .trim()
          .toLowerCase()
      : "") ||
    "member";
  const sessionAvatar = (() => {
    const fallbackAvatar = "/logobfang.svg";
    if (!sessionUser) return fallbackAvatar;

    const directAvatar =
      sessionMeta && (sessionMeta.avatar_url_custom || sessionMeta.avatar_url || sessionMeta.picture)
        ? String(sessionMeta.avatar_url_custom || sessionMeta.avatar_url || sessionMeta.picture).trim()
        : "";
    if (directAvatar) return directAvatar;

    const identities = Array.isArray(sessionUser.identities) ? sessionUser.identities : [];
    for (const identity of identities) {
      if (!identity || typeof identity !== "object") continue;
      const identityData =
        identity.identity_data && typeof identity.identity_data === "object" ? identity.identity_data : null;
      const avatar =
        identityData && (identityData.avatar_url || identityData.picture)
          ? String(identityData.avatar_url || identityData.picture).trim()
          : "";
      if (avatar) return avatar;
    }

    return fallbackAvatar;
  })();

  useEffect(() => {
    let cancelled = false;

    const syncReactionState = async () => {
      if (!isAuthenticated || !detail) {
        if (!cancelled) {
          setLikedIds(new Set());
          setReportedIds(new Set());
        }
        return;
      }

      const ids = [detail.post.id, ...detail.comments.map((item) => item.id)].filter(
        (value) => Number.isFinite(Number(value)) && Number(value) > 0
      );

      if (!ids.length) return;

      try {
        const payload = await fetchCommentReactions(ids.map((value) => Math.floor(Number(value))));
        if (!cancelled) {
          setLikedIds(new Set((payload.likedIds || []).map((value) => String(value))));
          setReportedIds(new Set((payload.reportedIds || []).map((value) => String(value))));
        }
      } catch (_err) {
        if (!cancelled) {
          setLikedIds(new Set());
          setReportedIds(new Set());
        }
      }
    };

    syncReactionState();
    return () => {
      cancelled = true;
    };
  }, [detail, isAuthenticated]);

  useEffect(() => {
    setBookmarked(Boolean(detail && detail.post && detail.post.saved));
  }, [detail]);

  const sortedComments = useMemo(() => {
    const mappedPersisted = detail ? detail.comments.map((item) => mapApiCommentToUiComment(item)) : [];
    const mergedById = new Map<string, UiComment>();

    mappedPersisted.forEach((item) => {
      mergedById.set(item.id, item);
    });
    optimisticComments.forEach((item) => {
      mergedById.set(item.id, item);
    });

    return buildCommentTree({
      comments: Array.from(mergedById.values()),
      sortMode: sortComments,
      rootPostId: String(detail?.post?.id || "").trim(),
      pinnedReplyIdSet: tempPinnedReplyIds,
    });
  }, [detail, optimisticComments, sortComments, tempPinnedReplyIds]);

  useEffect(() => {
    setVisibleRootCommentCount(ROOT_COMMENTS_PAGE_SIZE);
  }, [sortComments, detail?.post?.id]);

  const visibleRootComments = useMemo(
    () => sortedComments.slice(0, visibleRootCommentCount),
    [sortedComments, visibleRootCommentCount]
  );

  const hashTargetCommentId = useMemo(() => {
    const rawHash = decodeURIComponent(String(location.hash || "")).trim();
    const match = rawHash.match(/^#comment-([A-Za-z0-9_-]+)$/);
    return match ? String(match[1] || "").trim() : "";
  }, [location.hash]);

  const hashTargetMeta = useMemo(() => {
    if (!hashTargetCommentId) return null;

    for (let rootIndex = 0; rootIndex < sortedComments.length; rootIndex += 1) {
      const rootComment = sortedComments[rootIndex];
      if (!rootComment) continue;
      const rootId = String(rootComment.id || "").trim();
      if (!rootId) continue;

      if (rootId === hashTargetCommentId) {
        return {
          rootId,
          rootIndex,
          isRoot: true,
          replyIndex: -1,
        } as const;
      }

      const replies = Array.isArray(rootComment.replies) ? rootComment.replies : [];
      const replyIndex = replies.findIndex((reply) => String(reply && reply.id ? reply.id : "").trim() === hashTargetCommentId);
      if (replyIndex >= 0) {
        return {
          rootId,
          rootIndex,
          isRoot: false,
          replyIndex,
        } as const;
      }
    }

    return null;
  }, [hashTargetCommentId, sortedComments]);

  useEffect(() => {
    hashScrollDoneRef.current = "";
  }, [hashTargetCommentId, detail?.post?.id]);

  useEffect(() => {
    if (!hashTargetCommentId || !hashTargetMeta) return;

    let requiresNextRender = false;
    const minimumVisibleRoots = hashTargetMeta.rootIndex + 1;
    if (minimumVisibleRoots > visibleRootCommentCount) {
      setVisibleRootCommentCount((prev) => Math.max(prev, minimumVisibleRoots));
      requiresNextRender = true;
    }

    if (!hashTargetMeta.isRoot) {
      if (!forceExpandedReplyParentIds.has(hashTargetMeta.rootId)) {
        setForceExpandedReplyParentIds((prev) => {
          const next = new Set(prev);
          next.add(hashTargetMeta.rootId);
          return next;
        });
        requiresNextRender = true;
      }

      const minimumVisibleReplies = hashTargetMeta.replyIndex + 1;
      const currentForcedReplies = Number(forceVisibleReplyCountByParentId[hashTargetMeta.rootId] || 0);
      if (minimumVisibleReplies > currentForcedReplies) {
        setForceVisibleReplyCountByParentId((prev) => ({
          ...prev,
          [hashTargetMeta.rootId]: minimumVisibleReplies,
        }));
        requiresNextRender = true;
      }
    }

    if (requiresNextRender) return;

    const scrollKey = `${String(detail?.post?.id || "")}:${hashTargetCommentId}`;
    if (hashScrollDoneRef.current === scrollKey) return;

    const target = document.getElementById(`comment-${hashTargetCommentId}`);
    if (!target) return;

    hashScrollDoneRef.current = scrollKey;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, [
    detail?.post?.id,
    forceExpandedReplyParentIds,
    forceVisibleReplyCountByParentId,
    hashTargetCommentId,
    hashTargetMeta,
    visibleRootCommentCount,
  ]);

  const remainingRootComments = Math.max(sortedComments.length - visibleRootCommentCount, 0);
  const editDialogUploadProgressUploaded = editDialogImageSyncProgress ? editDialogImageSyncProgress.uploaded : 0;
  const editDialogUploadProgressTotal = editDialogImageSyncProgress ? editDialogImageSyncProgress.total : 0;
  const editDialogSaveButtonLabel = editDialogSaving
    ? editDialogSavePhase === "uploading"
      ? `Đang tải lên ${editDialogUploadProgressUploaded}/${editDialogUploadProgressTotal || 1} ảnh`
      : "Đang lưu..."
    : "Lưu thay đổi";

  const handleLogin = () => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    openAuthProviderDialog(next || "/forum");
  };

  const markActionPending = (id: string, pending: boolean) => {
    setPendingActionIds((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const refreshDetail = async (idValue: string | number) => {
    const payload = await fetchForumPostDetail(idValue);
    setDetail(payload);
  };

  const handleToggleLike = async (commentId: string) => {
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    if (!canInteract) {
      setActionNotice("Tài khoản của bạn hiện không có quyền tương tác.");
      return;
    }

    const safeId = String(commentId || "").trim();
    if (!safeId) return;

    try {
      markActionPending(safeId, true);
      const response = await toggleCommentLike(Number(safeId));
      const liked = Boolean(response && response.liked);
      const likeCount = Number(response && response.likeCount);

      setLikedIds((prev) => {
        const next = new Set(prev);
        if (liked) {
          next.add(safeId);
        } else {
          next.delete(safeId);
        }
        return next;
      });

      if (Number.isFinite(likeCount)) {
        setDetail((prev) => {
          if (!prev) return prev;
          const normalized = Math.max(0, Math.floor(likeCount));
          if (String(prev.post.id) === safeId) {
            return {
              ...prev,
              post: {
                ...prev.post,
                likeCount: normalized,
              },
            };
          }

          return {
            ...prev,
            comments: prev.comments.map((item) =>
              String(item.id) === safeId
                ? {
                    ...item,
                    likeCount: normalized,
                  }
                : item
            ),
          };
        });
      }
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể cập nhật lượt thích.");
    } finally {
      markActionPending(safeId, false);
    }
  };

  const handleReport = async (commentId: string) => {
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    if (!canInteract) {
      setActionNotice("Tài khoản của bạn hiện không có quyền tương tác.");
      return;
    }

    const safeId = String(commentId || "").trim();
    if (!safeId) return;

    try {
      markActionPending(safeId, true);
      const response = await reportComment(Number(safeId));
      const reportCount = Number(response && response.reportCount);

      setReportedIds((prev) => {
        const next = new Set(prev);
        next.add(safeId);
        return next;
      });

      if (Number.isFinite(reportCount)) {
        setDetail((prev) => {
          if (!prev) return prev;
          const normalized = Math.max(0, Math.floor(reportCount));
          if (String(prev.post.id) === safeId) {
            return {
              ...prev,
              post: {
                ...prev.post,
                reportCount: normalized,
              },
            };
          }

          return {
            ...prev,
            comments: prev.comments.map((item) =>
              String(item.id) === safeId
                ? {
                    ...item,
                    reportCount: normalized,
                  }
                : item
            ),
          };
        });
      }
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể báo cáo bình luận.");
    } finally {
      markActionPending(safeId, false);
    }
  };

  const handleEditComment = async (
    commentId: string,
    content: string,
    options?: { removedImageKeys?: string[] }
  ) => {
    if (!isAuthenticated) {
      handleLogin();
      return false;
    }

    const safeId = String(commentId || "").trim();
    if (!safeId) return false;

    try {
      markActionPending(safeId, true);
      await editComment(Number(safeId), content, { removedImageKeys: options?.removedImageKeys || [] });
      if (detail) {
        await refreshDetail(detail.post.id);
      }
      return true;
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể sửa bình luận.");
      return false;
    } finally {
      markActionPending(safeId, false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!isAuthenticated) {
      handleLogin();
      return;
    }

    const safeId = String(commentId || "").trim();
    if (!safeId || !detail) return;

    try {
      markActionPending(safeId, true);
      await deleteComment(Number(safeId));
      if (safeId === String(detail.post.id)) {
        navigateBackToForum();
        return;
      }
      await refreshDetail(detail.post.id);
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể xóa bình luận.");
    } finally {
      markActionPending(safeId, false);
    }
  };

  const handleShare = async () => {
    const shareUrl = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: post ? post.title : "Chủ đề",
          url: shareUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setActionNotice("Đã sao chép liên kết bài viết.");
    } catch (_err) {
      setActionNotice("Không thể chia sẻ liên kết ở thiết bị này.");
    }
  };

  const handleScrollToComments = () => {
    const commentsSection = document.getElementById("forum-comments");
    if (!commentsSection) return;
    commentsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const removeOptimisticComment = (commentId: string) => {
    const safeId = String(commentId || "").trim();
    if (!safeId) return;
    setOptimisticComments((prev) => prev.filter((item) => item.id !== safeId));
    if (optimisticCommentRef.current === safeId) {
      optimisticCommentRef.current = "";
    }
  };

  const pushOptimisticComment = (comment: UiComment) => {
    setOptimisticComments((prev) => [comment, ...prev.filter((item) => item.id !== comment.id)]);
    optimisticCommentRef.current = comment.id;
    setSortComments("new");

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = document.getElementById(`comment-${comment.id}`);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          handleScrollToComments();
        }
      });
    });
  };

  const notifyCommentRateLimit = (error: unknown, fallbackMessage: string) => {
    const message = error instanceof Error ? error.message : fallbackMessage;
    setActionNotice(message);

    const errorCode =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "").trim()
        : "";
    if (errorCode !== "COMMENT_RATE_LIMITED") {
      return;
    }

    const retryAfterRaw =
      error && typeof error === "object" && "retryAfter" in error
        ? Number((error as { retryAfter?: unknown }).retryAfter)
        : 0;
    const retryAfter = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? Math.floor(retryAfterRaw) : 0;

    toast({
      variant: "destructive",
      title: "Bạn thao tác quá nhanh",
      description:
        retryAfter > 0
          ? `Vui lòng chờ ${retryAfter} giây rồi thử lại.`
          : message,
    });
  };

  const buildOptimisticComment = (params: {
    content: string;
    parentId?: string;
    pendingText?: string;
  }): UiComment => {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      id: pendingId,
      content: normalizeForumContentHtml(params.content),
      author: {
        id: String(sessionUser && sessionUser.id ? sessionUser.id : "pending-user"),
        username: sessionUsername,
        displayName: sessionDisplayName,
        avatar: sessionAvatar,
        profileUrl: FORUM_USERNAME_PATTERN.test(sessionUsername)
          ? `/user/${encodeURIComponent(sessionUsername)}`
          : "",
        badges: [],
        userColor: "",
        role: "member",
      },
      upvotes: 0,
      downvotes: 0,
      createdAt: "Vừa xong",
      parentId: params.parentId ? String(params.parentId).trim() : "",
      replies: [],
      permissions: {
        canEdit: false,
        canDelete: false,
        canReport: false,
        canReply: false,
        isOwner: true,
      },
      isPending: true,
      pendingText: params.pendingText || "Đang gửi bình luận...",
    };
  };

  const handleToggleBookmark = async () => {
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    const safePostId = Number(detail && detail.post ? detail.post.id : 0);
    if (!Number.isFinite(safePostId) || safePostId <= 0) return;

    try {
      const payload = await toggleForumPostBookmark(Math.floor(safePostId));
      const nextSaved = Boolean(payload && payload.saved);
      setBookmarked(nextSaved);
      window.dispatchEvent(
        new CustomEvent("bfang:forum-bookmark-changed", {
          detail: {
            postId: String(Math.floor(safePostId)),
            saved: nextSaved,
          },
        })
      );
      setDetail((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          post: {
            ...prev.post,
            saved: nextSaved,
          },
        };
      });
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể cập nhật trạng thái lưu bài.");
    }
  };

  const handleTogglePostLock = async () => {
    if (!detail?.post?.id || postActionBusy || !canLockPost) return;
    const safePostId = Number(detail.post.id);
    if (!Number.isFinite(safePostId) || safePostId <= 0) return;

    try {
      markActionPending(String(detail.post.id), true);
      const nextLocked = !post?.isLocked;
      await setForumPostLocked(Math.floor(safePostId), nextLocked);
      await refreshDetail(detail.post.id);
      toast({
        title: nextLocked ? "Đã khoá" : "Đã mở khoá",
        description: nextLocked
          ? "Bài viết đã được khoá bình luận."
          : "Bài viết đã được mở khoá bình luận.",
      });
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể cập nhật trạng thái khóa chủ đề.");
    } finally {
      markActionPending(String(detail.post.id), false);
    }
  };

  const handleTogglePostPin = async () => {
    if (!detail?.post?.id || postActionBusy || !canPinPost) return;
    const safePostId = Number(detail.post.id);
    if (!Number.isFinite(safePostId) || safePostId <= 0) return;

    try {
      markActionPending(String(detail.post.id), true);
      const nextPinned = !post?.isSticky;
      await setForumPostPinned(Math.floor(safePostId), nextPinned);
      await refreshDetail(detail.post.id);
      toast({
        title: nextPinned ? "Đã ghim bài" : "Đã bỏ ghim",
        description: nextPinned
          ? "Bài viết đã được ghim trong chuyên mục."
          : "Bài viết đã được bỏ ghim.",
      });
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : "Không thể cập nhật trạng thái ghim chủ đề.");
    } finally {
      markActionPending(String(detail.post.id), false);
    }
  };

  const openDeleteConfirmDialog = (targetId: string, isPost = false) => {
    const safeId = String(targetId || "").trim();
    if (!safeId) return;
    setConfirmDialog({
      action: "delete",
      targetId: safeId,
      title: isPost ? "Xóa bài viết?" : "Xóa bình luận?",
      description: isPost
        ? "Bài viết và toàn bộ bình luận trong đó sẽ bị xóa. Hành động này không thể hoàn tác."
        : "Bình luận sẽ bị xóa. Nếu có phản hồi con, toàn bộ nhánh phản hồi cũng bị xóa.",
      confirmText: "Xóa",
    });
  };

  const openReportConfirmDialog = (targetId: string, isPost = false) => {
    const safeId = String(targetId || "").trim();
    if (!safeId) return;
    setConfirmDialog({
      action: "report",
      targetId: safeId,
      title: isPost ? "Báo cáo bài viết?" : "Báo cáo bình luận?",
      description: isPost
        ? "Báo cáo sẽ được ghi nhận và hiển thị cho quản trị viên để xử lý."
        : "Báo cáo sẽ được ghi nhận để đội kiểm duyệt xem xét nội dung này.",
      confirmText: "Báo cáo",
    });
  };

  const openEditDialog = useCallback(
    (params: {
      targetId: string;
      initialContent: string;
      title: string;
      fallbackPostTitle?: string;
      sectionSlug?: string;
    }) => {
      const safeId = String(params.targetId || "").trim();
      if (!safeId) return;

      const split = splitPostTitleAndBody(params.initialContent || "", params.fallbackPostTitle || "");
      const normalizedCategorySlug = normalizeForumSectionSlug(params.sectionSlug || split.sectionSlug);

      setEditDialogTargetId(safeId);
      setEditDialogTitle(params.title);
      setEditDialogPostTitle(split.title);
      setEditDialogContent(split.body || "");
      setEditDialogOriginalContent(String(params.initialContent || ""));
      const fallbackCategoryId = availableEditCategories[0]?.id || "thao-luan-chung";
      setEditDialogCategory(normalizedCategorySlug || fallbackCategoryId);
      setEditDialogOpen(true);
    },
    [availableEditCategories]
  );

  useEffect(() => {
    if (!detail || !detail.post || !detail.post.permissions || !detail.post.permissions.canEdit) {
      return;
    }

    const params = new URLSearchParams(location.search || "");
    const action = String(params.get("action") || "")
      .trim()
      .toLowerCase();
    const openEditFromState = Boolean(
      location.state && typeof location.state === "object" && "openEdit" in location.state
        ? (location.state as { openEdit?: unknown }).openEdit
        : false
    );

    if (action !== "edit" && !openEditFromState) {
      return;
    }

    openEditDialog({
      targetId: String(detail.post.id),
      initialContent: detail.post.content || "",
      title: "Chỉnh sửa bài viết",
      fallbackPostTitle: detail.post.title || "",
      sectionSlug: detail.post.sectionSlug || "",
    });

    params.delete("action");
    const nextSearch = params.toString();
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch ? `?${nextSearch}` : "",
      },
      { replace: true, state: null }
    );
  }, [detail, location.pathname, location.search, location.state, navigate, openEditDialog]);

  const handleConfirmAction = async () => {
    if (!confirmDialog) return;
    const action = confirmDialog.action;
    const targetId = confirmDialog.targetId;
    setConfirmDialog(null);

    if (action === "delete") {
      await handleDeleteComment(targetId);
      return;
    }

    await handleReport(targetId);
  };

  const handleSaveEditDialog = async () => {
    const targetId = String(editDialogTargetId || "").trim();
    const normalizedBody = (editDialogContent || "").toString().trim();
    if (!targetId) return;

    if (isEditTargetPost) {
      if (!editDialogCategory) {
        setActionNotice("Vui lòng chọn danh mục cho bài viết.");
        return;
      }

      if (!normalizedEditPostTitle) {
        setActionNotice("Tiêu đề bài viết không được để trống.");
        return;
      }

      if (normalizedEditPostTitle.length > FORUM_POST_TITLE_MAX_LENGTH) {
        setActionNotice(`Tiêu đề tối đa ${FORUM_POST_TITLE_MAX_LENGTH} ký tự.`);
        return;
      }

      if (!normalizedBody || normalizedBody === "<p></p>") {
        setActionNotice("Nội dung bài viết không được để trống.");
        return;
      }

      if (editDialogContentLength > FORUM_POST_MAX_LENGTH) {
        setActionNotice(`Bài viết tối đa ${FORUM_POST_MAX_LENGTH} ký tự.`);
        return;
      }

      const syncEditedPostImages = async (params: {
        postId: number;
        content: string;
        images: ForumLocalPostImage[];
        removedImageKeys: string[];
      }): Promise<string> => {
        const total = Array.isArray(params.images) ? params.images.length : 0;
        if (!total) return params.content;

        let syncedContent = params.content;
        setEditDialogSavePhase("uploading");
        for (let index = 0; index < total; index += 1) {
          const image = params.images[index];
          setEditDialogImageSyncProgress({ uploaded: index + 1, total });
          const result = await finalizeForumPostLocalImages({
            postId: params.postId,
            content: syncedContent,
            images: [image],
            allowPartialFinalize: true,
            removedImageKeys: index === 0 ? params.removedImageKeys : [],
          });
          syncedContent = result.content;
        }

        return syncedContent;
      };

      try {
        setEditDialogSaving(true);
        setEditDialogSavePhase("saving");
        setEditDialogImageSyncProgress(null);
        const prepared = prepareForumPostContentForSubmit(editDialogPostContent);
        const removedImageKeys = getRemovedForumManagedImageRefs(editDialogOriginalContent, editDialogPostContent);
        const ok = await handleEditComment(targetId, prepared.content, { removedImageKeys });
        if (!ok) {
          return;
        }

        if (prepared.images.length > 0) {
          const safePostId = Number(targetId);
          if (!Number.isFinite(safePostId) || safePostId <= 0) {
            throw new Error("Không xác định được bài viết để đồng bộ ảnh.");
          }

          await syncEditedPostImages({
            postId: Math.floor(safePostId),
            content: prepared.content,
            images: prepared.images,
            removedImageKeys,
          });

          if (detail) {
            await refreshDetail(detail.post.id);
          }
        }
        setEditDialogOpen(false);
      } catch (err) {
        setActionNotice(err instanceof Error ? err.message : "Không thể lưu thay đổi bài viết.");
      } finally {
        setEditDialogSaving(false);
        setEditDialogSavePhase("idle");
        setEditDialogImageSyncProgress(null);
      }
      return;
    }

    if (!normalizedBody || normalizedBody === "<p></p>" || editDialogContentLength <= 0) {
      setActionNotice("Nội dung chỉnh sửa không được để trống.");
      return;
    }

    if (editDialogContentLength > FORUM_COMMENT_MAX_LENGTH) {
      setActionNotice(`Bình luận tối đa ${FORUM_COMMENT_MAX_LENGTH} ký tự.`);
      return;
    }

    try {
      setEditDialogSaving(true);
      setEditDialogSavePhase("saving");
      setEditDialogImageSyncProgress(null);
      const ok = await handleEditComment(targetId, normalizedBody);
      if (ok) {
        setEditDialogOpen(false);
      }
    } finally {
      setEditDialogSaving(false);
      setEditDialogSavePhase("idle");
      setEditDialogImageSyncProgress(null);
    }
  };

  const handleSubmitReply = async (content: string) => {
    if (submitting) {
      return;
    }
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    if (!canInteract) {
      setActionNotice("Tài khoản của bạn hiện không có quyền tương tác.");
      return;
    }
    if (!detail?.post.replyEndpoint || !detail.post.id) return;

    const optimisticComment = buildOptimisticComment({
      content,
      parentId: String(detail.post.id),
      pendingText: "Đang gửi bình luận...",
    });

    try {
      setSubmitting(true);
      pushOptimisticComment(optimisticComment);
      await submitForumReply({
        endpoint: detail.post.replyEndpoint,
        content,
        parentId: detail.post.id,
      });

      const refreshed = await fetchForumPostDetail(detail.post.id);
      setDetail(refreshed);
      removeOptimisticComment(optimisticComment.id);
    } catch (err) {
      removeOptimisticComment(optimisticComment.id);
      notifyCommentRateLimit(err, "Không thể gửi bình luận.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReplyFromComment = async (commentId: string, content: string) => {
    if (submitting) {
      return;
    }
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    if (!canInteract) {
      setActionNotice("Tài khoản của bạn hiện không có quyền tương tác.");
      return;
    }
    if (!detail?.post.replyEndpoint || !detail.post.id) return;

    const safeParentId = Number(commentId);
    if (!Number.isFinite(safeParentId) || safeParentId <= 0) {
      setActionNotice("Không xác định được bình luận cha để phản hồi.");
      return;
    }

    const safeParentCommentId = String(Math.floor(safeParentId));
    setForceExpandedReplyParentIds((prev) => {
      const next = new Set(prev);
      next.add(safeParentCommentId);
      return next;
    });

    const normalizedContent = (content || "").toString().trim();
    const optimisticComment = buildOptimisticComment({
      content: normalizedContent,
      parentId: safeParentCommentId,
      pendingText: "Đang gửi bình luận...",
    });

    try {
      setSubmitting(true);
      pushOptimisticComment(optimisticComment);
      const payload = await submitForumReply({
        endpoint: detail.post.replyEndpoint,
        content: normalizedContent,
        parentId: Math.floor(safeParentId),
      });

      const persistedReplyId = Number(payload && payload.comment && payload.comment.id);
      if (Number.isFinite(persistedReplyId) && persistedReplyId > 0) {
        setTempPinnedReplyIds((prev) => {
          const next = new Set(prev);
          next.add(String(Math.floor(persistedReplyId)));
          return next;
        });
      }

      const refreshed = await fetchForumPostDetail(detail.post.id);
      setDetail(refreshed);
      removeOptimisticComment(optimisticComment.id);
    } catch (err) {
      removeOptimisticComment(optimisticComment.id);
      notifyCommentRateLimit(err, "Không thể gửi phản hồi.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="mx-auto max-w-3xl px-4 py-8">
          <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            Đang tải chủ đề...
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !post) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="mx-auto max-w-3xl px-4 py-8 space-y-3">
          <button
            onClick={navigateBackToForum}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Quay lại
          </button>
          <div className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            {loadError || "Không tìm thấy chủ đề."}
          </div>
        </div>
      </div>
    );
  }

  const postBadges = Array.isArray(post.author.badges) ? post.author.badges : [];
  const hasAdminBadge = postBadges.some((badge) => String(badge && badge.code ? badge.code : "").trim().toLowerCase() === "admin");
  const hasModBadge = postBadges.some((badge) => {
    const code = String(badge && badge.code ? badge.code : "").trim().toLowerCase();
    return code === "mod" || code === "moderator";
  });
  const shouldShowAuthorRoleBadge =
    post.author.role === "admin"
      ? !hasAdminBadge
      : post.author.role === "moderator"
        ? !hasModBadge
        : false;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-3xl px-4 py-4">
        <button
          onClick={navigateBackToForum}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Quay lại
        </button>

        {actionNotice ? (
          <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            {actionNotice}
          </div>
        ) : null}

        <article className="rounded-lg border border-border bg-card overflow-hidden animate-fade-in">
          <div className="border-b border-border px-4 py-3">
            <div className="flex items-start gap-2.5">
              {post.author.profileUrl ? (
                <a href={post.author.profileUrl} className="shrink-0">
                  <img
                    src={post.author.avatar}
                    alt={post.author.displayName || post.author.username}
                    className="w-10 h-10 rounded-full bg-accent hover:opacity-80 transition-opacity"
                    onError={(event) => {
                      event.currentTarget.onerror = null;
                      event.currentTarget.src = "/logobfang.svg";
                    }}
                  />
                </a>
              ) : (
                <img
                  src={post.author.avatar}
                  alt={post.author.displayName || post.author.username}
                  className="w-10 h-10 rounded-full shrink-0 bg-accent"
                  onError={(event) => {
                    event.currentTarget.onerror = null;
                    event.currentTarget.src = "/logobfang.svg";
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {post.author.profileUrl ? (
                    <a
                      href={post.author.profileUrl}
                      className="font-bold text-sm hover:underline cursor-pointer truncate max-w-[200px]"
                      style={post.author.userColor ? { color: post.author.userColor } : undefined}
                    >
                      {post.author.displayName || post.author.username}
                    </a>
                  ) : (
                    <span
                      className="font-bold text-foreground text-sm hover:underline cursor-pointer truncate max-w-[200px]"
                      style={post.author.userColor ? { color: post.author.userColor } : undefined}
                    >
                      {post.author.displayName || post.author.username}
                    </span>
                  )}
                  {postBadges.map((badge) => (
                    <span
                      key={`${badge.code}-${badge.label}`}
                      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        color: badge.color || '#f8f8f2',
                        backgroundColor: badge.color ? `${badge.color}22` : 'hsl(var(--secondary))'
                      }}
                    >
                      {badge.label}
                    </span>
                  ))}
                  {shouldShowAuthorRoleBadge ? <RoleBadge role={post.author.role} /> : null}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
                  {post.author.displayName && (
                    <>
                      <span>@{post.author.username}</span>
                      <span>·</span>
                    </>
                  )}
                  <span>{post.createdAt}</span>
                  {post.author.postCount != null && (
                    <>
                      <span>·</span>
                      <span>{post.author.postCount} bài viết</span>
                    </>
                  )}
                  {post.author.joinDate && (
                    <>
                      <span>·</span>
                      <span>Tham gia {post.author.joinDate}</span>
                    </>
                  )}
                </div>
                {post.author.bio && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1 max-w-md">{post.author.bio}</p>
                )}
              </div>

              {hasPostMenuActions ? (
                <div className="relative ml-auto">
                  <button
                    type="button"
                    onClick={() => setShowMenu(!showMenu)}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {showMenu && (
                    <div className="absolute right-0 top-full mt-1 bg-card border border-border rounded-lg shadow-lg py-1 z-20 min-w-[150px] animate-scale-in">
                      {detail?.post.permissions?.canEdit && (
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          type="button"
                          disabled={postActionBusy}
                          onClick={() => {
                            setShowMenu(false);
                            openEditDialog({
                              targetId: String(detail.post.id),
                              initialContent: detail.post.content || "",
                              title: "Chỉnh sửa bài viết",
                              fallbackPostTitle: detail.post.title || "",
                              sectionSlug: detail.post.sectionSlug || "",
                            });
                          }}
                        >
                          <Edit3 className="h-3.5 w-3.5" /> Chỉnh sửa
                        </button>
                      )}
                      {detail?.post.permissions?.canReport && (
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          type="button"
                          disabled={postActionBusy || postReported}
                          onClick={() => {
                            setShowMenu(false);
                            openReportConfirmDialog(String(detail.post.id), true);
                          }}
                        >
                          <Flag className="h-3.5 w-3.5" /> {postReported ? "Đã báo cáo" : "Báo cáo"}
                        </button>
                      )}
                      {canLockPost && (
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          type="button"
                          disabled={postActionBusy}
                          onClick={() => {
                            setShowMenu(false);
                            void handleTogglePostLock();
                          }}
                        >
                          <Lock className="h-3.5 w-3.5" /> {post?.isLocked ? "Mở khoá" : "Khoá"}
                        </button>
                      )}
                      {canPinPost && (
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          type="button"
                          disabled={postActionBusy}
                          onClick={() => {
                            setShowMenu(false);
                            void handleTogglePostPin();
                          }}
                        >
                          <Pin className="h-3.5 w-3.5" /> {post?.isSticky ? "Bỏ ghim" : "Ghim bài"}
                        </button>
                      )}
                      {detail?.post.permissions?.canDelete && (
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-destructive hover:bg-accent transition-colors"
                          type="button"
                          disabled={postActionBusy}
                          onClick={() => {
                            setShowMenu(false);
                            openDeleteConfirmDialog(String(detail.post.id), true);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Xóa bài
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="p-4">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {post.isAnnouncement && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-primary">
                  <Megaphone className="h-3 w-3" /> Thông báo
                </span>
              )}
              {post.isSticky && !post.isAnnouncement && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-sticky">
                  <Pin className="h-3 w-3" /> Ghim
                </span>
              )}
              {post.isLocked && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase text-muted-foreground">
                  <Lock className="h-3 w-3" /> Đã khóa
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {post.category.icon} {post.category.name}
              </span>
            </div>

            <h1 className="text-lg font-bold text-foreground leading-snug mb-3 break-words [overflow-wrap:anywhere]">{post.title}</h1>

            <ForumRichContent
              html={post.content}
              className="forum-rich-content text-sm text-foreground/90 leading-relaxed mb-4"
            />

            <div className="flex items-center gap-1 flex-wrap border-t border-border pt-3 -mx-4 px-4">
              <button
                type="button"
                onClick={() => handleToggleLike(String(post.id))}
                className={`flex items-center gap-1.5 text-xs transition-colors px-2 py-1.5 rounded-md hover:bg-accent ${
                  postLiked ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                disabled={postActionBusy}
              >
                <span>Thích</span>
                <span className="text-muted-foreground">{detail?.post.likeCount || 0}</span>
              </button>

              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-md hover:bg-accent"
                onClick={handleScrollToComments}
                type="button"
              >
                <MessageSquare className="h-3.5 w-3.5" /> {post.commentCount} bình luận
              </button>

              <button
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-md hover:bg-accent"
                onClick={handleShare}
                type="button"
              >
                <Share2 className="h-3.5 w-3.5" /> Chia sẻ
              </button>

              <button
                onClick={handleToggleBookmark}
                className={`flex items-center gap-1.5 text-xs transition-colors px-2 py-1.5 rounded-md hover:bg-accent ${
                  bookmarked ? "text-sticky" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bookmark className={`h-3.5 w-3.5 ${bookmarked ? "fill-current" : ""}`} />
                {bookmarked ? "Đã lưu" : "Lưu"}
              </button>

            </div>
          </div>
        </article>

        <div id="forum-comments" className="mt-4 rounded-lg border border-border bg-card p-4">
          {!post.isLocked ? (
            canInteract ? (
              <div className="mb-4">
                <CommentInput
                  onSubmit={handleSubmitReply}
                  placeholder={submitting ? "Đang gửi bình luận..." : "Viết bình luận..."}
                  mangaSlug={detail?.post.manga.slug || ""}
                  mentionRootCommentId={Number(detail?.post.id) || undefined}
                  submitting={submitting}
                />
              </div>
            ) : isAuthenticated ? (
              <div className="mb-4 rounded-lg border border-border bg-secondary/50 p-3 text-sm text-muted-foreground">
                Tài khoản của bạn hiện không có quyền tương tác trong diễn đàn.
              </div>
            ) : (
              <div className="mb-4 rounded-lg border border-border bg-secondary/50 p-3 text-sm text-muted-foreground flex items-center justify-between gap-3">
                <span>Bạn cần đăng nhập để bình luận.</span>
                <button
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  onClick={handleLogin}
                  type="button"
                >
                  Đăng nhập
                </button>
              </div>
            )
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary rounded-lg p-3 mb-4">
              <Lock className="h-4 w-4" /> Chủ đề này đã bị khóa. Bạn không thể bình luận.
            </div>
          )}

          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-muted-foreground">Sắp xếp theo:</span>
            {(["best", "new", "old"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortComments(s)}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  sortComments === s ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "best" ? "Hay nhất" : s === "new" ? "Mới nhất" : "Cũ nhất"}
              </button>
            ))}
          </div>

          <div className="space-y-0">
            {sortedComments.length > 0 ? (
              <>
                {visibleRootComments.map((comment) => (
                  <CommentThread
                    key={comment.id}
                    comment={comment}
                    canReply={canInteract}
                    forceExpandedParentIds={forceExpandedReplyParentIds}
                    forceVisibleReplyCountByParentId={forceVisibleReplyCountByParentId}
                    onReplySubmit={handleReplyFromComment}
                    onToggleLike={handleToggleLike}
                    onEditSubmit={handleEditComment}
                    onDelete={(commentId) => openDeleteConfirmDialog(commentId, false)}
                    onReport={(commentId) => openReportConfirmDialog(commentId, false)}
                    likedIds={likedIds}
                    reportedIds={reportedIds}
                    pendingActionIds={pendingActionIds}
                    mangaSlug={detail?.post.manga.slug || ""}
                    mentionRootCommentId={Number(detail?.post.id) || undefined}
                    submitting={submitting}
                  />
                ))}

                {remainingRootComments > 0 ? (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleRootCommentCount((prev) =>
                          Math.min(prev + ROOT_COMMENTS_PAGE_SIZE, sortedComments.length)
                        )
                      }
                      className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Xem thêm {Math.min(ROOT_COMMENTS_PAGE_SIZE, remainingRootComments)} bình luận
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa có bình luận nào.</p>
            )}
          </div>
        </div>

        <AlertDialog
          open={Boolean(confirmDialog)}
          onOpenChange={(open) => {
            if (!open) {
              setConfirmDialog(null);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmDialog?.title || "Xác nhận thao tác"}</AlertDialogTitle>
              <AlertDialogDescription>{confirmDialog?.description || ""}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Hủy</AlertDialogCancel>
              <AlertDialogAction
                className={confirmDialog?.action === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                onClick={handleConfirmAction}
              >
                {confirmDialog?.confirmText || "Xác nhận"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-border">
            <DialogHeader>
              <DialogTitle>{editDialogTitle}</DialogTitle>
              <DialogDescription>
                {isEditTargetPost
                  ? "Cập nhật bài viết với biểu mẫu giống khi đăng bài mới."
                  : "Chỉnh sửa nội dung trước khi lưu thay đổi."}
              </DialogDescription>
            </DialogHeader>

            {isEditTargetPost ? (
              <>
                <div className="mt-2">
                  <Input
                    placeholder="Tiêu đề bài viết"
                    value={editDialogPostTitle}
                    onChange={(e) => setEditDialogPostTitle(e.target.value)}
                    className="bg-secondary border-none text-foreground placeholder:text-muted-foreground"
                    maxLength={FORUM_POST_TITLE_MAX_LENGTH}
                  />
                  <p className="text-[11px] text-muted-foreground text-right mt-1">
                    {editDialogPostTitle.length}/{FORUM_POST_TITLE_MAX_LENGTH}
                  </p>
                </div>

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Danh mục</label>
                  <select
                    value={editDialogCategory}
                    onChange={(e) => setEditDialogCategory(e.target.value)}
                    className="w-full rounded-lg bg-secondary border-none text-sm text-foreground px-3 py-2 outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">Chọn danh mục...</option>
                    {availableEditCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.icon} {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

              </>
            ) : null}

            <div>
              <RichTextEditor
                content={editDialogContent}
                onUpdate={setEditDialogContent}
                placeholder={isEditTargetPost ? "Viết nội dung bài viết..." : "Nhập nội dung..."}
                compact={false}
                minHeight={isEditTargetPost ? "140px" : "96px"}
                mangaSlug={detail?.post.manga.slug || ""}
              />

              <p
                className={`mt-1 text-right text-[11px] ${
                  overEditDialogLimit ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {editDialogContentLength}/{isEditTargetPost ? FORUM_POST_MAX_LENGTH : FORUM_COMMENT_MAX_LENGTH}
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                Hủy
              </Button>
              <Button
                type="button"
                onClick={handleSaveEditDialog}
                disabled={
                  editDialogSaving ||
                  (isEditTargetPost
                    ? !normalizedEditPostTitle ||
                      !editDialogCategory ||
                      editDialogContentLength <= 0 ||
                      !normalizedEditBody ||
                      normalizedEditBody === "<p></p>"
                    : editDialogContentLength <= 0 || !(editDialogContent || "").trim() || editDialogContent === "<p></p>") ||
                  overEditDialogLimit
                }
              >
                {editDialogSaveButtonLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default PostDetail;
