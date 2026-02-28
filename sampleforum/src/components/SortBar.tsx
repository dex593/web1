import { Button } from "@/components/ui/button";
import { Flame, Clock, MessageSquare, Plus } from "lucide-react";

export type SortOption = "hot" | "new" | "most-commented";

interface SortBarProps {
  activeSort: SortOption;
  onSortChange: (sort: SortOption) => void;
  onCreatePost?: () => void;
  createDisabled?: boolean;
  createLabel?: string;
}

const sortOptions: { value: SortOption; label: string; icon: React.ElementType }[] = [
  { value: "hot", label: "Nổi bật", icon: Flame },
  { value: "new", label: "Mới nhất", icon: Clock },
  { value: "most-commented", label: "Nhiều bình luận", icon: MessageSquare },
];

export function SortBar({
  activeSort,
  onSortChange,
  onCreatePost,
  createDisabled = false,
  createLabel = "Tạo bài viết",
}: SortBarProps) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-1">
        {sortOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSortChange(opt.value)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeSort === opt.value
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            }`}
          >
            <opt.icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        ))}
      </div>
      <Button size="sm" className="gap-1.5 text-xs" onClick={onCreatePost} disabled={createDisabled}>
        <Plus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{createLabel}</span>
      </Button>
    </div>
  );
}
