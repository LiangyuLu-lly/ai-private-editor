import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createVocabulary, tokenize } from "../src/shared/neural/tokenizer.js";

type Fixture = {
  text: string;
  tokens: string[];
  input_ids: number[];
  input_ids_no_special: number[];
  offsets_no_special: [number, number][];
  offsets_no_special_utf16: [number, number][];
};

const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/neural-tokenizer-fixtures.json"), "utf8"),
) as { cases: Fixture[]; vocab_size: number };

const vocabularyTokens = JSON.parse(
  readFileSync(resolve(__dirname, "../src/shared/neural/vocab.json"), "utf8"),
) as string[];

const vocabulary = createVocabulary(vocabularyTokens);

describe("browser BertTokenizer matches the training tokenizer", () => {
  // The model predicts character offsets into the draft. A single token of drift shifts every
  // later offset, so the extension would mask the wrong text and leave the real value in the
  // outbound message. Nothing about that failure is visible at runtime, hence golden fixtures
  // generated from the actual checkpoint.
  it("loads the same vocabulary size as training", () => {
    expect(vocabularyTokens.length).toBe(fixtures.vocab_size);
  });

  it.each(fixtures.cases.map((fixture) => [fixture.text || "(empty)", fixture] as const))(
    "reproduces token ids for %s",
    (_name, fixture) => {
      expect(tokenize(fixture.text, vocabulary).inputIds).toEqual(fixture.input_ids_no_special);
    },
  );

  it.each(fixtures.cases.map((fixture) => [fixture.text || "(empty)", fixture] as const))(
    "reproduces UTF-16 offsets for %s",
    (_name, fixture) => {
      expect(tokenize(fixture.text, vocabulary).offsets).toEqual(fixture.offsets_no_special_utf16);
    },
  );

  it("keeps offsets aligned with the source text", () => {
    for (const fixture of fixtures.cases) {
      const { offsets } = tokenize(fixture.text, vocabulary);
      for (const [start, end] of offsets) {
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(fixture.text.length);
      }
    }
  });
});
