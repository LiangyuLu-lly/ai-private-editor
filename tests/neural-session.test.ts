import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildBatch,
  planWindows,
  predictEntities,
  sliceLogitsRow,
  windowOffsets,
  type InferenceRunner,
  type LogitsTensor,
} from "../src/shared/neural/session.js";
import { createVocabulary, tokenize } from "../src/shared/neural/tokenizer.js";

const windowFixtures = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/neural-window-fixtures.json"), "utf8"),
) as {
  max_length: number;
  stride: number;
  cases: { length: number; content_tokens_total: number; window_count: number }[];
};

const vocabularyTokens = JSON.parse(
  readFileSync(resolve(__dirname, "../src/shared/neural/vocab.json"), "utf8"),
) as string[];
const vocabulary = createVocabulary(vocabularyTokens);

const LABELS = [
  "O",
  "B-PERSON",
  "I-PERSON",
  "E-PERSON",
  "B-ADDRESS",
  "I-ADDRESS",
  "E-ADDRESS",
  "B-ACCOUNT_ALIAS",
  "I-ACCOUNT_ALIAS",
  "E-ACCOUNT_ALIAS",
];

describe("window planning matches HuggingFace overflow behaviour", () => {
  // The step between windows is capacity - stride, not stride. Getting that wrong misplaces
  // every window after the first, which silently moves the predicted spans.
  it.each(windowFixtures.cases.map((item) => [item.length, item] as const))(
    "plans the same window count for a %i-character draft",
    (_length, item) => {
      const plan = planWindows(item.content_tokens_total, windowFixtures.max_length, windowFixtures.stride);
      expect(plan.length).toBe(item.window_count);
    },
  );

  it("covers every token across the plan", () => {
    for (const item of windowFixtures.cases) {
      const plan = planWindows(item.content_tokens_total, windowFixtures.max_length, windowFixtures.stride);
      expect(plan[0]?.start).toBe(0);
      expect(plan[plan.length - 1]?.end).toBe(item.content_tokens_total);
      for (let index = 1; index < plan.length; index += 1) {
        // Consecutive windows must overlap, otherwise a span sitting on the seam is lost
        // by both windows' boundary filters.
        expect((plan[index] as { start: number }).start).toBeLessThan(
          (plan[index - 1] as { end: number }).end,
        );
      }
    }
  });

  it("rejects a stride that cannot make progress", () => {
    expect(() => planWindows(1000, 256, 254)).toThrow(/stride/);
    expect(() => planWindows(1000, 2, 0)).toThrow(/special tokens/);
  });
});

describe("batch assembly", () => {
  it("wraps each window in CLS and SEP and pads to the fixed model width", () => {
    const batch = buildBatch([11, 12, 13, 14, 15], [{ start: 0, end: 3 }, { start: 3, end: 5 }], vocabulary, 6);

    expect(batch.inputIds).toEqual([
      [vocabulary.clsId, 11, 12, 13, vocabulary.sepId, vocabulary.padId],
      [vocabulary.clsId, 14, 15, vocabulary.sepId, vocabulary.padId, vocabulary.padId],
    ]);
    expect(batch.attentionMask).toEqual([
      [1, 1, 1, 1, 1, 0],
      [1, 1, 1, 1, 0, 0],
    ]);
    expect(batch.tokenTypeIds).toEqual([
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ]);
  });

  it("pads to the fixed width regardless of how much content the window holds", () => {
    // Not a style preference. The export is dynamically quantized, so activation scales are
    // derived from each tensor's actual range including padding. Padding to the current window's
    // own length would make a sentence's scores depend on how much text happens to follow it:
    // measured on the shipped artifact, that moved logits by up to 1.26 and flipped 18 of 512
    // argmax decisions, which was enough to move span boundaries.
    const short = buildBatch([11, 12], [{ start: 0, end: 2 }], vocabulary, 16);
    const long = buildBatch(Array.from({ length: 14 }, (_, index) => index + 20), [{ start: 0, end: 14 }], vocabulary, 16);

    expect(short.inputIds[0]).toHaveLength(16);
    expect(long.inputIds[0]).toHaveLength(16);
  });

  it("gives special tokens and padding zero-width offsets", () => {
    const offsets: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];

    expect(windowOffsets(offsets, { start: 0, end: 2 }, 5)).toEqual([
      [0, 0],
      [0, 1],
      [1, 2],
      [0, 0],
      [0, 0],
    ]);
  });
});

