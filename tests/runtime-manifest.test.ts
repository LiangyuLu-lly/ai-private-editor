import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRuntimeManifest } from "../src/shared/neural/runtime-manifest.js";

const COMPLETE = {
  labels: { "0": "O", "1": "B-PERSON" },
  threshold: 0.15,
  max_length: 256,
  stride: 64,
};

describe("parseRuntimeManifest", () => {
  it("rejects a manifest missing threshold, max_length, stride, or labels", () => {
    expect(() => parseRuntimeManifest({})).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ threshold: 0.15 })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, labels: {} })).toThrow(/runtime_manifest\.json/);
    expect(() =>
      parseRuntimeManifest({
        labels: COMPLETE.labels,
        max_length: COMPLETE.max_length,
        stride: COMPLETE.stride,
      }),
    ).toThrow(/runtime_manifest\.json/);
    expect(() =>
      parseRuntimeManifest({
        labels: COMPLETE.labels,
        threshold: COMPLETE.threshold,
        stride: COMPLETE.stride,
      }),
    ).toThrow(/runtime_manifest\.json/);
    expect(() =>
      parseRuntimeManifest({
        labels: COMPLETE.labels,
        threshold: COMPLETE.threshold,
        max_length: COMPLETE.max_length,
      }),
    ).toThrow(/runtime_manifest\.json/);

    const parsed = parseRuntimeManifest(COMPLETE);
    expect(parsed).toEqual({
      labels: { "0": "O", "1": "B-PERSON" },
      threshold: 0.15,
      max_length: 256,
      stride: 64,
    });
    expect(parsed.threshold).not.toBe(0.35);

    const withUnknownKeys = parseRuntimeManifest({
      ...COMPLETE,
      artifact: "r9-electra-chat-augmented/checkpoint-3798",
      decoder: "constrained-bie",
      notes: ["ignored"],
    });
    expect(withUnknownKeys).toEqual({
      labels: { "0": "O", "1": "B-PERSON" },
      threshold: 0.15,
      max_length: 256,
      stride: 64,
    });

    const nonFallback = parseRuntimeManifest({
      labels: { "0": "O", "1": "B-PERSON" },
      threshold: 0.2,
      max_length: 128,
      stride: 32,
      extra: true,
    });
    expect(nonFallback).toEqual({
      labels: { "0": "O", "1": "B-PERSON" },
      threshold: 0.2,
      max_length: 128,
      stride: 32,
    });
    expect(nonFallback.threshold).not.toBe(0.35);
    expect(nonFallback.max_length).not.toBe(256);
    expect(nonFallback.stride).not.toBe(64);
  });

  it("rejects a threshold that is not finite and in (0, 1]", () => {
    expect(() => parseRuntimeManifest({ ...COMPLETE, threshold: 0 })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, threshold: 1.01 })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, threshold: Number.NaN })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, threshold: Number.POSITIVE_INFINITY })).toThrow(
      /runtime_manifest\.json/,
    );
    expect(parseRuntimeManifest({ ...COMPLETE, threshold: 1 }).threshold).toBe(1);
  });

  it("rejects a max_length that is not an integer > 2", () => {
    expect(() => parseRuntimeManifest({ ...COMPLETE, max_length: 2, stride: 0 })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, max_length: 2.5, stride: 0 })).toThrow(/runtime_manifest\.json/);
  });

  it("rejects a stride outside [0, max_length - 2)", () => {
    expect(() => parseRuntimeManifest({ ...COMPLETE, stride: -1 })).toThrow(/runtime_manifest\.json/);
    expect(() => parseRuntimeManifest({ ...COMPLETE, max_length: 256, stride: 254 })).toThrow(/runtime_manifest\.json/);
    expect(parseRuntimeManifest({ ...COMPLETE, max_length: 256, stride: 253 }).stride).toBe(253);
    expect(parseRuntimeManifest({ ...COMPLETE, stride: 0 }).stride).toBe(0);
  });

  it("parses the shipped runtime_manifest.json without injecting 0.35", () => {
    const text = readFileSync(resolve(__dirname, "../src/assets/model/runtime_manifest.json"), "utf8");
    const parsed = parseRuntimeManifest(JSON.parse(text));
    expect(parsed.threshold).not.toBe(0.35);
    expect(parsed.labels["0"]).toBe("O");
    expect(parsed.labels["1"]).toBe("B-PERSON");
    expect(text).toContain(`"threshold": ${parsed.threshold}`);
    expect(text).toContain(`"max_length": ${parsed.max_length}`);
    expect(text).toContain(`"stride": ${parsed.stride}`);
  });
});
