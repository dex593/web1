import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, MoreHorizontal, RefreshCw, Search, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import {
  bulkActionForumAdminComments,
  deleteForumAdminComment,
  fetchForumAdminComments,
  hideForumAdminComment,
  restoreForumAdminComment,
} from "@/lib/forum-api";
import type { ForumAdminCommentSummary } from "@/types/forum";

type ConfirmAction = "delete" | "hide" | "restore";

const PER_PAGE = 20;

const AdminComments = () => {
  const [comments, setComments] = useState<ForumAdminCommentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);

  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    comment?: ForumAdminCommentSummary;
    action?: ConfirmAction;
    isBulk?: boolean;
    ids?: number[];
  }>({ open: false });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [search]);

  const markPending = useCallback((commentId: number, pending: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(commentId);
      } else {
        next.delete(commentId);
      }
      return next;
    });
  }, []);

  const loadComments = useCallback(
    async (manual = false) => {
      if (manual) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");

      try {
        const payload = await fetchForumAdminComments({
          page,
          perPage: PER_PAGE,
          q: debouncedSearch,
          status: "all",
        });

        setComments(Array.isArray(payload.comments) ? payload.comments : []);
        setPageCount(Math.max(1, Number(payload.pagination?.pageCount) || 1));

        const serverPage = Number(payload.pagination?.page) || page;
        if (serverPage !== page) {
          setPage(serverPage);
        }
      } catch (err) {
        setComments([]);
        setError(err instanceof Error ? err.message : "Không thể tải danh sách bình luận.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [debouncedSearch, page]
  );

  useEffect(() => {
    void loadComments(false);
  }, [loadComments]);

  useEffect(() => {
    const commentIdSet = new Set(comments.map((comment) => Number(comment.id)).filter((id) => Number.isFinite(id) && id > 0));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => commentIdSet.has(id)));
      return next;
    });
  }, [comments]);

  const visibleCommentIds = useMemo(
    () => comments.map((comment) => Number(comment.id)).filter((id) => Number.isFinite(id) && id > 0),
    [comments]
  );

  const selectedVisibleCount = useMemo(
    () => visibleCommentIds.filter((id) => selectedIds.has(id)).length,
    [selectedIds, visibleCommentIds]
  );

  const selectAllState: boolean | "indeterminate" = useMemo(() => {
    if (!visibleCommentIds.length || selectedVisibleCount <= 0) return false;
    if (selectedVisibleCount >= visibleCommentIds.length) return true;
    return "indeterminate";
  }, [selectedVisibleCount, visibleCommentIds.length]);

  const selectedCount = selectedIds.size;

  const handleToggleSelectAll = useCallback(
    (checked: boolean | "indeterminate") => {
      const isChecked = checked === true;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (isChecked) {
          visibleCommentIds.forEach((id) => next.add(id));
        } else {
          visibleCommentIds.forEach((id) => next.delete(id));
        }
        return next;
      });
    },
    [visibleCommentIds]
  );

  const handleToggleSelectOne = useCallback((commentId: number, checked: boolean | "indeterminate") => {
    const isChecked = checked === true;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isChecked) {
        next.add(commentId);
      } else {
        next.delete(commentId);
      }
      return next;
    });
  }, []);

  const openConfirm = useCallback((comment: ForumAdminCommentSummary, action: ConfirmAction) => {
    setConfirmDialog({ open: true, comment, action, isBulk: false, ids: [Number(comment.id)] });
  }, []);

  const openBulkConfirm = useCallback(
    (action: "hide" | "delete") => {
      const ids = Array.from(selectedIds);
      if (!ids.length) return;
      setConfirmDialog({
        open: true,
        action,
        isBulk: true,
        ids,
      });
    },
    [selectedIds]
  );

  const handleConfirmAction = useCallback(async () => {
    const comment = confirmDialog.comment;
    const action = confirmDialog.action;
    const isBulk = Boolean(confirmDialog.isBulk);
    const ids = Array.isArray(confirmDialog.ids) ? confirmDialog.ids : [];
    if (!action) return;

    if (isBulk) {
      if ((action !== "hide" && action !== "delete") || !ids.length) {
        setConfirmDialog({ open: false });
        return;
      }

      try {
        setBulkPending(true);
        await bulkActionForumAdminComments(ids, action);
        toast({
          title: action === "hide" ? "Đã ẩn bình luận đã chọn" : "Đã xóa bình luận đã chọn",
          description: `Đã xử lý ${ids.length} bình luận.`,
        });
        setSelectedIds(new Set());
        setConfirmDialog({ open: false });
        await loadComments(true);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Không thể thực hiện thao tác hàng loạt",
          description: err instanceof Error ? err.message : "Vui lòng thử lại.",
        });
      } finally {
        setBulkPending(false);
      }
      return;
    }

    if (!comment) return;
    const commentId = Number(comment.id);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      setConfirmDialog({ open: false });
      return;
    }

    try {
      markPending(commentId, true);

      if (action === "delete") {
        await deleteForumAdminComment(commentId);
        toast({ title: "Đã xóa bình luận" });
      } else if (action === "hide") {
        await hideForumAdminComment(commentId);
        toast({ title: "Đã ẩn bình luận" });
      } else {
        await restoreForumAdminComment(commentId);
        toast({ title: "Đã khôi phục bình luận" });
      }

      setConfirmDialog({ open: false });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(commentId);
        return next;
      });
      await loadComments(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Không thể thực hiện thao tác",
        description: err instanceof Error ? err.message : "Vui lòng thử lại.",
      });
    } finally {
      markPending(commentId, false);
    }
  }, [confirmDialog.action, confirmDialog.comment, confirmDialog.ids, confirmDialog.isBulk, loadComments, markPending]);

  const confirmTitle = useMemo(() => {
    if (confirmDialog.action === "delete") return "Xóa bình luận";
    if (confirmDialog.action === "hide") return "Ẩn bình luận";
    if (confirmDialog.action === "restore") return "Khôi phục bình luận";
    return "Xác nhận";
  }, [confirmDialog.action]);

  const confirmDescription = useMemo(() => {
    if (confirmDialog.isBulk) {
      const targetCount = Array.isArray(confirmDialog.ids) ? confirmDialog.ids.length : 0;
      if (confirmDialog.action === "delete") {
        return `Bạn có chắc muốn xóa ${targetCount} bình luận đã chọn? Hành động này không thể hoàn tác.`;
      }
      if (confirmDialog.action === "hide") {
        return `Bạn có chắc muốn ẩn ${targetCount} bình luận đã chọn? Các phản hồi con liên quan cũng sẽ bị ẩn.`;
      }
      return "Bạn có chắc muốn thực hiện thao tác hàng loạt này?";
    }

    if (confirmDialog.action === "delete") {
      return "Hành động này không thể hoàn tác.";
    }
    if (confirmDialog.action === "hide") {
      return "Bình luận và các trả lời con sẽ được chuyển sang trạng thái ẩn.";
    }
    if (confirmDialog.action === "restore") {
      return "Bình luận và các trả lời con sẽ hiển thị lại.";
    }
    return "Bạn có chắc muốn thực hiện thao tác này?";
  }, [confirmDialog.action, confirmDialog.ids, confirmDialog.isBulk]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Quản lý bình luận</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 w-full sm:w-auto"
          disabled={loading || refreshing || bulkPending}
          onClick={() => {
            void loadComments(true);
          }}
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading || refreshing ? "animate-spin" : ""}`} />
          Làm mới
        </Button>
      </div>

      <Card className="border-border">
        <CardHeader className="space-y-3 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Tìm bình luận..."
              className="h-9 pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full sm:w-auto"
              disabled={selectedCount <= 0 || bulkPending || loading}
              onClick={() => openBulkConfirm("hide")}
            >
              <EyeOff className="mr-2 h-3.5 w-3.5" /> Ẩn đã chọn ({selectedCount})
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-8 w-full sm:w-auto"
              disabled={selectedCount <= 0 || bulkPending || loading}
              onClick={() => openBulkConfirm("delete")}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Xóa đã chọn ({selectedCount})
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {error ? (
            <div className="p-4 text-sm text-red-400">{error}</div>
          ) : (
            <>
              <div className="space-y-3 p-3 md:hidden">
                <div className="flex items-center justify-between rounded-md border border-border bg-secondary/40 px-2 py-1.5">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      aria-label="Chọn tất cả bình luận"
                      checked={selectAllState}
                      onCheckedChange={handleToggleSelectAll}
                      disabled={!visibleCommentIds.length || loading || bulkPending}
                    />
                    Chọn tất cả trong trang
                  </label>
                  <span className="text-[11px] text-muted-foreground">{`${selectedVisibleCount}/${visibleCommentIds.length}`}</span>
                </div>

                {loading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <div key={`comment-mobile-loading-${index}`} className="h-24 animate-pulse rounded-md bg-accent" />
                  ))
                ) : comments.length ? (
                  comments.map((comment) => {
                    const commentId = Number(comment.id);
                    const busy = pendingIds.has(commentId) || bulkPending;
                    return (
                      <div key={`comment-mobile-${comment.id}`} className="rounded-md border border-border p-3">
                        <div className="flex items-start gap-2">
                          <Checkbox
                            aria-label={`Chọn bình luận #${comment.id}`}
                            checked={selectedIds.has(commentId)}
                            onCheckedChange={(checked) => handleToggleSelectOne(commentId, checked)}
                            disabled={busy}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm">{comment.content}</p>
                            <p className="text-[11px] text-muted-foreground">{`#${comment.id} · ${comment.timeAgo}`}</p>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={busy}>
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {comment.status === "hidden" ? (
                                <DropdownMenuItem onClick={() => openConfirm(comment, "restore")}>
                                  <Eye className="mr-2 h-3.5 w-3.5" /> Khôi phục
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onClick={() => openConfirm(comment, "hide")}>
                                  <EyeOff className="mr-2 h-3.5 w-3.5" /> Ẩn bình luận
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="text-destructive" onClick={() => openConfirm(comment, "delete")}>
                                <Trash2 className="mr-2 h-3.5 w-3.5" /> Xóa
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-1">
                          {comment.status === "hidden" ? (
                            <Badge className="border-0 bg-red-500/20 text-red-300 text-xs">Đã ẩn</Badge>
                          ) : (
                            <Badge className="border-0 bg-emerald-500/20 text-emerald-300 text-xs">Hiển thị</Badge>
                          )}
                          {comment.reportCount > 0 ? (
                            <Badge className="border-0 bg-orange-500/20 text-orange-300 text-xs">{`${comment.reportCount} báo cáo`}</Badge>
                          ) : null}
                        </div>

                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {`${comment.author.name} · ${comment.kind === "reply" ? "Trả lời" : "Bình luận"}`}
                        </p>
                        <p className="line-clamp-1 text-[11px] text-muted-foreground">{comment.post.title}</p>
                      </div>
                    );
                  })
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">Không tìm thấy bình luận nào.</div>
                )}
              </div>

              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          aria-label="Chọn tất cả bình luận"
                          checked={selectAllState}
                          onCheckedChange={handleToggleSelectAll}
                          disabled={!visibleCommentIds.length || loading || bulkPending}
                        />
                      </TableHead>
                      <TableHead>Nội dung</TableHead>
                      <TableHead>Tác giả</TableHead>
                      <TableHead className="hidden md:table-cell">Loại</TableHead>
                      <TableHead className="hidden lg:table-cell">Bài viết</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>

                  <TableBody>
                    {loading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={`comment-loading-${index}`}>
                          <TableCell colSpan={7}>
                            <div className="h-4 animate-pulse rounded bg-accent" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : comments.length ? (
                      comments.map((comment) => {
                        const commentId = Number(comment.id);
                        const busy = pendingIds.has(commentId) || bulkPending;
                        return (
                          <TableRow key={comment.id}>
                            <TableCell>
                              <Checkbox
                                aria-label={`Chọn bình luận #${comment.id}`}
                                checked={selectedIds.has(commentId)}
                                onCheckedChange={(checked) => handleToggleSelectOne(commentId, checked)}
                                disabled={busy}
                              />
                            </TableCell>

                            <TableCell className="max-w-[320px]">
                              <div className="space-y-0.5">
                                <p className="truncate text-sm">{comment.content}</p>
                                <p className="text-[11px] text-muted-foreground">{`#${comment.id} · ${comment.timeAgo}`}</p>
                              </div>
                            </TableCell>

                            <TableCell className="text-sm text-muted-foreground">{comment.author.name}</TableCell>

                            <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                              {comment.kind === "reply" ? "Trả lời" : "Bình luận"}
                            </TableCell>

                            <TableCell className="hidden lg:table-cell max-w-[260px] text-sm text-muted-foreground">
                              <p className="truncate">{comment.post.title}</p>
                            </TableCell>

                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {comment.status === "hidden" ? (
                                  <Badge className="border-0 bg-red-500/20 text-red-300 text-xs">Đã ẩn</Badge>
                                ) : (
                                  <Badge className="border-0 bg-emerald-500/20 text-emerald-300 text-xs">Hiển thị</Badge>
                                )}
                                {comment.reportCount > 0 ? (
                                  <Badge className="border-0 bg-orange-500/20 text-orange-300 text-xs">
                                    {`${comment.reportCount} báo cáo`}
                                  </Badge>
                                ) : null}
                              </div>
                            </TableCell>

                            <TableCell>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy}>
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {comment.status === "hidden" ? (
                                    <DropdownMenuItem
                                      onClick={() => {
                                        openConfirm(comment, "restore");
                                      }}
                                    >
                                      <Eye className="mr-2 h-3.5 w-3.5" /> Khôi phục
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onClick={() => {
                                        openConfirm(comment, "hide");
                                      }}
                                    >
                                      <EyeOff className="mr-2 h-3.5 w-3.5" /> Ẩn bình luận
                                    </DropdownMenuItem>
                                  )}

                                  <DropdownMenuItem
                                    className="text-destructive"
                                    onClick={() => {
                                      openConfirm(comment, "delete");
                                    }}
                                  >
                                    <Trash2 className="mr-2 h-3.5 w-3.5" /> Xóa
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                          Không tìm thấy bình luận nào.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">{`Trang ${page}/${Math.max(1, pageCount)}`}</p>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full sm:w-auto"
            disabled={loading || page <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          >
            Trước
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full sm:w-auto"
            disabled={loading || page >= pageCount}
            onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
          >
            Sau
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDialog({ open: false });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTitle}</DialogTitle>
            <DialogDescription>{confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmDialog({ open: false });
              }}
            >
              Hủy
            </Button>
            <Button
              type="button"
              variant={confirmDialog.action === "restore" ? "default" : "destructive"}
              disabled={bulkPending}
              onClick={() => {
                void handleConfirmAction();
              }}
            >
              Xác nhận
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default memo(AdminComments);
