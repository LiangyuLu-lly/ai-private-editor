// Entry point for scoring the shipped detector with the local student model attached.
//
// Mirrors ts-detector-entry.ts, but the provider is backed by the real ONNX model instead of the
// rule/lexicon path alone. It reuses `reviewWithModel` and `combineSemanticProviders` — the same
// functions the offscreen document and content script use — so the measured system is the shipped
// system rather than a lookalike built for the benchmark.
import { getDetectionRanges } from "../../src/shared/detector.js";
import {
  combineSemanticProviders,
  createCachedNeuralProvider,
  createNeuralHintCache,
} from "../../src/shared/neural/hint-cache.js";
import { createOrtRunner } from "../../src/shared/neural/ort-runner.js";
import { reviewWithModel, type NeuralReviewSettings } from "../../src/shared/neural/review.js";
import { predictEntities } from "../../src/shared/neural/session.js";
import { createVocabulary } from "../../src/shared/neural/tokenizer.js";
import { createLocalStatisticalSemanticProvider } from "../../src/shared/semantic-review.js";

type Ranges = ReturnType<typeof getDetectionRanges>;

let settings: NeuralReviewSettings | null = null;
let runner: Awaited<ReturnType<typeof createOrtRunner>> | null = null;
const cache = createNeuralHintCache(4);

// The union of the rule/lexicon provider and the cache-backed neural provider, exactly as
// src/content.ts builds it.
const provider = combineSemanticProviders(
  createLocalStatisticalSemanticProvider(),
  createCachedNeuralProvider(cache),
);

async function load(options: {
  model: Uint8Array;
  wasmDirectoryUrl: string;
  vocabulary: string[];
  labels: string[];
  threshold: number;
  maxLength: number;
  stride: number;
  loadOrt: () => Promise<unknown>;
}): Promise<number> {
  runner = await createOrtRunner({
    model: options.model,
    wasmDirectoryUrl: options.wasmDirectoryUrl,
    loadOrt: options.loadOrt as never,
  });
  settings = {
    vocabulary: createVocabulary(options.vocabulary),
    labels: options.labels,
    threshold: options.threshold,
    maxLength: options.maxLength,
    stride: options.stride,
  };
  return runner.loadMilliseconds;
}

/**
 * Prime the cache for one draft, the way the content script does while the user types.
 *
 * Returns the number of hints so the harness can report how often the model contributed at all.
 */
async function prime(text: string): Promise<number> {
  if (settings === null || runner === null) {
    throw new Error("load() must be called first");
  }
  // Both detection profiles are scored over the same documents; re-running the model for the
  // second one would double the benchmark's cost for an identical result.
  const existing = cache.get(text);
  if (existing !== undefined) {
    return existing.length;
  }
  const hints = await reviewWithModel(text, settings, runner);
  cache.put(text, hints);
  return hints.length;
}

/**
 * Read the loaded ONNX output shape before an evaluation starts.
 *
 * A candidate with a different label head used to fail only after a corpus run had already
 * started. Keeping this probe beside the real runner turns that into a deterministic preflight
 * check without introducing a second ONNX implementation for evaluation.
 */
async function outputShape(): Promise<readonly number[]> {
  if (settings === null || runner === null) {
    throw new Error("load() must be called first");
  }
  const width = settings.maxLength ?? 256;
  const inputIds = new Array<number>(width).fill(settings.vocabulary.padId);
  const attentionMask = new Array<number>(width).fill(0);
  inputIds[0] = settings.vocabulary.clsId;
  inputIds[1] = settings.vocabulary.sepId;
  attentionMask[0] = 1;
  attentionMask[1] = 1;
  return (await runner.run({
    inputIds: [inputIds],
    attentionMask: [attentionMask],
    tokenTypeIds: [new Array<number>(width).fill(0)],
  })).dims;
}

function detect(text: string, profile: "conservative" | "balanced", withModel: boolean): Ranges {
  return getDetectionRanges(text, [], [], [], {
    detectionProfile: profile,
    ...(withModel ? { semanticReviewProvider: provider } : {}),
  });
}

/**
 * The model's own hints for a primed draft, before the detector consumes them.
 *
 * `tests/browser/neural-offscreen.test.mjs` compares these against what comes back through
 * `chrome.runtime` in a real browser. Hints are the right comparison surface for that: they are
 * exactly what crosses the two context boundaries, so a mismatch localises to the browser stack
 * rather than to anything the detector does afterwards.
 */
function hints(text: string): readonly { kind: string; start: number; end: number }[] {
  return (cache.get(text) ?? []).map(({ kind, start, end }) => ({ kind, start, end }));
}

/**
 * Expose decoded model spans before review-time repairs for offline diagnostics.
 *
 * This probe is not bundled into the extension. It lets an evaluator distinguish
 * a model boundary error from a boundary change introduced by reviewWithModel.
 */
async function rawEntities(text: string): Promise<readonly { label: string; start: number; end: number }[]> {
  if (settings === null || runner === null) {
    throw new Error("load() must be called first");
  }
  const { entities } = await predictEntities(
    text,
    settings.vocabulary,
    settings.labels,
    settings.threshold,
    runner,
    settings.maxLength,
    settings.stride,
  );
  return entities.map(({ label, start, end }) => ({ label, start, end }));
}

Object.assign(globalThis, { __neuralDetector: { load, prime, detect, hints, rawEntities, outputShape } });
