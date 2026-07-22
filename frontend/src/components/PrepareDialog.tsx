import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { parseYouTubeId } from "../utils";
import { useBackendStatus } from "./Layout";

type Phase = "idle" | "opened" | "error";

export default function PrepareDialog() {
  const backend = useBackendStatus();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setPhase("idle");
      setError("");
    }
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const videoId = parseYouTubeId(input);
    if (!videoId) {
      setError("Use a public YouTube URL or an 11-character video ID.");
      setPhase("error");
      return;
    }

    const youtubeTab = window.open(`https://www.youtube.com/watch?v=${videoId}`, "_blank");
    if (!youtubeTab) {
      setError("Your browser blocked the YouTube tab. Allow popups and try again.");
      setPhase("error");
      return;
    }

    youtubeTab.opener = null;
    setError("");
    setPhase("opened");
  };

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="focus-ring inline-flex h-9 items-center justify-center rounded-md bg-white px-3.5 text-sm font-extrabold tracking-tight text-black transition-colors hover:bg-neutral-200"
        >
          Open YouTube video
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-neutral-900 p-0 text-neutral-100 outline-none">
          <div className="border-b border-white/10 px-5 py-4">
            <div className="flex items-start justify-between gap-6">
              <div>
                <Dialog.Title className="text-base font-extrabold tracking-tight">
                  Caption a YouTube video
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-5 text-neutral-500">
                  Open the video, then use the CaptionAid extension to capture its audio and build
                  captions, ASL gloss, and matched sign clips.
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
                onChange={(event) => {
                  setInput(event.target.value);
                  if (phase !== "idle") setPhase("idle");
                }}
                placeholder="https://youtube.com/watch?v=..."
                autoComplete="off"
                className="focus-ring h-11 w-full rounded-md border border-white/10 bg-neutral-950 px-3 text-sm text-white placeholder:text-neutral-700"
              />
            </label>

            {phase === "opened" && (
              <div className="border border-lime-400/20 bg-lime-400/5 px-3 py-3" role="status">
                <p className="text-sm font-semibold text-lime-300">YouTube opened</p>
                <ol className="mt-2 space-y-1 font-mono text-[11px] leading-5 text-lime-100/60">
                  <li>1. Start playing the video.</li>
                  <li>2. Open CaptionAid and press Prepare captions.</li>
                  <li>3. Return here to review the transcript and signs.</li>
                </ol>
              </div>
            )}

            {phase === "error" && (
              <div className="border border-red-400/20 bg-red-400/5 px-3 py-2.5" role="alert">
                <p className="text-sm font-semibold text-red-300">Could not open this video</p>
                <p className="mt-1 text-xs leading-5 text-red-200/60">{error}</p>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-4">
              <span className="font-mono text-[10px] text-neutral-600">
                {backend === "connected" ? "Caption service online" : "Caption service offline"}
              </span>
              <button
                type="submit"
                disabled={!input.trim() || backend !== "connected"}
                className="focus-ring h-9 rounded-md bg-white px-4 text-sm font-extrabold text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                Open on YouTube
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
