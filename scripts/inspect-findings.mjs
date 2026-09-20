// One-off: print finding kinds and redaction values for a draft, so a failing
// assertion can be read without fighting console encoding.
//
// Usage: node scripts/inspect-findings.mjs "文本"
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, writeFile } from "node:fs/promises";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = await harnessBundle("inspect-entry.ts");
const outfile = await harnessBundle("inspect.mjs");

await writeFile(
  entry,
  `import { analyzeDraft, getRedactionValues, redactDraft } from "../src/shared/detector.js";
Object.assign(globalThis, { __inspect: { analyzeDraft, getRedactionValues, redactDraft } });
`,
  "utf8",
);
await build({
  entryPoints: [entry],
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
await rm(entry, { force: true });

const { analyzeDraft, getRedactionValues } = globalThis.__inspect;
const text = process.argv[2] ?? "";
const analysis = analyzeDraft(text);
console.log(JSON.stringify({
  kinds: analysis.findings.map((finding) => finding.kind),
  labels: analysis.findings.map((finding) => finding.labels ?? null),
  values: getRedactionValues(text),
}, null, 2));
