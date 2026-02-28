import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { ChapterList } from "@/components/manga/ChapterList";
import { mockManga } from "@/data/mockManga";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BookOpen, Eye, Users, Clock, ChevronDown, ChevronUp, Share2, Bookmark, BookmarkCheck,
} from "lucide-react";

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

const MangaDetail = () => {
  const { slug } = useParams<{ slug: string }>();
  const manga = useMemo(() => mockManga.find((m) => m.slug === slug), [slug]);
  const [descExpanded, setDescExpanded] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);

  if (!manga) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="mx-auto max-w-3xl px-4 py-20 text-center">
          <h1 className="text-xl font-bold text-foreground mb-2">Không tìm thấy truyện</h1>
          <Link to="/manga" className="text-primary text-sm hover:underline">← Quay lại thư viện</Link>
        </div>
      </div>
    );
  }

  const firstChapter = manga.chapters.length > 0 ? manga.chapters[0] : null;
  const lastChapter = manga.chapters.length > 0 ? manga.chapters[manga.chapters.length - 1] : null;

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-5xl px-4 py-6">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
          <Link to="/manga" className="hover:text-foreground transition-colors">Truyện</Link>
          <span>/</span>
          <span className="text-foreground">{manga.title}</span>
        </nav>

        {/* Detail header */}
        <div className="flex gap-5 flex-col sm:flex-row">
          <div className="w-48 shrink-0 self-start">
            <div className="overflow-hidden rounded-xl border border-border">
              <img
                src={manga.cover}
                alt={manga.title}
                className="w-full aspect-[3/4] object-cover"
              />
            </div>
          </div>

          <div className="flex-1 min-w-0 space-y-3">
            <h1 className="text-2xl font-bold text-foreground">{manga.title}</h1>

            {/* Authors */}
            <div className="text-sm text-muted-foreground">
              {manga.authors.map((a, i) => (
                <span key={i}>
                  {a.name}
                  <span className="text-xs opacity-60"> ({a.role === "author" ? "Tác giả" : a.role === "artist" ? "Họa sĩ" : "Dịch giả"})</span>
                  {i < manga.authors.length - 1 && " · "}
                </span>
              ))}
            </div>

            {/* Genres */}
            <div className="flex flex-wrap gap-1.5">
              {manga.genres.map((g) => (
                <Badge key={g.id} variant="secondary" className="text-xs bg-secondary text-muted-foreground">
                  {g.name}
                </Badge>
              ))}
              <Badge variant="secondary" className={`text-xs ${statusColor[manga.status]}`}>
                {statusLabel[manga.status]}
              </Badge>
            </div>

            {/* Stats */}
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><Eye className="h-4 w-4" /> {formatNumber(manga.viewCount)}</span>
              <span className="flex items-center gap-1"><Users className="h-4 w-4" /> {formatNumber(manga.followCount)}</span>
              <span className="flex items-center gap-1"><BookOpen className="h-4 w-4" /> {manga.totalChapters} chương</span>
            </div>

            {/* Description */}
            <div>
              <p className={`text-sm text-muted-foreground leading-relaxed ${!descExpanded ? "line-clamp-3" : ""}`}>
                {manga.description}
              </p>
              <button
                onClick={() => setDescExpanded(!descExpanded)}
                className="mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {descExpanded ? (
                  <><ChevronUp className="h-3 w-3" /> Thu gọn</>
                ) : (
                  <><ChevronDown className="h-3 w-3" /> Xem thêm</>
                )}
              </button>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              {firstChapter && (
                <Button asChild size="sm">
                  <Link to={`/manga/${manga.slug}/chapter/${firstChapter.number}`}>
                    Đọc từ đầu
                  </Link>
                </Button>
              )}
              {lastChapter && lastChapter !== firstChapter && (
                <Button asChild variant="secondary" size="sm">
                  <Link to={`/manga/${manga.slug}/chapter/${lastChapter.number}`}>
                    Chương mới nhất
                  </Link>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => setBookmarked(!bookmarked)}
              >
                {bookmarked ? (
                  <BookmarkCheck className="h-4 w-4 text-primary" />
                ) : (
                  <Bookmark className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={() => navigator.clipboard?.writeText(window.location.href)}
              >
                <Share2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Chapters */}
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-foreground flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-primary" />
              Danh sách chương
              <span className="text-xs text-muted-foreground font-normal">({manga.chapters.length} chương)</span>
            </h2>
          </div>
          <div className="rounded-xl border border-border bg-card p-2">
            <ChapterList mangaSlug={manga.slug} chapters={manga.chapters} />
          </div>
        </section>
      </div>
    </div>
  );
};

export default MangaDetail;
