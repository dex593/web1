import { memo, useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, FileText, Flag, MessageSquare, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchForumAdminOverview } from "@/lib/forum-api";
import type { ForumAdminOverviewResponse } from "@/types/forum";

const AdminDashboard = () => {
  const [payload, setPayload] = useState<ForumAdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextPayload = await fetchForumAdminOverview();
      setPayload(nextPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thể tải tổng quan quản trị.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const stats = payload
    ? [
        {
          label: "Tổng bài viết",
          value: payload.stats.totalPosts,
          icon: FileText,
          color: "text-blue-400",
        },
        {
          label: "Bài viết hiển thị",
          value: payload.stats.visiblePosts,
          icon: Eye,
          color: "text-emerald-400",
        },
        {
          label: "Bài viết đã ẩn",
          value: payload.stats.hiddenPosts,
          icon: EyeOff,
          color: "text-orange-400",
        },
        {
          label: "Bình luận",
          value: payload.stats.totalReplies,
          icon: MessageSquare,
          color: "text-cyan-400",
        },
        {
          label: "Báo cáo",
          value: payload.stats.totalReports,
          icon: Flag,
          color: "text-rose-400",
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Tổng quan diễn đàn</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={() => {
            void loadOverview();
          }}
          disabled={loading}
        >
          <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Làm mới
        </Button>
      </div>

      {error ? (
        <Card className="border-border">
          <CardContent className="p-4 text-sm text-red-400">{error}</CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(loading ? Array.from({ length: 5 }) : stats).map((item, index) => {
          if (loading || !item) {
            return (
              <Card key={`skeleton-${index}`} className="border-border">
                <CardContent className="p-4">
                  <div className="h-4 w-20 animate-pulse rounded bg-accent" />
                  <div className="mt-2 h-6 w-12 animate-pulse rounded bg-accent" />
                </CardContent>
              </Card>
            );
          }

          return (
            <Card key={item.label} className="border-border">
              <CardContent className="flex items-center gap-3 p-4">
                <div className={`rounded-md bg-accent p-2 ${item.color}`}>
                  <item.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className="text-lg font-semibold">{item.value.toLocaleString("vi-VN")}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Bài viết gần đây</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={`latest-skeleton-${index}`} className="h-10 animate-pulse rounded bg-accent" />
              ))}
            </div>
          ) : payload && payload.latestPosts.length > 0 ? (
            <div className="space-y-2">
              {payload.latestPosts.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.authorName} · {item.sectionLabel} · {item.status === "hidden" ? "Đã ẩn" : "Hiển thị"}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">{item.timeAgo}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Chưa có bài viết diễn đàn.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default memo(AdminDashboard);
