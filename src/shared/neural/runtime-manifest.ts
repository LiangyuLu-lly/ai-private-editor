/*
 * Fail-closed parse of the shipped student-model manifest.
 *
 * Threshold, window length and stride are part of the evaluated artifact. A missing key must
 * throw rather than revive a silent default that would desync the browser from the numbers
 * that justified shipping the model.
 */

export type RuntimeManifest = {
  readonly labels: Readonly<Record<string, string>>;
  readonly threshold: number;
  readonly max_length: number;
  readonly stride: number;
};

const MANIFEST_FILE = "runtime_manifest.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(detail: string): never {
  throw new Error(`${MANIFEST_FILE} ${detail}`);
}

function parseLabels(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    fail("carries no labels");
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string") {
      fail(`label ${key} is not a string`);
    }
    labels[key] = label;
  }
  if (Object.keys(labels).length === 0) {
    fail("carries no labels");
  }
  return labels;
}

export function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value)) {
    fail("is not an object");
  }
  const labels = parseLabels(value.labels);
  const threshold = value.threshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    fail("threshold must be a finite number > 0 and <= 1");
  }
  const maxLength = value.max_length;
  if (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength <= 2) {
    fail("max_length must be an integer > 2");
  }
  const stride = value.stride;
  if (typeof stride !== "number" || !Number.isInteger(stride) || stride < 0 || stride >= maxLength - 2) {
    fail("stride must be an integer >= 0 and < max_length - 2");
  }
  return {
    labels,
    threshold,
    max_length: maxLength,
    stride,
  };
}
