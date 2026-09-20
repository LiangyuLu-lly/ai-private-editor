// Score the shipped TypeScript rule detector on an arbitrary JSONL corpus.
// The detector uses JavaScript UTF-16 offsets; output is converted to the Python
// benchmark's Unicode code-point contract at the serialization boundary.
//
// Usage: node scripts/eval-rules.mjs <gold.jsonl> <outDir> [--profile conservative|balanced]
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { splitByKind } from "./eval-kind-map.mjs";
import { harnessBundle } from "./harness-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [goldPath, outDir] = process.argv.slice(2).filter((item) => !item.startsWith("--"));
const profile = process.argv.includes("--profile")
  ? process.argv[process.argv.indexOf("--profile") + 1]
  : "balanced";
if (!goldPath || !outDir || !["conservative", "balanced"].includes(profile)) {
  console.error("usage: node scripts/eval-rules.mjs <gold.jsonl> <outDir> [--profile conservative|balanced]");
  process.exit(2);
}

const bundlePath = await harnessBundle("rules-eval.mjs");
await build({
  entryPoints: [resolve(root, "tests", "probe", "ts-detector-entry.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  legalComments: "none",
  logLevel: "silent",
});
await import(pathToFileURL(bundlePath).href);
const detector = globalThis.__tsDetector;
const codePointOffset = (text, utf16Offset) => Array.from(text.slice(0, utf16Offset)).length;
const rows = (await readFile(resolve(root, goldPath), "utf8"))
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const droppedByKind = {};
const predictions = rows.map((row) => {
  const { mapped, droppedByKind: dropped } = splitByKind(detector.detect(row.text, profile));
  for (const [kind, count] of Object.entries(dropped)) {
    droppedByKind[kind] = (droppedByKind[kind] ?? 0) + count;
  }
  const entities = mapped
    .map((range) => {
      const raw = row.text.slice(range.start, range.end);
      const start = codePointOffset(row.text, range.start);
      return { start, end: start + Array.from(raw).length, label: range.label, text: raw };
    })
    .sort((left, right) => left.start - right.start);
  return {
    id: row.id,
    text: row.text,
    entities,
    source: row.source,
    template_id: row.template_id,
    template_family: row.template_family,
  };
});
await mkdir(resolve(root, outDir), { recursive: true });
const target = resolve(root, outDir, `rules-${profile}.pred.jsonl`);
await writeFile(target, predictions.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
await writeFile(resolve(root, outDir, "dropped-kinds.json"), `${JSON.stringify(droppedByKind, null, 2)}\n`, "utf8");
await rm(bundlePath, { force: true });
console.log(JSON.stringify({ profile, documents: rows.length, output: target }));
