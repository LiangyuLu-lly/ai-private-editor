import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBuildDirectory } from "./build-target.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src");
const dist = resolveBuildDirectory(root);
const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
const buildRevision = manifest.version_name;

if (typeof buildRevision !== "string" || buildRevision.length === 0) {
  throw new Error("src/manifest.json must define a non-empty version_name");
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function copyAsset(sourcePath, destinationPath) {
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

await Promise.all([
  build({
    entryPoints: [resolve(source, "content.ts")],
    outfile: resolve(dist, "content.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    define: { __CONTENT_BUILD_REVISION__: JSON.stringify(buildRevision) },
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(source, "popup.ts")],
    outfile: resolve(dist, "popup.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(source, "background.ts")],
    outfile: resolve(dist, "background.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(source, "sidepanel.ts")],
    outfile: resolve(dist, "sidepanel.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(source, "scanner.ts")],
    outfile: resolve(dist, "scanner.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  // The self-check page. It is the only way the release gate in ml/docs/r3-model-card.md can be
  // closed on machines where a real browser cannot be automated, so it ships rather than living in
  // tests/.
  build({
    entryPoints: [resolve(source, "diagnostics.ts")],
    outfile: resolve(dist, "diagnostics.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  // First-run page. Required by the default change rather than decorative: the shipped defaults now
  // enable the local model, and a default that changes what the extension does without telling the
  // user is not acceptable.
  build({
    entryPoints: [resolve(source, "welcome.ts")],
    outfile: resolve(dist, "welcome.js"),
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    legalComments: "none",
  }),
  // ESM, not IIFE: the offscreen host loads the ONNX Runtime bundle through a dynamic import
  // that must survive to runtime, so the WASM loader resolves against the vendored copy under
  // dist/vendor/onnxruntime/ instead of being inlined.
  build({
    entryPoints: [resolve(source, "offscreen.ts")],
    outfile: resolve(dist, "offscreen.js"),
    bundle: true,
    format: "esm",
    target: ["chrome116"],
    legalComments: "none",
  }),
]);

await Promise.all(
  ["manifest.json", "content.css", "popup.html", "popup.css", "scanner.html", "scanner.css", "sidepanel.html", "sidepanel.css", "offscreen.html", "diagnostics.html", "diagnostics.css", "welcome.html", "welcome.css"].map((asset) =>
    copyFile(resolve(source, asset), resolve(dist, asset)),
  ),
);

await Promise.all([
  copyAsset(
    resolve(root, "node_modules", "tesseract.js", "dist", "worker.min.js"),
    resolve(dist, "vendor", "tesseract", "worker.min.js"),
  ),
  copyAsset(
    resolve(root, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm.js"),
    resolve(dist, "vendor", "tesseract", "tesseract-core-lstm.wasm.js"),
  ),
  copyAsset(
    resolve(root, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm"),
    resolve(dist, "vendor", "tesseract", "tesseract-core-lstm.wasm"),
  ),
  copyAsset(
    resolve(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
    resolve(dist, "vendor", "pdfjs", "pdf.worker.mjs"),
  ),
  copyAsset(
    resolve(source, "assets", "tessdata", "chi_sim.traineddata"),
    resolve(dist, "assets", "tessdata", "chi_sim.traineddata"),
  ),
  copyAsset(
    resolve(source, "assets", "tessdata", "eng.traineddata"),
    resolve(dist, "assets", "tessdata", "eng.traineddata"),
  ),
  ...["personal", "work", "legal", "medical", "finance", "rd"].map((id) =>
    copyAsset(
      resolve(source, "assets", "presets", `${id}.json`),
      resolve(dist, "assets", "presets", `${id}.json`),
    ),
  ),
  ...[16, 32, 48, 128].map((size) =>
    copyAsset(
      resolve(source, "assets", "icons", `icon-${size}.png`),
      resolve(dist, "assets", "icons", `icon-${size}.png`),
    ),
  ),
  // ONNX Runtime, WASM backend only. The WebGL and WebGPU builds and the asyncify/JSEP/JSPI
  // binaries are deliberately not shipped.
  //
  // Three files, not two. The comment here used to claim the `bundle` entry inlines the emscripten
  // glue so only the .wasm was needed. That is true of the bundle in isolation and false for how it
  // is configured: `ort-runner.ts` sets `env.wasm.wasmPaths` to a directory URL, and a string prefix
  // makes ONNX Runtime resolve *both* `ort-wasm-simd-threaded.mjs` and `.wasm` from that prefix,
  // overriding the inlined copy. Without the .mjs the browser fails with
  //
  //   no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported
  //   module: chrome-extension://<id>/vendor/onnxruntime/ort-wasm-simd-threaded.mjs
  //
  // and that failure is silent to the user: the offscreen host records `ready: false`, the hint
  // cache stays empty, and the extension runs on rules alone. So the model would never have worked
  // for anyone who installed it. Found by tests/browser/neural-offscreen.test.mjs on the first run
  // that got a real Chrome to load the extension.
  copyAsset(
    resolve(root, "node_modules", "onnxruntime-web", "dist", "ort.wasm.bundle.min.mjs"),
    resolve(dist, "vendor", "onnxruntime", "ort.wasm.bundle.min.mjs"),
  ),
  copyAsset(
    resolve(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.mjs"),
    resolve(dist, "vendor", "onnxruntime", "ort-wasm-simd-threaded.mjs"),
  ),
  copyAsset(
    resolve(root, "node_modules", "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"),
    resolve(dist, "vendor", "onnxruntime", "ort-wasm-simd-threaded.wasm"),
  ),
]);

// The student model is optional. Without it the offscreen host reports `ready: false` and the
// extension runs on rules alone, which is exactly the behaviour that shipped before the model
// existed — so a missing artifact is a warning, not a build failure.
const modelSource = resolve(source, "assets", "model");
const modelFiles = ["model.int8.onnx", "runtime_manifest.json", "vocab.json"];
const presentModelFiles = [];
for (const file of modelFiles) {
  try {
    await copyAsset(resolve(modelSource, file), resolve(dist, "assets", "model", file));
    presentModelFiles.push(file);
  } catch {
    // Missing file: recorded below.
  }
}
if (presentModelFiles.length !== modelFiles.length) {
  const missing = modelFiles.filter((file) => !presentModelFiles.includes(file));
  console.warn(
    `[build] local semantic model not bundled; missing ${missing.join(", ")} under src/assets/model. ` +
      "The extension will run on rules only.",
  );
}

/*
 * Chrome reserves names beginning with `_` inside an extension directory and refuses to load the
 * whole extension if it finds one:
 *
 *   Cannot load extension with file or directory name __neural-eval.mjs.
 *
 * The offline harnesses used to write their esbuild bundles straight into `dist/`, which made the
 * built extension uninstallable while any of them ran and left it that way if one crashed. They now
 * use `.harness-tmp/` (scripts/harness-paths.mjs), and this check makes a regression fail the build
 * instead of surfacing later as an unexplained install error or a rejected Web Store upload.
 */
async function assertNoReservedNames(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("_")) {
      throw new Error(
        `dist/${relative}${entry.name} uses a name Chrome reserves. ` +
          "Names starting with '_' make the extension unloadable; write scratch files to .harness-tmp/ instead.",
      );
    }
    if (entry.isDirectory()) {
      await assertNoReservedNames(resolve(directory, entry.name), `${relative}${entry.name}/`);
    }
  }
}

await assertNoReservedNames(dist);
