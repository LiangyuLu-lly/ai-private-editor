import { describe, expect, it } from "vitest";

import { createSessionClearSignal } from "../src/shared/session-clear.js";

describe("session clear signal", () => {
  it("broadcasts an opaque local nonce without carrying a raw value", async () => {
    let stored: unknown;
    const listeners = new Set<(value: unknown) => void>();
    const signal = createSessionClearSignal(
      {
        async writeValue(value) {
          stored = value;
          listeners.forEach((listener) => listener(value));
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      () => "clear-nonce",
    );
    let clears = 0;
    signal.subscribe(() => {
      clears += 1;
    });

    await expect(signal.requestClear()).resolves.toBe(true);

    expect(stored).toBe("clear-nonce");
    expect(clears).toBe(1);
    expect(JSON.stringify(stored)).not.toContain("13800138000");
  });
});
