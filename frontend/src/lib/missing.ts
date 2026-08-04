import type { CaptionChunk } from "../types";

/**
 * Normalize a gloss token the same way the backend does
 * (`services/chunk_processor._normalize`): lowercase, collapse any run of
 * characters outside [a-z0-9'] into a single space, and trim. Keeping this in
 * lockstep with the server is what lets us compare a gloss token to the
 * `clips[].token` values it produced.
 */
export function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9']+/g, " ").trim();
}

/**
 * Grammatical / punctuation markers that are never "addable" — they have no
 * sign clip by design and shouldn't be flagged red. The gloss translator only
 * emits one such marker, `QUESTION-MARK` (see backend/text_to_gloss.py), which
 * normalizes to "question mark".
 */
export const NON_ADDABLE: ReadonlySet<string> = new Set(["question mark"]);

/**
 * The set of normalized gloss tokens in a chunk that are "missing" a sign clip:
 * non-empty, not a NON_ADDABLE marker, and not present in the chunk's matched
 * clips. A signed-in user can fill these with a personal clip.
 */
export function computeMissingTokens(chunk: CaptionChunk): Set<string> {
  const matched = new Set(chunk.clips.map((clip) => normalizeToken(clip.token)));
  const missing = new Set<string>();
  for (const token of chunk.gloss) {
    const norm = normalizeToken(token);
    if (!norm || NON_ADDABLE.has(norm) || matched.has(norm)) continue;
    missing.add(norm);
  }
  return missing;
}
