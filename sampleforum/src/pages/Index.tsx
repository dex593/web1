import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { CategorySidebar } from "@/components/CategorySidebar";
import { PostCard } from "@/components/PostCard";
import { SortBar, SortOption } from "@/components/SortBar";
import { ForumStats } from "@/components/ForumStats";
import { MobileCategoryDrawer } from "@/components/MobileCategoryDrawer";
import { CreatePostModal } from "@/components/CreatePostModal";
import { LayoutGrid } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { fetchAuthSession, fetchForumHome, fetchForumSavedPosts } from "@/lib/forum-api";
import { openAuthProviderDialog } from "@/lib/auth-login";
import {
  buildForumSections,
  filterPostsBySection,
  mapApiPostToUiPost,
} from "@/lib/forum-presenters";
import type { AuthSessionUser, ForumHomeResponse } from "@/types/forum";

const HOME_PER_PAGE = 20;

const normalizeSortOption = (value: string): SortOption => {
  const raw = (value || "").toString().trim().toLowerCase();
  if (raw === "new" || raw === "most-commented" || raw === "hot") {
    return raw;
  }
  return "hot";
};

const normalizePage = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.floor(parsed);
};

const normalizeSectionSlug = (value: string, availableSlugs: Set<string>): string | null => {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw) return null;

  const aliasMap: Record<string, string> = {
    "goi-y": "gop-y",
    "tin-tuc": "thong-bao",
  };

  const normalized = aliasMap[raw] || raw;
  return availableSlugs.has(normalized) ? normalized : null;
};