/** A runner that peaks the requested tag per content position, so decoding can be tested. */
function scriptedRunner(tagByCharacter: (character: string) => string, text: string): InferenceRunner {
  return {
    run: async (batch) => {
      const { offsets } = tokenize(text, vocabulary);
      const sequenceLength = batch.inputIds[0]?.length ?? 0;
      const data = new Float32Array(batch.inputIds.length * sequenceLength * LABELS.length);
      for (let row = 0; row < batch.inputIds.length; row += 1) {
        for (let position = 0; position < sequenceLength; position += 1) {
          // Position 0 is [CLS]; content token i sits at position i + 1 of window row.
          const tokenIndex = position - 1;
          const offset = offsets[tokenIndex];
          const tag = offset === undefined ? "O" : tagByCharacter(text.slice(offset[0], offset[1]));
          const base = (row * sequenceLength + position) * LABELS.length;
          for (let column = 0; column < LABELS.length; column += 1) {
            data[base + column] = column === LABELS.indexOf(tag) ? 8 : 0;
          }
        }
      }
      return { data, dims: [batch.inputIds.length, sequenceLength, LABELS.length] } as LogitsTensor;
    },
  };
}

describe("end-to-end prediction over a single window", () => {
  it("turns tagged tokens into character spans", async () => {
    const text = "请联系张默言确认";
    const tags: Record<string, string> = { 张: "B-PERSON", 默: "I-PERSON", 言: "E-PERSON" };
    const runner = scriptedRunner((character) => tags[character] ?? "O", text);

    const result = await predictEntities(text, vocabulary, LABELS, 0.5, runner);

    expect(result.windowCount).toBe(1);
    expect(result.entities).toEqual([{ start: 3, end: 6, label: "PERSON" }]);
    expect(text.slice(3, 6)).toBe("张默言");
  });

  it("returns nothing for text with no tokens", async () => {
    const runner = scriptedRunner(() => "O", "");

    expect(await predictEntities("", vocabulary, LABELS, 0.5, runner)).toEqual({
      entities: [],
      windowCount: 0,
    });
  });

  it("suppresses spans below the confidence threshold", async () => {
    const text = "请联系张默言确认";
    const tags: Record<string, string> = { 张: "B-PERSON", 默: "I-PERSON", 言: "E-PERSON" };
    const runner = scriptedRunner((character) => tags[character] ?? "O", text);

    // The scripted logits give the peaked label a probability near 1, so a threshold above
    // that suppresses everything. This is the guard that keeps a low-confidence model quiet.
    const result = await predictEntities(text, vocabulary, LABELS, 0.999999, runner);

    expect(result.entities).toEqual([]);
  });
});

describe("logits tensor shape", () => {
  it("rejects logits whose dims are not a 3D [batch,seq,labels] matching data.length", () => {
    const data = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

    expect(() => sliceLogitsRow({ data, dims: [4, 3] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [1, 4, 3, 1] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [1, 0, 3] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [-1, 4, 3] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [1, 4.5, 3] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data: data.slice(0, 11), dims: [1, 4, 3] }, 0)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [1, 4, 3] }, 1)).toThrow();
    expect(() => sliceLogitsRow({ data, dims: [1, 4, 3] }, -1)).toThrow();

    expect(sliceLogitsRow({ data, dims: [1, 4, 3] }, 0)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
      [9, 10, 11],
    ]);
  });
});
