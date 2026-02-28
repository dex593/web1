import { useState, memo } from "react";

type ReactionType = "like";

export type { ReactionType };

interface ReactionBarProps {
  counts: Record<ReactionType, number>;
  userReaction: ReactionType | null;
  onReact: (type: ReactionType | null) => void;
  hideCounts?: boolean;
}

export const ReactionBar = memo(function ReactionBar({ counts, userReaction, onReact, hideCounts = false }: ReactionBarProps) {
  const [animatingReaction, setAnimatingReaction] = useState<ReactionType | null>(null);
  const totalReactions = Math.max(0, Number(counts.like) || 0);

  const handleReact = (type: ReactionType) => {
    setAnimatingReaction(type);
    setTimeout(() => setAnimatingReaction(null), 600);
    onReact(userReaction === type ? null : type);
  };

  const activeReaction = userReaction === "like";

  return (
    <div className="relative inline-flex items-center">
      <button
        className={`flex items-center gap-1.5 text-xs transition-all px-2.5 py-1.5 rounded-md hover:bg-accent ${
          activeReaction ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
        onClick={() => handleReact("like")}
      >
        <span className={`text-sm leading-none transition-transform ${animatingReaction && activeReaction ? "animate-reaction-pop" : ""}`}>
          👍
        </span>
        <span>Thích</span>
        {!hideCounts && totalReactions > 0 && (
          <span className="text-muted-foreground">{totalReactions}</span>
        )}
      </button>
    </div>
  );
});

export const ReactionSummary = memo(function ReactionSummary({ counts }: { counts: Record<ReactionType, number> }) {
  const total = Math.max(0, Number(counts.like) || 0);
  if (total <= 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-card border border-border text-[11px] leading-none">
        👍
      </span>
      <span className="text-xs text-muted-foreground">{total}</span>
    </div>
  );
});

export function getDefaultReactionCounts(): Record<ReactionType, number> {
  return { like: 0 };
}
