import * as ScrollArea from "@radix-ui/react-scroll-area";
import { useEffect, useRef, useState } from "react";

import type { SignClip } from "../types";

type SpeedMode = "fit" | "0.5" | "1" | "1.5" | "2";

interface SignSequencePlayerProps {
  clips: SignClip[];
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
  const fallbackDuration = Math.max(0.1, segmentDuration) / clips.length;
  let cursor = 0;

  for (let index = 0; index < clips.length; index += 1) {
    const parsedDuration = Number(clips[index].target_duration);
    const targetDuration = parsedDuration > 0 ? parsedDuration : fallbackDuration;
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
  title = "Sign sequence",
  emptyMessage = "Select a caption to preview its matched sign clips.",
  sync,
}: SignSequencePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [speedMode, setSpeedMode] = useState<SpeedMode>("fit");
  const [playing, setPlaying] = useState(false);
  const clipKey = clips.map((item) => item.url).join("|");
  const syncedPosition = sync
    ? clipPosition(clips, sync.currentTime, sync.segmentDuration)
    : null;
  const clip = clips[index];

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [clipKey]);

  useEffect(() => {
    if (syncedPosition) setIndex(syncedPosition.index);
  }, [syncedPosition?.index]);

  const applySpeed = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const requestedSpeed =
      speedMode === "fit"
        ? clip?.target_duration
          ? (video.duration / clip.target_duration) * (sync?.playbackRate || 1)
          : 1
        : Number(speedMode);
    video.playbackRate = Math.max(0.25, Math.min(requestedSpeed, 16));
  };

  useEffect(() => {
    applySpeed();
  }, [speedMode, clip, sync?.playbackRate]);

  const alignToYouTube = (force = false) => {
    const video = videoRef.current;
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
    alignToYouTube();
  }, [sync?.currentTime, syncedPosition?.index, index]);

  useEffect(() => {
    const video = videoRef.current;
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
        <video
          key={clip.url}
          ref={videoRef}
          src={clip.url}
          className="size-full object-contain"
          preload="metadata"
          playsInline
          muted
          controls
          onLoadedMetadata={() => {
            applySpeed();
            alignToYouTube(true);
          }}
          onPlay={() => {
            if (!sync?.playing) setPlaying(true);
          }}
          onPause={() => {
            if (!sync?.playing) setPlaying(false);
          }}
          onEnded={() => {
            if (sync?.playing) return;
            if (index < clips.length - 1) {
              setIndex((current) => current + 1);
            } else {
              setPlaying(false);
            }
          }}
          aria-label={`ASL vocabulary clip for ${clip.token}`}
        />
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
