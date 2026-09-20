import { beforeAll, describe, expect, it, vi } from "vitest";

type PersistFn = (elapsedMs: number, deadlineMs: number) => boolean;

const HOST_CLIENT_DEADLINE_MS = 15_000;

let shouldPersistOffscreenReview: PersistFn;

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: () => undefined },
      getURL: (path: string) => path,
    },
  });
  const mod = await import("../src/offscreen.js");
  shouldPersistOffscreenReview = mod.shouldPersistOffscreenReview;
});

describe("shouldPersistOffscreenReview", () => {
  it("returns true when elapsed is inside the host/client wall", () => {
    // Given: review finished at 14_999 ms against the 15_000 ms exec deadline
    // When: deciding whether to write resultCache
    // Then: persist, the reply is still inside the wall
    expect(shouldPersistOffscreenReview(14_999, HOST_CLIENT_DEADLINE_MS)).toBe(true);
  });

  it("returns true when elapsed equals the host/client wall", () => {
    // Given: review finished at exactly 15_000 ms
    // When: deciding whether to write resultCache
    // Then: persist, elapsed is still within the wall
    expect(shouldPersistOffscreenReview(15_000, HOST_CLIENT_DEADLINE_MS)).toBe(true);
  });

  it("returns false when elapsed exceeds the host/client wall", () => {
    // Given: review finished at 15_001 ms, past neural-host.ts / client.ts 15s drop
    // When: deciding whether to write resultCache
    // Then: do not persist; a later same-text request must not reuse this late result
    expect(shouldPersistOffscreenReview(15_001, HOST_CLIENT_DEADLINE_MS)).toBe(false);
  });
});
