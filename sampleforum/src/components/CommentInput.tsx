import { useEffect, useMemo, useState, memo } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/RichTextEditor";
import { fetchAuthSession } from "@/lib/forum-api";
import { measureForumTextLength } from "@/lib/forum-content";
import { FORUM_COMMENT_MAX_LENGTH, FORUM_COMMENT_MIN_LENGTH } from "@/lib/forum-limits";
import type { AuthSessionUser } from "@/types/forum";

interface CommentInputProps {
  placeholder?: string;
  onSubmit: (content: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  mentionRootCommentId?: number;
  submitting?: boolean;
}

export const CommentInput = memo(function CommentInput({
  placeholder = "Viết bình luận...",
  onSubmit,
  onCancel,
  autoFocus,
  mentionRootCommentId,
  submitting = false,
}: CommentInputProps) {
  const [content, setContent] = useState("");
  const [expanded, setExpanded] = useState(autoFocus || false);
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    const syncSession = async () => {
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

    syncSession();

    const onAuthChanged = () => {
      syncSession();
    };

    window.addEventListener("bfang:auth", onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("bfang:auth", onAuthChanged);
    };
  }, []);

  const avatarUrl = useMemo(() => {
    const fallback = "https://api.dicebear.com/7.x/avataaars/svg?seed=currentuser";
    if (!sessionUser) return fallback;

    const meta =
      sessionUser.user_metadata && typeof sessionUser.user_metadata === "object"
        ? sessionUser.user_metadata
        : null;
    const direct =
      meta && (meta.avatar_url_custom || meta.avatar_url || meta.picture)
        ? String(meta.avatar_url_custom || meta.avatar_url || meta.picture).trim()
        : "";
    if (direct) return direct;

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

    return fallback;
  }, [sessionUser]);

  const handleSubmit = () => {
    if (submitting) return;
    const normalized = (content || "").toString().trim();
    const visibleLength = measureForumTextLength(normalized);
    if (
      normalized &&
      normalized !== "<p></p>" &&
      visibleLength <= FORUM_COMMENT_MAX_LENGTH &&
      visibleLength >= FORUM_COMMENT_MIN_LENGTH
    ) {
      onSubmit(content);
      setContent("");
      if (!autoFocus) setExpanded(false);
    }
  };

  const normalizedContent = (content || "").toString().trim();
  const contentLength = measureForumTextLength(normalizedContent);
  const overLimit = contentLength > FORUM_COMMENT_MAX_LENGTH;
  const underMin = contentLength > 0 && contentLength < FORUM_COMMENT_MIN_LENGTH;
  const invalidLength = contentLength < FORUM_COMMENT_MIN_LENGTH || overLimit;

  return (
    <div className="flex items-start gap-2">
      <img
        src={avatarUrl}
        alt="Avatar"
        className="w-6 h-6 rounded-full shrink-0 mt-0.5"
        referrerPolicy="no-referrer"
      />
      <div className="flex-1 min-w-0">
        {expanded ? (
          <div className="space-y-1.5">
            <RichTextEditor
              content={content}
              onUpdate={setContent}
              placeholder={placeholder}
              compact
              autoFocus={autoFocus}
              minHeight="32px"
              mentionRootCommentId={mentionRootCommentId}
            />
            <div className="flex justify-end gap-1.5">
              <span
                  className={`mr-auto self-center text-[11px] ${
                    overLimit || underMin ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {contentLength}/{FORUM_COMMENT_MAX_LENGTH}
                </span>
              {onCancel && (
                <Button variant="ghost" size="sm" onClick={() => { onCancel(); setExpanded(false); }} className="text-[11px] text-muted-foreground h-6 px-2">
                  Hủy
                </Button>
              )}
                <Button
                size="sm"
                  onClick={handleSubmit}
                  disabled={submitting || !normalizedContent || normalizedContent === "<p></p>" || invalidLength}
                  className="text-[11px] h-6 px-2.5 gap-1"
                >
                <Send className="h-3 w-3" /> {submitting ? "Đang gửi..." : "Gửi"}
              </Button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setExpanded(true)}
            className="w-full text-left rounded-lg bg-secondary border-none text-sm text-muted-foreground px-3 py-2 hover:bg-accent transition-colors"
            disabled={submitting}
          >
            {placeholder}
          </button>
        )}
      </div>
    </div>
  );
});
