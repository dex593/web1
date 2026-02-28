import { TrendingUp, Users, BookOpen } from "lucide-react";

interface ForumStatsProps {
  memberCount: number;
  postCount: number;
  replyCount: number;
}

const formatCompactNumber = (value: number): string => {
  return new Intl.NumberFormat("vi-VN").format(Math.max(0, Number(value) || 0));
};

export function ForumStats({ memberCount, postCount, replyCount }: ForumStatsProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Thống kê diễn đàn</h3>
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm">
          <Users className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">Thành viên:</span>
          <span className="text-foreground font-medium ml-auto">{formatCompactNumber(memberCount)}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <BookOpen className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">Bài viết:</span>
          <span className="text-foreground font-medium ml-auto">{formatCompactNumber(postCount)}</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <TrendingUp className="h-4 w-4 text-primary" />
          <span className="text-muted-foreground">Bình luận:</span>
          <span className="text-foreground font-medium ml-auto">{formatCompactNumber(replyCount)}</span>
        </div>
      </div>
    </div>
  );
}
