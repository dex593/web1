import { X } from "lucide-react";
import { Category } from "@/types/forum";

interface MobileCategoryDrawerProps {
  open: boolean;
  onClose: () => void;
  categories: Category[];
  selectedCategory: string | null;
  onSelectCategory: (slug: string | null) => void;
}

export function MobileCategoryDrawer({ open, onClose, categories, selectedCategory, onSelectCategory }: MobileCategoryDrawerProps) {
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden" onClick={onClose} />
      <div className="fixed inset-y-0 left-0 z-50 w-72 bg-card border-r border-border p-4 lg:hidden overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Danh mục</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-1">
          <button
            onClick={() => { onSelectCategory(null); onClose(); }}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              selectedCategory === null ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary"
            }`}
          >
            🏠 Tất cả
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => { onSelectCategory(cat.slug); onClose(); }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedCategory === cat.slug ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary"
              }`}
            >
              <span>{cat.icon} {cat.name}</span>
              <span className="text-xs text-muted-foreground">{cat.postCount}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