const Index = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createPostOpen, setCreatePostOpen] = useState(false);
  const [homeData, setHomeData] = useState<ForumHomeResponse | null>(null);
  const [sessionUser, setSessionUser] = useState<AuthSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savedPosts, setSavedPosts] = useState<ForumHomeResponse["posts"]>([]);
  const [savedPostsLoading, setSavedPostsLoading] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = (searchParams.get("q") || "").trim();
  const activeSort = normalizeSortOption(searchParams.get("sort") || "hot");
  const currentPage = normalizePage(searchParams.get("page") || "1");

  const loadHome = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchForumHome({
        page: currentPage,
        perPage: HOME_PER_PAGE,
        q: searchQuery,
        sort: activeSort,
      });
      setHomeData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể tải dữ liệu diễn đàn.");
    } finally {
      setLoading(false);
    }
  }, [activeSort, currentPage, searchQuery]);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

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

  const sourcePosts = homeData?.posts || [];
  const sectionOptions = useMemo(() => {
    return (homeData?.sections || [])
      .map((section) => ({
        slug: String(section?.slug || "").trim(),
        label: String(section?.label || "").trim(),
        icon: String(section?.icon || "").trim(),
        postCount: Number(section?.postCount) || 0,
      }))
      .filter((section) => section.slug && section.label);
  }, [homeData?.sections]);

  const categories = useMemo(
    () => buildForumSections(sourcePosts, sectionOptions),
    [sectionOptions, sourcePosts]
  );
  const availableSectionSlugs = useMemo(() => new Set(categories.map((item) => item.slug)), [categories]);
  const selectedCategory = useMemo(
    () => normalizeSectionSlug(searchParams.get("section") || "", availableSectionSlugs),
    [availableSectionSlugs, searchParams]
  );

  const handleSelectCategory = useCallback(
    (slug: string | null) => {
      const params = new URLSearchParams(searchParams);
      const normalized = normalizeSectionSlug(slug || "", availableSectionSlugs);

      if (normalized) {
        params.set("section", normalized);
      } else {
        params.delete("section");
      }

      params.delete("page");
      setSearchParams(params);
    },
    [availableSectionSlugs, searchParams, setSearchParams]
  );

  const filteredPosts = useMemo(
    () => filterPostsBySection(sourcePosts, selectedCategory, sectionOptions),
    [sectionOptions, sourcePosts, selectedCategory]
  );

  const sortedPosts = useMemo(() => {
    if (!selectedCategory) {
      return filteredPosts;
    }

    return [...filteredPosts].sort((a, b) => {
      const aPinned = Boolean(a && a.isSticky);
      const bPinned = Boolean(b && b.isSticky);
      if (aPinned === bPinned) return 0;
      return aPinned ? -1 : 1;
    });
  }, [filteredPosts, selectedCategory]);

  const isAuthenticated = Boolean(sessionUser && sessionUser.id);
  const canModerateForum = Boolean(homeData?.viewer?.canModerateForum || homeData?.viewer?.canDeleteAnyComment);

  const loadSavedPosts = useCallback(async () => {
    if (!isAuthenticated) {
      setSavedPosts([]);
      setSavedPostsLoading(false);
      return;
    }

    setSavedPostsLoading(true);
    try {
      const payload = await fetchForumSavedPosts(100);
      setSavedPosts(Array.isArray(payload && payload.posts) ? payload.posts : []);
    } catch (_err) {
      setSavedPosts([]);
    } finally {
      setSavedPostsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setSavedPosts([]);
      return;
    }

    void loadSavedPosts();
  }, [isAuthenticated, loadSavedPosts]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleBookmarkChanged = () => {
      void loadSavedPosts();
    };

    window.addEventListener("bfang:forum-bookmark-changed", handleBookmarkChanged as EventListener);
    return () => {
      window.removeEventListener("bfang:forum-bookmark-changed", handleBookmarkChanged as EventListener);
    };
  }, [isAuthenticated, loadSavedPosts]);

  const visibleSavedPosts = useMemo(() => savedPosts.slice(0, 5), [savedPosts]);
  const hasSavedPosts = savedPosts.length > 0;

  const handleLogin = () => {
    const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    openAuthProviderDialog(next || "/forum");
  };

  const handleOpenCreatePost = () => {
    if (!isAuthenticated) {
      handleLogin();
      return;
    }
    setCreatePostOpen(true);
  };

  const mangaOptions = useMemo(() => {
    const serverOptions = (homeData?.mangaOptions || [])
      .map((item) => ({
        slug: String(item?.slug || "").trim(),
        title: String(item?.title || "").trim(),
      }))
      .filter((item) => item.slug && item.title);
    if (serverOptions.length > 0) {
      return serverOptions;
    }

    const preferred = (homeData?.featuredManga || []).map((item) => ({
      slug: item.slug,
      title: item.title,
    }));
    if (preferred.length > 0) {
      return preferred;
    }

    const unique = new Map<string, string>();
    sourcePosts.forEach((post) => {
      const slug = (post.manga && post.manga.slug ? String(post.manga.slug).trim() : "");
      const title = (post.manga && post.manga.title ? String(post.manga.title).trim() : "");
      if (!slug || !title || unique.has(slug)) return;
      unique.set(slug, title);
    });

    return Array.from(unique.entries()).map(([slug, title]) => ({ slug, title }));
  }, [homeData, sourcePosts]);

  const setPage = useCallback(
    (nextPage: number) => {
      const pageCount = Number(homeData && homeData.pagination && homeData.pagination.pageCount) || 1;
      const clamped = Math.min(Math.max(Math.floor(nextPage), 1), Math.max(pageCount, 1));
      const params = new URLSearchParams(searchParams);
      if (clamped <= 1) {
        params.delete("page");
      } else {
        params.set("page", String(clamped));
      }
      setSearchParams(params);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [homeData, searchParams, setSearchParams]
  );

  const handleSortChange = useCallback(
    (nextSort: SortOption) => {
      const normalized = normalizeSortOption(nextSort);
      const params = new URLSearchParams(searchParams);
      if (normalized === "hot") {
        params.delete("sort");
      } else {
        params.set("sort", normalized);
      }
      params.delete("page");
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const pageItems = useMemo(() => {
    const pageCount = Number(homeData && homeData.pagination && homeData.pagination.pageCount) || 1;
    const page = Number(homeData && homeData.pagination && homeData.pagination.page) || 1;
    if (pageCount <= 1) return [] as Array<number | "ellipsis">;

    if (pageCount <= 7) {
      return Array.from({ length: pageCount }, (_item, index) => index + 1);
    }

    if (page <= 3) {
      return [1, 2, 3, 4, "ellipsis", pageCount];
    }

    if (page >= pageCount - 2) {
      return [1, "ellipsis", pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
    }

    return [1, "ellipsis", page - 1, page, page + 1, "ellipsis", pageCount];
  }, [homeData]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      <div className="mx-auto max-w-7xl px-4 py-4">
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <LayoutGrid className="h-4 w-4" />
          Danh mục
        </button>

        <div className="flex gap-6">
          <CategorySidebar
            categories={categories}
            selectedCategory={selectedCategory}
            onSelectCategory={handleSelectCategory}
          />

          <main className="flex-1 min-w-0 space-y-3">
            <SortBar
              activeSort={activeSort}
              onSortChange={handleSortChange}
              onCreatePost={handleOpenCreatePost}
              createLabel={isAuthenticated ? "Tạo bài viết" : "Đăng nhập để đăng bài"}
            />
            {loading ? (
              <div className="rounded-lg border border-border bg-card p-12 text-center">
                <p className="text-muted-foreground text-sm">Đang tải bài viết...</p>
              </div>
            ) : error ? (
              <div className="rounded-lg border border-border bg-card p-12 text-center space-y-3">
                <p className="text-muted-foreground text-sm">{error}</p>
                <button
                  className="inline-flex items-center rounded-md bg-secondary px-3 py-1.5 text-xs text-foreground hover:bg-accent"
                  onClick={loadHome}
                  type="button"
                >
                  Tải lại
                </button>
              </div>
            ) : sortedPosts.length > 0 ? (
              <>
                {sortedPosts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={mapApiPostToUiPost(post, sectionOptions)}
                    isAuthenticated={isAuthenticated}
                    canModerateForum={canModerateForum}
                    onRequireLogin={handleLogin}
                    onPostDeleted={() => {
                      void loadHome();
                    }}
                  />
                ))}

                {homeData && homeData.pagination && homeData.pagination.pageCount > 1 ? (
                  <div className="pt-2">
                    <Pagination>
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            href="#"
                            onClick={(event) => {
                              event.preventDefault();
                              if (!homeData.pagination.hasPrev) return;
                              setPage((homeData.pagination.page || 1) - 1);
                            }}
                            className={!homeData.pagination.hasPrev ? "pointer-events-none opacity-50" : ""}
                          />
                        </PaginationItem>

                        {pageItems.map((item, index) => {
                          if (item === "ellipsis") {
                            return (
                              <PaginationItem key={`ellipsis-${index}`}>
                                <PaginationEllipsis />
                              </PaginationItem>
                            );
                          }

                          return (
                            <PaginationItem key={`page-${item}`}>
                              <PaginationLink
                                href="#"
                                isActive={item === homeData.pagination.page}
                                onClick={(event) => {
                                  event.preventDefault();
                                  setPage(item);
                                }}
                              >
                                {item}
                              </PaginationLink>
                            </PaginationItem>
                          );
                        })}

                        <PaginationItem>
                          <PaginationNext
                            href="#"
                            onClick={(event) => {
                              event.preventDefault();
                              if (!homeData.pagination.hasNext) return;
                              setPage((homeData.pagination.page || 1) + 1);
                            }}
                            className={!homeData.pagination.hasNext ? "pointer-events-none opacity-50" : ""}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-lg border border-border bg-card p-12 text-center">
                <p className="text-muted-foreground text-sm">Chưa có bài viết nào trong mục này.</p>
              </div>
            )}
          </main>

          <aside className="w-72 shrink-0 hidden xl:block space-y-4">
            <ForumStats
              memberCount={homeData?.stats.memberCount || 0}
              postCount={homeData?.stats.postCount || 0}
              replyCount={homeData?.stats.replyCount || 0}
            />
            <div className="rounded-lg border border-border bg-card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-foreground">Quy tắc diễn đàn</h3>
              <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
                <li>Tôn trọng mọi thành viên</li>
                <li>Không spam hoặc quảng cáo</li>
                <li>Gắn thẻ spoiler khi cần thiết</li>
                <li>Sử dụng đúng danh mục</li>
                <li>Không đăng nội dung vi phạm</li>
              </ol>
            </div>

            {isAuthenticated ? (
              <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">Bài viết đã lưu</h3>
                  {savedPosts.length > 0 ? (
                    <span className="text-[11px] text-muted-foreground">{savedPosts.length} mục</span>
                  ) : null}
                </div>

                {savedPostsLoading ? (
                  <p className="text-xs text-muted-foreground">Đang tải bài viết đã lưu...</p>
                ) : savedPosts.length > 0 ? (
                  <>
                    <div className="space-y-2">
                      {visibleSavedPosts.map((post) => (
                        <Link
                          key={post.id}
                          to={`/post/${encodeURIComponent(String(post.id))}`}
                          className="block rounded-md border border-border/70 bg-secondary/40 px-2.5 py-2 hover:bg-secondary transition-colors"
                        >
                          <p className="text-xs font-medium text-foreground line-clamp-2">{post.title}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {post.timeAgo || "Vừa xong"} · {post.commentCount || 0} phản hồi
                          </p>
                        </Link>
                      ))}
                    </div>

                    {hasSavedPosts ? (
                      <Link
                        to="/saved-posts"
                        className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {`Xem tất cả ${savedPosts.length} mục`}
                      </Link>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Bạn chưa lưu bài viết nào.</p>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      <MobileCategoryDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        categories={categories}
        selectedCategory={selectedCategory}
        onSelectCategory={handleSelectCategory}
      />
      <CreatePostModal
        open={createPostOpen}
        onClose={() => setCreatePostOpen(false)}
        isAuthenticated={isAuthenticated}
        canCreateAnnouncement={Boolean(homeData?.viewer?.canCreateAnnouncement)}
        categories={categories}
        mangaOptions={mangaOptions}
        onRequireLogin={handleLogin}
        onCreated={loadHome}
      />
    </div>
  );
};

export default Index;
