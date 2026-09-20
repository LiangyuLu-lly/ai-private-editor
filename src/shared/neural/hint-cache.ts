/*
 * The bridge between an asynchronous model and a synchronous send decision.
 *
 * `src/pre-send.ts` must stop submission with `preventDefault()` and
 * `stopImmediatePropagation()` while the event is dispatching. Only after doing that can it await
 * a review of the exact final draft and then re-enter the protected detector path. This cache
 * keeps typing-time work warm so that exact review is normally already available.
 *
 * Two properties make this safe:
 *
 *  1. **Exact-text keying.** Hints are character offsets. If the draft changed by one
 *     character every offset after the edit is wrong, so a near-match must never be used. The
 *     key is the draft text itself rather than a hash, because a hash collision would apply
 *     someone else's spans to this draft.
 *  2. **A miss is visible at send time.** The synchronous provider returns no hints on a miss,
 *     but the local-neural send gate forces an exact review before the detector runs. If that
 *     review cannot finish, the user must explicitly choose one-time raw send or cancel.
 */

import type { SemanticHint, SemanticReviewProvider } from "../semantic-review.js";

export type NeuralHintCache = {
  /** Store hints for the exact draft they were computed from. */
  put(text: string, hints: readonly SemanticHint[]): void;
  /** Exact-match lookup. Returns undefined when this precise draft has not been reviewed. */
  get(text: string): readonly SemanticHint[] | undefined;
  /** Whether this exact draft already has hints, so callers can skip redundant requests. */
  has(text: string): boolean;
  readonly size: number;
  clear(): void;
};

/**
 * Entries are small (a handful of spans) but keys are whole drafts, so the bound is on entry
 * count and total key length. A user editing continuously would otherwise accumulate one
 * entry per keystroke.
 */
const DEFAULT_MAX_ENTRIES = 8;
const DEFAULT_MAX_TOTAL_KEY_CHARACTERS = 400_000;

export function createNeuralHintCache(
  maxEntries: number = DEFAULT_MAX_ENTRIES,
  maxTotalKeyCharacters: number = DEFAULT_MAX_TOTAL_KEY_CHARACTERS,
): NeuralHintCache {
  if (maxEntries < 1) {
    throw new Error("maxEntries must be at least 1");
  }
  // Insertion order is eviction order; re-inserting moves an entry to the end.
  const entries = new Map<string, readonly SemanticHint[]>();
  let totalKeyCharacters = 0;

  const evictOldest = (): void => {
    const oldest = entries.keys().next();
    if (oldest.done === true) {
      return;
    }
    totalKeyCharacters -= oldest.value.length;
    entries.delete(oldest.value);
  };

  return {
    put(text, hints) {
      if (entries.has(text)) {
        totalKeyCharacters -= text.length;
        entries.delete(text);
      }
      entries.set(text, [...hints]);
      totalKeyCharacters += text.length;
      while (entries.size > maxEntries || (entries.size > 1 && totalKeyCharacters > maxTotalKeyCharacters)) {
        evictOldest();
      }
    },
    get(text) {
      return entries.get(text);
    },
    has(text) {
      return entries.has(text);
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
      totalKeyCharacters = 0;
    },
  };
}

/**
 * A synchronous provider backed by the cache.
 *
 * Returning `[]` on a miss keeps this provider synchronous. The local-neural send gate is
 * responsible for ensuring that a final outgoing draft is not processed from an unreviewed miss.
 */
export function createCachedNeuralProvider(cache: NeuralHintCache): SemanticReviewProvider {
  return {
    review(input: string): readonly SemanticHint[] {
      return cache.get(input) ?? [];
    },
  };
}

/**
 * Combine providers, keeping every hint from each.
 *
 * Used to run the rule/lexicon provider and the neural provider together. Union rather than
 * override, because a model miss must never remove a rule hit: over-redaction costs the user a
 * click, under-redaction leaks the value. `appendSemanticCandidates` already drops hints that
 * overlap a high-confidence deterministic candidate, and `selectCandidates` prefers explicit
 * evidence, so duplicates resolve downstream.
 */
export function combineSemanticProviders(
  ...providers: readonly SemanticReviewProvider[]
): SemanticReviewProvider {
  return {
    review(input: string): readonly SemanticHint[] {
      const seen = new Set<string>();
      const combined: SemanticHint[] = [];
      for (const provider of providers) {
        for (const hint of provider.review(input)) {
          const key = `${hint.kind}:${hint.start}:${hint.end}`;
          const existing = seen.has(key);
          if (existing) {
            continue;
          }
          seen.add(key);
          combined.push(hint);
        }
      }
      return combined.sort((left, right) => left.start - right.start || right.end - left.end);
    },
  };
}
