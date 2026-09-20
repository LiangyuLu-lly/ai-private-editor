// Run the with/without-model comparison over every evaluation set, sequentially.
//
// A driver rather than a shell loop: the sets have to run one at a time (they share one ONNX
// session's worth of CPU) and the per-set stats need collecting into one place.
//
// Usage: node scripts/eval-with-neural-all.mjs [--limit N] [--onnx path] [--model-dir path] [--threshold N]
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SETS = [
  // hidden-redteam first: it is the only set never used to tune a rule, so it is the one that can
  // support a claim rather than describe development.
  ["hidden-redteam", "ml/data/curated/hidden-redteam-v1.jsonl"],
  ["org-negatives", "ml/data/curated/org-negatives-v1.jsonl"],
  ["sift-gold", "ml/data/external/sift-opf-zh/gold-supported.jsonl"],
  ["blind-probe", "ml/data/curated/blind-probe-v1-clean.jsonl"],
  ["openpii-holdout", "ml/data/curated/openpii-zh/evaluation/holdout.jsonl"],
];

const limitIndex = process.argv.indexOf("--limit");
const limitArgs = limitIndex === -1 ? [] : ["--limit", process.argv[limitIndex + 1]];

// Where the prediction files go. Overridable so a re-run after a configuration change does not
// overwrite the previous configuration's predictions — those are the baseline the change is measured
// against, and once overwritten the comparison cannot be reproduced.
const rootIndex = process.argv.indexOf("--out-root");
const outRoot = rootIndex === -1 ? "ml/reports/generated/r7/neural-eval" : process.argv[rootIndex + 1];

// Forwarded so an alternative student can be scored through the identical product path. Without it
// this driver would silently score whatever is in src/assets/model, which is exactly the kind of
// mistake that produces a table comparing a model against itself.
const onnxIndex = process.argv.indexOf("--onnx");
const onnxArgs = onnxIndex === -1 ? [] : ["--onnx", process.argv[onnxIndex + 1]];
const modelDirectoryIndex = process.argv.indexOf("--model-dir");
const modelDirectoryArgs = modelDirectoryIndex === -1 ? [] : ["--model-dir", process.argv[modelDirectoryIndex + 1]];
const thresholdIndex = process.argv.indexOf("--threshold");
const thresholdArgs = thresholdIndex === -1 ? [] : ["--threshold", process.argv[thresholdIndex + 1]];

const summary = {};
for (const [name, gold] of SETS) {
  const outDir = `${outRoot}/${name}`;
  console.log(`=== ${name}`);
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "scripts", "eval-with-neural.mjs"),
        gold,
        outDir,
        ...limitArgs,
        ...onnxArgs,
        ...modelDirectoryArgs,
        ...thresholdArgs,
      ],
      { cwd: root },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      process.stdout.write(`  ${chunk.toString()}`);
    });
    child.on("close", (code) => (code === 0 ? resolvePromise(out) : rejectPromise(new Error(`${name} exited ${code}`))));
  });
  try {
    summary[name] = JSON.parse(stdout);
  } catch {
    summary[name] = { raw: stdout.slice(0, 400) };
  }
  console.log(`  ${JSON.stringify(summary[name])}`);
}

const target = resolve(root, outRoot, "harness-stats.json");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\nwritten ${target}`);
