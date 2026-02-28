import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { PostCard } from "@/components/PostCard";
import { fetchAuthSession, fetchForumSavedPosts } from "@/lib/forum-api";
import { openAuthProviderDialog } from "@/lib/auth-login";
import { mapApiPostToUiPost } from "@/lib/forum-presenters";
import type { AuthSessionUser, ForumApiPostSummary } from "@/types/forum";

const SavedPosts = () => {
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [savedPosts, setSavedPosts] = useState<ForumApiPostSummary[]>([]);
  const [canModerateForum, setCanModerateForum] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAuthenticated = Boolean(sessionUser && sessionUser.id);

  const loadSavedPosts = useCallback(async () => {
    if (!isAuthenticated) {
      setSavedPosts([]);
      setCanModerateForum(false);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const payload = await fetchForumSavedPosts(100);
      setSavedPosts(Array.isArray(payload && payload.posts) ? payload.posts : []);
      setCanModerateForum(Boolean(payload?.viewer?.canModerateForum || payload?.viewer?.canDeleteAnyComment));
    } catch (err) {
      setSavedPosts([]);
      setCanModerateForum(false);
      setError(err instanceof Error ? err.message : "Không thể tải danh sách bài viết đã lưu.");
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

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
      } finally {
        if (!cancelled) {
          setIsLoadingSession(false);
        }
      }
    };

    loadSession();

    const onAuthChanged = () => {
      void loadSession();
    };

    window.addEventListener("bfang:auth", onAuthChanged);

    return () => {
      cancelled = true;
      window.removeEventListener("bfang:auth", onAuthChanged);
    };
  }, []);

  useEffect(() => {
    if (isLoadingSession) return;
    void loadSavedPosts();
  }, [isLoadingSession, loadSavedPosts]);

  useEffect(() => {
    if (!isAuthenticated || isLoadingSession) return;

    const handleBookmarkChanged = () => {
      void loadSavedPosts();
    };

    window.addEventListener("bfang:forum-bookmark-changed", handleBookmarkChanged as EventListener);
    return () => {
      window.removeEventListener("bfang:forum-bookmark-changed", handleBookmarkChanged as EventListener);
    };
  }, [isAuthenticated, isLoadingSession, loadSavedPosts]);

  const handleLogin = () => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    openAuthProviderDialog(next || "/forum/saved-posts");
  };

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      <div className="mx-auto max-w-5xl px-4 py-4 space-y-3">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Bộ sưu tập cá nhân</p>
              <h1 className="mt-1 text-lg font-semibold text-foreground">Bài viết đã lưu</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {isAuthenticated ? `${savedPosts.length} bài viết` : "Đăng nhập để xem danh sách bài viết đã lưu."}
              </p>
            </div>

            <Link
              to="/"
              className="inline-flex items-center rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Quay lại diễn đàn
            </Link>
          </div>
        </section>

        {isLoadingSession ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">Đang kiểm tra phiên đăng nhập...</p>
          </div>
        ) : !isAuthenticated ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Bạn cần đăng nhập để xem bài viết đã lưu.</p>
            <button
              type="button"
              onClick={handleLogin}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              Đăng nhập
            </button>
          </div>
        ) : loading ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">Đang tải bài viết đã lưu...</p>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              type="button"
              onClick={() => {
                void loadSavedPosts();
              }}
              className="inline-flex items-center rounded-md bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent"
            >
              Tải lại
            </button>
          </div>
        ) : savedPosts.length > 0 ? (
          savedPosts.map((post) => (
            <PostCard
              key={post.id}
              post={mapApiPostToUiPost(post)}
              isAuthenticated={isAuthenticated}
              canModerateForum={canModerateForum}
              onRequireLogin={handleLogin}
              onPostDeleted={() => {
                void loadSavedPosts();
              }}
            />
          ))
        ) : (
          <div className="rounded-lg border border-border bg-card p-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">Bạn chưa lưu bài viết nào.</p>
            <p className="text-xs text-muted-foreground">Nhấn nút Lưu ở bài viết bạn quan tâm để thêm vào danh sách này.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SavedPosts;
