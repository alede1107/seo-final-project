import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { getPreparation, getVideoCaptions, startPreparation } from "../api";
import CaptionTimeline from "../components/CaptionTimeline";
import SignSequencePlayer from "../components/SignSequencePlayer";
import { useBackendStatus } from "../components/Layout";
import type { CaptionChunk, PrepareStatus } from "../types";
import { formatClock, parseYouTubeId } from "../utils";

type PageState = "idle" | "requesting" | "preparing" | "ready" | "error";

export default function PreparePage() {
  const backendStatus = useBackendStatus();
  const [input, setInput] = useState("");
  const [videoId, setVideoId] = useState("");
  const [pageState, setPageState] = useState<PageState>("idle");
  const [job, setJob] = useState<PrepareStatus | null>(null);
  const [chunks, setChunks] = useState<CaptionChunk[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [progress, setProgress] = useState(0);

  const selectedChunk = chunks[selectedIndex];
  const totalClips = useMemo(
    () => chunks.reduce((total, chunk) => total + chunk.clips.length, 0),
    [chunks],
  );
  const transcriptDuration = chunks.at(-1)?.video_time_end || 0;

  const loadPreparedCaptions = async (id: string, status: PrepareStatus) => {
    const loadedChunks = await getVideoCaptions(id);
    setJob(status);
    setChunks(loadedChunks);
    setSelectedIndex(0);
    setProgress(100);
    setPageState("ready");
  };

  useEffect(() => {
    if (pageState !== "requesting" && pageState !== "preparing") return;
    const update = () => {
      const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
      const next =
        pageState === "requesting"
          ? Math.min(38, 5 + elapsed * 1.4)
          : Math.min(94, 42 + elapsed * 0.45);
      setProgress(Math.round(next));
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [pageState, startedAt]);

  useEffect(() => {
    if (pageState !== "preparing" || !videoId) return;
    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const status = await getPreparation(videoId);
        if (cancelled) return;
        setJob(status);
        if (status.status === "ready") {
          await loadPreparedCaptions(videoId, status);
          return;
        }
        if (status.status === "error") {
          setError(status.error || "Caption preparation failed.");
          setPageState("error");
          return;
        }
        timer = window.setTimeout(poll, 2000);
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : "Could not check progress.");
          setPageState("error");
        }
      }
    };

    timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pageState, videoId]);

  const prepareVideo = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = parseYouTubeId(input);
    if (!id) {
      setError("Enter a valid public YouTube URL or 11-character video ID.");
      setPageState("error");
      return;
    }

    setVideoId(id);
    setChunks([]);
    setJob(null);
    setError("");
    setSelectedIndex(0);
    setStartedAt(Date.now());
    setProgress(5);
    setPageState("requesting");

    try {
      const status = await startPreparation(id);
      setJob(status);
      if (status.status === "ready") {
        await loadPreparedCaptions(id, status);
      } else {
        setPageState("preparing");
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Could not start caption preparation.",
      );
      setPageState("error");
    }
  };

  const stage =
    pageState === "requesting"
      ? "Downloading public YouTube audio"
      : progress < 80
        ? "Transcribing and building ASL gloss"
        : "Matching and timing vocabulary clips";

  return (
    <div className="page-stack">
      <section className="page-hero prepare-hero">
        <div>
          <span className="eyebrow">Shared pipeline, safer demo path</span>
          <h1>Prepare once. Review without the wait.</h1>
          <p>
            Generate finalized English captions, ASL gloss, and matched vocabulary clips before
            playback. The same records power this companion site and the YouTube extension overlay.
          </p>
        </div>
        <div className="hero-proof" aria-label="CaptionAid processing flow">
          <span>01</span>
          <strong>YouTube audio</strong>
          <i aria-hidden="true" />
          <span>02</span>
          <strong>Caption + gloss</strong>
          <i aria-hidden="true" />
          <span>03</span>
          <strong>Sign queue</strong>
        </div>
      </section>

      <section className="prepare-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">New preparation</span>
            <h2>Paste a public YouTube link</h2>
          </div>
          <span className={`connection-label ${backendStatus}`}>
            {backendStatus === "connected" ? "Ready to process" : "Backend required"}
          </span>
        </div>

        <form className="prepare-form" onSubmit={prepareVideo}>
          <label htmlFor="youtube-url">
            YouTube URL or video ID
            <span>Public videos work best for this MVP.</span>
          </label>
          <div className="input-action">
            <input
              id="youtube-url"
              type="text"
              inputMode="url"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              autoComplete="off"
            />
            <button
              className="primary-button"
              type="submit"
              disabled={
                !input.trim() ||
                pageState === "requesting" ||
                pageState === "preparing" ||
                backendStatus === "disconnected"
              }
            >
              {pageState === "requesting" || pageState === "preparing"
                ? "Preparing..."
                : "Prepare captions"}
            </button>
          </div>
        </form>

        {(pageState === "requesting" || pageState === "preparing") && (
          <div className="progress-card" role="status" aria-live="polite">
            <div className="progress-copy">
              <div>
                <span className="pulse-dot" aria-hidden="true" />
                <strong>{stage}</strong>
              </div>
              <span>{progress}%</span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <p>
              This is an estimate. You can leave this page open while AssemblyAI finishes the
              transcript.
            </p>
          </div>
        )}

        {pageState === "error" && (
          <div className="alert error-alert" role="alert">
            <strong>Preparation could not finish</strong>
            <p>{error}</p>
            <button type="button" onClick={() => setPageState("idle")}>
              Try again
            </button>
          </div>
        )}
      </section>

      {pageState === "ready" && (
        <>
          <section className="result-banner" aria-live="polite">
            <div>
              <span className="success-mark" aria-hidden="true">Ready</span>
              <div>
                <span className="eyebrow">Preparation complete</span>
                <h2>{job?.title || `YouTube video ${videoId}`}</h2>
                <p>These captions are cached and ready for the extension overlay.</p>
              </div>
            </div>
            <div className="result-actions">
              <a
                className="secondary-button"
                href={`https://www.youtube.com/watch?v=${videoId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open on YouTube
              </a>
              <Link className="primary-button" to={`/history?video=${videoId}`}>
                Open full review
              </Link>
            </div>
          </section>

          <section className="metric-grid" aria-label="Preparation summary">
            <article>
              <span>Caption segments</span>
              <strong>{chunks.length}</strong>
              <small>finalized rows</small>
            </article>
            <article>
              <span>Matched signs</span>
              <strong>{totalClips}</strong>
              <small>queued clips</small>
            </article>
            <article>
              <span>Transcript span</span>
              <strong>{formatClock(transcriptDuration)}</strong>
              <small>prepared audio</small>
            </article>
          </section>

          <section className="review-workspace">
            <div className="video-transcript-column">
              <div className="youtube-frame">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${videoId}`}
                  title={job?.title || "Prepared YouTube video"}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <div className="panel-heading timeline-heading">
                <div>
                  <span className="eyebrow">Finalized output</span>
                  <h2>Caption timeline</h2>
                </div>
                <span>{chunks.length} segments</span>
              </div>
              <CaptionTimeline
                chunks={chunks}
                selectedIndex={selectedIndex}
                onSelect={setSelectedIndex}
                emptyMessage="AssemblyAI returned no finalized caption rows for this video."
              />
            </div>

            <aside className="sticky-player">
              <SignSequencePlayer
                clips={selectedChunk?.clips || []}
                title="Matched sign sequence"
                emptyMessage="This caption has no matches in the current vocabulary. English captions remain available."
              />
            </aside>
          </section>
        </>
      )}
    </div>
  );
}
