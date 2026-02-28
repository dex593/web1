import { Category } from "@/types/forum";

interface CategorySidebarProps {
  categories: Category[];
  selectedCategory: string | null;
  onSelectCategory: (slug: string | null) => void;
}

export function CategorySidebar({ categories, selectedCategory, onSelectCategory }: CategorySidebarProps) {
  return (
    <aside className="w-64 shrink-0 hidden lg:block">
      <div className="sticky top-[72px] space-y-1">
        <h3 className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Danh mục
        </h3>
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
            selectedCategory === null
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
        >
          <span>🏠</span>
          <span>Tất cả</span>
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onSelectCategory(cat.slug)}
            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
              selectedCategory === cat.slug
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <div className="flex items-center gap-3">
              <span>{cat.icon}</span>
              <span className="truncate">{cat.name}</span>
            </div>
            <span className="text-xs text-muted-foreground">{cat.postCount}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
