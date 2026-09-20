import { describe, expect, it, vi } from "vitest";

import {
  createNeuralReviewClient,
  DEFAULT_DEBOUNCE_MILLISECONDS,
  MAX_NEURAL_REVIEW_CHARACTERS,
} from "../src/shared/neural/client.js";
import { createNeuralHintCache } from "../src/shared/neural/hint-cache.js";
import {
  isNeuralReviewRequest,
  isNeuralReviewResult,
  isValidHintForText,
  NEURAL_REVIEW_RESULT,
} from "../src/shared/neural/messages.js";
import type { SemanticHint } from "../src/shared/semantic-review.js";

function hint(start: number, end: number): SemanticHint {
  return { kind: "person_name", start, end, score: 0.9, requiresConfirmation: true };
}

function okResult(requestId: string, hints: SemanticHint[]) {
  return { type: NEURAL_REVIEW_RESULT, requestId, ok: true as const, hints, elapsedMs: 12 };
}

/** Immediate timers, so scheduling order is exercised without real waiting. */
function immediateTimers() {
  return {
    setTimer: (callback: () => void, milliseconds = 0) => {
      // Debounce still flushes synchronously. A send-timeout deadline must not, or every
      // review would fail closed before the transport could settle.
      if (milliseconds <= DEFAULT_DEBOUNCE_MILLISECONDS) {
        callback();
      }
      return 0;
    },
    clearTimer: () => undefined,
  };
}

describe("neural review protocol validation", () => {
  it("accepts a well-formed request and rejects extra keys", () => {
    expect(isNeuralReviewRequest({ type: "NEURAL_REVIEW_REQUEST", requestId: "1", text: "x" })).toBe(true);
    expect(
      isNeuralReviewRequest({ type: "NEURAL_REVIEW_REQUEST", requestId: "1", text: "x", extra: 1 }),
    ).toBe(false);
    expect(isNeuralReviewRequest({ type: "NEURAL_REVIEW_REQUEST", requestId: "", text: "x" })).toBe(false);
  });

  it("rejects a hint whose span cannot exist in the draft", () => {
    // A span past the end of the text would mask nothing and hide a real value; rejecting it
    // at the boundary keeps the failure attributable.
    expect(isValidHintForText(hint(0, 3), "周妍舒")).toBe(true);
    expect(isValidHintForText(hint(0, 4), "周妍舒")).toBe(false);
    expect(isValidHintForText(hint(3, 3), "周妍舒")).toBe(false);
    expect(isValidHintForText({ ...hint(0, 3), requiresConfirmation: false }, "周妍舒")).toBe(false);
    expect(isValidHintForText({ ...hint(0, 3), kind: "phone" }, "周妍舒")).toBe(true);
    expect(isValidHintForText({ ...hint(0, 3), kind: "secret_value" }, "周妍舒")).toBe(false);
    expect(
      isValidHintForText(
        { ...hint(0, 13), kind: "account" },
        "wxid_demo_123",
      ),
    ).toBe(true);
  });

  it("rejects a result carrying a hint that does not fit the requested text", () => {
    expect(isNeuralReviewResult(okResult("1", [hint(0, 3)]), "周妍舒", "1")).toBe(true);
    expect(isNeuralReviewResult(okResult("1", [hint(0, 9)]), "周妍舒", "1")).toBe(false);
  });
});

