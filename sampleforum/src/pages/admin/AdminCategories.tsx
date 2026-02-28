import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import {
  createForumAdminCategory,
  deleteForumAdminCategory,
  fetchForumAdminCategories,
  updateForumAdminCategory,
} from "@/lib/forum-api";
import type { ForumAdminCategorySummary } from "@/types/forum";

const sortCategories = (items: ForumAdminCategorySummary[]) => {
  return [...items].sort((left, right) => {
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return left.slug.localeCompare(right.slug);
  });
};

const AdminCategories = () => {
  const [categories, setCategories] = useState<ForumAdminCategorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [pendingSlugs, setPendingSlugs] = useState<Set<string>>(new Set());

  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    mode: "create" | "edit";
    category?: ForumAdminCategorySummary;
  }>({ open: false, mode: "edit" });
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    category?: ForumAdminCategorySummary;
  }>({ open: false });
  const [editLabel, setEditLabel] = useState("");
  const [editIcon, setEditIcon] = useState("");

  const markPending = useCallback((slug: string, pending: boolean) => {
    setPendingSlugs((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
  }, []);

  const loadCategories = useCallback(async (manual = false) => {
    if (manual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const payload = await fetchForumAdminCategories();
      const list = Array.isArray(payload.categories) ? payload.categories : [];
      setCategories(sortCategories(list));
    } catch (err) {
      setCategories([]);
      setError(err instanceof Error ? err.message : "Không thể tải danh mục diễn đàn.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadCategories(false);
  }, [loadCategories]);

  const updateCategory = useCallback(
    async (
      category: ForumAdminCategorySummary,
      payload: {
        label?: string;
        icon?: string;
        visible?: boolean;
        sortOrder?: number;
      },
      successTitle: string,
      successDescription?: string
    ) => {
      try {
        markPending(category.slug, true);
        await updateForumAdminCategory(category.slug, payload);
        toast({
          title: successTitle,
          description: successDescription,
        });
        await loadCategories(true);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Không thể cập nhật danh mục",
          description: err instanceof Error ? err.message : "Vui lòng thử lại.",
        });
      } finally {
        markPending(category.slug, false);
      }
    },
    [loadCategories, markPending]
  );

  const handleToggleVisibility = useCallback(
    async (category: ForumAdminCategorySummary, visible: boolean) => {
      await updateCategory(
        category,
        { visible },
        visible ? "Đã bật danh mục" : "Đã ẩn danh mục",
        category.label
      );
    },
    [updateCategory]
  );

  const openCreateDialog = useCallback(() => {
    setEditLabel("");
    setEditIcon("💬");
    setEditDialog({ open: true, mode: "create" });
  }, []);

  const openEditDialog = useCallback((category: ForumAdminCategorySummary) => {
    setEditLabel(category.label);
    setEditIcon(category.icon);
    setEditDialog({ open: true, mode: "edit", category });
  }, []);

  const handleSaveEdit = useCallback(async () => {
    const nextLabel = editLabel.trim();
    const nextIcon = editIcon.trim();
    if (!nextLabel) {
      toast({
        variant: "destructive",
        title: "Tên danh mục không hợp lệ",
        description: "Vui lòng nhập tên danh mục.",
      });
      return;
    }

    if (editDialog.mode === "create") {
      try {
        await createForumAdminCategory({
          label: nextLabel,
          icon: nextIcon,
        });
        toast({
          title: "Đã thêm danh mục",
          description: nextLabel,
        });
        setEditDialog({ open: false, mode: "edit" });
        await loadCategories(true);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Không thể thêm danh mục",
          description: err instanceof Error ? err.message : "Vui lòng thử lại.",
        });
      }
      return;
    }

    const category = editDialog.category;
    if (!category) return;

    await updateCategory(
      category,
      {
        label: nextLabel,
        icon: nextIcon,
      },
      "Đã lưu danh mục",
      nextLabel
    );
    setEditDialog({ open: false, mode: "edit" });
  }, [editDialog.category, editDialog.mode, editIcon, editLabel, loadCategories, updateCategory]);

  const handleDeleteCategory = useCallback(async () => {
    const category = deleteDialog.category;
    if (!category) return;

    try {
      markPending(category.slug, true);
      await deleteForumAdminCategory(category.slug);
      toast({
        title: "Đã xóa danh mục",
        description: category.label,
      });
      setDeleteDialog({ open: false });
      await loadCategories(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Không thể xóa danh mục",
        description: err instanceof Error ? err.message : "Vui lòng thử lại.",
      });
    } finally {
      markPending(category.slug, false);
    }
  }, [deleteDialog.category, loadCategories, markPending]);

  const moveCategory = useCallback(
    async (slug: string, direction: "up" | "down") => {
      const ordered = sortCategories(categories);
      const index = ordered.findIndex((item) => item.slug === slug);
      if (index < 0) return;

      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= ordered.length) return;

      const current = ordered[index];
      const target = ordered[targetIndex];
      try {
        markPending(current.slug, true);
        markPending(target.slug, true);

        await updateForumAdminCategory(current.slug, { sortOrder: target.sortOrder });
        await updateForumAdminCategory(target.slug, { sortOrder: current.sortOrder });

        toast({
          title: "Đã cập nhật thứ tự danh mục",
          description: `${current.label} ${direction === "up" ? "lên" : "xuống"} 1 bậc`,
        });
        await loadCategories(true);
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Không thể đổi thứ tự",
          description: err instanceof Error ? err.message : "Vui lòng thử lại.",
        });
      } finally {
        markPending(current.slug, false);
        markPending(target.slug, false);
      }
    },
    [categories, loadCategories, markPending]
  );

  const orderedCategories = useMemo(() => sortCategories(categories), [categories]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Quản lý danh mục</h2>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            type="button"
            size="sm"
            className="h-8 flex-1 sm:flex-none"
            onClick={openCreateDialog}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Thêm danh mục
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 flex-1 sm:flex-none"
            disabled={loading || refreshing}
            onClick={() => {
              void loadCategories(true);
            }}
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading || refreshing ? "animate-spin" : ""}`} />
            Làm mới
          </Button>
        </div>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          {error ? (
            <div className="p-4 text-sm text-red-400">{error}</div>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={`category-loading-${index}`} className="h-12 animate-pulse rounded bg-accent" />
              ))}
            </div>
          ) : orderedCategories.length ? (
            <div className="divide-y divide-border">
              {orderedCategories.map((category, index) => {
                const busy = pendingSlugs.has(category.slug);
                return (
                  <div key={category.slug} className="px-4 py-3">
                    <div className="hidden items-center gap-3 md:flex">
                      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" />

                      <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-base">
                        {category.icon || "💬"}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium">{category.label}</p>
                          <Badge variant="outline" className="text-[11px] text-muted-foreground">
                            {category.slug}
                          </Badge>
                          {category.isSystem ? (
                            <Badge className="border-0 bg-blue-500/20 text-blue-300 text-xs">Hệ thống</Badge>
                          ) : null}
                          {!category.visible ? (
                            <Badge className="border-0 bg-zinc-500/20 text-zinc-300 text-xs">Đang ẩn</Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {`${category.postCount.toLocaleString("vi-VN")} bài viết · ${category.hiddenPostCount.toLocaleString("vi-VN")} bài ẩn · ${category.reportCount.toLocaleString("vi-VN")} báo cáo`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {category.lastPostTimeAgo ? `Hoạt động gần nhất ${category.lastPostTimeAgo}` : "Chưa có bài viết"}
                        </p>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={busy || index === 0}
                          onClick={() => {
                            void moveCategory(category.slug, "up");
                          }}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={busy || index === orderedCategories.length - 1}
                          onClick={() => {
                            void moveCategory(category.slug, "down");
                          }}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>

                        <Switch
                          checked={category.visible}
                          disabled={busy}
                          onCheckedChange={(checked) => {
                            void handleToggleVisibility(category, checked);
                          }}
                        />

                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={busy}
                          onClick={() => {
                            openEditDialog(category);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>

                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          disabled={busy || category.isSystem}
                          onClick={() => {
                            setDeleteDialog({ open: true, category });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    <div className="md:hidden">
                      <div className="flex items-start gap-3">
                        <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-base">
                          {category.icon || "💬"}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">{category.label}</p>
                            <Badge variant="outline" className="max-w-full break-all text-[11px] text-muted-foreground">
                              {category.slug}
                            </Badge>
                            {category.isSystem ? (
                              <Badge className="border-0 bg-blue-500/20 text-blue-300 text-xs">Hệ thống</Badge>
                            ) : null}
                            {!category.visible ? (
                              <Badge className="border-0 bg-zinc-500/20 text-zinc-300 text-xs">Đang ẩn</Badge>
                            ) : null}
                          </div>

                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {`${category.postCount.toLocaleString("vi-VN")} bài viết · ${category.hiddenPostCount.toLocaleString("vi-VN")} bài ẩn · ${category.reportCount.toLocaleString("vi-VN")} báo cáo`}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {category.lastPostTimeAgo ? `Hoạt động gần nhất ${category.lastPostTimeAgo}` : "Chưa có bài viết"}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2 py-1">
                          <span className="text-[11px] text-muted-foreground">Hiển thị</span>
                          <Switch
                            checked={category.visible}
                            disabled={busy}
                            onCheckedChange={(checked) => {
                              void handleToggleVisibility(category, checked);
                            }}
                          />
                        </div>

                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={busy || index === 0}
                            onClick={() => {
                              void moveCategory(category.slug, "up");
                            }}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={busy || index === orderedCategories.length - 1}
                            onClick={() => {
                              void moveCategory(category.slug, "down");
                            }}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => {
                              openEditDialog(category);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            disabled={busy || category.isSystem}
                            onClick={() => {
                              setDeleteDialog({ open: true, category });
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">Không có danh mục nào.</div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={editDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setEditDialog({ open: false, mode: "edit" });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editDialog.mode === "create" ? "Thêm danh mục" : "Chỉnh sửa danh mục"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Tên danh mục</label>
              <Input value={editLabel} className="h-9" onChange={(event) => setEditLabel(event.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">Icon (emoji)</label>
              <Input value={editIcon} className="h-9 w-24" onChange={(event) => setEditIcon(event.target.value)} />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setEditDialog({ open: false, mode: "edit" });
              }}
            >
              Hủy
            </Button>
            <Button type="button" onClick={() => void handleSaveEdit()}>
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteDialog({ open: false });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xóa danh mục</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {`Bạn có chắc muốn xóa danh mục "${deleteDialog.category?.label || ""}"?`}
          </DialogDescription>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDeleteDialog({ open: false });
              }}
            >
              Hủy
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleDeleteCategory()}>
              Xóa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default memo(AdminCategories);
