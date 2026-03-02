import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/RichTextEditor";
import { measureForumTextLength } from "@/lib/forum-content";
import { finalizeForumPostLocalImages, submitForumPost } from "@/lib/forum-api";
import {
  prepareForumPostContentForSubmit,
  type ForumLocalPostImage,
} from "@/lib/forum-local-post-images";
import {
  FORUM_POST_MAX_LENGTH,
  FORUM_POST_MIN_LENGTH,
  FORUM_POST_TITLE_MAX_LENGTH,
  FORUM_POST_TITLE_MIN_LENGTH,
} from "@/lib/forum-limits";
import type { Category } from "@/types/forum";

const basicCategories = [
  { id: "thao-luan-chung", name: "Thảo luận chung", icon: "💬" },
  { id: "thong-bao", name: "Thông báo", icon: "📢" },
  { id: "huong-dan", name: "Hướng dẫn", icon: "📘" },
  { id: "tim-truyen", name: "Tìm truyện", icon: "🔎" },
  { id: "gop-y", name: "Góp ý", icon: "🛠️" },
  { id: "tam-su", name: "Tâm sự", icon: "💭" },
  { id: "chia-se", name: "Chia sẻ", icon: "🤝" },
];

const CREATE_POST_DRAFT_EDITOR_KEY = "create-post";
const CREATE_POST_DRAFT_CONTENT_STORAGE_KEY = `draft_${CREATE_POST_DRAFT_EDITOR_KEY}`;
const CREATE_POST_DRAFT_TITLE_STORAGE_KEY = `${CREATE_POST_DRAFT_CONTENT_STORAGE_KEY}_title`;
const LEGACY_FORUM_TMP_DRAFT_IMAGE_PATH_PATTERN = /\/forum\/tmp\/posts\/user-[^/"']+\/draft-[^/"']+\//i;

const readCreatePostDraftTitle = (): string => {
  try {
    return localStorage.getItem(CREATE_POST_DRAFT_TITLE_STORAGE_KEY) || "";
  } catch (_error) {
    return "";
  }
};

const persistCreatePostDraftTitle = (value: string): void => {
  const nextValue = String(value || "");
  try {
    if (nextValue) {
      localStorage.setItem(CREATE_POST_DRAFT_TITLE_STORAGE_KEY, nextValue);
    } else {
      localStorage.removeItem(CREATE_POST_DRAFT_TITLE_STORAGE_KEY);
    }
  } catch (_error) {
    // Ignore storage failures.
  }
};

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  isAuthenticated: boolean;
  canCreateAnnouncement?: boolean;
  categories: Category[];
  onRequireLogin?: () => void;
  onCreated?: () => void;
}

type ForumImageSyncFailureContext = {
  syncedContent: string;
  failedIndex: number;
};

type ForumImageSyncError = Error & ForumImageSyncFailureContext;

const buildForumImageSyncError = (
  error: unknown,
  context: ForumImageSyncFailureContext
): ForumImageSyncError => {
  const message = error instanceof Error ? error.message : "Đồng bộ ảnh thất bại.";
  const nextError = new Error(message) as ForumImageSyncError;
  nextError.syncedContent = context.syncedContent;
  nextError.failedIndex = context.failedIndex;
  return nextError;
};

const extractForumImageSyncFailure = (error: unknown): ForumImageSyncFailureContext | null => {
  if (!error || typeof error !== "object") return null;
  const maybe = error as Partial<ForumImageSyncFailureContext>;
  const failedIndex = Number(maybe.failedIndex);
  if (!Number.isFinite(failedIndex) || failedIndex < 0) return null;
  return {
    syncedContent: String(maybe.syncedContent || ""),
    failedIndex: Math.floor(failedIndex),
  };
};

