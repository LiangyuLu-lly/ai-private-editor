// Measure shipped professional-entity rules on the six evaluation sets.
// Gate: gold spans that the previous rules path covered must still overlap a prediction.
//
// Usage: node scripts/measure-rules-six-set.mjs
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = resolve(root, ".harness-tmp/wave-logs/W2-T13");
const r5Dir = resolve(root, "ml/reports/generated/r5");
const SCORE_PY = "import json,sys\nfrom evaluate_r5 import load, score\nprint(json.dumps(score(load(sys.argv[1]), load(sys.argv[2]))))";
const NEW_KIND_LABELS = [
  "INVOICE",
  "COURT_CASE",
  "VIN",
  "CONTRACT",
  "IPV6",
  "AWS_KEY",
  "AZURE_SAS",
  "GCP_SA",
  "LABELED_IDENTIFIER",
];
const SELECTION_SETS = [
  ["blind-probe", "ml/data/curated/blind-probe-v1-clean.jsonl"],
  ["sift-gold", "ml/data/external/sift-opf-zh/gold-supported.jsonl"],
  ["openpii-holdout", "ml/data/curated/openpii-zh/evaluation/holdout.jsonl"],
  ["cleanroom", "ml/data/curated/semantic-v2/test.jsonl"],
  ["org-negatives", "ml/data/curated/org-negatives-v1.jsonl"],
];
const REPORT_ONLY_SETS = [["hidden-redteam", "ml/data/curated/hidden-redteam-v1.jsonl"]];
const PROFILES = ["conservative", "balanced"];

export class GoldSpanDeletionError extends Error {
  constructor(deleted) {
    super(`gold span deletions: ${deleted}`);
    this.name = "GoldSpanDeletionError";
    this.deleted = deleted;
  }
}

function coveredPositions(entities) {
  const covered = new Set();
  for (const item of entities ?? []) {
    for (let position = item.start; position < item.end; position += 1) {
      covered.add(position);
    }
  }
  return covered;
}

function spanHasOverlap(entity, covered) {
  for (let position = entity.start; position < entity.end; position += 1) {
    if (covered.has(position)) return true;
  }
  return false;
}

export function countDeletedGoldSpans(goldRows, predictionRows) {
  let deleted = 0;
  for (let index = 0; index < goldRows.length; index += 1) {
    const predicted = predictionRows[index];
    const covered = coveredPositions(predicted?.entities);
    for (const entity of goldRows[index].entities ?? []) {
      if (!spanHasOverlap(entity, covered)) deleted += 1;
    }
  }
  return deleted;
}

export function assertZeroGoldSpanDeletions(goldRows, predictionRows) {
  const deleted = countDeletedGoldSpans(goldRows, predictionRows);
  if (deleted > 0) throw new GoldSpanDeletionError(deleted);
}

