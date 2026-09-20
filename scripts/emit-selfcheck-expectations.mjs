// Compute the expected hints for the extension's built-in self-check, from the shipped artifact.
//
// The self-check exists because this machine cannot automate a real browser: Chrome 152 ignores
// --load-extension, CDP Extensions.loadUnpacked installs an extension that stays unreachable, and
// Edge cannot be spawned from Node here at all. So the release gate — does the offscreen document
// get created, does WASM load under the extension-page CSP, does inference produce the right spans —
// has to be verifiable by a person clicking one button in their own browser.
//
// For that to mean anything, the expectations cannot be hand-written. They come from the Node ONNX
// path, which the parity fixtures pin against the Python reference. Printing them here and pasting
// them into src/diagnostics.ts keeps the self-check honest and makes regeneration a documented step
// rather than folklore.
//
// Usage: node scripts/emit-selfcheck-expectations.mjs
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// One draft per property the gate cares about. Kept short so a person can read the result.
const DRAFTS = [
  ["bare-person", "周妍舒昨天说过这件事", "裸人名，规则接不住，这一条证明模型真的在跑"],
  ["unanchored-address", "武汉市洪山区霁虹街95号", "无锚词地址"],
  ["anchored-person", "客户张伟会尽快跟进。", "有锚词的人名"],
  ["account-alias", "请搜索 wxid_demo_123 看看", "账号别名经过本地形态和上下文门控"],
  ["organisation", "请联系华为处理云服务故障。", "机构名不该被当成人名"],
  ["clean", "今天天气很好，适合出去走走。", "干净文本，必须没有任何提示"],
  ["obfuscated", "客户张\u200b默\u2066言会跟进。", "零宽与双向控制符混淆，考归一化视图与偏移回映"],
];

const bundlePath = await harnessBundle("selfcheck-expectations.mjs");
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

const modelDirectory = resolve(root, "src", "assets", "model");
const manifest = JSON.parse(await readFile(resolve(modelDirectory, "runtime_manifest.json"), "utf8"));
await detector.load({
  model: new Uint8Array(await readFile(resolve(modelDirectory, "model.int8.onnx"))),
  wasmDirectoryUrl: `${pathToFileURL(resolve(root, "node_modules", "onnxruntime-web", "dist")).href}/`,
  vocabulary: JSON.parse(await readFile(resolve(modelDirectory, "vocab.json"), "utf8")),
  labels: Object.entries(manifest.labels)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, label]) => label),
  threshold: manifest.threshold,
  maxLength: manifest.max_length,
  stride: manifest.stride,
  loadOrt: () => import("onnxruntime-web/wasm"),
});

const cases = [];
for (const [id, text, note] of DRAFTS) {
  await detector.prime(text);
  cases.push({
    id,
    text,
    note,
    expected: detector.hints(text).map((hint) => ({ kind: hint.kind, start: hint.start, end: hint.end })),
  });
}

await rm(bundlePath, { force: true });

console.log(`// artifact: ${manifest.artifact}, threshold ${manifest.threshold}`);
console.log(`// regenerate with: node scripts/emit-selfcheck-expectations.mjs`);
console.log("const SELF_CHECK_CASES: readonly SelfCheckCase[] = [");
for (const item of cases) {
  console.log(`  {`);
  console.log(`    id: ${JSON.stringify(item.id)},`);
  console.log(`    text: ${JSON.stringify(item.text)},`);
  console.log(`    note: ${JSON.stringify(item.note)},`);
  console.log(
    `    expected: [${item.expected
      .map((hint) => `{ kind: ${JSON.stringify(hint.kind)}, start: ${hint.start}, end: ${hint.end} }`)
      .join(", ")}],`,
  );
  console.log(`  },`);
}
console.log("];");
