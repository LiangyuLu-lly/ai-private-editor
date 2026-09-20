/*
 * Content-script side of neural review: warm the exact-text cache while typing and provide a
 * forced review for the send-time gate.
 *
 * The scheduling rules exist for specific failure modes rather than tidiness:
 *
 *  - **Debounce.** Requesting per keystroke would queue work that is obsolete before it
 *    finishes and would keep the model busy for the whole time the user is typing.
 *  - **One in flight.** The model is the slow part; letting requests pile up means the newest
 *    draft waits behind stale ones. A newer draft supersedes an older pending request.
 *  - **Tier by length.** A full pass over a long draft costs far more than the interaction
 *    budget, so typing-time prewarm is skipped past a threshold and `skippedForLength` records
 *    it. The R9 send-time gate still stops the native event and asks the user to cancel or
 *    explicitly send raw text; it never treats the skipped draft as model-reviewed.
 *  - **Never throw into the page.** A transport failure leaves the cache untouched. The caller
 *    can then make the send-time decision explicit instead of treating the failure as no PII.
 */

import type { SemanticHint } from "../semantic-review.js";
import type { NeuralHintCache } from "./hint-cache.js";
import { NEURAL_REVIEW_REQUEST, isNeuralReviewResult, type NeuralReviewRequest } from "./messages.js";

/**
 * Longest draft the model is allowed to scan.
 *
 * At 200 usable characters per 256-token window and 50-130 ms per window in WASM, 5000
 * characters is about 25 windows, or 1.25-3.25 s of background work. Past that the pass would
 * still be running long after the user has sent, so it is not attempted.
 */
export const MAX_NEURAL_REVIEW_CHARACTERS = 5_000;
export const DEFAULT_DEBOUNCE_MILLISECONDS = 350;

export type NeuralReviewTransport = (message: NeuralReviewRequest) => Promise<unknown>;

export type NeuralReviewClient = {
  /** Called on draft changes. Schedules a review of the exact text after the debounce. */
  schedule(text: string): void;
  /** Force the exact draft through the same queue and wait until it is cached or fails. */
  reviewNow(text: string): Promise<boolean>;
  /** Await the currently scheduled or in-flight review. Test and diagnostic use only. */
  settle(): Promise<void>;
  readonly stats: {
    requested: number;
    completed: number;
    failed: number;
    skippedForLength: number;
    skippedCached: number;
    superseded: number;
  };
  dispose(): void;
};

export type NeuralReviewClientOptions = {
  cache: NeuralHintCache;
  transport: NeuralReviewTransport;
  debounceMilliseconds?: number;
  maxCharacters?: number;
  /** Fail-closed deadline for one transport send; defaults to 15s. */
  timeoutMilliseconds?: number;
  /** Injected for tests; defaults to the platform timers. */
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function createNeuralReviewClient(options: NeuralReviewClientOptions): NeuralReviewClient {
  const debounce = options.debounceMilliseconds ?? DEFAULT_DEBOUNCE_MILLISECONDS;
  const maxCharacters = options.maxCharacters ?? MAX_NEURAL_REVIEW_CHARACTERS;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const stats = {
    requested: 0,
    completed: 0,
    failed: 0,
    skippedForLength: 0,
    skippedCached: 0,
    superseded: 0,
  };

  let timer: unknown = null;
  let pendingText: string | null = null;
  let inFlight: Promise<void> | null = null;
  let inFlightText: string | null = null;
  let disposed = false;
  let sequence = 0;

  const send = async (text: string): Promise<void> => {
    stats.requested += 1;
    inFlightText = text;
    sequence += 1;
    const request: NeuralReviewRequest = {
      type: NEURAL_REVIEW_REQUEST,
      requestId: `${Date.now()}-${sequence}`,
      text,
    };
    let cancelled = false;
    let timeoutHandle: unknown = null;
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        timeoutHandle = setTimer(() => {
          cancelled = true;
          reject(new Error("neural review timed out"));
        }, timeoutMilliseconds);
        void options.transport(request).then(
          (value) => {
            if (cancelled) {
              return;
            }
            if (timeoutHandle !== null) {
              clearTimer(timeoutHandle);
              timeoutHandle = null;
            }
            resolve(value);
          },
          (error: unknown) => {
            if (cancelled) {
              return;
            }
            if (timeoutHandle !== null) {
              clearTimer(timeoutHandle);
              timeoutHandle = null;
            }
            reject(error);
          },
        );
      });
      if (disposed || cancelled) {
        return;
      }
      if (!isNeuralReviewResult(response, text, request.requestId)) {
        stats.failed += 1;
        return;
      }
      if (response.ok === false) {
        stats.failed += 1;
        return;
      }
      // Store even an empty result: it records that this exact draft was reviewed and found
      // nothing, so the same text is not re-requested on every keystroke pause.
      options.cache.put(text, response.hints as SemanticHint[]);
      stats.completed += 1;
    } catch {
      // A transport failure must not surface in the page during typing. The cache stays untouched;
      // the R9 send-time gate surfaces the missed exact review and requires cancel/raw-once choice.
      stats.failed += 1;
    } finally {
      if (timeoutHandle !== null) {
        clearTimer(timeoutHandle);
      }
      inFlightText = null;
    }
  };

  const drain = async (): Promise<void> => {
    while (pendingText !== null && !disposed) {
      const text = pendingText;
      pendingText = null;
      await send(text);
    }
    inFlight = null;
  };

  const fire = (): void => {
    timer = null;
    if (disposed || pendingText === null) {
      return;
    }
    if (inFlight !== null) {
      // A newer draft arrived while the model was busy; drain() will pick it up.
      stats.superseded += 1;
      return;
    }
    inFlight = drain();
  };

  return {
    schedule(text) {
      if (disposed) {
        return;
      }
      if (text.length === 0 || text.length > maxCharacters) {
        if (text.length > maxCharacters) {
          stats.skippedForLength += 1;
        }
        return;
      }
      if (options.cache.has(text) || inFlightText === text) {
        stats.skippedCached += 1;
        return;
      }
      pendingText = text;
      if (timer !== null) {
        clearTimer(timer);
      }
      timer = setTimer(fire, debounce);
    },
    async reviewNow(text) {
      if (disposed || text.length === 0 || text.length > maxCharacters) {
        return false;
      }
      if (options.cache.has(text)) {
        return true;
      }
      pendingText = text;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      fire();
      await Promise.resolve();
      while (inFlight !== null || pendingText !== null) {
        if (inFlight !== null) {
          await inFlight;
        } else {
          fire();
          await Promise.resolve();
        }
      }
      return options.cache.has(text);
    },
    async settle() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
        fire();
      }
      while (inFlight !== null) {
        await inFlight;
      }
    },
    stats,
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pendingText = null;
    },
  };
}
