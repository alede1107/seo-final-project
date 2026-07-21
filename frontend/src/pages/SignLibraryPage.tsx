import * as Dialog from "@radix-ui/react-dialog";
import { useDeferredValue, useEffect, useState } from "react";

import { getSigns } from "../api";
import type { SignEntry } from "../types";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export default function SignLibraryPage() {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [letter, setLetter] = useState("");
  const [signs, setSigns] = useState<SignEntry[]>([]);
  const [selected, setSelected] = useState<SignEntry | null>(null);
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
        setError("");
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Could not load the sign library.");
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
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load more signs.");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="hairline-grid min-h-screen px-3 py-5 sm:px-5 lg:px-7 lg:py-6">
      <div className="mx-auto max-w-[1500px]">
        <header className="flex flex-col justify-between gap-4 pb-5 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-600">WLASL vocabulary</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">Sign library</h1>
            <p className="mt-1 max-w-xl text-sm leading-5 text-neutral-500">
              Search the exact word-level clips CaptionAid can match. These clips support vocabulary learning, not full ASL translation.
            </p>
          </div>
          <div className="flex items-baseline gap-2 border-l border-white/10 pl-4">
            <strong className="text-2xl font-extrabold tracking-tight text-accent">
              {vocabularyTotal.toLocaleString()}
            </strong>
            <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">available signs</span>
          </div>
        </header>

        <section className="border border-white/10 bg-[#0c0c0e]">
          <div className="grid border-b border-white/10 lg:grid-cols-[minmax(0,1fr)_auto]">
            <label className="relative block border-b border-white/10 lg:border-b-0 lg:border-r" htmlFor="sign-search">
              <span className="sr-only">Search sign vocabulary</span>
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-[10px] text-neutral-600">SEARCH</span>
              <input
                id="sign-search"
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLetter("");
                }}
                placeholder="Try help, book, family..."
                className="focus-ring h-14 w-full bg-transparent pl-20 pr-4 text-sm font-semibold text-white placeholder:font-normal placeholder:text-neutral-700"
              />
            </label>
            <div className="flex h-14 items-center justify-between gap-4 px-4 font-mono text-[10px] text-neutral-600">
              <span aria-live="polite">
                {loading ? "Loading..." : `${matchedTotal.toLocaleString()} results`}
              </span>
              {(query || letter) && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setLetter("");
                  }}
                  className="focus-ring rounded-md text-neutral-400 hover:text-white"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="scrollbar-none overflow-x-auto border-b border-white/10 px-3 py-2" role="group" aria-label="Filter by first letter">
            <div className="flex min-w-max items-center gap-1">
              <button
                type="button"
                className={`focus-ring h-7 rounded-md px-2.5 font-mono text-[10px] transition-colors ${
                  !letter ? "bg-white text-black" : "text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
                }`}
                aria-pressed={!letter}
                onClick={() => setLetter("")}
              >
                ALL
              </button>
              {alphabet.map((character) => {
                const value = character.toLowerCase();
                return (
                  <button
                    type="button"
                    key={character}
                    className={`focus-ring grid size-7 place-items-center rounded-md font-mono text-[10px] transition-colors ${
                      letter === value
                        ? "bg-white text-black"
                        : "text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
                    }`}
                    aria-pressed={letter === value}
                    onClick={() => {
                      setLetter((current) => (current === value ? "" : value));
                      setQuery("");
                    }}
                  >
                    {character}
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div className="border-b border-red-400/20 bg-red-400/5 px-4 py-3" role="alert">
              <p className="text-xs text-red-200/70">{error}</p>
            </div>
          )}

          {!loading && !signs.length ? (
            <div className="grid min-h-80 place-items-center px-6 text-center">
              <div>
                <p className="text-base font-extrabold tracking-tight text-neutral-300">No matching sign</p>
                <p className="mt-1 max-w-sm text-sm leading-5 text-neutral-600">
                  Try a simpler word or browse by its first letter.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid border-l border-white/10 sm:grid-cols-2 xl:grid-cols-3">
              {signs.map((sign, index) => (
                <button
                  type="button"
                  key={sign.word}
                  onClick={() => setSelected(sign)}
                  className="focus-ring group grid min-h-20 grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 border-b border-r border-white/10 bg-neutral-950/20 px-3 text-left transition-colors hover:bg-neutral-800/60"
                >
                  <span className="font-mono text-[9px] text-neutral-700">
                    {String(index + 1).padStart(3, "0")}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-extrabold tracking-tight text-neutral-300 group-hover:text-white">
                      {sign.word}
                    </strong>
                    <span className="mt-1 block truncate font-mono text-[9px] text-neutral-700">{sign.source}</span>
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600 group-hover:text-accent">View</span>
                </button>
              ))}
            </div>
          )}

          {signs.length < matchedTotal && (
            <div className="flex justify-center border-t border-white/10 p-3">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="focus-ring h-9 rounded-md border border-white/10 px-4 text-xs font-bold text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white disabled:cursor-wait disabled:text-neutral-700"
              >
                {loadingMore ? "Loading..." : `Load more (${signs.length} of ${matchedTotal})`}
              </button>
            </div>
          )}
        </section>
      </div>

      <Dialog.Root open={Boolean(selected)} onOpenChange={(nextOpen) => !nextOpen && setSelected(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-white/10 bg-neutral-900 text-neutral-100 outline-none">
            {selected && (
              <>
                <div className="flex items-start justify-between gap-6 border-b border-white/10 px-4 py-3">
                  <div>
                    <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-neutral-600">Vocabulary clip</p>
                    <Dialog.Title className="mt-1 text-lg font-extrabold tracking-tight">{selected.word}</Dialog.Title>
                    <Dialog.Description className="mt-1 font-mono text-[10px] text-neutral-600">
                      {selected.source}
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="Close sign preview"
                      className="focus-ring grid size-8 place-items-center rounded-md border border-white/10 font-mono text-xs text-neutral-500 hover:bg-neutral-800 hover:text-white"
                    >
                      X
                    </button>
                  </Dialog.Close>
                </div>
                <div className="aspect-video bg-black">
                  <video
                    key={selected.url}
                    src={selected.url}
                    className="size-full object-contain"
                    controls
                    autoPlay
                    loop
                    playsInline
                    aria-label={`ASL vocabulary clip for ${selected.word}`}
                  />
                </div>
                <div className="flex items-start justify-between gap-6 border-t border-white/10 px-4 py-3">
                  <p className="max-w-lg text-xs leading-5 text-neutral-500">
                    A single vocabulary example can vary by signer and region. Use it as a learning reference, not a complete translation.
                  </p>
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring shrink-0 rounded-md border border-white/10 px-3 py-2 text-xs font-bold text-neutral-300 hover:bg-neutral-800 hover:text-white"
                  >
                    Open clip
                  </a>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