export function CreatePostModal({
  open,
  onClose,
  isAuthenticated,
  canCreateAnnouncement = false,
  categories,
  onRequireLogin,
  onCreated,
}: CreatePostModalProps) {
  const [title, setTitle] = useState(() => readCreatePostDraftTitle());
  const [content, setContent] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "posting" | "uploading">("idle");
  const [submitError, setSubmitError] = useState("");
  const [imageSyncProgress, setImageSyncProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [clearDraftOnClose, setClearDraftOnClose] = useState(false);
  const [pendingImageSync, setPendingImageSync] = useState<{
    postId: number;
    content: string;
    images: ForumLocalPostImage[];
  } | null>(null);
  useEffect(() => {
    if (open || !clearDraftOnClose) return;
    const timer = window.setTimeout(() => setClearDraftOnClose(false), 0);
    return () => window.clearTimeout(timer);
  }, [open, clearDraftOnClose]);

  useEffect(() => {
    if (!open) return;
    setTitle(readCreatePostDraftTitle());
  }, [open]);

  useEffect(() => {
    if (canCreateAnnouncement) return;
    if (selectedCategory !== "thong-bao") return;
    setSelectedCategory("");
  }, [canCreateAnnouncement, selectedCategory]);

  const resetForm = () => {
    setTitle("");
    setContent("");
    setSelectedCategory("");
    setSubmitError("");
    setSubmitting(false);
    setSubmitPhase("idle");
    setImageSyncProgress(null);
    setPendingImageSync(null);
  };

  const handleClose = () => {
    onClose();
    resetForm();
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    persistCreatePostDraftTitle(value);
  };

  const handleSubmit = async () => {
    if (!isAuthenticated) {
      if (typeof onRequireLogin === "function") {
        onRequireLogin();
      }
      return;
    }

    const syncForumImages = async (payload: {
      postId: number;
      content: string;
      images: ForumLocalPostImage[];
    }) => {
      if (!payload || !Array.isArray(payload.images) || payload.images.length === 0) {
        return payload.content;
      }
      setSubmitPhase("uploading");
      const total = payload.images.length;
      let syncedContent = payload.content;

      for (let index = 0; index < total; index += 1) {
        const image = payload.images[index];
        setImageSyncProgress({ uploaded: index + 1, total });
        try {
          const result = await finalizeForumPostLocalImages({
            postId: payload.postId,
            content: syncedContent,
            images: [image],
            allowPartialFinalize: true,
          });
          syncedContent = result.content;
          setImageSyncProgress({ uploaded: index + 1, total });
        } catch (error) {
          throw buildForumImageSyncError(error, {
            syncedContent,
            failedIndex: index,
          });
        }
      }

      return syncedContent;
    };

    let nextPendingImageSync = pendingImageSync;

    try {
      setSubmitting(true);
      setSubmitPhase("posting");
      setSubmitError("");
      setClearDraftOnClose(false);

      if (!nextPendingImageSync && LEGACY_FORUM_TMP_DRAFT_IMAGE_PATH_PATTERN.test(content || "")) {
        throw new Error(
          "Nháp đang chứa ảnh tạm (/forum/tmp/.../draft-...). Vui lòng xóa ảnh đó và chèn lại ảnh mới trước khi đăng."
        );
      }

      if (!nextPendingImageSync) {
        const prepared = prepareForumPostContentForSubmit(content);
        const payload = await submitForumPost({
          title,
          content: prepared.content,
          categorySlug: selectedCategory,
        });
        const submittedContent =
          payload && typeof payload.normalizedContent === "string" && payload.normalizedContent.trim()
            ? payload.normalizedContent
            : prepared.content;

        const createdPostId = Number(payload && payload.comment ? payload.comment.id : 0);
        if (prepared.images.length > 0) {
          if (!Number.isFinite(createdPostId) || createdPostId <= 0) {
            throw new Error("Đăng bài thành công nhưng không lấy được ID để đồng bộ ảnh.");
          }

          nextPendingImageSync = {
            postId: Math.floor(createdPostId),
            content: submittedContent,
            images: prepared.images,
          };
          setPendingImageSync(nextPendingImageSync);
        }
      }

      if (nextPendingImageSync) {
        const syncedContent = await syncForumImages(nextPendingImageSync);
        nextPendingImageSync = {
          ...nextPendingImageSync,
          content: syncedContent,
          images: [],
        };
        setPendingImageSync(null);
      }

      setClearDraftOnClose(true);
      try {
        localStorage.removeItem(CREATE_POST_DRAFT_CONTENT_STORAGE_KEY);
        localStorage.removeItem(CREATE_POST_DRAFT_TITLE_STORAGE_KEY);
      } catch (_error) {
        // Ignore storage cleanup failures.
      }
      handleClose();
      if (typeof onCreated === "function") {
        onCreated();
      }
    } catch (error) {
      const knownCode =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code || "").trim()
          : "";
      const retryAfterRaw =
        error && typeof error === "object" && "retryAfter" in error
          ? Number((error as { retryAfter?: unknown }).retryAfter)
          : 0;
      const retryAfter = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? Math.floor(retryAfterRaw) : 0;
      let message = error instanceof Error ? error.message : "Không thể đăng bài. Vui lòng thử lại.";

      if (knownCode === "COMMENT_RATE_LIMITED" && retryAfter > 0) {
        message = `Bạn thao tác quá nhanh, vui lòng chờ ${retryAfter} giây rồi thử lại.`;
      }

      if (nextPendingImageSync) {
        const syncFailure = extractForumImageSyncFailure(error);
        if (syncFailure) {
          const remainingImages = nextPendingImageSync.images.slice(syncFailure.failedIndex);
          if (remainingImages.length > 0) {
            nextPendingImageSync = {
              ...nextPendingImageSync,
              content: syncFailure.syncedContent || nextPendingImageSync.content,
              images: remainingImages,
            };
          } else {
            nextPendingImageSync = null;
          }
        }

        if (nextPendingImageSync) {
          setPendingImageSync(nextPendingImageSync);
        } else {
          setPendingImageSync(null);
        }

        const remainingCount = nextPendingImageSync ? nextPendingImageSync.images.length : 0;
        setSubmitError(
          remainingCount > 0
            ? `Bài viết đã được tạo, còn ${remainingCount} ảnh chưa đồng bộ: ${message}. Nhấn "Đăng bài" lần nữa để thử lại.`
            : `Bài viết đã được tạo, nhưng đồng bộ ảnh chưa hoàn tất: ${message}.`
        );
      } else {
        setSubmitError(message);
      }
    } finally {
      setSubmitting(false);
      setSubmitPhase("idle");
      setImageSyncProgress(null);
    }
  };

  const normalizedContent = (content || "").toString().trim();
  const contentLength = measureForumTextLength(normalizedContent);
  const overContentLimit = contentLength > FORUM_POST_MAX_LENGTH;
  const underContentMin = contentLength > 0 && contentLength < FORUM_POST_MIN_LENGTH;
  const titleLength = (title || "").trim().length;
  const underTitleMin = titleLength > 0 && titleLength < FORUM_POST_TITLE_MIN_LENGTH;

  const isValid =
    titleLength >= FORUM_POST_TITLE_MIN_LENGTH &&
    Boolean(selectedCategory) &&
    contentLength >= FORUM_POST_MIN_LENGTH &&
    normalizedContent !== "<p></p>" &&
    !overContentLimit &&
    !underTitleMin &&
    !underContentMin;
  const normalizedCategories = (Array.isArray(categories) && categories.length ? categories : basicCategories)
    .map((cat) => {
      const slug = String((cat as { slug?: string; id?: string }).slug || (cat as { id?: string }).id || "").trim();
      const name = String((cat as { name?: string }).name || "").trim();
      const icon = String((cat as { icon?: string }).icon || "").trim() || "💬";
      if (!slug || !name) return null;
      return { id: slug, name, icon };
    })
    .filter((item): item is { id: string; name: string; icon: string } => Boolean(item));

  const availableCategories = normalizedCategories.filter(
    (cat) => cat.id !== "thong-bao" || canCreateAnnouncement
  );

  const pendingImageCount = pendingImageSync ? pendingImageSync.images.length : 0;
  const uploadProgressUploaded = imageSyncProgress ? imageSyncProgress.uploaded : 0;
  const uploadProgressTotal = imageSyncProgress ? imageSyncProgress.total : pendingImageCount;
  const submitButtonLabel = submitting
    ? submitPhase === "uploading"
      ? `Đang tải lên ${uploadProgressUploaded}/${uploadProgressTotal || 1} ảnh`
      : "Đang đăng..."
    : pendingImageSync
      ? "Đồng bộ ảnh"
      : "Đăng bài";
  const canSubmit = pendingImageSync
    ? isAuthenticated && !submitting
    : isValid && !submitting && isAuthenticated;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          handleClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-border">
        <DialogHeader>
          <DialogTitle className="text-foreground">Tạo bài viết mới</DialogTitle>
        </DialogHeader>

        {!isAuthenticated ? (
          <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
            Bạn cần đăng nhập để tạo bài viết.
          </div>
        ) : null}

        {/* Title */}
        <div className="mt-2">
          <Input
            placeholder="Tiêu đề bài viết"
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            className="bg-secondary border-none text-foreground placeholder:text-muted-foreground"
            maxLength={FORUM_POST_TITLE_MAX_LENGTH}
          />
          <p className="text-[11px] text-muted-foreground text-right mt-1">
            {title.length}/{FORUM_POST_TITLE_MAX_LENGTH}
          </p>
          {underTitleMin ? (
            <p className="text-[11px] text-destructive">Tiêu đề cần ít nhất {FORUM_POST_TITLE_MIN_LENGTH} ký tự.</p>
          ) : null}
        </div>

        {/* Category */}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Danh mục</label>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="w-full rounded-lg bg-secondary border-none text-sm text-foreground px-3 py-2 outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Chọn danh mục...</option>
            {availableCategories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.icon} {cat.name}</option>
            ))}
          </select>
        </div>

        <div>
          <RichTextEditor
            content={content}
            onUpdate={setContent}
            placeholder="Viết nội dung bài viết..."
            draftKey={CREATE_POST_DRAFT_EDITOR_KEY}
            clearDraftOnUnmount={clearDraftOnClose}
          />
          <p
            className={`mt-1 text-right text-[11px] ${
              overContentLimit ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {contentLength}/{FORUM_POST_MAX_LENGTH}
          </p>
          {underContentMin ? (
            <p className="text-[11px] text-destructive">Nội dung cần ít nhất {FORUM_POST_MIN_LENGTH} ký tự.</p>
          ) : null}
        </div>

        {submitError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {submitError}
          </div>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Giới hạn đăng bài mới: tối thiểu 15 phút giữa mỗi lần đăng.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={() => handleClose()}
            className="text-muted-foreground"
          >
            Hủy
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitButtonLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
