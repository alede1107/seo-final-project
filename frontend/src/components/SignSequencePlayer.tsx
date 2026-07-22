import * as ScrollArea from "@radix-ui/react-scroll-area";
import { useEffect, useRef, useState } from "react";

import type { SignClip } from "../types";

type SpeedMode = "fit" | "0.5" | "1" | "1.5" | "2";
const MIN_SYNCED_SIGN_DURATION = 0.75;

interface SignSequencePlayerProps {
  clips: SignClip[];
  sequenceId?: string;
  preloadClips?: SignClip[];
  preloadSequenceId?: string;
  title?: string;
  emptyMessage?: string;
  sync?: {
    currentTime: number;
    playing: boolean;
    playbackRate: number;
    segmentDuration: number;
  };
}

function clipPosition(clips: SignClip[], elapsed: number, segmentDuration: number) {
  if (!clips.length) return null;
  const safeSegmentDuration = Math.max(0.1, segmentDuration);
  const averageDuration = safeSegmentDuration / clips.length;
  const minimumDuration = Math.min(MIN_SYNCED_SIGN_DURATION, averageDuration);
  const rawDurations = clips.map((clip) => {
    const parsedDuration = Number(clip.target_duration);
    return parsedDuration > 0 ? parsedDuration : averageDuration;
  });
  const rawTotal = rawDurations.reduce((total, duration) => total + duration, 0);
  const flexibleTime = Math.max(0, safeSegmentDuration - minimumDuration * clips.length);
  const durations = rawDurations.map(
    (duration) => minimumDuration + flexibleTime * (duration / rawTotal),
  );
  let cursor = 0;

  for (let index = 0; index < clips.length; index += 1) {
    const targetDuration = durations[index];
    const next = cursor + targetDuration;
    if (elapsed < next || index === clips.length - 1) {
      return {
        index,
        targetDuration,
        elapsed: Math.max(0, Math.min(elapsed - cursor, targetDuration)),
      };
    }
    cursor = next;
  }

  return null;
}

