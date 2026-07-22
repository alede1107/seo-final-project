import * as Dialog from "@radix-ui/react-dialog";
import * as Progress from "@radix-ui/react-progress";
import { useEffect, useRef, useState } from "react";

import { getPreparation, startPreparation } from "../api";
import { parseYouTubeId } from "../utils";
import { useBackendStatus } from "./Layout";

interface PrepareDialogProps {
  onPrepared: (videoId: string) => void;
}

type Phase = "idle" | "requesting" | "preparing" | "error";

export default function PrepareDialog({ onPrepared }: PrepareDialogProps) {
  const backend = useBackendStatus();
  const onPreparedRef = useRef(onPrepared);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [videoId, setVideoId] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [error, setError] = useState("");

  onPreparedRef.current = onPrepared;
  const busy = phase === "requesting" || phase === "preparing";

  useEffect(() => {
    if (!busy) return;

    const update = () => {
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      const next =
        phase === "requesting"
          ? Math.min(30, 6 + elapsed * 4)
          : Math.min(94, 34 + elapsed * 0.7);
      setProgress(Math.round(next));
    };

    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [busy, phase, startedAt]);

  useEffect(() => {
    if (phase !== "preparing" || !videoId) return;
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const status = await getPreparation(videoId);
        if (cancelled) return;

        if (status.status === "ready") {
          setProgress(100);
          setPhase("idle");
          setOpen(false);
          onPreparedRef.current(videoId);
          return;
        }

        if (status.status === "error") {
          setError(status.error || "Caption preparation failed.");
          setPhase("error");
          return;
        }

        timer = window.setTimeout(poll, 2000);
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Could not check preparation.");
          setPhase("error");
        }
      }
    };

    timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, videoId]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedId = parseYouTubeId(input);
    if (!parsedId) {
      setError("Use a public YouTube URL or an 11-character video ID.");
      setPhase("error");
      return;
    }

    setVideoId(parsedId);
    setError("");
    setProgress(6);
    setStartedAt(Date.now());
    setPhase("requesting");

    try {
      const status = await startPreparation(parsedId);
      if (status.status === "ready") {
        setProgress(100);
        setPhase("idle");
        setOpen(false);
        onPreparedRef.current(parsedId);
        return;
      }
      if (status.status === "error") {
        setError(status.error || "Caption preparation failed.");
        setPhase("error");
        return;
      }
      setPhase("preparing");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not start preparation.");
      setPhase("error");
    }
  };

  const stage =
    phase === "requesting"
      ? "Fetching audio"
      : progress < 76
        ? "Transcribing captions"
        : "Matching sign clips";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          disabled={backend === "disconnected"}
          className="focus-ring inline-flex h-9 items-center justify-center rounded-md bg-white px-3.5 text-sm font-extrabold tracking-tight text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          Prepare video
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-neutral-900 p-0 text-neutral-100 outline-none">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex items-start justify-between gap-6">
              <div>
                <Dialog.Title className="text-base font-extrabold tracking-tight">
                  Prepare a YouTube video
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-5 text-neutral-500">
                  CaptionAid transcribes the video, builds ASL gloss, and matches available clips.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="focus-ring grid size-8 shrink-0 place-items-center rounded-md border border-white/10 font-mono text-sm text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white"
                >
                  X
                </button>
              </Dialog.Close>
            </div>
          </div>

          <form className="space-y-5 px-5 py-5" onSubmit={submit}>
            <label className="block" htmlFor="youtube-url">
              <span className="mb-2 block font-mono text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                YouTube URL
              </span>
              <input
                id="youtube-url"
                type="text"
                inputMode="url"
                value={input}
                disabled={busy}
                onChange={(event) => setInput(event.target.value)}
                placeholder="https://youtube.com/watch?v=..."
                autoComplete="off"
                className="focus-ring h-11 w-full rounded-md border border-white/10 bg-neutral-950 px-3 text-sm text-white placeholder:text-neutral-700 disabled:cursor-wait disabled:text-neutral-500"
              />
            </label>

            {busy && (
              <div className="border border-white/10 bg-neutral-950/60 p-3" role="status" aria-live="polite">
                <div className="mb-2 flex items-center justify-between gap-4">
                  <span className="text-sm font-semibold text-neutral-300">{stage}</span>
                  <span className="font-mono text-xs text-accent">{progress}%</span>
                </div>
                <Progress.Root
                  value={progress}
                  className="h-1.5 overflow-hidden rounded-full bg-neutral-800"
                  aria-label={stage}
                >
                  <Progress.Indicator
                    className="h-full bg-accent transition-transform duration-500 ease-out"
                    style={{ transform: `translateX(-${100 - progress}%)` }}
                  />
                </Progress.Root>
                <p className="mt-2 font-mono text-[10px] leading-4 text-neutral-600">
                  Approximate progress. This window can stay open while preparation finishes.
                </p>
              </div>
            )}

            {phase === "error" && (
              <div className="border border-red-400/20 bg-red-400/5 px-3 py-2.5" role="alert">
                <p className="text-sm font-semibold text-red-300">Could not prepare this video</p>
                <p className="mt-1 text-xs leading-5 text-red-200/60">{error}</p>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
              <span className="font-mono text-[10px] text-neutral-600">Public videos work best</span>
              <button
                type="submit"
                disabled={!input.trim() || busy || backend !== "connected"}
                className="focus-ring h-9 rounded-md bg-white px-4 text-sm font-extrabold text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                {busy ? "Preparing..." : "Start preparation"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
