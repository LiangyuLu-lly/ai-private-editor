import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  buildNodeDetectorRunReceipt,
  writeRunReceipt,
} from "../../scripts/release-run-receipt.mjs";

const HASH = "a".repeat(64);
const ARTIFACTS = {
  onnx_int8: HASH,
  runtime_manifest: "b".repeat(64),
  detector_source: "c".repeat(64),
  browser_evaluator: "d".repeat(64),
};
const METADATA = {
  candidate_id: "r14-fixture",
  rule_profile: "balanced",
  model_threshold: "0.5",
  label_set: "PERSON,ADDRESS,ACCOUNT_ALIAS,CN_PHONE,EMAIL,CN_ID,BANK_CARD,LICENSE_PLATE,PASSPORT",
};

function rehash(receipt) {
  const { run_receipt_sha256: _omitted, ...payload } = receipt;
  const canonical = Object.fromEntries(Object.keys(payload).sort().map((key) => [key, payload[key]]));
  return { ...payload, run_receipt_sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

test("builds a path-free Node detector receipt bound to inputs and system identity", () => {
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: METADATA,
  });
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.run_receipt_version, "evaluator-run-v2");
  assert.equal(receipt.execution_backend, "node-wasm");
  assert.equal(receipt.execution_scope, "detector-only");
  assert.equal(receipt.browser_evaluator_sha256, ARTIFACTS.browser_evaluator);
  assert.match(receipt.system_identity_sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.run_receipt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.raw_text_in_receipt, false);
  assert.equal(receipt.raw_paths_in_receipt, false);
  assert.ok(!serialized.includes("/tmp/"));
  assert.ok(!serialized.includes("example prompt"));
});

test("accepts a manifest-derived label set instead of a hardcoded candidate taxonomy", () => {
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: { ...METADATA, label_set: "PERSON,EMAIL" },
  });

  assert.equal(receipt.execution_backend, "node-wasm");
});

test("callers cannot relabel the Node producer as an extension pre-send run", () => {
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: METADATA,
    executionBackend: "chromium-extension",
    executionScope: "pre-send",
    execution_backend: "chromium-extension",
    execution_scope: "pre-send",
  });

  assert.equal(receipt.execution_backend, "node-wasm");
  assert.equal(receipt.execution_scope, "detector-only");
});

test("execution provenance is hashed and only finite backend/scope pairs can be written", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "r14-context-receipt-"));
  const nodeReceipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: METADATA,
  });
  const browserFixture = {
    ...nodeReceipt,
    execution_backend: "chromium-extension",
    execution_scope: "pre-send",
  };

  await assert.rejects(() => writeRunReceipt(resolve(directory, "tampered.json"), browserFixture), /self hash/i);
  const hashedFixture = rehash(browserFixture);
  assert.notEqual(hashedFixture.run_receipt_sha256, nodeReceipt.run_receipt_sha256);
  await writeRunReceipt(resolve(directory, "synthetic-browser-context.json"), hashedFixture);

  for (const [backend, scope] of [
    ["node-wasm", "pre-send"],
    ["chromium-extension", "detector-only"],
    ["unknown", "pre-send"],
    ["chromium-extension", "unknown"],
    [null, "pre-send"],
    ["chromium-extension", null],
  ]) {
    const invalid = rehash({ ...nodeReceipt, execution_backend: backend, execution_scope: scope });
    await assert.rejects(() => writeRunReceipt(resolve(directory, "invalid.json"), invalid), /execution context/i);
  }
});

test("rejects free-form identity metadata and does not overwrite a receipt", async () => {
  assert.throws(
    () => buildNodeDetectorRunReceipt({
      goldContentSha256: "e".repeat(64),
      predictionsContentSha256: "f".repeat(64),
      artifactHashes: ARTIFACTS,
      metadata: { ...METADATA, unexpected: "free text" },
    }),
    /metadata/i,
  );

  const directory = await mkdtemp(resolve(tmpdir(), "r14-browser-receipt-"));
  const target = resolve(directory, "run.json");
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: METADATA,
  });

  await writeRunReceipt(target, receipt);
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), receipt);
  await assert.rejects(() => writeRunReceipt(target, receipt), /already exists/i);
});

test("a new receipt cannot overwrite or upgrade an existing legacy receipt", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "r14-legacy-receipt-"));
  const target = resolve(directory, "run.json");
  const receipt = buildNodeDetectorRunReceipt({
    goldContentSha256: "e".repeat(64),
    predictionsContentSha256: "f".repeat(64),
    artifactHashes: ARTIFACTS,
    metadata: METADATA,
  });
  const legacy = '{"browser_run_receipt_version":"browser-evaluator-run-v1"}\n';
  await writeFile(target, legacy, { encoding: "utf8", flag: "wx" });

  await assert.rejects(() => writeRunReceipt(target, receipt), /already exists/i);
  assert.equal(await readFile(target, "utf8"), legacy);
});
