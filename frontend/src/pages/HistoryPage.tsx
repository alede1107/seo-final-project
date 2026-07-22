import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { getSessions, getVideoCaptions } from "../api";
import CaptionTimeline from "../components/CaptionTimeline";
import DeletePreparedDialog from "../components/DeletePreparedDialog";
import PrepareDialog from "../components/PrepareDialog";
import SignSequencePlayer from "../components/SignSequencePlayer";
import YouTubePlayer, { type YouTubePlaybackState } from "../components/YouTubePlayer";
import type { CaptionChunk, SessionSummary } from "../types";
import { formatClock, formatDate } from "../utils";

type TranscriptMode = "english" | "asl";

export default function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedVideo = searchParams.get("video");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [chunks, setChunks] = useState<CaptionChunk[]>([]);
  const [sessionSearch, setSessionSearch] = useState("");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [activeChunkIndex, setActiveChunkIndex] = useState(0);
  const [mode, setMode] = useState<TranscriptMode>("english");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [videoPlayback, setVideoPlayback] = useState<YouTubePlaybackState>({
    currentTime: 0,
    playing: false,
    playbackRate: 1,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer = 0;

    const load = async (initial = false) => {
      if (cancelled || inFlight) return;
      inFlight = true;
      if (initial) setLoadingSessions(true);
      try {
        const items = await getSessions();
        if (!cancelled) {
          setSessions(items);
          setError("");
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not load caption history.");
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoadingSessions(false);
          timer = window.setTimeout(() => void load(), 5000);
        }
      }
    };

    const refreshOnFocus = () => {
      window.clearTimeout(timer);
      void load();
    };

    void load(true);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refreshKey]);

  const selected = useMemo(
    () =>
      sessions.find((session) => session.video_id === requestedVideo) ||
      sessions.find((session) => session.status === "ready") ||
      sessions[0] ||
      null,
    [requestedVideo, sessions],
  );

  useEffect(() => {
    setActiveChunkIndex(0);
    setTranscriptSearch("");
    setMatchedOnly(false);
    setVideoPlayback({
      currentTime: 0,
      playing: false,
      playbackRate: 1,
      ready: false,
    });

    if (!selected || selected.status !== "ready") {
      setChunks([]);
      return;
    }

    const controller = new AbortController();
    setLoadingChunks(true);
    getVideoCaptions(selected.video_id, controller.signal)
      .then((items) => {
        setChunks(items);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load this transcript.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingChunks(false);
      });
    return () => controller.abort();
  }, [selected?.video_id, selected?.status]);

  const visibleSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(
      (session) =>
        session.video_id.toLowerCase().includes(query) ||
        session.title.toLowerCase().includes(query) ||
        session.transcript_preview.toLowerCase().includes(query),
    );
  }, [sessionSearch, sessions]);

  const filteredChunks = useMemo(() => {
    const query = transcriptSearch.trim().toLowerCase();
    return chunks.filter((chunk) => {
      if (matchedOnly && !chunk.clips.length) return false;
      if (!query) return true;
      return (
        chunk.text.toLowerCase().includes(query) ||
        chunk.gloss.some((token) => token.toLowerCase().includes(query))
      );
    });
  }, [chunks, matchedOnly, transcriptSearch]);

  useEffect(() => {
    setActiveChunkIndex(0);
  }, [matchedOnly, transcriptSearch]);

  useEffect(() => {
    if (!videoPlayback.ready) return;
    const nextIndex = filteredChunks.findIndex(
      (chunk) =>
        videoPlayback.currentTime >= chunk.video_time_offset &&
        videoPlayback.currentTime < chunk.video_time_end,
    );
    if (nextIndex >= 0) {
      setActiveChunkIndex((current) => (current === nextIndex ? current : nextIndex));
    }
  }, [filteredChunks, videoPlayback.currentTime, videoPlayback.ready]);

  const selectedChunk = filteredChunks[activeChunkIndex] || null;
  const readyCount = sessions.filter((session) => session.status === "ready").length;
  const signCount = sessions.reduce((total, session) => total + session.sign_count, 0);

  const copyTranscript = async () => {
    if (!chunks.length) return;
    const transcript = chunks
      .map(
        (chunk) =>
          `[${formatClock(chunk.video_time_offset)}-${formatClock(chunk.video_time_end)}] ${chunk.text}`,
      )
      .join("\n");

    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("The browser could not copy this transcript.");
    }
  };

  const deleted = (videoId: string) => {
    setSessions((current) => current.filter((session) => session.video_id !== videoId));
    setChunks([]);
    setSearchParams({});
    setRefreshKey((current) => current + 1);
  };

  const prepared = (videoId: string) => {
    setSearchParams({ video: videoId });
    setRefreshKey((current) => current + 1);
  };

  return (
    <div className="hairline-grid min-h-screen px-3 py-5 sm:px-5 lg:px-7 lg:py-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="flex flex-col justify-between gap-4 pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600">Caption workspace</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">History</h1>
            <p className="mt-1 max-w-xl text-sm leading-5 text-neutral-500">
              Review prepared captions, ASL gloss, and the vocabulary clips available for each line.
            </p>
          </div>
          <PrepareDialog onPrepared={prepared} />
        </header>

        <section className="mb-4 grid grid-cols-3 border border-white/10 bg-neutral-950/70" aria-label="History summary">
          <div className="border-r border-white/10 px-3 py-3 sm:px-4">
            <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">Stored jobs</span>
            <strong className="mt-1 block text-lg font-extrabold tracking-tight">{sessions.length}</strong>
          </div>
          <div className="border-r border-white/10 px-3 py-3 sm:px-4">
            <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">Ready</span>
            <strong className="mt-1 block text-lg font-extrabold tracking-tight text-accent">{readyCount}</strong>
          </div>
          <div className="px-3 py-3 sm:px-4">
            <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">Matched clips</span>
            <strong className="mt-1 block text-lg font-extrabold tracking-tight">{signCount}</strong>
          </div>
        </section>

        {error && (
          <div className="mb-4 flex items-start justify-between gap-4 border border-red-400/20 bg-red-400/5 px-3 py-2.5" role="alert">
            <p className="text-xs leading-5 text-red-200/70">{error}</p>
            <button
              type="button"
              className="focus-ring font-mono text-[10px] text-red-300 hover:text-red-200"
              onClick={() => setError("")}
            >
              Dismiss
            </button>
          </div>
        )}

        <section className="overflow-hidden border border-white/10 bg-[#0c0c0e] lg:grid lg:grid-cols-[180px_minmax(0,1fr)_220px] xl:grid-cols-[240px_minmax(0,1fr)_300px] 2xl:grid-cols-[280px_minmax(0,1fr)_340px]">
          <aside className="border-b border-white/10 lg:border-b-0 lg:border-r">
            <div className="border-b border-white/10 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-extrabold tracking-tight text-neutral-300">Prepared videos</h2>
                <span className="font-mono text-[9px] text-neutral-600">{visibleSessions.length}</span>
              </div>
              <input
                type="search"
                value={sessionSearch}
                onChange={(event) => setSessionSearch(event.target.value)}
                placeholder="Search title or video ID"
                aria-label="Search prepared videos"
                className="focus-ring h-9 w-full rounded-md border border-white/10 bg-neutral-950 px-2.5 text-xs text-neutral-200 placeholder:text-neutral-700"
              />
            </div>

            <ScrollArea.Root className="h-64 overflow-hidden lg:h-[calc(100vh-272px)] lg:min-h-[500px]">
              <ScrollArea.Viewport className="size-full">
                {loadingSessions && !sessions.length && (
                  <p className="px-3 py-5 font-mono text-[10px] text-neutral-600">Loading history...</p>
                )}
                {!loadingSessions && !visibleSessions.length && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm font-bold tracking-tight text-neutral-300">No videos yet</p>
                    <p className="mt-1 text-xs leading-5 text-neutral-600">Open a captioned YouTube video and prepare it with CaptionAid.</p>
                  </div>
                )}
                <div className="divide-y divide-white/10">
                  {visibleSessions.map((session) => (
                    <button
                      type="button"
                      key={session.video_id}
                      onClick={() => setSearchParams({ video: session.video_id })}
                      className={`focus-ring block w-full border-l-2 px-3 py-3 text-left transition-colors ${
                        selected?.video_id === session.video_id
                          ? "border-l-accent bg-neutral-800/70"
                          : "border-l-transparent hover:bg-neutral-900"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className={`font-mono text-[9px] uppercase tracking-wider ${
                            session.status === "ready"
                              ? "text-accent"
                              : session.status === "error"
                                ? "text-red-400"
                                : "text-amber-300"
                          }`}
                        >
                          {session.status}
                        </span>
                        <span className="font-mono text-[9px] text-neutral-700">{session.chunk_count} lines</span>
                      </div>
                      <strong className="mt-1.5 line-clamp-2 block text-xs font-bold leading-4 tracking-tight text-neutral-300">
                        {session.title}
                      </strong>
                      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[9px] text-neutral-600">
                        <span>{formatDate(session.created_at)}</span>
                        <span>{session.sign_count} clips</span>
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea.Viewport>
              <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 bg-neutral-950 p-0.5">
                <ScrollArea.Thumb className="relative flex-1 rounded-full bg-neutral-700" />
              </ScrollArea.Scrollbar>
            </ScrollArea.Root>
          </aside>

          <div className="min-w-0">
            {!selected ? (
              <div className="grid min-h-[520px] place-items-center px-6 text-center">
                <div>
                  <p className="text-base font-extrabold tracking-tight text-neutral-300">Nothing selected</p>
                  <p className="mt-1 text-sm text-neutral-600">Prepare a video or choose one from history.</p>
                </div>
              </div>
            ) : selected.status !== "ready" ? (
              <div className="grid min-h-[520px] place-items-center px-6 text-center">
                <div className="max-w-md">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600">
                    {selected.status}
                  </span>
                  <h2 className="mt-2 text-lg font-extrabold tracking-tight text-neutral-200">{selected.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-600">
                    {selected.error || "Caption preparation is still running. Refresh shortly to see the result."}
                  </p>
                  {selected.status === "error" && (
                    <div className="mt-5 flex justify-center">
                      <DeletePreparedDialog
                        videoId={selected.video_id}
                        title={selected.title}
                        onDeleted={deleted}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-col justify-between gap-3 border-b border-white/10 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-extrabold tracking-tight text-neutral-100">{selected.title}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-neutral-600">
                      <span>{selected.video_id}</span>
                      <span>{formatClock(selected.duration)}</span>
                      <span>{selected.chunk_count} captions</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <DeletePreparedDialog
                      videoId={selected.video_id}
                      title={selected.title}
                      onDeleted={deleted}
                    />
                  </div>
                </div>

                <div className="border-b border-white/10 bg-black">
                  <div className="mx-auto aspect-video max-h-[380px]">
                    <YouTubePlayer
                      videoId={selected.video_id}
                      title={selected.title}
                      onPlaybackChange={setVideoPlayback}
                    />
                  </div>
                </div>

                <Tabs.Root value={mode} onValueChange={(value) => setMode(value as TranscriptMode)}>
                  <div className="border-b border-white/10 px-3 py-2.5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Tabs.List className="inline-flex w-fit rounded-md border border-white/10 bg-neutral-950 p-0.5" aria-label="Transcript display">
                        <Tabs.Trigger
                          value="english"
                          className="focus-ring h-7 rounded-[4px] px-3 text-[11px] font-bold text-neutral-500 transition-colors data-[state=active]:bg-neutral-800 data-[state=active]:text-white"
                        >
                          English
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          value="asl"
                          className="focus-ring h-7 rounded-[4px] px-3 text-[11px] font-bold text-neutral-500 transition-colors data-[state=active]:bg-neutral-800 data-[state=active]:text-accent"
                        >
                          ASL gloss
                        </Tabs.Trigger>
                      </Tabs.List>
                      <div className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-md">
                        <input
                          type="search"
                          value={transcriptSearch}
                          onChange={(event) => setTranscriptSearch(event.target.value)}
                          placeholder="Search transcript"
                          aria-label="Search selected transcript"
                          className="focus-ring h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-neutral-950 px-2.5 text-[11px] text-neutral-200 placeholder:text-neutral-700"
                        />
                        <label className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-white/10 px-2.5 font-mono text-[9px] text-neutral-500 hover:bg-neutral-800/50">
                          <input
                            type="checkbox"
                            checked={matchedOnly}
                            onChange={(event) => setMatchedOnly(event.target.checked)}
                            className="accent-lime-400"
                          />
                          Matches only
                        </label>
                        <button
                          type="button"
                          onClick={copyTranscript}
                          className="focus-ring hidden h-8 shrink-0 rounded-md border border-white/10 px-2.5 text-[10px] font-semibold text-neutral-500 hover:bg-neutral-800 hover:text-white sm:block"
                        >
                          {copied ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                    <p className="mt-2 font-mono text-[9px] text-neutral-700">
                      {loadingChunks ? "Loading transcript..." : `${filteredChunks.length} of ${chunks.length} captions`}
                    </p>
                  </div>

                  <Tabs.Content value="english" className="outline-none">
                    <CaptionTimeline
                      chunks={filteredChunks}
                      selectedIndex={activeChunkIndex}
                      onSelect={setActiveChunkIndex}
                      mode="english"
                      emptyMessage="No English captions match the current filters."
                    />
                  </Tabs.Content>
                  <Tabs.Content value="asl" className="outline-none">
                    <CaptionTimeline
                      chunks={filteredChunks}
                      selectedIndex={activeChunkIndex}
                      onSelect={setActiveChunkIndex}
                      mode="asl"
                      emptyMessage="No ASL gloss matches the current filters."
                    />
                  </Tabs.Content>
                </Tabs.Root>
              </>
            )}
          </div>

          <aside className="min-w-0 border-t border-white/10 p-3 lg:col-start-auto lg:border-l lg:border-t-0">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-600">Selected caption</p>
                <h2 className="mt-1 text-xs font-extrabold tracking-tight text-neutral-300">Matched signs</h2>
              </div>
              {selectedChunk && (
                <span className="font-mono text-[9px] text-neutral-600">
                  {formatClock(selectedChunk.video_time_offset)}
                </span>
              )}
            </div>
            <SignSequencePlayer
              clips={selectedChunk?.clips || []}
              sequenceId={
                selectedChunk
                  ? `${selectedChunk.session_id}:${selectedChunk.chunk_index}`
                  : undefined
              }
              preloadClips={filteredChunks[activeChunkIndex + 1]?.clips || []}
              preloadSequenceId={
                filteredChunks[activeChunkIndex + 1]
                  ? `${filteredChunks[activeChunkIndex + 1].session_id}:${filteredChunks[activeChunkIndex + 1].chunk_index}`
                  : undefined
              }
              emptyMessage="This caption has no word in the current sign vocabulary."
              sync={
                selectedChunk && videoPlayback.ready
                  ? {
                      currentTime:
                        videoPlayback.currentTime - selectedChunk.video_time_offset,
                      playing:
                        videoPlayback.playing &&
                        videoPlayback.currentTime >= selectedChunk.video_time_offset &&
                        videoPlayback.currentTime < selectedChunk.video_time_end,
                      playbackRate: videoPlayback.playbackRate,
                      segmentDuration:
                        selectedChunk.video_time_end - selectedChunk.video_time_offset,
                    }
                  : undefined
              }
            />
            {selectedChunk && (
              <div className="mt-3 border border-white/10 bg-neutral-950/50 px-3 py-2.5">
                <p className="text-xs leading-5 text-neutral-400">{selectedChunk.text}</p>
                {selectedChunk.gloss.length > 0 && (
                  <p className="mt-2 font-mono text-[10px] uppercase leading-5 tracking-wide text-accent/80">
                    {selectedChunk.gloss.join(" ")}
                  </p>
                )}
              </div>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}
