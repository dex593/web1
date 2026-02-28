import { useState, useMemo, useCallback } from "react";
import { Navbar } from "@/components/Navbar";
import { MangaCard } from "@/components/manga/MangaCard";
import { GenreFilter } from "@/components/manga/GenreFilter";
import { mockManga, genres } from "@/data/mockManga";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

const MangaLibrary = () => {
  const [query, setQuery] = useState("");
  const [included, setIncluded] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);

  const handleToggle = useCallback((genreId: string) => {
    setIncluded((prev) => {
      if (prev.includes(genreId)) {
        // Move to excluded
        setExcluded((ex) => [...ex, genreId]);
        return prev.filter((id) => id !== genreId);
      }
      // Check if excluded
      setExcluded((ex) => {
        if (ex.includes(genreId)) {
          return ex.filter((id) => id !== genreId);
        }
        return ex;
      });
      if (excluded.includes(genreId)) return prev; // just removing from excluded
      return [...prev, genreId];
    });
  }, [excluded]);

  const handleClear = useCallback(() => {
    setIncluded([]);
    setExcluded([]);
  }, []);

  const filtered = useMemo(() => {
    let result = mockManga;
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (m) => m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)
      );
    }
    if (included.length > 0) {
      result = result.filter((m) =>
        included.every((gid) => m.genres.some((g) => g.id === gid))
      );
    }
    if (excluded.length > 0) {
      result = result.filter((m) =>
        !excluded.some((gid) => m.genres.some((g) => g.id === gid))
      );
    }
    return result;
  }, [query, included, excluded]);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-7xl px-4 py-6">
        <h1 className="text-xl font-bold text-foreground mb-4">Thư viện truyện</h1>

        {/* Search */}
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Tìm kiếm truyện..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9 bg-card border-border h-9 text-sm"
          />
        </div>

        {/* Genre filter */}
        <div className="mb-6 rounded-xl border border-border bg-card p-4">
          <GenreFilter
            genres={genres}
            included={included}
            excluded={excluded}
            onToggle={handleToggle}
            onClear={handleClear}
          />
        </div>

        {/* Results */}
        {filtered.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {filtered.map((m) => (
              <MangaCard key={m.id} manga={m} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-12 text-center">
            <p className="text-muted-foreground text-sm">Không tìm thấy truyện nào phù hợp.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default MangaLibrary;
