/*
 * Windowing and inference orchestration for the browser student model.
 *
 * The runtime call is behind `InferenceRunner` so everything except the WASM execution is
 * unit-testable: windowing, batch assembly, row slicing, decoding and stitching all run in
 * vitest against golden fixtures, and only the ONNX session itself needs a browser.
 *
 * Window geometry is pinned by tests/fixtures/neural-window-fixtures.json, captured from the
 * real tokenizer at max_length=256 / stride=64 — the configuration every offline number was
 * measured with. HuggingFace's stride convention is not obvious (the step is
 * capacity - stride, not stride), and getting it wrong misplaces every window after the first.
 */

import {
  constrainedBieLabelIds,
  decodeBieEntities,
  filterWindowBoundaryEntities,
  mergeWindowEntities,
  softmaxAt,
  type DecodedEntity,
} from "./decode.js";
import { tokenize, type BertVocabulary } from "./tokenizer.js";

/** Inference settings. These are not tunable knobs: they must match the training export. */
export const MODEL_MAX_LENGTH = 256;
export const MODEL_STRIDE = 64;
/** [CLS] and [SEP] occupy two of the max_length positions. */
const SPECIAL_TOKEN_COUNT = 2;

export type WindowPlan = { start: number; end: number };

export type ModelBatch = {
  inputIds: number[][];
  attentionMask: number[][];
  tokenTypeIds: number[][];
};

/** Logits as ONNX Runtime returns them: flat data plus [batch, sequence, labels] dims. */
export type LogitsTensor = { data: Float32Array | number[]; dims: readonly number[] };

export type InferenceRunner = {
  run(batch: ModelBatch): Promise<LogitsTensor>;
};

export function planWindows(
  tokenCount: number,
  maxLength: number = MODEL_MAX_LENGTH,
  stride: number = MODEL_STRIDE,
): WindowPlan[] {
  const capacity = maxLength - SPECIAL_TOKEN_COUNT;
  if (capacity < 1) {
    throw new Error("maxLength must leave room for the special tokens");
  }
  if (stride < 0 || stride >= capacity) {
    throw new Error("stride must be non-negative and smaller than the content capacity");
  }
  if (tokenCount <= capacity) {
    return [{ start: 0, end: tokenCount }];
  }
  const step = capacity - stride;
  const windows: WindowPlan[] = [];
  for (let start = 0; start < tokenCount; start += step) {
    const end = Math.min(start + capacity, tokenCount);
    windows.push({ start, end });
    // HuggingFace stops as soon as a window reaches the end rather than emitting further
    // windows that would all end at the same place.
    if (end === tokenCount) {
      break;
    }
  }
  return windows;
}

/**
 * Build one model input row per window, padded to a fixed width.
 *
 * The width is fixed at `maxLength` rather than at the longest window on purpose. The export is
 * dynamically quantized, which means activation scales are derived from each tensor's actual
 * range at run time — and padding positions are part of that tensor. Padding to whatever the
 * current draft happens to need therefore makes the logits depend on the draft's length: the same
 * sentence produces slightly different scores depending on how much text follows it.
 *
 * Measured on this artifact: padding the trailing 164-token window to its own width instead of to
 * 256 moved logits by up to 1.26 and changed 18 of 512 argmax decisions, which was enough to move
 * span boundaries. A fixed width removes the variable entirely.
 */
export function buildBatch(
  inputIds: readonly number[],
  windows: readonly WindowPlan[],
  vocabulary: BertVocabulary,
  maxLength: number = MODEL_MAX_LENGTH,
): ModelBatch {
  const width = maxLength;
  const batch: ModelBatch = { inputIds: [], attentionMask: [], tokenTypeIds: [] };
  for (const window of windows) {
    const content = inputIds.slice(window.start, window.end);
    const row = [vocabulary.clsId, ...content, vocabulary.sepId];
    const mask = new Array<number>(row.length).fill(1);
    while (row.length < width) {
      row.push(vocabulary.padId);
      mask.push(0);
    }
    batch.inputIds.push(row);
    batch.attentionMask.push(mask);
    batch.tokenTypeIds.push(new Array<number>(width).fill(0));
  }
  return batch;
}

/**
 * Offsets for one window's row, including the zero-width entries for [CLS], [SEP] and padding.
 *
 * The decoder treats a zero-width offset as an unsupervised position and forces it to O, which
 * is how the Python side keeps special tokens from opening or closing a span.
 */
