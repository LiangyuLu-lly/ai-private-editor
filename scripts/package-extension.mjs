// Build a Chrome Web Store upload and refuse to produce one that would be rejected.
//
// The checks are not decoration. Every one of them corresponds to something that actually went wrong
// or would have:
//
//   - reserved names: nine offline harnesses used to write `__*.mjs` into dist/. Chrome refuses to
//     load an extension directory containing any entry starting with `_`, so whether the extension
//     was installable depended on which harness had run last. This is the defect that blocked the
//     first real-browser run of the release gate.
//   - manifest/self-check agreement: the self-check compares model output against spans generated
//     from one specific checkpoint. If the packaged manifest names a different one, a green
//     self-check proves nothing.
//   - permission justification: every entry in `permissions` has to be explainable at review time.
//     Unexplained permissions are the most common rejection reason for a privacy extension.
//   - size and file count: the Web Store caps uploads, and this package carries a 12 MB model plus
//     WASM and OCR data, so the margin is worth printing rather than discovering at upload.
//
// Usage: node scripts/package-extension.mjs
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const outputDirectory = resolve(root, "release");

// A build can succeed with a stale registry or self-check marker. Refuse to touch release/ until
// the source model metadata, artifact digest and package identity agree.
execFileSync(process.execPath, [resolve(root, "scripts", "verify-release-consistency.mjs")], {
  cwd: root,
  stdio: "inherit",
});

// Why each permission is requested, in the words a reviewer needs. Keys must match manifest
// `permissions` exactly; a mismatch in either direction fails the check, so adding a permission
// without justifying it cannot ship.
const PERMISSION_JUSTIFICATIONS = {
  storage: "保存用户自定义敏感词、白名单与检测档位。仅本地 chrome.storage.local，不同步、不上传。",
  sidePanel: "在侧边栏提供私密编辑器，让用户在发送前查看并确认将要替换的内容。",
  offscreen:
    "在离屏文档中运行本地语义模型（ONNX Runtime WASM）。必须是扩展页面才能使用 manifest 声明的 wasm-unsafe-eval；" +
    "service worker 空闲会被销毁，模型会反复重载；内容脚本受页面 CSP 限制。草稿文本不离开浏览器。",
};

const failures = [];
const warnings = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

async function walk(directory, relative = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = `${relative}${entry.name}`;
    if (entry.isDirectory()) {
      entries.push(...(await walk(path, `${relativePath}/`)));
    } else {
      entries.push({ path, relativePath, size: (await stat(path)).size });
    }
  }
  return entries;
}

const distExists = await stat(dist).then(
  (info) => info.isDirectory(),
  () => false,
);
if (!distExists) {
  console.error("dist/ does not exist. Run `npm run build` first.");
  process.exit(2);
}

const files = await walk(dist);
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));

// 1. Names Chrome reserves.
const reserved = files.filter((file) => file.relativePath.split("/").some((part) => part.startsWith("_")));
check(
  reserved.length === 0,
  `dist contains ${reserved.length} entr${reserved.length === 1 ? "y" : "ies"} whose name starts with "_", ` +
    `which makes the extension unloadable: ${reserved.map((file) => file.relativePath).join(", ")}. ` +
    "Scratch bundles belong in .harness-tmp/ (scripts/harness-paths.mjs).",
);

// 2. Manifest completeness for a store listing.
check(typeof manifest.name === "string" && manifest.name.length > 0, "manifest.name is missing");
check(
  typeof manifest.description === "string" && manifest.description.length > 0 && manifest.description.length <= 132,
  `manifest.description must be 1-132 characters; it is ${manifest.description?.length ?? 0}`,
);
check(/^\d+(\.\d+){0,3}$/.test(String(manifest.version)), `manifest.version is not a store-valid version: ${manifest.version}`);
check(typeof manifest.version_name === "string" && manifest.version_name.length > 0, "manifest.version_name is missing");
for (const size of ["16", "32", "48", "128"]) {
  check(typeof manifest.icons?.[size] === "string", `manifest.icons is missing the ${size}px entry`);
}
check(manifest.manifest_version === 3, "manifest_version must be 3");
check(
  typeof manifest.content_security_policy?.extension_pages === "string" &&
    manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"),
  "extension_pages CSP must allow 'wasm-unsafe-eval'; without it the local model cannot load",
);

// 3. Every permission justified, and nothing justified that is not requested.
const requested = [...(manifest.permissions ?? [])].sort();
const justified = Object.keys(PERMISSION_JUSTIFICATIONS).sort();
check(
  JSON.stringify(requested) === JSON.stringify(justified),
  `permissions and justifications disagree. manifest: [${requested.join(", ")}]; ` +
    `justified: [${justified.join(", ")}]. Update PERMISSION_JUSTIFICATIONS in this script.`,
);
check(
  !(manifest.permissions ?? []).includes("tabs"),
  "the `tabs` permission is not needed and triggers extra review",
);
check(
  (manifest.host_permissions ?? []).every((pattern) => !pattern.startsWith("<all_urls>") && !pattern.includes("://*/")),
  "host_permissions must stay on an explicit site list; a broad match invites rejection for a privacy tool",
);

