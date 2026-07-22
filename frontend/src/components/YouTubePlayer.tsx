import { useEffect, useRef } from "react";

export interface YouTubePlaybackState {
  currentTime: number;
  playing: boolean;
  playbackRate: number;
  ready: boolean;
}

interface YouTubePlayerInstance {
  destroy: () => void;
  getCurrentTime: () => number;
  getPlaybackRate: () => number;
  getPlayerState: () => number;
}

interface YouTubePlayerEvent<T = undefined> {
  data: T;
  target: YouTubePlayerInstance;
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady: (event: YouTubePlayerEvent) => void;
        onStateChange: (event: YouTubePlayerEvent<number>) => void;
        onPlaybackRateChange: (event: YouTubePlayerEvent<number>) => void;
      };
    },
  ) => YouTubePlayerInstance;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeApi> | null = null;

function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error("YouTube player API did not initialize."));
    };

    let script = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    if (!script) {
      script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener(
      "error",
      () => reject(new Error("Could not load the YouTube player API.")),
      { once: true },
    );
  });

  return apiPromise;
}

interface YouTubePlayerProps {
  videoId: string;
  title: string;
  onPlaybackChange: (state: YouTubePlaybackState) => void;
}

export default function YouTubePlayer({
  videoId,
  title,
  onPlaybackChange,
}: YouTubePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let player: YouTubePlayerInstance | null = null;
    let timer: number | null = null;

    const stopPolling = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };

    const publish = (target: YouTubePlayerInstance, playing?: boolean) => {
      if (cancelled) return;
      try {
        onPlaybackChange({
          currentTime: target.getCurrentTime() || 0,
          playing: playing ?? target.getPlayerState() === 1,
          playbackRate: target.getPlaybackRate() || 1,
          ready: true,
        });
      } catch {
        // The player can disappear between an event and component cleanup.
      }
    };

    const pollWhilePlaying = (target: YouTubePlayerInstance) => {
      stopPolling();
      timer = window.setInterval(() => publish(target, true), 100);
    };

    void loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        const mount = document.createElement("div");
        container.replaceChildren(mount);
        player = new api.Player(mount, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: ({ target }) => publish(target, false),
            onStateChange: ({ target, data }) => {
              const playing = data === 1;
              publish(target, playing);
              if (playing) pollWhilePlaying(target);
              else stopPolling();
            },
            onPlaybackRateChange: ({ target }) => publish(target),
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          onPlaybackChange({
            currentTime: 0,
            playing: false,
            playbackRate: 1,
            ready: false,
          });
        }
      });

    return () => {
      cancelled = true;
      stopPolling();
      player?.destroy();
      container.replaceChildren();
    };
  }, [onPlaybackChange, videoId]);

  return (
    <div
      ref={containerRef}
      className="size-full"
      aria-label={title}
    />
  );
}
