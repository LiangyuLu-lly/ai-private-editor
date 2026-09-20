// Re-run the type-coverage probe cases through the shipped extension, with and without the local
// student model.
//
// `ml/reports/generated/probe/coverage_matrix.py` measures the same cases against the rule engine
// and the PyTorch teachers. It cannot measure the shipped student, because that runs in the
// extension's ONNX path rather than in the playground. This script closes that gap so the
// `TS-bal+模型` column in docs/type-coverage.md is measured rather than inferred from the
// corpus-level recall numbers.
//
// The cases are copied verbatim from CASES in coverage_matrix.py; if that list changes, this one
// must be updated with it. A drift check is not automated because the Python list is a literal in
// a gitignored report script.
//
// Usage: node scripts/probe-coverage-with-neural.mjs
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { harnessBundle } from "./harness-paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// [group, type, expected value, expected DetectionKind or null, sentence]
const CASES = [
  ["语义三标签", "PERSON 锚定", "沈砚", "person_name", "工单已受理，处理人 沈砚。"],
  ["语义三标签", "PERSON 裸提及", "沈砚", "person_name", "沈砚提交的复机申请我看过了。"],
  ["语义三标签", "ADDRESS 有锚词", "北京市朝阳区砚溪路128号", "address", "样品寄到北京市朝阳区砚溪路128号，到楼下再联系。"],
  ["语义三标签", "ADDRESS 无锚词", "武汉市洪山区霁虹街95号", "address", "武汉市洪山区霁虹街95号，明天上门。"],
  ["语义三标签", "ACCOUNT_ALIAS", "yx_12345", "account", "加微信 yx_12345 确认售后。"],

  ["两侧都有", "CN_PHONE", "13843029571", "phone", "回访号码 13843029571。"],
  ["两侧都有", "EMAIL", "yanxi@probe-mail.test", "email", "开票邮箱 yanxi@probe-mail.test。"],
  ["两侧都有", "CN_ID 裸", "110105199003074210", "china_id", "证件号 110105199003074210 已核验。"],
  ["两侧都有", "CN_ID 带标签", "110105199003074210", "china_id", "身份证号：110105199003074210"],
  ["两侧都有", "BANK_CARD 裸", "6222021234567890128", "bank_card", "工资卡 6222021234567890128。"],
  ["两侧都有", "LICENSE_PLATE 裸", "京A12345", "license_plate", "他的车是京A12345，停在地下二层。"],
  ["两侧都有", "PASSPORT 裸", "E12345678", "passport", "护照 E12345678 已经过期。"],

  ["只有 TS 侧", "统一社会信用代码", "91110108MA01ABCD2H", null, "统一社会信用代码 91110108MA01ABCD2H。"],
  ["只有 TS 侧", "IPv4 内网", "192.168.31.42", null, "服务器内网 IP 192.168.31.42。"],
  ["只有 TS 侧", "本地路径", "C:\\Users\\shenyan\\Desktop", null, "日志在 C:\\Users\\shenyan\\Desktop 下面。"],
  ["只有 TS 侧", "API key", "sk-abcdef1234567890abcdef", null, "api_key=sk-abcdef1234567890abcdef"],
  ["只有 TS 侧", "数据库连接串", "postgres://user:pass@10.0.0.5:5432/db", null, "连接串 postgres://user:pass@10.0.0.5:5432/db"],
  ["只有 TS 侧", "密码字段", "Hunter2Hunter2", null, "数据库密码：Hunter2Hunter2"],
  ["只有 TS 侧", "标签化编号", "RS-DA-2023-147", null, "人事档案编号：RS-DA-2023-147"],

  ["两侧都没有", "私密日期（生日）", "1990年3月7日", null, "他的生日是1990年3月7日。"],
  ["两侧都没有", "私密 URL（分享链接）", "https://drive.example.test/s/9fA2kQ", null, "文件在 https://drive.example.test/s/9fA2kQ"],
  ["两侧都没有", "对公银行账号", "1002 3456 7890 1234", null, "对公账号 1002 3456 7890 1234。"],
  ["两侧都没有", "医保号（空格分隔）", "3701021988", null, "医保卡号 3701021988 已停用。"],
];

// The hard half of `PERSON 裸提及`. `沈砚` above is surname + one character and the rule engine
// already reaches it, which is why that row reads 半 rather than 。 — these are the ones it
// misses: common surname + two-character given name, no anchor word before, no role word after.
// docs/type-coverage.md calls this cell "the model's reason to exist", so it has to be measured
// rather than argued.
//
// `客户王川梓会跟进` is deliberately absent: 客户 is itself an anchor word, so it would prove
// nothing about the unanchored case.
const HARD_BARE_MENTIONS = [
  ["周妍舒", "周妍舒昨天说过这件事。"],
  ["王川梓", "王川梓昨天提交了复机申请。"],
  ["岑湛珩", "岑湛珩的沟通记录我已经看过。"],
  ["储翊安", "储翊安明天不在工位。"],
  ["邵桉", "邵桉昨天就把材料带走了。"],
];

// Negative controls. The model must not turn these into hits; that is the pollution surface the
// model card quantifies, and this probe should show it rather than hide it.
const NEGATIVES = [
  ["公司名不该打码", "药明康德的报告已经发布。"],
  ["公司名不该打码", "隆基绿能今年的出货量增长明显。"],
  ["历史人物不该打码", "王维的作品将在公开课中讲解。"],
  // The clean-room surfaces R6 eliminated on the teacher side. The student brings them back;
  // these four are the top of that list, kept here so the regression is visible in one command.
  ["历史人物不该打码", "李白将在公开课中被讨论。"],
  ["历史人物不该打码", "公告提到王安石，不是个人联系信息。"],
  ["地标不该打码", "公告提到黄鹤楼，不是个人联系信息。"],
  ["占位值不该打码", "示例中写的是张三，不是真人。"],
];

