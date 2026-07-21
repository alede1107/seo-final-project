import type { CaptionChunk } from "../types";
import { formatClock } from "../utils";

interface CaptionTimelineProps {
  chunks: CaptionChunk[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  emptyMessage?: string;
}

export default function CaptionTimeline({
  chunks,
  selectedIndex,
  onSelect,
  emptyMessage = "No finalized captions are available yet.",
}: CaptionTimelineProps) {
  if (!chunks.length) {
    return (
      <div className="empty-panel transcript-empty">
        <h2>No transcript yet</h2>
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ol className="caption-timeline" aria-label="Finalized caption timeline">
      {chunks.map((chunk, index) => (
        <li key={`${chunk.session_id}-${chunk.chunk_index}`}>
          <button
            type="button"
            className={selectedIndex === index ? "caption-row selected" : "caption-row"}
            onClick={() => onSelect(index)}
            aria-pressed={selectedIndex === index}
          >
            <span className="caption-time">
              {formatClock(chunk.video_time_offset)}
              <small>{formatClock(chunk.video_time_end)}</small>
            </span>
            <span className="caption-copy">
              <strong>{chunk.text || "No transcript text"}</strong>
              {chunk.gloss.length > 0 && (
                <span className="gloss-line" aria-label={`ASL gloss: ${chunk.gloss.join(" ")}`}>
                  {chunk.gloss.map((token, tokenIndex) => (
                    <span key={`${token}-${tokenIndex}`}>{token}</span>
                  ))}
                </span>
              )}
            </span>
            <span className="match-count">
              {chunk.clips.length}
              <small>clips</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
