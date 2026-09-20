// End-to-end smoke test of the browser inference path against the real INT8 model.
//
// The parity suite replays recorded logits, which verifies tokenization, windowing, decoding and
// stitching. It cannot verify `ort-runner.ts`, because that is the one piece that talks to ONNX
// Runtime. This script closes that gap by driving the real runner in Node with the WASM backend —
// the same backend the offscreen document uses — and comparing against the same fixtures.
//
// Usage: node scripts/smoke-neural-runner.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Bundle the TypeScript inference stack the same way the extension does, so this exercises the
// shipped code rather than a parallel implementation.
const bundle = await harnessBundle("smoke-neural.mjs");
await build({
  entryPoints: [resolve(root, "tests", "probe", "neural-entry.ts")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  legalComments: "none",
});
const { createOrtRunner, predictEntities, createVocabulary, tokenize } = await import(
  pathToFileURL(bundle).href
);

const modelDirectory = resolve(root, "src", "assets", "model");
const manifest = JSON.parse(readFileSync(resolve(modelDirectory, "runtime_manifest.json"), "utf8"));
const labels = Object.entries(manifest.labels)
  .sort(([left], [right]) => Number(left) - Number(right))
  .map(([, label]) => label);
const vocabulary = createVocabulary(JSON.parse(readFileSync(resolve(modelDirectory, "vocab.json"), "utf8")));
const fixtures = JSON.parse(
  readFileSync(resolve(root, "tests", "fixtures", "neural-parity-fixtures.json"), "utf8"),
);

const wasmDirectory = `${pathToFileURL(resolve(root, "node_modules", "onnxruntime-web", "dist")).href}/`;
const runner = await createOrtRunner({
  // Bytes rather than a path: Node's fetch rejects `file:` URLs, and the browser side passes a
  // chrome-extension:// URL that fetch handles natively.
  model: new Uint8Array(readFileSync(resolve(modelDirectory, "model.int8.onnx"))),
  wasmDirectoryUrl: wasmDirectory,
  loadOrt: () => import("onnxruntime-web/wasm"),
});
console.log(`session loaded in ${runner.loadMilliseconds} ms`);

const NON_PERSON_ORGANISATION_NAMES = new Set([
  "华为",
  "腾讯",
  "小米",
  "阿里",
  "百度",
  "王府井",
  "中关村",
]);

function productEntities(text, entities) {
  return entities.filter((entity) =>
    (entity.label === "PERSON" || entity.label === "ADDRESS") &&
    !(entity.label === "PERSON" && NON_PERSON_ORGANISATION_NAMES.has(text.slice(entity.start, entity.end))),
  );
}

let rawMismatches = 0;
let productMismatches = 0;
let checked = 0;
const timings = [];
const divergences = [];
const allDeltas = [];

for (const fixture of fixtures.cases) {
  if (fixture.text.length === 0) {
    continue;
  }
  // Capture the live logits alongside the prediction so a span difference can be attributed to
  // kernel numerics rather than to the decode port.
  // One call per window now, so the observer accumulates instead of overwriting.
  const liveChunks = [];
  const observing = {
    run: async (batch) => {
      const tensor = await runner.run(batch);
      liveChunks.push(tensor.data);
      return tensor;
    },
  };

  const started = performance.now();
  const result = await predictEntities(
    fixture.text,
    vocabulary,
    labels,
    manifest.threshold,
    observing,
    manifest.max_length,
    manifest.stride,
  );
  const elapsed = performance.now() - started;
  timings.push({ characters: fixture.text.length, windows: result.windowCount, elapsed });
  checked += 1;

  const live = new Float32Array(liveChunks.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of liveChunks) {
    live.set(chunk, cursor);
    cursor += chunk.length;
  }

  let maxDelta = 0;
  let argmaxDisagreements = 0;
  let positions = 0;
  if (live.length === fixture.logits.length) {
    const width = labels.length;
    for (let index = 0; index < fixture.logits.length; index += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(live[index] - fixture.logits[index]));
    }
    // Only content positions matter. [CLS], [SEP] and padding get zero-width offsets, and the
    // decoder forces those to O regardless of what the model says there, so a disagreement in the
    // padding region cannot move a span.
    const contentTokens = tokenize(fixture.text, vocabulary).inputIds.length;
    const perWindow = fixture.logits_dims[1];
    for (let base = 0, index = 0; base < fixture.logits.length; base += width, index += 1) {
      const positionInWindow = index % perWindow;
      const windowIndex = Math.floor(index / perWindow);
      const windowStart = windowIndex * (perWindow - 2 - manifest.stride);
      const contentIndex = windowStart + positionInWindow - 1;
      const isContent = positionInWindow >= 1 && contentIndex < contentTokens &&
        positionInWindow <= Math.min(perWindow - 2, contentTokens - windowStart);
      if (!isContent) {
        continue;
      }
      let liveBest = 0;
      let recordedBest = 0;
      for (let column = 1; column < width; column += 1) {
        if (live[base + column] > live[base + liveBest]) liveBest = column;
        if (fixture.logits[base + column] > fixture.logits[base + recordedBest]) recordedBest = column;
      }
      positions += 1;
      if (liveBest !== recordedBest) argmaxDisagreements += 1;
    }
  } else {
    console.error(
      `  logits length mismatch for ${JSON.stringify(fixture.text.slice(0, 24))}: ` +
        `live ${live.length} vs recorded ${fixture.logits.length}`,
    );
  }

  allDeltas.push({
    text: fixture.text.slice(0, 26),
    windows: result.windowCount,
    maxDelta,
    argmaxDisagreements,
    positions,
  });

  const rawActual = JSON.stringify(result.entities);
  const rawExpected = JSON.stringify(fixture.entities_utf16);
  const actual = JSON.stringify(productEntities(fixture.text, result.entities));
  const expected = JSON.stringify(productEntities(fixture.text, fixture.entities_utf16));
  if (rawActual !== rawExpected) {
    rawMismatches += 1;
  }
  if (actual !== expected) {
    productMismatches += 1;
    divergences.push({
      text: fixture.text.slice(0, 40),
      windows: result.windowCount,
      maxDelta,
      argmaxDisagreements,
      positions,
      rawExpected,
      rawActual,
      expected,
      actual,
    });
  }
}

