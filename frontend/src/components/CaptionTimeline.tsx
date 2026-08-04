import * as ScrollArea from "@radix-ui/react-scroll-area";
import type { ReactNode } from "react";

import { computeMissingTokens, normalizeToken } from "../lib/missing";
import type { CaptionChunk } from "../types";
import { formatClock } from "../utils";

/**
 * Render text with any word that maps to a missing gloss token highlighted.
 * The red is paired with a dotted underline so it is not conveyed by color
 * alone (per ACCESSIBILITY_GUIDE.md).
 */
function highlightMissing(text: string, missing: Set<string>): ReactNode {
  if (!missing.size) return text;
  return text.split(/(\s+)/).map((part, index) => {
    if (!part || /^\s+$/.test(part)) return part;
    const norm = normalizeToken(part);
    if (norm && missing.has(norm)) {
      return (
        <span key={index} className="text-danger underline decoration-dotted">
          {part}
        </span>
      );
    }
    return part;
  });
}

interface CaptionTimelineProps {
  chunks: CaptionChunk[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  mode?: "english" | "asl";
  emptyMessage?: string;
}

export default function CaptionTimeline({
  chunks,
  selectedIndex,
  onSelect,
  mode = "english",
  emptyMessage = "No finalized captions are available yet.",
}: CaptionTimelineProps) {
  if (!chunks.length) {
    return (
      <div className="grid min-h-48 place-items-center border border-border bg-background/40 px-6 text-center">
        <div>
          <p className="text-sm font-bold tracking-tight text-foreground">No transcript yet</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea.Root className="h-[min(58vh,620px)] overflow-hidden">
      <ScrollArea.Viewport className="size-full">
        <ol aria-label="Finalized caption timeline">
          {chunks.map((chunk, index) => {
            const gloss = chunk.gloss.join(" ");
            const primary = mode === "asl" ? gloss || "No matched ASL vocabulary" : chunk.text;
            const secondary = mode === "asl" ? chunk.text : gloss;
            const missing = computeMissingTokens(chunk);

            return (
              <li key={`${chunk.session_id}-${chunk.chunk_index}`} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  className={`focus-ring grid w-full grid-cols-[60px_minmax(0,1fr)_44px] gap-3 px-3 py-3 text-left transition-colors sm:grid-cols-[72px_minmax(0,1fr)_52px] ${
                    selectedIndex === index
                      ? "bg-surface-active"
                      : "bg-background/20 hover:bg-surface/80"
                  }`}
                  onClick={() => onSelect(index)}
                  aria-pressed={selectedIndex === index}
                >
                  <span className="pt-0.5 font-mono text-[11px] leading-4 text-muted">
                    <span className="block text-foreground/70">{formatClock(chunk.video_time_offset)}</span>
                    {formatClock(chunk.video_time_end)}
                  </span>
                  <span className="min-w-0">
                    <strong
                      className={`block leading-5 tracking-tight ${
                        mode === "asl"
                          ? "font-mono text-xs font-medium text-accent"
                          : "text-sm font-semibold text-foreground"
                      }`}
                    >
                      {highlightMissing(primary || "No transcript text", missing)}
                    </strong>
                    {secondary && (
                      <span
                        className={`mt-1 block truncate ${
                          mode === "asl"
                            ? "text-xs text-muted"
                            : "font-mono text-[11px] uppercase tracking-wide text-muted"
                        }`}
                      >
                        {secondary}
                      </span>
                    )}
                  </span>
                  <span className="pt-0.5 text-right font-mono text-[11px] text-muted">
                    <span className={chunk.clips.length ? "block text-accent" : "block"}>
                      {chunk.clips.length}
                    </span>
                    clips
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none border-l border-border/30 bg-background p-0.5"
      >
        <ScrollArea.Thumb className="relative flex-1 rounded-full bg-surface-active" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