describe("neural review client scheduling", () => {
  it("reviews the exact final draft before the send path continues", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async (message: { requestId: string; text: string }) =>
      okResult(message.requestId, [hint(0, 3)]));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    await expect(client.reviewNow("周妍舒昨天说过这件事")).resolves.toBe(true);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ text: "周妍舒昨天说过这件事" }));
    expect(cache.get("周妍舒昨天说过这件事")).toEqual([hint(0, 3)]);
  });

  it("reports an unavailable exact review instead of pretending the draft was scanned", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async () => {
      throw new Error("offscreen document is gone");
    });
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    await expect(client.reviewNow("周妍舒昨天说过这件事")).resolves.toBe(false);
    await expect(client.reviewNow("字".repeat(MAX_NEURAL_REVIEW_CHARACTERS + 1))).resolves.toBe(false);
    expect(cache.has("周妍舒昨天说过这件事")).toBe(false);
  });

  it("fills the cache for the exact draft that was reviewed", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async (message: { requestId: string }) => okResult(message.requestId, [hint(0, 3)]));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("周妍舒昨天说过这件事");
    await client.settle();

    expect(cache.get("周妍舒昨天说过这件事")).toEqual([hint(0, 3)]);
    expect(client.stats.completed).toBe(1);
  });

  it("skips drafts longer than the tier limit instead of running a doomed pass", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async (message: { requestId: string }) => okResult(message.requestId, []));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("字".repeat(MAX_NEURAL_REVIEW_CHARACTERS + 1));
    await client.settle();

    expect(transport).not.toHaveBeenCalled();
    expect(client.stats.skippedForLength).toBe(1);
  });

  it("does not re-request a draft that is already cached", async () => {
    const cache = createNeuralHintCache();
    cache.put("周妍舒昨天说过这件事", [hint(0, 3)]);
    const transport = vi.fn(async (message: { requestId: string }) => okResult(message.requestId, []));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("周妍舒昨天说过这件事");
    await client.settle();

    expect(transport).not.toHaveBeenCalled();
    expect(client.stats.skippedCached).toBe(1);
  });

  it("caches an empty result so the same draft is not re-requested", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async (message: { requestId: string }) => okResult(message.requestId, []));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("今天天气很好");
    await client.settle();
    client.schedule("今天天气很好");
    await client.settle();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(cache.get("今天天气很好")).toEqual([]);
  });

  it("leaves the cache untouched when the transport fails", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async () => {
      throw new Error("offscreen document is gone");
    });
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("周妍舒昨天说过这件事");
    await client.settle();

    // The cache stays empty and the page must never see the transport failure; the R9 send-time
    // gate, not this client, decides whether to cancel or offer one explicit raw send.
    expect(cache.get("周妍舒昨天说过这件事")).toBeUndefined();
    expect(client.stats.failed).toBe(1);
  });

  it("ignores a malformed reply", async () => {
    const cache = createNeuralHintCache();
    const transport = vi.fn(async () => ({ type: "NEURAL_REVIEW_RESULT", requestId: "1", ok: true }));
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("周妍舒昨天说过这件事");
    await client.settle();

    expect(cache.size).toBe(0);
    expect(client.stats.failed).toBe(1);
  });

  it("serialises requests and reviews the newest draft", async () => {
    const cache = createNeuralHintCache();
    const seen: string[] = [];
    let release = (): void => undefined;
    const firstCallBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = vi.fn(async (message: { requestId: string; text: string }) => {
      seen.push(message.text);
      if (seen.length === 1) {
        await firstCallBlocked;
      }
      return okResult(message.requestId, []);
    });
    const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

    client.schedule("第一版草稿");
    client.schedule("第二版草稿更长一些");
    release();
    await client.settle();

    // Both drafts get reviewed, but never concurrently: the model is the bottleneck and
    // overlapping passes would make the newest draft wait behind stale ones.
    expect(seen).toEqual(["第一版草稿", "第二版草稿更长一些"]);
    expect(cache.has("第二版草稿更长一些")).toBe(true);
  });

    it("stops scheduling after dispose", async () => {
      const cache = createNeuralHintCache();
      const transport = vi.fn(async (message: { requestId: string }) => okResult(message.requestId, []));
      const client = createNeuralReviewClient({ cache, transport, ...immediateTimers() });

      client.dispose();
      client.schedule("周妍舒昨天说过这件事");
      await client.settle();

      expect(transport).not.toHaveBeenCalled();
    });

    it("fails a hung transport as unreviewed and ignores a late success", async () => {
      const cache = createNeuralHintCache();
      const put = vi.spyOn(cache, "put");
      const hungText = "周妍舒昨天说过这件事";
      const laterText = "今天天气很好";
      let resolveLate: ((value: unknown) => void) | undefined;
      let calls = 0;
      const transport = vi.fn((message: { requestId: string; text: string }) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((resolve) => {
            resolveLate = resolve;
          });
        }
        return Promise.resolve(okResult(message.requestId, []));
      });
      const scheduled: { callback: () => void; milliseconds: number; handle: number }[] = [];
      let nextHandle = 1;
      const setTimer = (callback: () => void, milliseconds: number) => {
        const handle = nextHandle;
        nextHandle += 1;
        scheduled.push({ callback, milliseconds, handle });
        return handle;
      };
      const clearTimer = (handle: unknown) => {
        const index = scheduled.findIndex((entry) => entry.handle === handle);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      };
      const timeoutMilliseconds = 15_000;
      const client = createNeuralReviewClient({
        cache,
        transport,
        timeoutMilliseconds,
        setTimer,
        clearTimer,
      });

      const review = client.reviewNow(hungText);
      const timeoutIndex = scheduled.findIndex((entry) => entry.milliseconds === timeoutMilliseconds);
      const timeoutTimer = scheduled[timeoutIndex];
      expect(timeoutTimer).toBeDefined();
      if (timeoutTimer === undefined) {
        return;
      }
      scheduled.splice(timeoutIndex, 1);
      timeoutTimer.callback();

      await expect(review).resolves.toBe(false);
      expect(client.stats.failed).toBe(1);
      expect(cache.has(hungText)).toBe(false);

      await expect(client.reviewNow(laterText)).resolves.toBe(true);
      expect(cache.has(laterText)).toBe(true);

      const lateResult = okResult("late", [hint(0, 3)]);
      resolveLate?.(lateResult);
      await Promise.resolve();
      await Promise.resolve();
      expect(put.mock.calls.some((call) => call[0] === hungText)).toBe(false);
      expect(cache.has(hungText)).toBe(false);
    });
  });
