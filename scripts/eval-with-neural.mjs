// Score the detector with and without the local student model in Node/WASM.
// This does not execute Chromium, the extension lifecycle, or the content-script pre-send path.
//
// This is the number that decides whether the model earns its 26 MB: not the model's standalone
// F1, but what it adds to the system the user actually runs. The rule engine already reaches
// ADDRESS recall 1.000 on two sets, so most of the remaining headroom is one bucket — unanchored
// personal names — and this harness shows whether the model fills it without dragging precision
// down elsewhere.
//
// Both arms use the same detector, the same profile and the same provider composition as
// src/content.ts. The only difference is whether the neural cache was primed.
//
// Usage: node scripts/eval-with-neural.mjs <gold.jsonl> <outDir> [--limit N] [--onnx path/to.onnx] [--model-dir path/to/artifact] [--threshold N] [--hints-output path/to/hints.jsonl] [--raw-entities-output path/to/entities.jsonl] [--run-receipt path --candidate-id id --release-profile balanced|conservative]
//
// `--onnx` swaps the model file while keeping the shipped manifest, so an alternative student can be
// scored through the identical product path. Only valid for students that share the shipped label
// order, tokenizer vocabulary, max_length and stride — which the R7 control arm does, having been
// trained from the same base with the same flags minus `--teacher`.
//
// `--model-dir` is the candidate path. Unlike `--onnx`, it reads the candidate's own manifest and
// vocabulary, so a nine-label head cannot be silently decoded as the shipped three-label student.
// Candidate exports currently carry Hugging Face `tokenizer.json`; the fallback is intentionally
// reported in the receipt, while production packaging still requires the explicit `vocab.json` file.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { splitByKind } from "./eval-kind-map.mjs";
import { harnessBundle } from "./harness-paths.mjs";
import { buildNodeDetectorRunReceipt, writeRunReceipt } from "./release-run-receipt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function labelsFromManifest(manifest, manifestPath) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${manifestPath} must be an object`);
  }
  if (manifest.labels === null || typeof manifest.labels !== "object" || Array.isArray(manifest.labels)) {
    throw new Error(`${manifestPath} carries no labels object`);
  }
  const entries = Object.entries(manifest.labels)
    .map(([index, label]) => [Number(index), label])
    .sort(([left], [right]) => left - right);
  if (entries.length === 0 || entries.some(([index, label], expected) => index !== expected || typeof label !== "string")) {
    throw new Error(`${manifestPath} labels must have contiguous numeric indices starting at zero`);
  }
  const labels = entries.map(([, label]) => label);
  if (labels[0] !== "O") {
    throw new Error(`${manifestPath} label 0 must be O`);
  }
  if (new Set(labels).size !== labels.length) {
    throw new Error(`${manifestPath} labels must be unique`);
  }
  return labels;
}

