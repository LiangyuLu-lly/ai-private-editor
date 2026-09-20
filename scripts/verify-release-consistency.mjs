// Verify that the browser artifact, runtime manifest, model registry and package metadata name
// the same release. This is intentionally read-only: a release check must never repair drift by
// rewriting a manifest or silently accepting a missing artifact.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];

async function readJson(relativePath) {
  const absolutePath = resolve(root, relativePath);
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: cannot read valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function equal(label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label}: expected a non-empty string`);
    return null;
  }
  return value;
}

const packageJson = await readJson("package.json");
const extensionManifest = await readJson("src/manifest.json");
const runtimeManifest = await readJson("src/assets/model/runtime_manifest.json");
const parityFixtures = await readJson("tests/fixtures/neural-parity-fixtures.json");
const registry = await readJson("ml/model-registry.json");
const diagnostics = await readFile(resolve(root, "src/diagnostics.ts"), "utf8").catch((error) => {
  errors.push(`src/diagnostics.ts: cannot read (${error instanceof Error ? error.message : String(error)})`);
  return "";
});

const shipped = registry?.benchmark_candidates?.find((candidate) => candidate?.id === "hfl-chinese-electra-small")?.shipped_artifact;
const browserArtifact = requiredString(shipped?.browser_artifact, "registry shipped_artifact.browser_artifact");
const runtimeArtifact = requiredString(runtimeManifest?.artifact, "runtime_manifest.artifact");
const runtimeTrainingData = requiredString(runtimeManifest?.training_data, "runtime_manifest.training_data");
const runtimeModelCard = requiredString(shipped?.model_card, "registry shipped_artifact.model_card");
const runtimeLabels = Object.values(runtimeManifest?.labels ?? {});
const runtimeSemanticScope = [...new Set(
  runtimeLabels
    .filter((label) => typeof label === "string" && label !== "O")
    .map((label) => String(label).replace(/^[BIE]-/u, "")),
)].sort();

equal("package.json.version and src/manifest.json.version", packageJson?.version, extensionManifest?.version);
equal("registry shipped checkpoint", shipped?.checkpoint, runtimeArtifact);
if (runtimeArtifact !== null) {
  equal("registry shipped checkpoint_path", shipped?.checkpoint_path, `artifacts/${runtimeArtifact}`);
  try {
    await stat(resolve(root, "ml", `artifacts/${runtimeArtifact}`));
  } catch {
    errors.push(`offline checkpoint path does not exist: ml/artifacts/${runtimeArtifact}`);
  }
}
equal("registry shipped training_data", shipped?.training_data, runtimeTrainingData);
equal("registry shipped threshold", shipped?.threshold, runtimeManifest?.threshold);
equal("registry shipped runtime_manifest", shipped?.runtime_manifest, "src/assets/model/runtime_manifest.json");
equal("registry semantic_scope", JSON.stringify([...(shipped?.semantic_scope ?? [])].sort()), JSON.stringify(runtimeSemanticScope));

if (parityFixtures !== null && runtimeManifest !== null) {
  equal("parity fixture artifact", parityFixtures.artifact, runtimeArtifact);
  equal("parity fixture threshold", parityFixtures.threshold, runtimeManifest.threshold);
  equal("parity fixture max_length", parityFixtures.max_length, runtimeManifest.max_length);
  equal("parity fixture stride", parityFixtures.stride, runtimeManifest.stride);
  equal("parity fixture labels", JSON.stringify(parityFixtures.labels), JSON.stringify(runtimeLabels));
  equal("parity fixture runtime_manifest", parityFixtures.runtime_manifest, "src/assets/model/runtime_manifest.json");
}

if (runtimeModelCard !== null) {
  try {
    await stat(resolve(root, "ml", runtimeModelCard));
  } catch {
    errors.push(`registry shipped model_card does not exist: ml/${runtimeModelCard}`);
  }
}

if (browserArtifact !== null) {
  const artifactPath = resolve(root, browserArtifact);
  try {
    const artifact = await readFile(artifactPath);
    const digest = createHash("sha256").update(artifact).digest("hex").toUpperCase();
    const size = artifact.byteLength;
    equal("registry browser_artifact_size_bytes", shipped?.browser_artifact_size_bytes, size);
    equal("registry browser_artifact_sha256", shipped?.browser_artifact_sha256, digest);
  } catch (error) {
    errors.push(`${browserArtifact}: cannot read (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (runtimeArtifact !== null && !diagnostics.includes(`artifact: ${runtimeArtifact}`)) {
  errors.push(`src/diagnostics.ts does not record runtime artifact ${runtimeArtifact}`);
}
if (runtimeManifest?.threshold !== undefined && !diagnostics.includes(`threshold ${runtimeManifest.threshold}`)) {
  errors.push(`src/diagnostics.ts does not record runtime threshold ${runtimeManifest.threshold}`);
}

const result = {
  status: errors.length === 0 ? "ok" : "failed",
  extension_version: extensionManifest?.version ?? null,
  version_name: extensionManifest?.version_name ?? null,
  checkpoint: runtimeArtifact,
  training_data: runtimeTrainingData,
  semantic_scope: runtimeManifest?.labels ?? null,
  threshold: runtimeManifest?.threshold ?? null,
  browser_artifact: browserArtifact,
  parity_fixture: parityFixtures === null ? null : {
    artifact: parityFixtures.artifact ?? null,
    threshold: parityFixtures.threshold ?? null,
    max_length: parityFixtures.max_length ?? null,
    stride: parityFixtures.stride ?? null,
  },
  errors,
};

if (errors.length > 0) {
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
}
