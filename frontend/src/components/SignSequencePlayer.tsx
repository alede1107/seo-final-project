import { useEffect, useRef, useState } from "react";

import type { SignClip } from "../types";

type SpeedMode = "fit" | "0.5" | "1" | "1.5" | "2";

interface SignSequencePlayerProps {
  clips: SignClip[];
  title?: string;
  emptyMessage?: string;
}

export default function SignSequencePlayer({
  clips,
  title = "Sign sequence",
  emptyMessage = "Choose a caption or vocabulary word to preview its sign clip.",
}: SignSequencePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(0);
  const [speedMode, setSpeedMode] = useState<SpeedMode>("fit");
  const [playing, setPlaying] = useState(false);

  const clip = clips[index];

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [clips]);

  const applySpeed = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const numericSpeed =
      speedMode === "fit"
        ? clip?.target_duration
          ? video.duration / clip.target_duration
          : 1
        : Number(speedMode);
    video.playbackRate = Math.max(0.5, Math.min(numericSpeed, 4));
  };

  useEffect(() => {
    applySpeed();
  }, [speedMode, clip]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;
    void video.play().catch(() => setPlaying(false));
  }, [index, playing]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      setPlaying(true);
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const moveTo = (nextIndex: number) => {
    setIndex(Math.max(0, Math.min(nextIndex, clips.length - 1)));
  };

  if (!clip) {
    return (
      <section className="sign-player empty-panel" aria-label={title}>
        <div className="empty-icon" aria-hidden="true">ASL</div>
        <h2>{title}</h2>
        <p>{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="sign-player" aria-label={title}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Vocabulary clip</span>
          <h2>{clip.token}</h2>
        </div>
        <span className="queue-count">
          {index + 1} / {clips.length}
        </span>
      </div>

      <div className="sign-video-frame">
        <video
          key={clip.url}
          ref={videoRef}
          src={clip.url}
          preload="metadata"
          playsInline
          onLoadedMetadata={applySpeed}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            if (index < clips.length - 1) {
              setIndex((current) => current + 1);
            } else {
              setPlaying(false);
            }
          }}
          aria-label={`ASL vocabulary clip for ${clip.token}`}
        />
        <button className="video-play-button" type="button" onClick={togglePlayback}>
          {playing ? "Pause" : "Play"} {clip.token}
        </button>
      </div>

      <div className="player-controls">
        <div className="transport-controls">
          <button type="button" onClick={() => moveTo(index - 1)} disabled={index === 0}>
            Previous
          </button>
          <button type="button" className="primary-small" onClick={togglePlayback}>
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            onClick={() => moveTo(index + 1)}
            disabled={index === clips.length - 1}
          >
            Next
          </button>
        </div>
        <label className="speed-control">
          Playback
          <select
            value={speedMode}
            onChange={(event) => setSpeedMode(event.target.value as SpeedMode)}
          >
            <option value="fit">Fit caption</option>
            <option value="0.5">0.5x</option>
            <option value="1">1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
        </label>
      </div>

      <ol className="clip-queue" aria-label="Sign clip queue">
        {clips.map((item, itemIndex) => (
          <li key={`${item.token}-${itemIndex}`}>
            <button
              type="button"
              className={itemIndex === index ? "active" : undefined}
              aria-current={itemIndex === index ? "true" : undefined}
              onClick={() => moveTo(itemIndex)}
            >
              <span>{itemIndex + 1}</span>
              {item.token}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
