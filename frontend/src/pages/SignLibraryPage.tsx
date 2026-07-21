import { useDeferredValue, useEffect, useMemo, useState } from "react";

import { getSigns } from "../api";
import SignSequencePlayer from "../components/SignSequencePlayer";
import type { SignEntry } from "../types";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export default function SignLibraryPage() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [letter, setLetter] = useState("");
  const [signs, setSigns] = useState<SignEntry[]>([]);
  const [selected, setSelected] = useState<SignEntry | null>(null);
  const [queue, setQueue] = useState<SignEntry[]>([]);
  const [matchedTotal, setMatchedTotal] = useState(0);
  const [vocabularyTotal, setVocabularyTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getSigns(deferredQuery, letter, 0, controller.signal)
      .then((page) => {
        setSigns(page.items);
        setMatchedTotal(page.matched_total);
        setVocabularyTotal(page.vocabulary_total);
        setSelected((current) => {
          if (current && page.items.some((sign) => sign.word === current.word)) return current;
          return page.items[0] || null;
        });
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load vocabulary.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [deferredQuery, letter]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await getSigns(deferredQuery, letter, signs.length);
      setSigns((current) => [...current, ...page.items]);
      setMatchedTotal(page.matched_total);
      setVocabularyTotal(page.vocabulary_total);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load more signs.");
    } finally {
      setLoadingMore(false);
    }
  };

  const queueClips = useMemo(
    () => queue.map((sign) => ({ token: sign.word, url: sign.url })),
    [queue],
  );

  const toggleQueue = (sign: SignEntry) => {
    setQueue((current) =>
      current.some((item) => item.word === sign.word)
        ? current.filter((item) => item.word !== sign.word)
        : [...current, sign],
    );
  };

  return (
    <div className="page-stack">
      <section className="page-hero library-hero">
        <div>
          <span className="eyebrow">Backed by word_to_url.json</span>
          <h1>Sign vocabulary library</h1>
          <p>
            Browse the exact vocabulary CaptionAid can match today. Every result opens the real S3
            clip used by the extension and prepared-caption pipeline.
          </p>
        </div>
        <div className="vocabulary-counter">
          <strong>{vocabularyTotal.toLocaleString()}</strong>
          <span>mapped vocabulary clips</span>
        </div>
      </section>

      <section className="library-tools">
        <label className="search-field prominent-search">
          <span>Search vocabulary</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLetter("");
            }}
            placeholder="Search a word, such as help"
          />
        </label>
        <div className="alphabet-filter" role="group" aria-label="Filter by first letter">
          <button
            type="button"
            className={!letter ? "active" : undefined}
            aria-pressed={!letter}
            onClick={() => setLetter("")}
          >
            All
          </button>
          {alphabet.map((character) => (
            <button
              type="button"
              key={character}
              className={letter === character.toLowerCase() ? "active" : undefined}
              aria-pressed={letter === character.toLowerCase()}
              onClick={() => {
                setLetter((current) =>
                  current === character.toLowerCase() ? "" : character.toLowerCase(),
                );
                setQuery("");
              }}
            >
              {character}
            </button>
          ))}
        </div>
        <p className="result-count" aria-live="polite">
          {loading
            ? "Loading vocabulary..."
            : `${matchedTotal.toLocaleString()} matching ${matchedTotal === 1 ? "entry" : "entries"}`}
        </p>
      </section>

      {error && (
        <div className="alert error-alert" role="alert">
          <strong>Vocabulary could not be loaded</strong>
          <p>{error}</p>
        </div>
      )}

      <section className="library-layout">
        <div className="library-results">
          {!loading && !signs.length ? (
            <div className="empty-panel">
              <div className="empty-icon" aria-hidden="true">?</div>
              <h2>No vocabulary match</h2>
              <p>
                CaptionAid only queues clips for words available in the current mapped vocabulary.
              </p>
            </div>
          ) : (
            <div className="sign-grid">
              {signs.map((sign, index) => {
                const inQueue = queue.some((item) => item.word === sign.word);
                return (
                  <article
                    key={sign.word}
                    className={selected?.word === sign.word ? "sign-card selected" : "sign-card"}
                  >
                    <button
                      className="sign-card-preview"
                      type="button"
                      onClick={() => setSelected(sign)}
                      aria-label={`Preview sign for ${sign.word}`}
                    >
                      <span className="sign-index">{String(index + 1).padStart(2, "0")}</span>
                      <span className="sign-glyph" aria-hidden="true">{sign.word.slice(0, 1)}</span>
                      <strong>{sign.word}</strong>
                      <small>View actual clip</small>
                    </button>
                    <button
                      className={inQueue ? "queue-button active" : "queue-button"}
                      type="button"
                      onClick={() => toggleQueue(sign)}
                    >
                      {inQueue ? "Remove from queue" : "Add to queue"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}

          {signs.length < matchedTotal && (
            <button
              className="load-more-button"
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : `Load more (${signs.length} of ${matchedTotal})`}
            </button>
          )}
        </div>

        <aside className="library-detail">
          <div className="sticky-library-panels">
            <SignSequencePlayer
              clips={selected ? [{ token: selected.word, url: selected.url }] : []}
              title={selected ? selected.word : "Sign preview"}
            />
            <section className="practice-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Optional practice</span>
                  <h2>Vocabulary queue</h2>
                </div>
                {queue.length > 0 && (
                  <button type="button" onClick={() => setQueue([])}>
                    Clear
                  </button>
                )}
              </div>
              {queue.length ? (
                <>
                  <SignSequencePlayer
                    clips={queueClips}
                    title="Practice sequence"
                    emptyMessage="Add words from the library."
                  />
                  <div className="queue-tags">
                    {queue.map((sign) => (
                      <button type="button" key={sign.word} onClick={() => toggleQueue(sign)}>
                        {sign.word}
                        <span aria-hidden="true">x</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="quiet-state">
                  Add individual words to replay a study sequence. This is not ASL sentence
                  translation.
                </p>
              )}
            </section>
          </div>
        </aside>
      </section>
    </div>
  );
}