// 4. The self-check has to match the model that is actually packaged.
const modelManifestPath = resolve(dist, "assets", "model", "runtime_manifest.json");
const modelManifest = await readFile(modelManifestPath, "utf8").then(JSON.parse, () => null);
if (modelManifest === null) {
  warnings.push(
    "no model bundled under assets/model — the extension will run on rules only. " +
      "That is a supported configuration, but the local-model feature will be inert.",
  );
} else {
  const diagnostics = await readFile(resolve(root, "src", "diagnostics.ts"), "utf8");
  check(
    diagnostics.includes(`artifact: ${modelManifest.artifact}`),
    `src/diagnostics.ts holds expectations for a different artifact than dist ships ` +
      `(${modelManifest.artifact}). Regenerate: node scripts/emit-selfcheck-expectations.mjs`,
  );
  for (const required of ["model.int8.onnx", "vocab.json", "runtime_manifest.json"]) {
    check(
      files.some((file) => file.relativePath === `assets/model/${required}`),
      `assets/model/${required} is missing from the package`,
    );
  }
  check(
    files.some((file) => file.relativePath === "vendor/onnxruntime/ort-wasm-simd-threaded.wasm"),
    "the ONNX Runtime WASM binary is missing; the model would fail to load in the browser",
  );
}

// 5. Documents a reviewer and a user both need.
// STORE-LISTING.md is checked too: the permission justifications below have to match what gets typed
// into the store form, and a listing that drifts from the manifest is a rejection.
for (const document of ["PRIVACY.md", "THIRD_PARTY_NOTICES.md", "STORE-LISTING.md"]) {
  check(
    await stat(resolve(root, document)).then(
      () => true,
      () => false,
    ),
    `${document} is missing from the repository root`,
  );
}

// 6. Store assets. Absent is a warning, not a failure: a build for local testing does not need them,
// and generating them costs a real browser launch. Stale is worse than missing, so the check compares
// against the manifest version rather than only asserting existence.
const storeAssets = resolve(root, "release", "store-assets");
const requiredAssets = [
  "01-welcome.png",
  "02-send-confirmation.png",
  "03-settings.png",
  "04-self-check.png",
  "promo-small-440x280.png",
  "promo-large-1400x560.png",
];
const missingAssets = [];
for (const asset of requiredAssets) {
  const present = await stat(resolve(storeAssets, asset)).then(
    () => true,
    () => false,
  );
  if (!present) {
    missingAssets.push(asset);
  }
}
if (missingAssets.length === requiredAssets.length) {
  warnings.push(
    "release/store-assets/ 里没有商店素材。提交前跑 `node scripts/capture-store-assets.mjs`（会启动一次真实 Chrome）。",
  );
} else if (missingAssets.length > 0) {
  check(false, `商店素材缺失：${missingAssets.join(", ")}。重新生成：node scripts/capture-store-assets.mjs`);
}

// 7. Size. The Web Store limit is 2 GB for the package but 10 MB per file is the practical review
// threshold people hit; the numbers are printed either way so the margin is never a surprise.
const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
const largest = [...files].sort((left, right) => right.size - left.size).slice(0, 5);

if (failures.length > 0) {
  console.error("发布前检查未通过：\n");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error("\n未生成压缩包。");
  process.exit(1);
}

await mkdir(outputDirectory, { recursive: true });
const zipPath = resolve(outputDirectory, `${manifest.name.replace(/\s+/gu, "-")}-${manifest.version}.zip`);
await rm(zipPath, { force: true });

const zip = new JSZip();
for (const file of files) {
  zip.file(file.relativePath, await readFile(file.path));
}
await new Promise((done, fail) => {
  zip
    // DEFLATE at maximum: the model and WASM dominate and both compress, so this is the difference
    // between a package that looks reasonable to a reviewer and one that does not.
    .generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 9 } })
    .pipe(createWriteStream(zipPath))
    .on("finish", done)
    .on("error", fail);
});
const zipped = (await stat(zipPath)).size;

console.log("发布前检查全部通过。\n");
for (const warning of warnings) {
  console.log(`  ! ${warning}`);
}
console.log(
  JSON.stringify(
    {
      package: zipPath,
      name: manifest.name,
      version: manifest.version,
      versionName: manifest.version_name,
      files: files.length,
      unpackedMB: Number((totalBytes / 1048576).toFixed(2)),
      zippedMB: Number((zipped / 1048576).toFixed(2)),
      permissions: manifest.permissions,
      hostPermissions: (manifest.host_permissions ?? []).length,
      modelArtifact: modelManifest?.artifact ?? null,
      largestFiles: largest.map((file) => `${file.relativePath} ${(file.size / 1048576).toFixed(2)} MB`),
    },
    null,
    2,
  ),
);
console.log("\n权限说明（提交商店时逐条填写）：");
for (const [permission, justification] of Object.entries(PERMISSION_JUSTIFICATIONS)) {
  console.log(`  ${permission}: ${justification}`);
}
