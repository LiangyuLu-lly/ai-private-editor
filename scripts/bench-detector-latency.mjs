// Measure the shipped detector's latency at realistic draft sizes, both profiles.
//
// Needed to size the budget for neural review: the model's per-window cost only makes
// sense against how much of the interaction budget the rule engine already spends.
// The address component-chain work added in this round is not in the older measurements.
//
// Usage: node scripts/bench-detector-latency.mjs
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function loadDetector() {
  const outfile = await harnessBundle("bench-detector.mjs");
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

// A sentence mix that exercises every path: person anchor, address structure, phone, email.
const UNIT =
  "客户张默言下周来签合同，收货地址是上海市浦东新区世纪大道88号绿城花园12幢1801，" +
  "手机 13801234567，邮箱 zhang.moyan@example.com。负责人 李雷已经确认。";

function draftOfLength(target) {
  let text = "";
  while (text.length < target) {
    text += UNIT;
  }
  return text.slice(0, target);
}

const detector = await loadDetector();
const sizes = [200, 1_000, 5_000, 20_000, 80_000];
const rows = [];

for (const size of sizes) {
  const text = draftOfLength(size);
  for (const profile of ["conservative", "balanced"]) {
    // Warm up so the first-call compile cost is not attributed to the measurement.
    detector.detect(text, profile);
    const samples = [];
    const runs = size >= 20_000 ? 5 : 20;
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      const ranges = detector.detect(text, profile);
      samples.push(performance.now() - started);
      if (index === 0) {
        rows.push({ size, profile, detections: ranges.length });
      }
    }
    samples.sort((left, right) => left - right);
    const row = rows[rows.length - 1];
    row.p50 = samples[Math.floor(samples.length * 0.5)];
    row.p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
    row.runs = runs;
  }
}

console.log(
  ["chars", "profile", "detections", "p50 ms", "p95 ms", "runs"]
    .map((head, index) => (index === 0 ? head.padStart(7) : head.padStart(12)))
    .join(""),
);
for (const row of rows) {
  console.log(
    String(row.size).padStart(7) +
      row.profile.padStart(14) +
      String(row.detections).padStart(12) +
      row.p50.toFixed(2).padStart(10) +
      row.p95.toFixed(2).padStart(10) +
      String(row.runs).padStart(7),
  );
}

// Windows a 256-token neural pass would need. The student was benchmarked at sequence
// length 256; for Chinese, MacBERT/ELECTRA tokenizers are close to one token per character,
// so a window covers roughly 200 characters once special tokens and overlap are counted.
console.log();
console.log("neural windows needed (about 200 characters of usable span per 256-token window):");
console.log(
  ["chars", "windows", "native 26.05ms", "wasm 50ms", "wasm 130ms"]
    .map((head, index) => (index === 0 ? head.padStart(7) : head.padStart(16)))
    .join(""),
);
for (const size of sizes) {
  const windows = Math.ceil(size / 200);
  console.log(
    String(size).padStart(7) +
      String(windows).padStart(16) +
      `${(windows * 26.05).toFixed(0)} ms`.padStart(16) +
      `${(windows * 50).toFixed(0)} ms`.padStart(16) +
      `${(windows * 130).toFixed(0)} ms`.padStart(16),
  );
}
