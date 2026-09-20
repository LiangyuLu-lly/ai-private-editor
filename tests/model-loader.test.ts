import { describe, expect, it } from "vitest";

import { createModelLoader } from "../src/shared/neural/model-loader.js";

const MODEL = { id: "student" } as const;

describe("createModelLoader", () => {
  it("retries a transient load failure and clears loadError after success", async () => {
    // Given: load fails twice, then returns the model
    let calls = 0;
    const load = async (): Promise<typeof MODEL> => {
      calls += 1;
      if (calls < 3) {
        throw new Error(`transient-${calls}`);
      }
      return MODEL;
    };
    const loader = createModelLoader({ load, maxAttempts: 3 });

    // When: the first two ensure() calls hit those failures
    expect(await loader.ensure()).toBeNull();
    expect(loader.loadError).toBe("transient-1");
    expect(await loader.ensure()).toBeNull();
    expect(loader.loadError).toBe("transient-2");

    // Then: the third ensure() returns the model and clears loadError
    expect(await loader.ensure()).toBe(MODEL);
    expect(loader.loadError).toBeNull();
    expect(calls).toBe(3);
  });

  it("returns null and stops calling load after three consecutive failures", async () => {
    // Given: load always throws
    let calls = 0;
    const load = async (): Promise<typeof MODEL> => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    };
    const loader = createModelLoader({ load, maxAttempts: 3 });

    // When: ensure() is invoked four times
    expect(await loader.ensure()).toBeNull();
    expect(await loader.ensure()).toBeNull();
    expect(await loader.ensure()).toBeNull();
    expect(await loader.ensure()).toBeNull();

    // Then: the error is kept and load is not invoked past the attempt cap
    expect(loader.loadError).toBe("fail-3");
    expect(calls).toBe(3);
  });

  it("coalesces concurrent ensure() calls into one load", async () => {
    // Given: a load that stays pending until released
    let calls = 0;
    let resolveLoad: ((value: typeof MODEL) => void) | undefined;
    const load = (): Promise<typeof MODEL> => {
      calls += 1;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    };
    const loader = createModelLoader({ load, maxAttempts: 3 });

    // When: two ensure() calls overlap on the same in-flight load
    const first = loader.ensure();
    const second = loader.ensure();
    expect(calls).toBe(1);
    if (resolveLoad === undefined) {
      throw new Error("load was not started");
    }
    resolveLoad(MODEL);

    // Then: both callers receive the same model and load ran once
    expect(await first).toBe(MODEL);
    expect(await second).toBe(MODEL);
    expect(calls).toBe(1);
    expect(loader.loadError).toBeNull();
  });
});
