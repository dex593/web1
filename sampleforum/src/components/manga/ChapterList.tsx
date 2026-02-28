import { memo } from "react";
import { Link } from "react-router-dom";
import { Chapter } from "@/types/manga";
import { Clock } from "lucide-react";

interface ChapterListProps {
  mangaSlug: string;
  chapters: Chapter[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 30) return `${Math.floor(days / 30)} tháng trước`;
  if (days > 0) return `${days} ngày trước`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours} giờ trước`;
  return "Vừa xong";
}

export const ChapterList = memo(function ChapterList({ mangaSlug, chapters }: ChapterListProps) {
  const sorted = [...chapters].sort((a, b) => b.number - a.number);

  return (
    <div className="space-y-1">
      {sorted.map((ch) => (
        <Link
          key={ch.id}
          to={`/manga/${mangaSlug}/chapter/${ch.number}`}
          className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-accent group"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium text-foreground group-hover:text-primary transition-colors">
              Chương {ch.number}
            </span>
            {ch.title && (
              <span className="text-muted-foreground text-xs truncate">
                — {ch.title}
              </span>
            )}
          </div>
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 ml-2">
            <Clock className="h-3 w-3" />
            {timeAgo(ch.createdAt)}
          </span>
        </Link>
      ))}
    </div>
  );
});