export function goldRowsCoveredByBaseline(goldRows, baselineRows) {
  const byId = new Map(baselineRows.map((row) => [row.id, row]));
  return goldRows.map((row) => {
    const covered = coveredPositions(byId.get(row.id)?.entities);
    return { ...row, entities: (row.entities ?? []).filter((entity) => spanHasOverlap(entity, covered)) };
  });
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function pythonBin() {
  const venv = resolve(root, "ml/.venv/Scripts/python.exe");
  return existsSync(venv) ? venv : "python";
}

function fmtRate(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(4);
}

function newKindRecall(recallByLabel) {
  const picked = {};
  for (const label of NEW_KIND_LABELS) {
    if (recallByLabel?.[label] !== undefined) picked[label] = recallByLabel[label];
  }
  return picked;
}

function regressionExamples(goldRows, baselineRows, predictionRows) {
  const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
  const examples = [];
  for (let index = 0; index < goldRows.length; index += 1) {
    const gold = goldRows[index];
    const baselineCovered = coveredPositions(baselineById.get(gold.id)?.entities);
    const predictedCovered = coveredPositions(predictionRows[index]?.entities);
    for (const entity of gold.entities ?? []) {
      if (!spanHasOverlap(entity, baselineCovered) || spanHasOverlap(entity, predictedCovered)) continue;
      examples.push({
        id: gold.id,
        label: entity.label,
        start: entity.start,
        end: entity.end,
        text: gold.text.slice(entity.start, entity.end),
      });
      if (examples.length >= 8) return examples;
    }
  }
  return examples;
}

async function scorePredictions(goldPath, predPath) {
  const result = await execFileAsync(pythonBin(), ["-c", SCORE_PY, goldPath, predPath], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: r5Dir },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

async function runEvalRules(goldRel, outDir, profile) {
  await mkdir(outDir, { recursive: true });
  await execFileAsync(
    process.execPath,
    [resolve(root, "scripts/eval-rules.mjs"), goldRel, outDir, "--profile", profile],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  return resolve(outDir, `rules-${profile}.pred.jsonl`);
}

async function measureSet(setName, goldRel, profile) {
  const selection = SELECTION_SETS.some((item) => item[0] === setName);
  const goldPath = resolve(root, goldRel);
  const outDir = resolve(logDir, "preds", setName);
  const predPath = await runEvalRules(goldRel, outDir, profile);
  const goldRows = await readJsonl(goldPath);
  const predictionRows = await readJsonl(predPath);
  const metrics = await scorePredictions(goldPath, predPath);
  const baselinePath = resolve(root, "ml/reports/generated/r7/neural-eval", setName, `rules-${profile}.pred.jsonl`);
  const baselineRows = existsSync(baselinePath) ? await readJsonl(baselinePath) : [];
  const keptGold = baselineRows.length > 0 ? goldRowsCoveredByBaseline(goldRows, baselineRows) : goldRows;
  const goldDeleted = countDeletedGoldSpans(keptGold, predictionRows);
  const uncovered = countDeletedGoldSpans(goldRows, predictionRows);
  const examples = goldDeleted > 0 ? regressionExamples(goldRows, baselineRows, predictionRows) : [];
  return {
    set: setName,
    profile,
    selection,
    missing: false,
    gold_deleted: goldDeleted,
    uncovered,
    charLeak: metrics.character_leak_rate,
    fullExpose: metrics.full_exposure_rate,
    pollution: metrics.clean_pollution_rate,
    recall_by_label: metrics.recall_by_label,
    new_kind_recall: newKindRecall(metrics.recall_by_label),
    baseline: baselineRows.length > 0,
    examples,
  };
}

function printTable(rows) {
  const header = `${"set".padEnd(18)}${"profile".padEnd(14)}${"goldDel".padStart(8)}${"charLeak".padStart(10)}${"fullExpose".padStart(12)}${"pollution".padStart(11)}  role`;
  console.log(header);
  for (const row of rows) {
    const role = row.selection ? "selection" : "report-only";
    console.log(
      `${row.set.padEnd(18)}${row.profile.padEnd(14)}${String(row.gold_deleted).padStart(8)}${fmtRate(row.charLeak).padStart(10)}${fmtRate(row.fullExpose).padStart(12)}${fmtRate(row.pollution).padStart(11)}  ${role}`,
    );
  }
}

async function main() {
  await mkdir(logDir, { recursive: true });
  const missing = [];
  const rows = [];
  for (const [setName, goldRel] of [...SELECTION_SETS, ...REPORT_ONLY_SETS]) {
    const goldPath = resolve(root, goldRel);
    if (!existsSync(goldPath)) {
      missing.push({ set: setName, path: goldRel });
      console.log(`MISSING ${setName}: ${goldRel}`);
      continue;
    }
    for (const profile of PROFILES) {
      console.log(`measuring ${setName} ${profile}`);
      rows.push(await measureSet(setName, goldRel, profile));
    }
  }
  printTable(rows);
  const selectionRows = rows.filter((row) => row.selection);
  const gateFail =
    selectionRows.some((row) => row.gold_deleted > 0) ||
    missing.some((item) => SELECTION_SETS.some((set) => set[0] === item.set));
  const regressions = selectionRows.flatMap((row) =>
    row.examples.map((example) => ({ ...example, set: row.set, profile: row.profile })),
  );
  console.log(gateFail ? "GATE: FAIL" : "GATE: PASS");
  if (regressions.length > 0) {
    console.log("regressions:");
    for (const example of regressions) {
      console.log(JSON.stringify(example));
    }
  }
  const summary = { missing, rows, gate: gateFail ? "FAIL" : "PASS", regressions };
  await writeFile(resolve(logDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (gateFail) process.exit(1);
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  await main();
}
