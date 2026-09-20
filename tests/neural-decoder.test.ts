import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  constrainedBieLabelIds,
  decodeBieEntities,
  filterWindowBoundaryEntities,
  mergeWindowEntities,
  softmaxAt,
  type DecodedEntity,
} from "../src/shared/neural/decode.js";

type Fixture = {
  name: string;
  text: string;
  offsets: [number, number][];
  logits: number[][];
  threshold: number;
  constrained_label_ids: number[];
  confidences: number[];
  entities: DecodedEntity[];
};

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/neural-decoder-fixtures.json"), "utf8"),
) as { labels: string[]; cases: Fixture[] };

const labels = fixtures.labels;

describe("browser BIE decoding matches the offline decoder", () => {
  // Every number in the model cards was measured through the Python decoder. If the browser
  // decodes differently, the shipped behaviour is not the behaviour that was evaluated, and
  // the difference shows up as spans on the wrong characters rather than as an error.
  it.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))(
    "reproduces the constrained tag path for %s",
    (_name, fixture) => {
      const valid = fixture.offsets.map(([start, end]) => start !== end);
      expect(constrainedBieLabelIds(fixture.logits, valid, labels)).toEqual(fixture.constrained_label_ids);
    },
  );

  it.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))(
    "reproduces confidences for %s",
    (_name, fixture) => {
      const computed = fixture.logits.map((row, index) =>
        softmaxAt(row, fixture.constrained_label_ids[index] as number),
      );
      computed.forEach((value, index) => {
        expect(value).toBeCloseTo(fixture.confidences[index] as number, 9);
      });
    },
  );

  it.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))(
    "reproduces decoded spans for %s",
    (_name, fixture) => {
      const confidences = fixture.logits.map((row, index) =>
        softmaxAt(row, fixture.constrained_label_ids[index] as number),
      );
      const decoded = decodeBieEntities(
        fixture.text,
        fixture.offsets,
        fixture.constrained_label_ids,
        confidences,
        labels,
        fixture.threshold,
      );
      expect(decoded).toEqual(fixture.entities);
    },
  );
});

describe("window stitching", () => {
  it("drops spans clipped by a window edge where text continues", () => {
    const entities: DecodedEntity[] = [
      { start: 10, end: 14, label: "PERSON" },
      { start: 20, end: 30, label: "ADDRESS" },
      { start: 40, end: 50, label: "PERSON" },
    ];

    // Window covers [10, 50) of a 100-character text: the span starting exactly at the window
    // start and the one ending exactly at the window end both have arbitrary edges.
    expect(filterWindowBoundaryEntities(entities, 10, 50, 100)).toEqual([
      { start: 20, end: 30, label: "ADDRESS" },
    ]);
  });

  it("keeps edge spans when the window edge is the text edge", () => {
    const entities: DecodedEntity[] = [
      { start: 0, end: 4, label: "PERSON" },
      { start: 40, end: 50, label: "PERSON" },
    ];

    expect(filterWindowBoundaryEntities(entities, 0, 50, 50)).toEqual(entities);
  });

  it("prefers the longer span when windows disagree about an overlap", () => {
    const merged = mergeWindowEntities([
      { start: 5, end: 9, label: "PERSON" },
      { start: 5, end: 12, label: "ADDRESS" },
      { start: 20, end: 24, label: "PERSON" },
    ]);

    expect(merged).toEqual([
      { start: 5, end: 12, label: "ADDRESS" },
      { start: 20, end: 24, label: "PERSON" },
    ]);
  });

  it("deduplicates identical spans produced by overlapping windows", () => {
    const merged = mergeWindowEntities([
      { start: 3, end: 6, label: "PERSON" },
      { start: 3, end: 6, label: "PERSON" },
    ]);

    expect(merged).toEqual([{ start: 3, end: 6, label: "PERSON" }]);
  });

  it("returns spans sorted by position", () => {
    const merged = mergeWindowEntities([
      { start: 30, end: 33, label: "PERSON" },
      { start: 3, end: 6, label: "PERSON" },
      { start: 15, end: 20, label: "ADDRESS" },
    ]);

    expect(merged.map((entity) => entity.start)).toEqual([3, 15, 30]);
  });
});
