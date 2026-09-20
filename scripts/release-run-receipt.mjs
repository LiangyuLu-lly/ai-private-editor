// Execution declarations are hash-bound provenance, not proof that a browser ran.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RUN_RECEIPT_VERSION = "evaluator-run-v2";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const LABEL_NAME = /^[A-Z][A-Z0-9_]*$/;
const REQUIRED_ARTIFACTS = ["browser_evaluator", "detector_source", "onnx_int8", "runtime_manifest"];
const REQUIRED_METADATA = ["candidate_id", "label_set", "model_threshold", "rule_profile"];
const RECEIPT_FIELDS = [
  "browser_evaluator_sha256",
  "execution_backend",
  "execution_scope",
  "gold_content_sha256",
  "predictions_content_sha256",
  "raw_entity_values_in_receipt",
  "raw_ids_in_receipt",
  "raw_paths_in_receipt",
  "raw_text_in_receipt",
  "run_receipt_sha256",
  "run_receipt_version",
  "system_identity_sha256",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function validateIdentity(artifactHashes, metadata) {
  if (!hasExactKeys(artifactHashes, REQUIRED_ARTIFACTS)) {
    throw new Error("artifact hashes must use the fixed release schema");
  }
  for (const key of REQUIRED_ARTIFACTS) {
    assertSha256(artifactHashes[key], `artifact ${key}`);
  }
  if (!hasExactKeys(metadata, REQUIRED_METADATA)) {
    throw new Error("metadata must use the fixed release schema");
  }
  if (!SAFE_IDENTIFIER.test(metadata.candidate_id) || !SAFE_IDENTIFIER.test(metadata.rule_profile)) {
    throw new Error("metadata identifiers are invalid");
  }
  const threshold = Number(metadata.model_threshold);
  const labels = typeof metadata.label_set === "string" ? metadata.label_set.split(",") : [];
  if (
    !Number.isFinite(threshold)
    || threshold < 0
    || threshold > 1
    || labels.length === 0
    || labels.some((label) => !LABEL_NAME.test(label))
    || new Set(labels).size !== labels.length
  ) {
    throw new Error("metadata does not match the release contract");
  }
}

function receiptHash(receipt) {
  const { run_receipt_sha256: _omitted, ...withoutHash } = receipt;
  return sha256(canonicalJson(withoutHash));
}

function validateReceipt(receipt) {
  if (!hasExactKeys(receipt, RECEIPT_FIELDS)) {
    throw new Error("evaluator run receipt has an invalid schema");
  }
  if (receipt.run_receipt_version !== RUN_RECEIPT_VERSION) {
    throw new Error("evaluator run receipt version is invalid");
  }
  if (!(
    (receipt.execution_backend === "node-wasm" && receipt.execution_scope === "detector-only")
    || (receipt.execution_backend === "chromium-extension" && receipt.execution_scope === "pre-send")
  )) {
    throw new Error("evaluator run receipt execution context is invalid");
  }
  for (const key of [
    "gold_content_sha256",
    "predictions_content_sha256",
    "system_identity_sha256",
    "browser_evaluator_sha256",
    "run_receipt_sha256",
  ]) {
    assertSha256(receipt[key], key);
  }
  for (const key of ["raw_text_in_receipt", "raw_entity_values_in_receipt", "raw_ids_in_receipt", "raw_paths_in_receipt"]) {
    if (receipt[key] !== false) {
      throw new Error("evaluator run receipt privacy flags are invalid");
    }
  }
  if (receipt.run_receipt_sha256 !== receiptHash(receipt)) {
    throw new Error("evaluator run receipt self hash is invalid");
  }
}

export function buildNodeDetectorRunReceipt({
  goldContentSha256,
  predictionsContentSha256,
  artifactHashes,
  metadata,
}) {
  assertSha256(goldContentSha256, "gold content");
  assertSha256(predictionsContentSha256, "prediction content");
  validateIdentity(artifactHashes, metadata);
  const systemIdentity = {
    artifacts_sha256: canonicalize(artifactHashes),
    metadata: canonicalize(metadata),
  };
  const receipt = {
    run_receipt_version: RUN_RECEIPT_VERSION,
    execution_backend: "node-wasm",
    execution_scope: "detector-only",
    gold_content_sha256: goldContentSha256,
    predictions_content_sha256: predictionsContentSha256,
    system_identity_sha256: sha256(canonicalJson(systemIdentity)),
    browser_evaluator_sha256: artifactHashes.browser_evaluator,
    raw_text_in_receipt: false,
    raw_entity_values_in_receipt: false,
    raw_ids_in_receipt: false,
    raw_paths_in_receipt: false,
  };
  receipt.run_receipt_sha256 = receiptHash(receipt);
  validateReceipt(receipt);
  return receipt;
}

export async function writeRunReceipt(path, receipt) {
  validateReceipt(receipt);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
