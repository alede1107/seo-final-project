import * as ScrollArea from "@radix-ui/react-scroll-area";

import type { CaptionChunk } from "../types";
import { formatClock } from "../utils";

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
      <div className="grid min-h-48 place-items-center border border-white/10 bg-neutral-950/40 px-6 text-center">
        <div>
          <p className="text-sm font-bold tracking-tight text-neutral-300">No transcript yet</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-neutral-600">{emptyMessage}</p>
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

            return (
              <li key={`${chunk.session_id}-${chunk.chunk_index}`} className="border-b border-white/10 last:border-b-0">
                <button
                  type="button"
                  className={`focus-ring grid w-full grid-cols-[60px_minmax(0,1fr)_44px] gap-3 px-3 py-3 text-left transition-colors sm:grid-cols-[72px_minmax(0,1fr)_52px] ${
                    selectedIndex === index
                      ? "bg-neutral-800/80"
                      : "bg-neutral-950/20 hover:bg-neutral-900/80"
                  }`}
                  onClick={() => onSelect(index)}
                  aria-pressed={selectedIndex === index}
                >
                  <span className="pt-0.5 font-mono text-[10px] leading-4 text-neutral-600">
                    <span className="block text-neutral-400">{formatClock(chunk.video_time_offset)}</span>
                    {formatClock(chunk.video_time_end)}
                  </span>
                  <span className="min-w-0">
                    <strong
                      className={`block leading-5 tracking-tight ${
                        mode === "asl"
                          ? "font-mono text-xs font-medium text-accent"
                          : "text-sm font-semibold text-neutral-200"
                      }`}
                    >
                      {primary || "No transcript text"}
                    </strong>
                    {secondary && (
                      <span
                        className={`mt-1 block truncate ${
                          mode === "asl"
                            ? "text-xs text-neutral-600"
                            : "font-mono text-[10px] uppercase tracking-wide text-neutral-600"
                        }`}
                      >
                        {secondary}
                      </span>
                    )}
                  </span>
                  <span className="pt-0.5 text-right font-mono text-[10px] text-neutral-600">
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
        className="flex w-2 touch-none select-none border-l border-white/5 bg-neutral-950 p-0.5"
      >
        <ScrollArea.Thumb className="relative flex-1 rounded-full bg-neutral-700" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
