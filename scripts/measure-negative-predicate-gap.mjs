// How much would applying the existing person-negative lexicon to model hints buy, and what would
// it cost?
//
// `isPersonNegative` runs inside the rule generator, upstream of the provider boundary, so neural
// hints never touch it. Measured symptom: `示例中写的是张三，不是真人。` is empty under rules alone
// and redacts `张三` once the model is attached.
//
// This script answers the question offline, from the prediction files the R7 evaluation already
// wrote, so it needs no model run:
//   - benefit: person spans predicted on documents with no gold entities that the predicate rejects
//   - cost:    person spans that match a gold entity and that the predicate would also reject
//
// A change that removes even a handful of true positives is not free, and pollution is a usability
// cost while a miss is a safety failure. So the cost column decides, not the benefit column.
//
// Usage: node scripts/measure-negative-predicate-gap.mjs
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SETS = [
  ["hidden-redteam", "ml/data/curated/hidden-redteam-v1.jsonl"],
  ["org-negatives", "ml/data/curated/org-negatives-v1.jsonl"],
  ["sift-gold", "ml/data/external/sift-opf-zh/gold-supported.jsonl"],
  ["blind-probe", "ml/data/curated/blind-probe-v1-clean.jsonl"],
  ["openpii-holdout", "ml/data/curated/openpii-zh/evaluation/holdout.jsonl"],
  ["cleanroom", "ml/data/curated/semantic-v2/test.jsonl"],
];

const entryPath = await harnessBundle("negative-predicate-entry.ts");
const bundlePath = await harnessBundle("negative-predicate.mjs");
await build({
  stdin: {
    contents:
      'import { isPersonNegative, looksLikeNonPersonValue } from "../src/shared/semantic-candidates.js";\n' +
      "Object.assign(globalThis, { __predicate: { isPersonNegative, looksLikeNonPersonValue } });\n",
    resolveDir: dirname(entryPath),
    sourcefile: "negative-predicate-entry.ts",
    loader: "ts",
  },
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  legalComments: "none",
});
await import(pathToFileURL(bundlePath).href);
const { isPersonNegative } = globalThis.__predicate;

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const totals = { rejectedClean: 0, rejectedGold: 0, cleanDocsFixed: 0, goldSpansLost: 0 };
const examples = { clean: new Map(), gold: new Map() };

for (const [name, goldPath] of SETS) {
  const predictionPath = resolve(root, "ml/reports/generated/r7/neural-eval", name, "rules-plus-model-balanced.pred.jsonl");
  let predictions;
  try {
    predictions = await readJsonl(predictionPath);
  } catch {
    console.log(`${name}: no prediction file, skipped`);
    continue;
  }
  const gold = new Map((await readJsonl(resolve(root, goldPath))).map((row) => [row.id, row]));

  let rejectedClean = 0;
  let rejectedGold = 0;
  let cleanDocsFixed = 0;
  let goldSpansLost = 0;
  let cleanDocsPolluted = 0;

  for (const row of predictions) {
    const goldRow = gold.get(row.id);
    if (goldRow === undefined) {
      continue;
    }
    const goldPersonSpans = new Set(
      (goldRow.entities ?? []).filter((entity) => entity.label === "PERSON").map((entity) => `${entity.start}:${entity.end}`),
    );
    const documentIsClean = (goldRow.entities ?? []).length === 0;
    const persons = (row.entities ?? []).filter((entity) => entity.label === "PERSON");
    if (documentIsClean && persons.length > 0) {
      cleanDocsPolluted += 1;
    }

    let allPersonsRejected = persons.length > 0;
    for (const entity of persons) {
      const rejected = isPersonNegative(row.text, entity.start, entity.end);
      if (!rejected) {
        allPersonsRejected = false;
      }
      if (rejected && documentIsClean) {
        rejectedClean += 1;
        examples.clean.set(entity.text, (examples.clean.get(entity.text) ?? 0) + 1);
      }
      if (rejected && goldPersonSpans.has(`${entity.start}:${entity.end}`)) {
        rejectedGold += 1;
        goldSpansLost += 1;
        examples.gold.set(entity.text, (examples.gold.get(entity.text) ?? 0) + 1);
      }
    }
    if (documentIsClean && allPersonsRejected) {
      cleanDocsFixed += 1;
    }
  }

  totals.rejectedClean += rejectedClean;
  totals.rejectedGold += rejectedGold;
  totals.cleanDocsFixed += cleanDocsFixed;
  totals.goldSpansLost += goldSpansLost;

  console.log(
    `${name.padEnd(16)} 干净文档被污染 ${String(cleanDocsPolluted).padStart(4)} → 词表可清掉 ${String(cleanDocsFixed).padStart(4)} 篇` +
      ` | 误报跨度被拒 ${String(rejectedClean).padStart(4)} | **正确人名被拒 ${String(rejectedGold).padStart(4)}**`,
  );
}

const top = (map, count) =>
  [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([value, occurrences]) => `${value}×${occurrences}`)
    .join(", ");

console.log("\n合计", JSON.stringify(totals));
console.log(`被拒的误报表面 top: ${top(examples.clean, 20) || "(无)"}`);
console.log(`被拒的正确人名 top: ${top(examples.gold, 20) || "(无)"}`);

await rm(bundlePath, { force: true });