export default function SignSequencePlayer({
  clips,
  sequenceId,
  preloadClips = [],
  preloadSequenceId,
  title = "Sign sequence",
  emptyMessage = "Select a caption to preview its matched sign clips.",
  sync,
}: SignSequencePlayerProps) {
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const preloadRequests = useRef<WeakSet<HTMLVideoElement>>(new WeakSet());
  const [speedMode, setSpeedMode] = useState<SpeedMode>("fit");
  const [playing, setPlaying] = useState(false);
  const clipKey = clips.map((item) => item.url).join("|");
  const preloadKey = preloadClips.map((item) => item.url).join("|");
  const currentSequenceId = sequenceId || `current:${clipKey}`;
  const nextSequenceId = preloadSequenceId || `next:${preloadKey}`;
  const [selection, setSelection] = useState({
    sequenceId: currentSequenceId,
    index: 0,
  });
  const index = selection.sequenceId === currentSequenceId ? selection.index : 0;
  const setIndex = (next: number | ((current: number) => number)) => {
    setSelection((current) => {
      const currentIndex = current.sequenceId === currentSequenceId ? current.index : 0;
      return {
        sequenceId: currentSequenceId,
        index: typeof next === "function" ? next(currentIndex) : next,
      };
    });
  };
  const syncedPosition = sync
    ? clipPosition(clips, sync.currentTime, sync.segmentDuration)
    : null;
  const clip = clips[index];

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [clipKey, currentSequenceId]);

  useEffect(() => {
    if (syncedPosition) setIndex(syncedPosition.index);
  }, [syncedPosition?.index]);

  const videoId = (id: string, clipIndex: number) => `${id}:${clipIndex}`;
  const activeVideo = () => videoRefs.current.get(videoId(currentSequenceId, index));

  useEffect(() => {
    const targets = [
      ...clips.slice(index, index + 5).map((_, offset) =>
        videoRefs.current.get(videoId(currentSequenceId, index + offset)),
      ),
      ...preloadClips.slice(0, 2).map((_, preloadIndex) =>
        videoRefs.current.get(videoId(nextSequenceId, preloadIndex)),
      ),
    ];

    for (const video of targets) {
      if (!video || preloadRequests.current.has(video)) continue;
      video.preload = "auto";
      video.load();
      preloadRequests.current.add(video);
    }
  }, [clipKey, currentSequenceId, index, nextSequenceId, preloadKey]);

  const applySpeed = () => {
    const video = activeVideo();
    if (!video || !Number.isFinite(video.duration)) return;
    const requestedSpeed =
      speedMode === "fit"
        ? syncedPosition?.index === index
          ? (video.duration / syncedPosition.targetDuration) * (sync?.playbackRate || 1)
          : clip?.target_duration
            ? video.duration / clip.target_duration
          : 1
        : Number(speedMode);
    video.playbackRate = Math.max(0.5, Math.min(requestedSpeed, 2));
  };

  useEffect(() => {
    applySpeed();
  }, [speedMode, clip, sync?.playbackRate]);

  const alignToYouTube = (force = false) => {
    const video = activeVideo();
    if (!video || !syncedPosition || syncedPosition.index !== index) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;

    const desiredTime = Math.min(
      video.duration - 0.01,
      (syncedPosition.elapsed / syncedPosition.targetDuration) * video.duration,
    );
    if (force || Math.abs(video.currentTime - desiredTime) > 0.3) {
      video.currentTime = Math.max(0, desiredTime);
    }
  };

  useEffect(() => {
    const video = activeVideo();
    if (!video) return;
    if (sync?.playing || playing) {
      void video.play().catch(() => {
        if (!sync?.playing) setPlaying(false);
      });
    } else {
      video.pause();
    }
  }, [index, playing, sync?.playing]);

  const moveTo = (nextIndex: number) => {
    setIndex(Math.max(0, Math.min(nextIndex, clips.length - 1)));
  };

  if (!clip) {
    return (
      <section className="grid min-h-64 place-items-center border border-white/10 bg-neutral-900/40 px-6 text-center" aria-label={title}>
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-700">ASL clip</span>
          <h2 className="mt-2 text-sm font-extrabold tracking-tight text-neutral-300">{title}</h2>
          <p className="mt-1 max-w-xs text-xs leading-5 text-neutral-600">{emptyMessage}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-md border border-white/10 bg-neutral-900/50" aria-label={title}>
      <div className="flex h-12 items-center justify-between border-b border-white/10 px-3">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-600">Now signing</p>
          <h2 className="truncate text-sm font-extrabold tracking-tight text-neutral-100">{clip.token}</h2>
        </div>
        <span className="font-mono text-[10px] text-neutral-500">
          {index + 1} / {clips.length}
        </span>
      </div>

      <div className="aspect-[4/3] border-b border-white/10 bg-black">
        {[
          ...clips.map((item, itemIndex) => ({
            clip: item,
            clipIndex: itemIndex,
            id: currentSequenceId,
            current: true,
          })),
          ...preloadClips.slice(0, 2).map((item, itemIndex) => ({
            clip: item,
            clipIndex: itemIndex,
            id: nextSequenceId,
            current: false,
          })),
        ].map((item) => {
          const id = videoId(item.id, item.clipIndex);
          const active = item.current && item.clipIndex === index;
          const preloading =
            !item.current ||
            (item.clipIndex >= index && item.clipIndex < index + 5);

          return (
            <video
              key={id}
              ref={(element) => {
                if (element) videoRefs.current.set(id, element);
                else videoRefs.current.delete(id);
              }}
              src={item.clip.url}
              className={active ? "size-full object-contain" : "hidden"}
              preload={preloading ? "auto" : "metadata"}
              playsInline
              muted
              controls={active}
              onLoadedMetadata={() => {
                if (!active) return;
                applySpeed();
                alignToYouTube(true);
              }}
              onCanPlay={() => {
                if (active && (sync?.playing || playing)) {
                  void activeVideo()?.play().catch(() => undefined);
                }
              }}
              onPlay={() => {
                if (active && !sync?.playing) setPlaying(true);
              }}
              onPause={() => {
                if (active && !sync?.playing) setPlaying(false);
              }}
              onEnded={() => {
                if (!active || sync?.playing) return;
                if (index < clips.length - 1) {
                  setIndex((current) => current + 1);
                } else {
                  setPlaying(false);
                }
              }}
              aria-label={active ? `ASL vocabulary clip for ${item.clip.token}` : undefined}
            />
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => moveTo(index - 1)}
            disabled={index === 0}
            className="focus-ring h-8 rounded-md border border-white/10 px-2.5 text-xs font-semibold text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => moveTo(index + 1)}
            disabled={index === clips.length - 1}
            className="focus-ring h-8 rounded-md border border-white/10 px-2.5 text-xs font-semibold text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            Next
          </button>
        </div>
        <label className="flex items-center gap-2 font-mono text-[10px] text-neutral-600">
          Speed
          <select
            value={speedMode}
            onChange={(event) => setSpeedMode(event.target.value as SpeedMode)}
            className="focus-ring h-8 rounded-md border border-white/10 bg-neutral-950 px-2 text-[10px] text-neutral-300"
          >
            <option value="fit">Fit</option>
            <option value="0.5">0.5x</option>
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </label>
      </div>

      {clips.length > 1 && (
        <ScrollArea.Root className="max-h-40 overflow-hidden">
          <ScrollArea.Viewport className="max-h-40 w-full">
            <ol className="divide-y divide-white/10">
              {clips.map((item, itemIndex) => (
                <li key={`${item.token}-${itemIndex}`}>
                  <button
                    type="button"
                    className={`focus-ring flex w-full items-center gap-3 px-3 py-2 text-left text-xs transition-colors ${
                      itemIndex === index
                        ? "bg-neutral-800 text-white"
                        : "text-neutral-500 hover:bg-neutral-800/50 hover:text-neutral-200"
                    }`}
                    aria-current={itemIndex === index ? "true" : undefined}
                    onClick={() => moveTo(itemIndex)}
                  >
                    <span className="font-mono text-[9px] text-neutral-600">
                      {String(itemIndex + 1).padStart(2, "0")}
                    </span>
                    <span className="font-semibold tracking-tight">{item.token}</span>
                  </button>
                </li>
              ))}
            </ol>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 bg-neutral-950 p-0.5">
            <ScrollArea.Thumb className="relative flex-1 rounded-full bg-neutral-700" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      )}
    </section>
  );
}
