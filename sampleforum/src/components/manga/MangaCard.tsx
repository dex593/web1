import { memo } from "react";
import { Link } from "react-router-dom";
import { Manga } from "@/types/manga";
import { Eye, Users, BookOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MangaCardProps {
  manga: Manga;
  variant?: "grid" | "featured";
}

const statusLabel: Record<string, string> = {
  ongoing: "Đang ra",
  completed: "Hoàn thành",
  hiatus: "Tạm ngưng",
};

const statusColor: Record<string, string> = {
  ongoing: "bg-primary/20 text-primary",
  completed: "bg-emerald-500/20 text-emerald-400",
  hiatus: "bg-yellow-500/20 text-yellow-400",
};

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

export const MangaCard = memo(function MangaCard({ manga, variant = "grid" }: MangaCardProps) {
  if (variant === "featured") {
    return (
      <Link
        to={`/manga/${manga.slug}`}
        className="group relative flex gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent"
      >
        <div className="w-28 shrink-0 overflow-hidden rounded-lg">
          <img
            src={manga.cover}
            alt={manga.title}
            className="h-40 w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        </div>
        <div className="flex flex-1 flex-col justify-between min-w-0 py-1">
          <div>
            <h3 className="text-base font-semibold text-foreground line-clamp-2 group-hover:text-primary transition-colors">
              {manga.title}
            </h3>
            <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">{manga.description}</p>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" /> {formatNumber(manga.viewCount)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> {formatNumber(manga.followCount)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <BookOpen className="h-3.5 w-3.5" /> {manga.totalChapters}
            </span>
            <Badge variant="secondary" className={`ml-auto text-[10px] px-1.5 py-0 ${statusColor[manga.status]}`}>
              {statusLabel[manga.status]}
            </Badge>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      to={`/manga/${manga.slug}`}
      className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/30"
    >
      <div className="relative overflow-hidden aspect-[3/4]">
        <img
          src={manga.cover}
          alt={manga.title}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
        />
        <Badge
          variant="secondary"
          className={`absolute top-2 left-2 text-[10px] px-1.5 py-0 ${statusColor[manga.status]}`}
        >
          {statusLabel[manga.status]}
        </Badge>
        {manga.chapters.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-2 py-1 text-[11px] text-foreground">
            Ch. {manga.chapters[manga.chapters.length - 1].number}
          </div>
        )}
      </div>
      <div className="p-2.5">
        <h3 className="text-sm font-medium text-foreground line-clamp-2 leading-tight group-hover:text-primary transition-colors">
          {manga.title}
        </h3>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
            <Eye className="h-3 w-3" /> {formatNumber(manga.viewCount)}
          </span>
          <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
            <BookOpen className="h-3 w-3" /> {manga.totalChapters}
          </span>
        </div>
      </div>
    </Link>
  );
});