const bundlePath = await harnessBundle("coverage-probe.mjs");
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
const labels = Object.entries(manifest.labels)
  .sort(([left], [right]) => Number(left) - Number(right))
  .map(([, label]) => label);

await detector.load({
  model: new Uint8Array(await readFile(resolve(modelDirectory, "model.int8.onnx"))),
  wasmDirectoryUrl: `${pathToFileURL(resolve(root, "node_modules", "onnxruntime-web", "dist")).href}/`,
  vocabulary: JSON.parse(await readFile(resolve(modelDirectory, "vocab.json"), "utf8")),
  labels,
  threshold: manifest.threshold,
  maxLength: manifest.max_length,
  stride: manifest.stride,
  loadOrt: () => import("onnxruntime-web/wasm"),
});

/**
 * Classify one arm's result for one case, using the same rule coverage_matrix.py uses:
 * a hit only counts as `Y` when the detection carries the expected kind. An overlapping detection
 * with a different kind is `?(kind)`, because a token named `[[IDENTIFIER_001]]` tells the reader
 * less than `[[LICENSE_PLATE_001]]` and can mean the value was covered incidentally.
 */
function classify(text, expectedValue, expectedKind, ranges) {
  const start = text.indexOf(expectedValue);
  if (start === -1) {
    throw new Error(`probe case is malformed, value not in text: ${expectedValue}`);
  }
  const end = start + expectedValue.length;
  const overlapping = ranges.filter((range) => range.start < end && range.end > start);
  if (overlapping.length === 0) {
    return ".";
  }
  const exact = overlapping.find((range) => range.start === start && range.end === end);
  const kinds = [...new Set(overlapping.map((range) => range.kind))].join("+");
  if (expectedKind !== null && overlapping.some((range) => range.kind === expectedKind)) {
    return exact !== undefined && exact.kind === expectedKind ? "Y" : `Y(跨度不精确:${kinds})`;
  }
  return `?(${kinds})`;
}

const results = [];
for (const [group, kind, value, expectedKind, text] of CASES) {
  const hints = await detector.prime(text);
  const row = { group, kind, value, expectedKind, text, hints };
  for (const profile of ["conservative", "balanced"]) {
    row[`rules-${profile}`] = classify(text, value, expectedKind, detector.detect(text, profile, false));
    row[`model-${profile}`] = classify(text, value, expectedKind, detector.detect(text, profile, true));
  }
  results.push(row);
}

const hardBare = [];
for (const [value, text] of HARD_BARE_MENTIONS) {
  const hints = await detector.prime(text);
  const row = { value, text, hints };
  for (const profile of ["conservative", "balanced"]) {
    row[`rules-${profile}`] = classify(text, value, "person_name", detector.detect(text, profile, false));
    row[`model-${profile}`] = classify(text, value, "person_name", detector.detect(text, profile, true));
  }
  hardBare.push(row);
}

const negatives = [];
for (const [group, text] of NEGATIVES) {
  const hints = await detector.prime(text);
  const row = { group, text, hints };
  for (const profile of ["conservative", "balanced"]) {
    row[`rules-${profile}`] = detector
      .detect(text, profile, false)
      .map((range) => `${range.kind}:${text.slice(range.start, range.end)}`);
    row[`model-${profile}`] = detector
      .detect(text, profile, true)
      .map((range) => `${range.kind}:${text.slice(range.start, range.end)}`);
  }
  negatives.push(row);
}

await rm(bundlePath, { force: true });

const pad = (text, width) => {
  // Count CJK as two columns so the plain-text table lines up in a terminal.
  let measured = 0;
  for (const character of text) {
    measured += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(character) ? 2 : 1;
  }
  return text + " ".repeat(Math.max(0, width - measured));
};

console.log(
  `${pad("类型", 24)} ${pad("cons", 22)} ${pad("cons+模型", 24)} ${pad("bal", 22)} ${pad("bal+模型", 24)} hints`,
);
for (const row of results) {
  console.log(
    `${pad(row.kind, 24)} ${pad(row["rules-conservative"], 22)} ${pad(row["model-conservative"], 24)} ` +
      `${pad(row["rules-balanced"], 22)} ${pad(row["model-balanced"], 24)} ${row.hints}`,
  );
}

console.log("\nPERSON 裸提及的难例：常见姓 + 2 字名，前无锚词后无角色词");
for (const row of hardBare) {
  console.log(
    `${pad(row.value, 24)} ${pad(row["rules-conservative"], 22)} ${pad(row["model-conservative"], 24)} ` +
      `${pad(row["rules-balanced"], 22)} ${pad(row["model-balanced"], 24)} ${row.hints}`,
  );
}

console.log("\n负例（下面任何一项从空变成非空都是新增误报）");
for (const row of negatives) {
  console.log(`  ${row.text}`);
  console.log(`    hints=${row.hints}`);
  console.log(`    cons        ${JSON.stringify(row["rules-conservative"])}`);
  console.log(`    cons+模型   ${JSON.stringify(row["model-conservative"])}`);
  console.log(`    bal         ${JSON.stringify(row["rules-balanced"])}`);
  console.log(`    bal+模型    ${JSON.stringify(row["model-balanced"])}`);
}
