import { describe, expect, it } from "vitest";

import { createNeuralHostHandler } from "../src/neural-host.js";
import { NEURAL_REVIEW_REQUEST, NEURAL_REVIEW_RESULT } from "../src/shared/neural/messages.js";

const RUNTIME_STATUS_KEYS = new Set(["ready", "loadMilliseconds", "error", "updatedAt"]);

describe("neural host exec deadline", () => {
  it("returns ok:false when offscreen exec exceeds the deadline", async () => {
    const offscreen = {
      hasDocument: async () => true,
      createDocument: async () => undefined,
    };
    let resolveLate: ((value: unknown) => void) | undefined;
    const send = () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      });
    const published: Array<{ ready: boolean; loadMilliseconds: number | null; error: string | null }> = [];
    const publish = (status: { ready: boolean; loadMilliseconds: number | null; error: string | null }) => {
      published.push(status);
    };
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
    const handle = createNeuralHostHandler(offscreen, send, publish, {
      timeoutMilliseconds,
      setTimer,
      clearTimer,
    });

    const pending = handle({
      type: NEURAL_REVIEW_REQUEST,
      requestId: "r1",
      text: "周妍舒昨天说过这件事",
    });
    for (let i = 0; i < 5; i += 1) {
      if (scheduled.length > 0) {
        break;
      }
      await Promise.resolve();
    }

    const timeoutIndex = scheduled.findIndex((entry) => entry.milliseconds === timeoutMilliseconds);
    const timeoutTimer = scheduled[timeoutIndex];
    expect(timeoutTimer).toBeDefined();
    if (timeoutTimer === undefined) {
      return;
    }
    scheduled.splice(timeoutIndex, 1);
    timeoutTimer.callback();

    const result = await pending;
    expect(result).toEqual(
      expect.objectContaining({
        type: NEURAL_REVIEW_RESULT,
        requestId: "r1",
        ok: false,
      }),
    );
    expect(result !== null && result.ok === false ? result.error : "").toContain("timeout");
    expect(published).toHaveLength(1);
    const status = published[0];
    expect(status).toBeDefined();
    if (status === undefined) {
      return;
    }
    expect(status.ready).toBe(false);
    expect(Object.keys(status).every((key) => RUNTIME_STATUS_KEYS.has(key))).toBe(true);
    expect(Object.keys(status)).toEqual(["ready", "loadMilliseconds", "error"]);

    resolveLate?.({
      type: NEURAL_REVIEW_RESULT,
      requestId: "r1",
      ok: true,
      hints: [],
      elapsedMs: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toHaveLength(1);
    expect(result !== null && result.ok === true).toBe(false);
  });
});
