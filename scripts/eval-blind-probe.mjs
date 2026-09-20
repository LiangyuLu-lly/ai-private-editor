// Score the shipped TypeScript detector against the blind probe set.
//
// Usage: node scripts/eval-blind-probe.mjs <probe.jsonl> <outDir>
//
// Emits one predictions JSONL per detection profile, using the ml-side label
// names so the existing Python evaluator can score them unchanged.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { splitByKind } from "./eval-kind-map.mjs";
import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function loadDetector() {
  const outfile = await harnessBundle("probe-detector.mjs");
  await build({
    entryPoints: [resolve(root, "tests", "probe", "ts-detector-entry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    legalComments: "none",
  });
  await import(`file://${outfile}`);
  await rm(outfile, { force: true });
  return globalThis.__tsDetector;
}

const [probePath, outDir] = process.argv.slice(2);
if (!probePath || !outDir) {
  console.error("usage: node scripts/eval-blind-probe.mjs <probe.jsonl> <outDir>");
  process.exit(2);
}

const detector = await loadDetector();
const rows = (await readFile(probePath, "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

await mkdir(outDir, { recursive: true });
const droppedByKind = {};

for (const profile of ["conservative", "balanced"]) {
  const predictions = [];
  const started = process.hrtime.bigint();

  for (const row of rows) {
    const { mapped, droppedByKind: dropped } = splitByKind(detector.detect(row.text, profile));
    for (const [kind, count] of Object.entries(dropped)) {
      droppedByKind[kind] = (droppedByKind[kind] ?? 0) + count;
    }
    const entities = mapped.map((range) => ({
      start: range.start,
      end: range.end,
      label: range.label,
      text: row.text.slice(range.start, range.end),
    }));
    entities.sort((left, right) => left.start - right.start);
    // Mirror the schema the Python evaluator expects, carrying provenance through
    // from the gold row so per-family error analysis works on these predictions.
    predictions.push({
      id: row.id,
      text: row.text,
      entities,
      source: row.source,
      template_id: row.template_id,
      template_family: row.template_family,
    });
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const target = resolve(outDir, `ts-${profile}.pred.jsonl`);
  await writeFile(target, predictions.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  console.log(
    JSON.stringify({
      profile,
      documents: rows.length,
      output: target,
      total_ms: Math.round(elapsedMs),
      per_document_ms: Number((elapsedMs / rows.length).toFixed(3)),
    }),
  );
}

await writeFile(resolve(outDir, "dropped-kinds.json"), `${JSON.stringify(droppedByKind, null, 2)}\n`, "utf8");
