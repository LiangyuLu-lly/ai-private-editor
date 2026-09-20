// A long-lived stdin/stdout service around the shipped TypeScript detector.
//
// The playground needs the rule engine and the neural model side by side, and the rule
// engine only exists as TypeScript inside the extension. Bundling per request would cost
// a Node start plus an esbuild pass every time, so this bundles once at startup and then
// answers line-delimited JSON requests for as long as it is kept open.
//
// Protocol, one JSON object per line in each direction:
//   in : {"id": 1, "text": "...", "profiles": ["conservative", "balanced"]}
//   out: {"id": 1, "results": {"conservative": {"ranges": [...], "ms": 0.02}, ...}}
//   out: {"id": 1, "error": "..."}
// A single {"ready": true} line is written once the detector is loaded.
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Same mapping the evaluation harness uses, so the playground and the scored numbers
// describe the same system. Kinds with no ml counterpart are still shown, tagged with
// their raw kind, because a user testing the tool wants to see everything it would mask.
const LABEL_MAP = {
  phone: "CN_PHONE",
  email: "EMAIL",
  china_id: "CN_ID",
  bank_card: "BANK_CARD",
  person_name: "PERSON",
  address: "ADDRESS",
  account: "ACCOUNT_ALIAS",
};

async function loadDetector() {
  const outfile = await harnessBundle("playground-detector.mjs");
  await build({
    entryPoints: [resolve(root, "tests", "probe", "ts-detector-entry.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node20"],
    legalComments: "none",
    logLevel: "silent",
  });
  await import(`file://${outfile}`);
  await rm(outfile, { force: true });
  return globalThis.__tsDetector;
}

const detector = await loadDetector();
process.stdout.write(JSON.stringify({ ready: true }) + "\n");

const reader = createInterface({ input: process.stdin });
for await (const line of reader) {
  if (!line.trim()) {
    continue;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: null, error: `bad request: ${error.message}` }) + "\n");
    continue;
  }

  try {
    const text = String(request.text ?? "");
    const profiles = Array.isArray(request.profiles) ? request.profiles : ["conservative", "balanced"];
    const results = {};
    for (const profile of profiles) {
      const started = process.hrtime.bigint();
      const ranges = detector.detect(text, profile);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      results[profile] = {
        ms: Number(elapsedMs.toFixed(3)),
        ranges: ranges.map((range) => ({
          start: range.start,
          end: range.end,
          kind: range.kind,
          label: LABEL_MAP[range.kind] ?? range.kind.toUpperCase(),
          text: text.slice(range.start, range.end),
        })),
      };
    }
    process.stdout.write(JSON.stringify({ id: request.id ?? null, results }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id ?? null, error: String(error) }) + "\n");
  }
}
