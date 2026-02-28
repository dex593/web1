import { useMemo, useState, useEffect, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { mockManga } from "@/data/mockManga";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft, ChevronRight, List, ArrowLeft,
} from "lucide-react";

const ChapterReader = () => {
  const { slug, chapterNumber } = useParams<{ slug: string; chapterNumber: string }>();
  const navigate = useNavigate();
  const chNum = Number(chapterNumber);

  const manga = useMemo(() => mockManga.find((m) => m.slug === slug), [slug]);
  const chapter = useMemo(
    () => manga?.chapters.find((c) => c.number === chNum),
    [manga, chNum]
  );
  const prevChapter = useMemo(
    () => manga?.chapters.find((c) => c.number === chNum - 1),
    [manga, chNum]
  );
  const nextChapter = useMemo(
    () => manga?.chapters.find((c) => c.number === chNum + 1),
    [manga, chNum]
  );

  const [showNav, setShowNav] = useState(true);
  const [showChapterList, setShowChapterList] = useState(false);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && prevChapter) {
        navigate(`/manga/${slug}/chapter/${prevChapter.number}`);
      } else if (e.key === "ArrowRight" && nextChapter) {
        navigate(`/manga/${slug}/chapter/${nextChapter.number}`);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prevChapter, nextChapter, slug, navigate]);

  // Scroll to top on chapter change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [chNum]);

  if (!manga || !chapter) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <div className="mx-auto max-w-3xl px-4 py-20 text-center">
          <h1 className="text-xl font-bold text-foreground mb-2">Không tìm thấy chương</h1>
          <Link to={`/manga/${slug || ""}`} className="text-primary text-sm hover:underline">← Quay lại truyện</Link>
        </div>
      </div>
    );
  }

  const chapterLabel = chapter.title ? `Chương ${chapter.number}: ${chapter.title}` : `Chương ${chapter.number}`;

  const navBar = (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={!prevChapter}
        onClick={() => prevChapter && navigate(`/manga/${slug}/chapter/${prevChapter.number}`)}
        className="gap-1"
      >
        <ChevronLeft className="h-4 w-4" /> Trước
      </Button>

      <button
        onClick={() => setShowChapterList(!showChapterList)}
        className="flex items-center gap-1.5 text-sm text-foreground hover:text-primary transition-colors"
      >
        <List className="h-4 w-4" />
        <span className="hidden sm:inline">{chapterLabel}</span>
        <span className="sm:hidden">Ch. {chapter.number}</span>
      </button>

      <Button
        variant="ghost"
        size="sm"
        disabled={!nextChapter}
        onClick={() => nextChapter && navigate(`/manga/${slug}/chapter/${nextChapter.number}`)}
        className="gap-1"
      >
        Sau <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-black">
      {/* Top bar */}
      <div className="sticky top-0 z-40 bg-card/95 backdrop-blur border-b border-border">
        <div className="mx-auto max-w-4xl px-4 py-2">
          <div className="flex items-center gap-3 mb-2">
            <Link
              to={`/manga/${slug}`}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" /> {manga.title}
            </Link>
          </div>
          {navBar}

          {/* Chapter dropdown */}
          {showChapterList && (
            <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-border bg-card p-2 space-y-0.5">
              {[...manga.chapters].sort((a, b) => b.number - a.number).map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => {
                    navigate(`/manga/${slug}/chapter/${ch.number}`);
                    setShowChapterList(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                    ch.number === chNum
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  Chương {ch.number} {ch.title ? `— ${ch.title}` : ""}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pages */}
      <div className="mx-auto max-w-3xl">
        {chapter.pageUrls.map((url, i) => (
          <img
            key={i}
            src={url}
            alt={`Trang ${i + 1}`}
            className="w-full"
            loading={i < 3 ? "eager" : "lazy"}
          />
        ))}
      </div>

      {/* Bottom nav */}
      <div className="mx-auto max-w-4xl px-4 py-4">
        {navBar}
      </div>
    </div>
  );
};

export default ChapterReader;