export function windowOffsets(
  offsets: readonly [number, number][],
  window: WindowPlan,
  width: number,
): [number, number][] {
  const rows: [number, number][] = [[0, 0]];
  for (let index = window.start; index < window.end; index += 1) {
    rows.push(offsets[index] as [number, number]);
  }
  while (rows.length < width) {
    rows.push([0, 0]);
  }
  return rows;
}

export function sliceLogitsRow(tensor: LogitsTensor, row: number): number[][] {
  const dims = tensor.dims;
  const batch = dims[0];
  const sequenceLength = dims[1];
  const labelCount = dims[2];
  if (
    dims.length !== 3 ||
    typeof batch !== "number" ||
    typeof sequenceLength !== "number" ||
    typeof labelCount !== "number" ||
    !Number.isInteger(batch) ||
    !Number.isInteger(sequenceLength) ||
    !Number.isInteger(labelCount) ||
    batch <= 0 ||
    sequenceLength <= 0 ||
    labelCount <= 0 ||
    tensor.data.length !== batch * sequenceLength * labelCount ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= batch
  ) {
    throw new Error("logits tensor must be 3D [batch, seq, labels] matching data.length");
  }
  const data = tensor.data;
  const base = row * sequenceLength * labelCount;
  const rows: number[][] = [];
  for (let position = 0; position < sequenceLength; position += 1) {
    const start = base + position * labelCount;
    const values: number[] = [];
    for (let column = 0; column < labelCount; column += 1) {
      values.push(data[start + column] as number);
    }
    rows.push(values);
  }
  return rows;
}

export type NeuralPrediction = { entities: DecodedEntity[]; windowCount: number };

/**
 * Run the model over one text and return stitched character spans.
 *
 * Mirrors `SemanticTagger.predict`: window, decode per window with the constrained BIE
 * decoder, drop spans clipped by a window edge where the text continues, then merge.
 */
export async function predictEntities(
  text: string,
  vocabulary: BertVocabulary,
  labels: readonly string[],
  threshold: number,
  runner: InferenceRunner,
  maxLength: number = MODEL_MAX_LENGTH,
  stride: number = MODEL_STRIDE,
): Promise<NeuralPrediction> {
  const { inputIds, offsets } = tokenize(text, vocabulary);
  if (inputIds.length === 0) {
    return { entities: [], windowCount: 0 };
  }
  const windows = planWindows(inputIds.length, maxLength, stride);

  /*
   * One window per inference call, deliberately not one batched call.
   *
   * Quantized INT8 MatMul kernels pick their blocking from the batch dimension, and ONNX
   * Runtime's native CPU and WASM builds pick differently. Measured with
   * `scripts/smoke-neural-runner.mjs` on this artifact: every single-window draft agreed with the
   * native reference on every position (max logit delta 0.21, zero argmax differences), while the
   * one two-window draft diverged at 18 of 512 positions with a max delta of 1.26 — enough to move
   * a span boundary where two tags are near-tied.
   *
   * Running unbatched keeps the browser in the configuration that reproduces the reference
   * exactly. It costs one call per window instead of one per draft; since this runs in the
   * background while the user types, and it also lets the event loop breathe between windows, the
   * trade is worth exact agreement with the behaviour that was evaluated.
   */
  const collected: DecodedEntity[] = [];
  for (const window of windows) {
    const batch = buildBatch(inputIds, [window], vocabulary, maxLength);
    const width = batch.inputIds[0]?.length ?? SPECIAL_TOKEN_COUNT;
    const tensor = await runner.run(batch);
    const rowOffsets = windowOffsets(offsets, window, width);
    const logits = sliceLogitsRow(tensor, 0);
    const valid = rowOffsets.map(([start, end]) => start !== end);
    const labelIds = constrainedBieLabelIds(logits, valid, labels);
    const confidences = logits.map((values, index) => softmaxAt(values, labelIds[index] as number));
    const entities = decodeBieEntities(text, rowOffsets, labelIds, confidences, labels, threshold);
    const content = rowOffsets.filter(([start, end]) => start !== end);
    const windowStart = content[0]?.[0] ?? 0;
    const windowEnd = content[content.length - 1]?.[1] ?? 0;
    collected.push(...filterWindowBoundaryEntities(entities, windowStart, windowEnd, text.length));
  }

  return { entities: mergeWindowEntities(collected), windowCount: windows.length };
}