function entityLabelSetFromManifest(labels, manifestPath) {
  const entityLabels = [];
  for (const tag of labels) {
    if (tag === "O") {
      continue;
    }
    const separator = tag.indexOf("-");
    const prefix = separator === -1 ? "" : tag.slice(0, separator);
    const label = separator === -1 ? "" : tag.slice(separator + 1);
    if (!/^[BIE]$/.test(prefix) || !/^[A-Z][A-Z0-9_]*$/.test(label)) {
      throw new Error(`${manifestPath} contains an invalid entity tag: ${tag}`);
    }
    if (!entityLabels.includes(label)) {
      entityLabels.push(label);
    }
  }
  if (entityLabels.length === 0) {
    throw new Error(`${manifestPath} contains no entity labels`);
  }
  return entityLabels.join(",");
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function vocabularyFromTokenizer(payload, tokenizerPath) {
  const vocab = payload?.model?.vocab;
  if (vocab === null || typeof vocab !== "object" || Array.isArray(vocab)) {
    throw new Error(`${tokenizerPath} does not expose model.vocab`);
  }
  const entries = Object.entries(vocab)
    .map(([token, index]) => [token, Number(index)])
    .sort(([, left], [, right]) => left - right);
  if (entries.length === 0 || entries.some(([, index], expected) => !Number.isInteger(index) || index !== expected)) {
    throw new Error(`${tokenizerPath} vocabulary indices must be contiguous starting at zero`);
  }
  return entries.map(([token]) => token);
}

async function loadVocabulary(modelDirectory) {
  const vocabPath = resolve(modelDirectory, "vocab.json");
  try {
    const bytes = await readFile(vocabPath);
    const vocabulary = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(vocabulary) || vocabulary.some((token) => typeof token !== "string")) {
      throw new Error(`${vocabPath} must be a JSON array of strings`);
    }
    return { vocabulary, path: vocabPath, source: "vocab.json", sha256: sha256(bytes) };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const tokenizerPath = resolve(modelDirectory, "tokenizer.json");
  const bytes = await readFile(tokenizerPath);
  return {
    vocabulary: vocabularyFromTokenizer(JSON.parse(bytes.toString("utf8")), tokenizerPath),
    path: tokenizerPath,
    source: "tokenizer.json",
    sha256: sha256(bytes),
  };
}

const [goldPath, outDir] = process.argv.slice(2);
if (!goldPath || !outDir) {
  console.error("usage: node scripts/eval-with-neural.mjs <gold.jsonl> <outDir> [--limit N] [--onnx path] [--model-dir path] [--threshold N] [--hints-output path] [--raw-entities-output path] [--run-receipt path --candidate-id id --release-profile balanced|conservative]");
  process.exit(2);
}
const limit = Number(readFlag("--limit", "0"));
const onnxOverride = readFlag("--onnx", "");
const modelDirectoryOverride = readFlag("--model-dir", "");
const thresholdOverride = readFlag("--threshold", "");
const hintsOutputPath = readFlag("--hints-output", "");
const rawEntitiesOutputPath = readFlag("--raw-entities-output", "");
const runReceiptPath = readFlag("--run-receipt", "");
const candidateId = readFlag("--candidate-id", "");
const releaseProfile = readFlag("--release-profile", "");
if (!Number.isInteger(limit) || limit < 0) {
  throw new Error(`--limit must be a non-negative integer, received ${readFlag("--limit", "0")}`);
}
if (onnxOverride !== "" && modelDirectoryOverride !== "") {
  throw new Error("--onnx and --model-dir are mutually exclusive; use --model-dir for a full candidate artifact");
}
if (runReceiptPath !== "") {
  if (candidateId === "") {
    throw new Error("--run-receipt requires --candidate-id");
  }
  if (!["balanced", "conservative"].includes(releaseProfile)) {
    throw new Error("--run-receipt requires --release-profile balanced or conservative");
  }
} else if (candidateId !== "" || releaseProfile !== "") {
  throw new Error("--candidate-id and --release-profile are only valid with --run-receipt");
}

const bundlePath = await harnessBundle("neural-eval.mjs");
await build({
  entryPoints: [resolve(root, "tests", "probe", "neural-detector-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  legalComments: "none",
});
await import(pathToFileURL(bundlePath).href);
const detector = globalThis.__neuralDetector;

const modelDirectory = modelDirectoryOverride === ""
  ? resolve(root, "src", "assets", "model")
  : resolve(root, modelDirectoryOverride);
const manifestPath = resolve(modelDirectory, "runtime_manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const labels = labelsFromManifest(manifest, manifestPath);
const labelSet = entityLabelSetFromManifest(labels, manifestPath);
const maxLength = positiveInteger(manifest.max_length, `${manifestPath}.max_length`, 256);
if (maxLength < 3) {
  throw new Error(`${manifestPath}.max_length must leave room for CLS, SEP and one token`);
}
const stride = nonNegativeInteger(manifest.stride, `${manifestPath}.stride`, 64);
if (stride >= maxLength - 2) {
  throw new Error(`${manifestPath}.stride must be smaller than max_length - 2`);
}
const modelPath = onnxOverride === "" ? resolve(modelDirectory, "model.int8.onnx") : resolve(root, onnxOverride);
if (onnxOverride !== "") {
  console.error(`model override: ${modelPath}`);
}
if (thresholdOverride === "" && !Number.isFinite(manifest.threshold)) {
  throw new Error(`${manifestPath} has no finite threshold; pass --threshold explicitly for a candidate artifact`);
}
const threshold = thresholdOverride === "" ? manifest.threshold : Number(thresholdOverride);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  throw new Error(`--threshold must be a finite number in [0, 1], received ${thresholdOverride}`);
}
const modelBytes = await readFile(modelPath);
const vocabulary = await loadVocabulary(modelDirectory);

const loadMilliseconds = await detector.load({
  // Bytes, because Node's fetch rejects file: URLs. The extension passes a chrome-extension:// URL.
  model: new Uint8Array(modelBytes),
  wasmDirectoryUrl: `${pathToFileURL(resolve(root, "node_modules", "onnxruntime-web", "dist")).href}/`,
  vocabulary: vocabulary.vocabulary,
  labels,
  threshold,
  maxLength,
  stride,
  loadOrt: () => import("onnxruntime-web/wasm"),
});
console.error(`model loaded in ${loadMilliseconds} ms`);
const outputShape = await detector.outputShape();
if (outputShape.length !== 3 || outputShape[2] !== labels.length) {
  throw new Error(
    `ONNX output label width ${outputShape[2] ?? "unknown"} does not match ${labels.length} labels in ${manifestPath}`,
  );
}

const rows = (await readFile(resolve(root, goldPath), "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const documents = limit > 0 ? rows.slice(0, limit) : rows;

await mkdir(resolve(root, outDir), { recursive: true });
const evaluatedGoldTarget = resolve(root, outDir, "gold.evaluated.jsonl");
await writeFile(evaluatedGoldTarget, documents.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
console.error(`written ${evaluatedGoldTarget}`);

const droppedByKind = {};

function entitiesFrom(row, ranges) {
  const { mapped, droppedByKind: dropped } = splitByKind(ranges);
  for (const [kind, count] of Object.entries(dropped)) {
    droppedByKind[kind] = (droppedByKind[kind] ?? 0) + count;
  }
  const entities = mapped.map((range) => {
    // Detector offsets are JavaScript UTF-16 indices; the Python benchmark contract uses
    // Unicode code-point offsets. Convert only at the serialization boundary so the detector
    // and the browser path keep their native indexing semantics.
    const raw = row.text.slice(range.start, range.end);
    const start = Array.from(row.text.slice(0, range.start)).length;
    const end = start + Array.from(raw).length;
    return { start, end, label: range.label, text: raw };
  });
  entities.sort((left, right) => left.start - right.start);
  return entities;
}

const stats = { documents: documents.length, primedWithHints: 0, totalHints: 0, neuralMs: 0 };

// One pass over the corpus, priming each document once and scoring all four arms from it. Looping
// per arm instead would re-run the model three extra times per document for identical hints.
const output = {
  "rules-conservative": [],
  "rules-balanced": [],
  "rules-plus-model-conservative": [],
  "rules-plus-model-balanced": [],
};
const hintTrace = [];
const rawEntityTrace = [];

let processed = 0;
for (const row of documents) {
  const started = performance.now();
  const hintCount = await detector.prime(row.text);
  stats.neuralMs += performance.now() - started;
  stats.totalHints += hintCount;
  if (hintCount > 0) {
    stats.primedWithHints += 1;
  }
  if (hintsOutputPath !== "") {
    hintTrace.push({
      id: row.id,
      hints: detector.hints(row.text).map(({ kind, start, end }) => ({ kind, start, end })),
    });
  }
  if (rawEntitiesOutputPath !== "") {
    rawEntityTrace.push({ id: row.id, entities: await detector.rawEntities(row.text) });
  }

  for (const profile of ["conservative", "balanced"]) {
    for (const arm of ["rules", "rules-plus-model"]) {
      output[`${arm}-${profile}`].push({
        id: row.id,
        text: row.text,
        entities: entitiesFrom(row, detector.detect(row.text, profile, arm === "rules-plus-model")),
        source: row.source,
        template_id: row.template_id,
        template_family: row.template_family,
      });
    }
  }

  processed += 1;
  if (processed % 250 === 0) {
    console.error(`  ${processed}/${documents.length}  ${(stats.neuralMs / processed).toFixed(1)} ms/doc`);
  }
}

for (const [name, predictions] of Object.entries(output)) {
  const target = resolve(root, outDir, `${name}.pred.jsonl`);
  await writeFile(target, predictions.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  console.error(`written ${target}`);
}
await writeFile(resolve(root, outDir, "dropped-kinds.json"), `${JSON.stringify(droppedByKind, null, 2)}\n`, "utf8");

let releaseRunReceipt = null;
if (runReceiptPath !== "") {
  const arm = `rules-plus-model-${releaseProfile}`;
  const predictionTarget = resolve(root, outDir, `${arm}.pred.jsonl`);
  const detectorSourceBytes = await readFile(resolve(root, "src", "shared", "detector.ts"));
  const evaluatorSourceBytes = await readFile(fileURLToPath(import.meta.url));
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: sha256(await readFile(evaluatedGoldTarget)),
    predictionsContentSha256: sha256(await readFile(predictionTarget)),
    artifactHashes: {
      onnx_int8: sha256(modelBytes),
      runtime_manifest: sha256(manifestBytes),
      detector_source: sha256(detectorSourceBytes),
      browser_evaluator: sha256(evaluatorSourceBytes),
    },
    metadata: {
      candidate_id: candidateId,
      rule_profile: releaseProfile,
      model_threshold: String(threshold),
      label_set: labelSet,
    },
  });
  await writeRunReceipt(resolve(root, runReceiptPath), receipt);
  releaseRunReceipt = {
    arm,
    sha256: receipt.run_receipt_sha256,
    run_receipt_version: receipt.run_receipt_version,
    execution_backend: receipt.execution_backend,
    execution_scope: receipt.execution_scope,
  };
}

if (hintsOutputPath !== "") {
  const target = resolve(root, hintsOutputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, hintTrace.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  console.error(`written ${target}`);
}

if (rawEntitiesOutputPath !== "") {
  const target = resolve(root, rawEntitiesOutputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, rawEntityTrace.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  console.error(`written ${target}`);
}

await rm(bundlePath, { force: true });
console.log(
  JSON.stringify(
    {
      ...stats,
      neuralMsPerDocument: Number((stats.neuralMs / Math.max(1, stats.documents)).toFixed(2)),
      loadMilliseconds,
      threshold,
      input: {
        goldPath,
        evaluatedGoldPath: `${outDir}/gold.evaluated.jsonl`,
        limit,
        hintsOutputPath: hintsOutputPath === "" ? null : hintsOutputPath,
        rawEntitiesOutputPath: rawEntitiesOutputPath === "" ? null : rawEntitiesOutputPath,
      },
      artifact: {
        modelDirectory: modelDirectoryOverride === "" ? "src/assets/model" : modelDirectoryOverride,
        modelPath: onnxOverride === "" ? `${modelDirectoryOverride === "" ? "src/assets/model" : modelDirectoryOverride}/model.int8.onnx` : onnxOverride,
        modelSha256: sha256(modelBytes),
        manifestPath: modelDirectoryOverride === "" ? "src/assets/model/runtime_manifest.json" : `${modelDirectoryOverride}/runtime_manifest.json`,
        manifestSha256: sha256(manifestBytes),
        vocabularyPath: vocabulary.path.startsWith(root) ? vocabulary.path.slice(root.length + 1).replaceAll("\\", "/") : vocabulary.path,
        vocabularySource: vocabulary.source,
        vocabularySha256: vocabulary.sha256,
        labels,
        maxLength,
        stride,
        outputShape,
      },
      releaseRunReceipt,
    },
    null,
    2,
  ),
);