console.log();
console.log(`${checked - rawMismatches}/${checked} texts produced raw spans identical to the Python reference`);
console.log(`${checked - productMismatches}/${checked} texts produced identical user-visible semantic hints`);
console.log();
console.log("logits agreement between the WASM run and the recorded native run, every case:");
console.log(
  ["windows", "maxDelta", "argmaxDiff", "positions", "text"]
    .map((head, index) => (index === 4 ? `  ${head}` : head.padStart(11)))
    .join(""),
);
for (const item of allDeltas) {
  console.log(
    String(item.windows).padStart(11) +
      item.maxDelta.toFixed(4).padStart(11) +
      String(item.argmaxDisagreements).padStart(11) +
      String(item.positions).padStart(11) +
      `  ${JSON.stringify(item.text)}`,
  );
}
if (divergences.length > 0) {
  console.log();
  console.log("divergences, with the logits delta that explains them:");
  for (const item of divergences) {
    console.log(`  ${JSON.stringify(item.text)}  windows=${item.windows}`);
    console.log(
      `    max |live - recorded| logit delta: ${item.maxDelta.toFixed(6)}` +
        `   argmax disagreements: ${item.argmaxDisagreements}/${item.positions}`,
    );
    console.log(`    python hints: ${item.expected}`);
    console.log(`    browser hints: ${item.actual}`);
    if (item.rawExpected !== item.expected || item.rawActual !== item.actual) {
      console.log(`    raw python: ${item.rawExpected}`);
      console.log(`    raw browser: ${item.rawActual}`);
    }
  }
  console.log();
  console.log(
    "What this measures, stated precisely:\n" +
      "  Both sides now run one window per call, padded to max_length, so tokenization, window\n" +
      "  geometry and input tensors are identical. The remaining difference is ONNX Runtime's\n" +
      "  native CPU INT8 kernels versus its WASM kernels, which are not bit-identical.\n" +
      "  The release comparison is the product-visible semantic hint: it drops ACCOUNT_ALIAS and the\n" +
      "  exact organization-name false positives that review.ts drops before a hint crosses contexts.\n" +
      "  The remaining divergence above is on the one draft long enough to span two windows — a\n" +
      "  synthetic six-fold repetition, where the same near-tied patterns recur and a handful flip.\n" +
      "  Consequence to carry into any claim: browser output is close to, but not guaranteed\n" +
      "  identical to, the offline evaluation. With one divergent case there is no basis for saying\n" +
      "  the drift is unbiased, only that it was small here.\n" +
      "  It does not affect the safety property: rule candidates are computed independently and\n" +
      "  unioned with the model's, and every semantic candidate is confirm-policy.",
  );
}
console.log();
console.log("per-draft latency through the real runner (native WASM in Node):");
console.log(["chars", "windows", "ms", "ms/window"].map((head) => head.padStart(11)).join(""));
for (const timing of timings.sort((left, right) => left.characters - right.characters)) {
  console.log(
    String(timing.characters).padStart(11) +
      String(timing.windows).padStart(11) +
      timing.elapsed.toFixed(1).padStart(11) +
      (timing.elapsed / Math.max(1, timing.windows)).toFixed(1).padStart(11),
  );
}

await runner.dispose();

// The gate is that the runner works and that divergence stays rare and attributable, not that
// WASM reproduces native kernels bit-for-bit — which it does not.
const tolerated = Math.floor(checked * 0.1);
if (productMismatches > tolerated) {
  console.error(`\n${productMismatches} user-visible divergences exceeds the tolerated ${tolerated}.`);
  process.exit(1);
}
process.exit(0);
