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
import { cancelForumPostDraft, createForumPostDraft, submitForumPost } from "@/lib/forum-api";
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

interface CreatePostModalProps {
  open: boolean;
  onClose: () => void;
  isAuthenticated: boolean;
  canCreateAnnouncement?: boolean;
  categories: Category[];
  mangaOptions: Array<{ slug: string; title: string }>;
  onRequireLogin?: () => void;
  onCreated?: () => void;
}

export function CreatePostModal({
  open,
  onClose,
  isAuthenticated,
  canCreateAnnouncement = false,
  categories,
  mangaOptions,
  onRequireLogin,
  onCreated,
}: CreatePostModalProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [postDraftToken, setPostDraftToken] = useState("");
  const defaultMangaSlug = (mangaOptions[0]?.slug || "").trim();

  useEffect(() => {
    if (!open || !isAuthenticated || postDraftToken) return;
    const fallbackSlug = defaultMangaSlug;
    if (!fallbackSlug) return;
    let cancelled = false;

    createForumPostDraft(fallbackSlug)
      .then((payload) => {
        if (cancelled) return;
        const token = (payload && payload.token ? String(payload.token) : "").trim();
        if (token) {
          setPostDraftToken(token);
        }
      })
      .catch(() => null);

    return () => {
      cancelled = true;
    };
  }, [defaultMangaSlug, open, isAuthenticated, postDraftToken]);

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
    setPostDraftToken("");
  };

  const handleClose = ({ skipDraftCancel = false }: { skipDraftCancel?: boolean } = {}) => {
    const token = (postDraftToken || "").trim();
    if (token && !skipDraftCancel) {
      void cancelForumPostDraft(token).catch(() => null);
    }
    onClose();
    resetForm();
  };

  const handleSubmit = async () => {
    if (!isAuthenticated) {
      if (typeof onRequireLogin === "function") {
        onRequireLogin();
      }
      return;
    }

    const mangaSlug = defaultMangaSlug;
    if (!mangaSlug) {
      setSubmitError("Chưa có dữ liệu truyện nền để đăng bài.");
      return;
    }

    const payloadContent = content;

    try {
      setSubmitting(true);
      setSubmitError("");
      await submitForumPost({
        mangaSlug,
        title,
        content: payloadContent,
        draftToken: postDraftToken,
        categorySlug: selectedCategory,
      });

      localStorage.removeItem("draft_create-post");
      handleClose({ skipDraftCancel: true });
      if (typeof onCreated === "function") {
        onCreated();
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Không thể đăng bài. Vui lòng thử lại.");
    } finally {
      setSubmitting(false);
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
            onChange={(e) => setTitle(e.target.value)}
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
            draftKey="create-post"
            mangaSlug={defaultMangaSlug}
            postDraftToken={postDraftToken}
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

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            onClick={() => handleClose()}
            className="text-muted-foreground"
          >
            Hủy
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || submitting || !defaultMangaSlug || !isAuthenticated}>
            {submitting ? "Đang đăng..." : "Đăng bài"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
