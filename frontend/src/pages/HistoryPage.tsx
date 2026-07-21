import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { getSessions, getVideoCaptions } from "../api";
import CaptionTimeline from "../components/CaptionTimeline";
import SignSequencePlayer from "../components/SignSequencePlayer";
import type { CaptionChunk, SessionSummary } from "../types";
import { formatClock, formatDate } from "../utils";

export default function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
  const [chunks, setChunks] = useState<CaptionChunk[]>([]);
  const [selectedChunk, setSelectedChunk] = useState<CaptionChunk | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [matchedOnly, setMatchedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getSessions(controller.signal)
      .then((items) => {
        setSessions(items);
        const requestedVideo = searchParams.get("video");
        const initial =
          items.find((item) => item.video_id === requestedVideo) ||
          items.find((item) => item.status === "ready") ||
          items[0] ||
          null;
        setSelected(initial);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load history.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected || selected.status !== "ready") {
      setChunks([]);
      setSelectedChunk(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    getVideoCaptions(selected.video_id, controller.signal)
      .then((items) => {
        setChunks(items);
        setSelectedChunk(items[0] || null);
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load transcript.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected]);

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
    if (selectedChunk && filteredChunks.includes(selectedChunk)) return;
    setSelectedChunk(filteredChunks[0] || null);
  }, [filteredChunks, selectedChunk]);

  const chooseSession = (session: SessionSummary) => {
    setSelected(session);
    setSearchParams({ video: session.video_id });
    setTranscriptSearch("");
    setMatchedOnly(false);
  };

  const copyTranscript = async () => {
    if (!chunks.length) return;
    const transcript = chunks
      .map(
        (chunk) =>
          `[${formatClock(chunk.video_time_offset)}-${formatClock(chunk.video_time_end)}] ${chunk.text}`,
      )
      .join("\n");
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="page-stack">
      <section className="page-hero compact-hero">
        <div>
          <span className="eyebrow">Real pipeline records</span>
          <h1>Caption history</h1>
          <p>
            Revisit videos prepared by either the companion website or extension. Search finalized
            English text, inspect ASL gloss, and replay every matched clip.
          </p>
        </div>
        <div className="hero-stat">
          <strong>{sessions.length}</strong>
          <span>preparation jobs stored locally</span>
        </div>
      </section>

      {error && (
        <div className="alert error-alert" role="alert">
          <strong>History could not be loaded</strong>
          <p>{error}</p>
        </div>
      )}

      <section className="history-layout">
        <aside className="history-sidebar">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Saved work</span>
              <h2>Recent videos</h2>
            </div>
          </div>
          <label className="search-field">
            <span>Search videos</span>
            <input
              type="search"
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              placeholder="Title, ID, or transcript"
            />
          </label>

          <div className="session-list">
            {loading && !sessions.length && <p className="quiet-state">Loading history...</p>}
            {!loading && !visibleSessions.length && (
              <div className="quiet-state">
                <strong>No prepared videos found.</strong>
                <span>Prepare a YouTube video to create your first history entry.</span>
                <Link to="/">Prepare captions</Link>
              </div>
            )}
            {visibleSessions.map((session) => (
              <button
                type="button"
                key={session.video_id}
                className={selected?.video_id === session.video_id ? "session-card active" : "session-card"}
                onClick={() => chooseSession(session)}
              >
                <span className={`status-chip ${session.status}`}>{session.status}</span>
                <strong>{session.title}</strong>
                <code>{session.video_id}</code>
                <small>
                  {formatDate(session.created_at)} / {session.chunk_count} captions /{" "}
                  {session.sign_count} signs
                </small>
              </button>
            ))}
          </div>
        </aside>

        <div className="history-main">
          {!selected ? (
            <div className="empty-panel">
              <div className="empty-icon" aria-hidden="true">CC</div>
              <h2>Select a prepared video</h2>
              <p>Its finalized transcript and sign sequence will appear here.</p>
            </div>
          ) : selected.status !== "ready" ? (
            <div className="empty-panel error-state">
              <div className="empty-icon" aria-hidden="true">!</div>
              <h2>{selected.status === "error" ? "Preparation failed" : "Still preparing"}</h2>
              <p>{selected.error || "This job has not produced finalized captions yet."}</p>
              <Link className="primary-button" to="/">
                Retry from Prepare
              </Link>
            </div>
          ) : (
            <>
              <section className="session-summary">
                <div>
                  <span className="eyebrow">Selected record</span>
                  <h2>{selected.title}</h2>
                  <div className="summary-meta">
                    <code>{selected.video_id}</code>
                    <span>{formatDate(selected.created_at)}</span>
                    <span>{formatClock(selected.duration)}</span>
                  </div>
                </div>
                <div className="result-actions">
                  <button className="secondary-button" type="button" onClick={copyTranscript}>
                    {copied ? "Copied" : "Copy transcript"}
                  </button>
                  <a
                    className="primary-button"
                    href={`https://www.youtube.com/watch?v=${selected.video_id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open YouTube
                  </a>
                </div>
              </section>

              <section className="metric-grid compact-metrics" aria-label="Session summary">
                <article>
                  <span>Finalized captions</span>
                  <strong>{chunks.length}</strong>
                </article>
                <article>
                  <span>Matched signs</span>
                  <strong>{selected.sign_count}</strong>
                </article>
                <article>
                  <span>Vocabulary coverage</span>
                  <strong>
                    {chunks.length
                      ? Math.round(
                          (chunks.filter((chunk) => chunk.clips.length > 0).length / chunks.length) *
                            100,
                        )
                      : 0}
                    %
                  </strong>
                </article>
              </section>

              <div className="transcript-toolbar">
                <label className="search-field">
                  <span>Search transcript or gloss</span>
                  <input
                    type="search"
                    value={transcriptSearch}
                    onChange={(event) => setTranscriptSearch(event.target.value)}
                    placeholder="Try a word such as help"
                  />
                </label>
                <label className="check-control">
                  <input
                    type="checkbox"
                    checked={matchedOnly}
                    onChange={(event) => setMatchedOnly(event.target.checked)}
                  />
                  Only captions with sign matches
                </label>
              </div>

              <div className="review-workspace history-review">
                <div className="video-transcript-column">
                  <CaptionTimeline
                    chunks={filteredChunks}
                    selectedIndex={
                      selectedChunk ? Math.max(0, filteredChunks.indexOf(selectedChunk)) : 0
                    }
                    onSelect={(index) => setSelectedChunk(filteredChunks[index] || null)}
                    emptyMessage="No caption rows match the current filters."
                  />
                </div>
                <aside className="sticky-player">
                  <SignSequencePlayer
                    clips={selectedChunk?.clips || []}
                    title="Caption sign sequence"
                    emptyMessage="This caption has no vocabulary matches."
                  />
                </aside>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
