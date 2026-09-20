import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isNonPersonOrganisation } from "../src/shared/neural/review.js";
import { predictEntities, type InferenceRunner } from "../src/shared/neural/session.js";
import { createVocabulary } from "../src/shared/neural/tokenizer.js";

type ParityCase = {
  text: string;
  window_count: number;
  logits_dims: [number, number, number];
  logits: number[];
  entities_utf16: { start: number; end: number; label: string }[];
};

type ParityFixtures = {
  artifact: string;
  runtime_manifest: string;
  labels: string[];
  threshold: number;
  max_length: number;
  stride: number;
  cases: ParityCase[];
};

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/neural-parity-fixtures.json"), "utf8"),
) as ParityFixtures;

const vocabulary = createVocabulary(
  JSON.parse(readFileSync(resolve(__dirname, "../src/shared/neural/vocab.json"), "utf8")) as string[],
);

/** Replays the logits the real INT8 model produced for this exact text. */
function replayRunner(fixture: ParityCase): InferenceRunner {
  // The browser runs one window per call, so the recorded logits are replayed one window at a
  // time in the same order. Batching is avoided on both sides because quantized INT8 kernels are
  // not bit-identical across batch shapes or execution providers.
  let window = 0;
  const [, sequenceLength, labelCount] = fixture.logits_dims;
  return {
    run: async (batch) => {
      expect(batch.inputIds.length).toBe(1);
      expect(batch.inputIds[0]?.length).toBe(sequenceLength);
      const stride = sequenceLength * labelCount;
      const slice = fixture.logits.slice(window * stride, (window + 1) * stride);
      window += 1;
      return { data: Float32Array.from(slice), dims: [1, sequenceLength, labelCount] };
    },
  };
}

describe("browser inference decoder reproduces the recorded Python pipeline", () => {
  /*
   * The tokenizer, window and decoder suites each pin one stage against golden data. This pins
   * the composition against recorded INT8 output. The fixture carries the artifact, threshold and
   * window metadata used to generate it; release consistency binds those fields to the shipped
   * runtime manifest. It is a regression fixture, not a substitute for independent accuracy
   * evaluation.
   *
   * Passing here proves the browser decoder still matches the recorded reference path. Release
   * identity is separately checked from the manifest, registry, artifact digest and diagnostics.
   */
  const cases = fixtures.cases.filter((fixture) => fixture.text.length > 0);

  it.each(cases.map((fixture) => [fixture.text.slice(0, 24) || "(empty)", fixture] as const))(
    "produces identical spans for %s",
    async (_name, fixture) => {
      const result = await predictEntities(
        fixture.text,
        vocabulary,
        fixtures.labels,
        fixtures.threshold,
        replayRunner(fixture),
        fixtures.max_length,
        fixtures.stride,
      );

      expect(result.windowCount).toBe(fixture.window_count);
      expect(result.entities).toEqual(fixture.entities_utf16);
    },
  );

  it("returns nothing for empty input without calling the model", async () => {
    let called = false;
    const runner: InferenceRunner = {
      run: async () => {
        called = true;
        return { data: new Float32Array(), dims: [0, 0, 0] };
      },
    };

    expect(await predictEntities("", vocabulary, fixtures.labels, fixtures.threshold, runner)).toEqual({
      entities: [],
      windowCount: 0,
    });
    expect(called).toBe(false);
  });

  it("finds the unanchored personal names the rule engine cannot reach", async () => {
    // The whole reason for shipping a model. These three are verified rule-engine misses; the
    // model recovers all of them.
    const unanchored = ["周妍舒昨天说过这件事", "这份材料是高子墨整理的", "魏向澜和我一起去的"];

    for (const text of unanchored) {
      const fixture = fixtures.cases.find((item) => item.text === text);
      expect(fixture, `missing parity fixture for ${text}`).toBeDefined();
      const result = await predictEntities(
        text,
        vocabulary,
        fixtures.labels,
        fixtures.threshold,
        replayRunner(fixture as ParityCase),
        fixtures.max_length,
        fixtures.stride,
      );
      expect(result.entities.some((entity) => entity.label === "PERSON")).toBe(true);
    }
  });

  it("does not let an organization name reach the draft as a person", async () => {
    // Asserted at the layer that decides what the user sees, and split in two on purpose.
    //
    // This used to assert `result.entities` was empty on an earlier artifact where the model itself
    // left 华为 alone. The recorded fixture model flags it. That is a real model behavior and it is
    // recorded rather than hidden: the organisation filter in review.ts is what suppresses it, so the two assertions
    // below say "the model can get this wrong" and "the filter is what stops it". Delete the filter
    // and the second assertion fails, which is the point.
    //
    // The filter is not a patch bolted on for this case: it is a verbatim port of hybrid.py's
    // COMMON_NON_PERSON_NAMES, measured across six evaluation sets to remove false positives while
    // deleting zero gold-matching spans.
    const text = "请联系华为处理云服务故障。";
    const fixture = fixtures.cases.find((item) => item.text === text) as ParityCase;

    const result = await predictEntities(
      text,
      vocabulary,
      fixtures.labels,
      fixtures.threshold,
      replayRunner(fixture),
      fixtures.max_length,
      fixtures.stride,
    );

    // DecodedEntity carries offsets only, so the surface comes from the draft — the same way
    // review.ts slices it before consulting the filter.
    const surface = (entity: { start: number; end: number }) => text.slice(entity.start, entity.end);
    const surviving = result.entities.filter(
      (entity) => !(entity.label === "PERSON" && isNonPersonOrganisation(surface(entity))),
    );
    expect(
      surviving.map((entity) => `${entity.label}:${surface(entity)}`),
      "a span survived the organisation filter and would reach the user's draft",
    ).toEqual([]);
    expect(
      result.entities.every((entity) => isNonPersonOrganisation(surface(entity))),
      "the model produced a span the organisation filter does not explain; investigate before relaxing this",
    ).toBe(true);
  });

  it("stitches spans across windows on a draft longer than one window", async () => {
    const fixture = fixtures.cases.find((item) => item.window_count > 1) as ParityCase;
    expect(fixture).toBeDefined();

    const result = await predictEntities(
      fixture.text,
      vocabulary,
      fixtures.labels,
      fixtures.threshold,
      replayRunner(fixture),
      fixtures.max_length,
      fixtures.stride,
    );

    expect(result.windowCount).toBeGreaterThan(1);
    expect(result.entities).toEqual(fixture.entities_utf16);
    // Stitched output must stay ordered and non-overlapping, which is what the extension's
    // range resolution assumes.
    for (let index = 1; index < result.entities.length; index += 1) {
      const previous = result.entities[index - 1] as { end: number };
      const current = result.entities[index] as { start: number };
      expect(current.start).toBeGreaterThanOrEqual(previous.end);
    }
  });
});
