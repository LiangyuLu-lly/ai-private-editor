// Print raw semantic candidates (person / address) with their seed provenance.
//
// Usage:
//   node scripts/debug-semantic-candidates.mjs --text "武汉市洪山区霁虹街95号"
//   node scripts/debug-semantic-candidates.mjs --jsonl ml/data/... --grep "文三路" [--limit 20]
//
// Boundary bugs cannot be attributed without knowing which seed produced a span:
// the anchor path starts after a matched anchor word, the structural path backs off
// from an administrative-division or road suffix. The two need different fixes.
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function loadDetector() {
  const outfile = await harnessBundle("candidate-debug.mjs");
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

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const inlineText = readFlag("--text");
const jsonlPath = readFlag("--jsonl");
const grep = readFlag("--grep");
const limit = Number(readFlag("--limit") ?? 20);

if (!inlineText && !jsonlPath) {
  console.error("usage: --text <string> | --jsonl <path> [--grep <substring>] [--limit <n>]");
  process.exit(2);
}

const detector = await loadDetector();

let texts = [];
if (inlineText) {
  texts = [inlineText];
} else {
  const rows = (await readFile(resolve(root, jsonlPath), "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  texts = rows
    .map((row) => row.text)
    .filter((text) => typeof text === "string" && (grep === undefined || text.includes(grep)))
    .slice(0, limit);
}

for (const text of texts) {
  console.log("=".repeat(78));
  console.log(text);
  const found = detector.candidates(text);
  if (found.length === 0) {
    console.log("  (no semantic candidates)");
    continue;
  }
  for (const candidate of found) {
    const value = text.slice(candidate.start, candidate.end);
    console.log(
      `  ${candidate.kind.padEnd(12)} ${String(candidate.reason).padEnd(18)}` +
        `ev=${candidate.evidence.toFixed(2)} [${candidate.start},${candidate.end}) ${JSON.stringify(value)}`,
    );
  }
}
