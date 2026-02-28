import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { MangaCard } from "@/components/manga/MangaCard";
import { mockManga } from "@/data/mockManga";
import { BookOpen, TrendingUp, Clock, Star } from "lucide-react";

const MangaHome = () => {
  const featured = useMemo(() => mockManga.filter((m) => m.isFeatured), []);
  const latest = useMemo(
    () => [...mockManga].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    []
  );
  const popular = useMemo(
    () => [...mockManga].sort((a, b) => b.viewCount - a.viewCount).slice(0, 6),
    []
  );

  const stats = useMemo(() => ({
    totalManga: mockManga.length,
    totalChapters: mockManga.reduce((s, m) => s + m.totalChapters, 0),
    totalViews: mockManga.reduce((s, m) => s + m.viewCount, 0),
  }), []);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Stats bar */}
        <div className="mb-6 flex items-center gap-6 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            <div>
              <p className="text-lg font-bold text-foreground">{stats.totalManga}</p>
              <p className="text-xs text-muted-foreground">Truyện</p>
            </div>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-yellow-500" />
            <div>
              <p className="text-lg font-bold text-foreground">{stats.totalChapters.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Chương</p>
            </div>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-emerald-500" />
            <div>
              <p className="text-lg font-bold text-foreground">
                {stats.totalViews >= 1000000
                  ? `${(stats.totalViews / 1000000).toFixed(1)}M`
                  : stats.totalViews.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">Lượt xem</p>
            </div>
          </div>
        </div>

        {/* Featured */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Star className="h-5 w-5 text-primary" /> Truyện nổi bật
            </h2>
            <Link to="/manga" className="text-xs text-primary hover:underline">
              Xem tất cả →
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {featured.map((m) => (
              <MangaCard key={m.id} manga={m} variant="featured" />
            ))}
          </div>
        </section>

        {/* Latest updates */}
        <section className="mb-8">
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2 mb-4">
            <Clock className="h-5 w-5 text-primary" /> Mới cập nhật
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {latest.map((m) => (
              <MangaCard key={m.id} manga={m} />
            ))}
          </div>
        </section>

        {/* Popular */}
        <section>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2 mb-4">
            <TrendingUp className="h-5 w-5 text-primary" /> Phổ biến nhất
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {popular.map((m) => (
              <MangaCard key={m.id} manga={m} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export default MangaHome;
