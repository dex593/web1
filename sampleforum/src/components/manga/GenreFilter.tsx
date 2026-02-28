import { memo } from "react";
import { Genre } from "@/types/manga";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

interface GenreFilterProps {
  genres: Genre[];
  included: string[];
  excluded: string[];
  onToggle: (genreId: string) => void;
  onClear: () => void;
}

export const GenreFilter = memo(function GenreFilter({
  genres,
  included,
  excluded,
  onToggle,
  onClear,
}: GenreFilterProps) {
  const hasFilters = included.length > 0 || excluded.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Thể loại</h3>
        {hasFilters && (
          <button
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" /> Xóa bộ lọc
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {genres.map((genre) => {
          const isIncluded = included.includes(genre.id);
          const isExcluded = excluded.includes(genre.id);
          let className = "cursor-pointer text-xs transition-colors ";
          if (isIncluded) {
            className += "bg-primary/20 text-primary border-primary/30 hover:bg-primary/30";
          } else if (isExcluded) {
            className += "bg-destructive/20 text-destructive line-through border-destructive/30 hover:bg-destructive/30";
          } else {
            className += "bg-secondary text-muted-foreground border-border hover:bg-accent hover:text-foreground";
          }
          return (
            <Badge
              key={genre.id}
              variant="outline"
              className={className}
              onClick={() => onToggle(genre.id)}
            >
              {genre.name}
            </Badge>
          );
        })}
      </div>
      {hasFilters && (
        <p className="text-[11px] text-muted-foreground">
          Nhấn 1 lần = chọn, nhấn lần 2 = loại trừ, nhấn lần 3 = bỏ
        </p>
      )}
    </div>
  );
});
