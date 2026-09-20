/*
 * Cross-context protocol for neural review.
 *
 * The draft text crosses two boundaries on its way to the model: content script → service
 * worker → offscreen document. Both hops go through `chrome.runtime`, which any other
 * extension component can also send to, so every payload is validated on arrival with the
 * same strict shape checks the rest of the extension uses (exact key sets, not just presence).
 *
 * A malformed hint here would become a character span applied to the user's draft, so the
 * validator checks span sanity too, not just types.
 */

import type { SemanticHint } from "../semantic-review.js";

const VALID_HINT_KINDS: ReadonlySet<SemanticHint["kind"]> = new Set([
  "person_name",
  "address",
  "account",
  "phone",
  "email",
  "china_id",
  "bank_card",
  "license_plate",
  "passport",
]);

export const NEURAL_REVIEW_REQUEST = "NEURAL_REVIEW_REQUEST" as const;
/**
 * Second hop, service worker → offscreen document.
 *
 * A distinct type rather than a `target` field on the first one: both hops travel over
 * `chrome.runtime.sendMessage`, which broadcasts to every extension context including the
 * sender's own listener. Reusing one type would make the service worker answer its own
 * forwarded message and never reach the model.
 */
export const NEURAL_REVIEW_EXEC = "NEURAL_REVIEW_EXEC" as const;
export const NEURAL_REVIEW_RESULT = "NEURAL_REVIEW_RESULT" as const;
export const NEURAL_REVIEW_STATUS = "NEURAL_REVIEW_STATUS" as const;

export type NeuralReviewRequest = {
  type: typeof NEURAL_REVIEW_REQUEST;
  requestId: string;
  text: string;
};

export type NeuralReviewExec = {
  type: typeof NEURAL_REVIEW_EXEC;
  requestId: string;
  text: string;
};

export type NeuralReviewResult =
  | { type: typeof NEURAL_REVIEW_RESULT; requestId: string; ok: true; hints: SemanticHint[]; elapsedMs: number }
  | { type: typeof NEURAL_REVIEW_RESULT; requestId: string; ok: false; error: string };

export type NeuralReviewStatus = {
  type: typeof NEURAL_REVIEW_STATUS;
  ready: boolean;
  loadMilliseconds: number | null;
  error: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isReviewPayload(value: unknown, type: string): boolean {
  return (
    isRecord(value) &&
    value.type === type &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.text === "string" &&
    hasOnlyKeys(value, ["type", "requestId", "text"])
  );
}

export function isNeuralReviewRequest(value: unknown): value is NeuralReviewRequest {
  return isReviewPayload(value, NEURAL_REVIEW_REQUEST);
}

export function isNeuralReviewExec(value: unknown): value is NeuralReviewExec {
  return isReviewPayload(value, NEURAL_REVIEW_EXEC);
}

/**
 * A hint is only accepted if its span could actually exist in `text`.
 *
 * `isValidSemanticHint` in detector.ts checks the same invariants before a hint becomes a
 * candidate, but checking here too means a bad span is rejected at the boundary where the
 * originating context is still known, instead of silently vanishing later.
 */
export function isValidHintForText(value: unknown, text: string): value is SemanticHint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.kind === "string" &&
    VALID_HINT_KINDS.has(value.kind as SemanticHint["kind"]) &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    value.start >= 0 &&
    value.end > value.start &&
    value.end <= text.length &&
    typeof value.score === "number" &&
    Number.isFinite(value.score) &&
    value.requiresConfirmation === true &&
    hasOnlyKeys(value, ["kind", "start", "end", "score", "requiresConfirmation"])
  );
}

export function isNeuralReviewResult(value: unknown, text: string, requestId: string): value is NeuralReviewResult {
  if (
    !isRecord(value) ||
    value.type !== NEURAL_REVIEW_RESULT ||
    typeof value.requestId !== "string" ||
    requestId.length === 0 ||
    value.requestId !== requestId
  ) {
    return false;
  }
  if (value.ok === true) {
    return (
      Array.isArray(value.hints) &&
      value.hints.every((hint) => isValidHintForText(hint, text)) &&
      typeof value.elapsedMs === "number" &&
      Number.isFinite(value.elapsedMs) &&
      hasOnlyKeys(value, ["type", "requestId", "ok", "hints", "elapsedMs"])
    );
  }
  return (
    value.ok === false &&
    typeof value.error === "string" &&
    hasOnlyKeys(value, ["type", "requestId", "ok", "error"])
  );
}

export function isNeuralReviewStatus(value: unknown): value is NeuralReviewStatus {
  return (
    isRecord(value) &&
    value.type === NEURAL_REVIEW_STATUS &&
    typeof value.ready === "boolean" &&
    (value.loadMilliseconds === null || typeof value.loadMilliseconds === "number") &&
    (value.error === null || typeof value.error === "string") &&
    hasOnlyKeys(value, ["type", "ready", "loadMilliseconds", "error"])
  );
}
