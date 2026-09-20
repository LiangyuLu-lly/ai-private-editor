import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { KIND_TO_EVAL_LABEL } from "../scripts/eval-kind-map.mjs";
import { isKnownDetectionKind } from "../src/scanner/types.js";
import {
  NEURAL_REVIEW_STATUS,
  isNeuralReviewStatus,
} from "../src/shared/neural/messages.js";
import { isNeuralRuntimeStatus } from "../src/shared/neural/runtime-status.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";
import type { DetectionKind } from "../src/shared/types.js";

const ROOT = process.cwd();
const FINDING_LABEL_FILES = [
  "src/sensitive-confirmation.ts",
  "src/pre-send.ts",
  "src/paste-guard.ts",
  "src/sidepanel.ts",
] as const;
const HISTORICAL_EVAL_LABELS = [
  "CN_PHONE",
  "EMAIL",
  "CN_ID",
  "BANK_CARD",
  "PERSON",
  "ADDRESS",
  "ACCOUNT_ALIAS",
  "PASSPORT",
  "LICENSE_PLATE",
] as const;
const SILENT_MANIFEST_DEFAULTS = ["?? 0.35", "?? 256", "?? 64"] as const;
const CHINESE = /[\u4e00-\u9fff]/;
const TOKEN_SHAPE = /^\[\[[A-Z][A-Z0-9_]*_001\]\]$/;

function readSource(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function stripComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      output += current;
      index += 1;
      while (index < source.length) {
        const inside = source[index];
        output += inside;
        if (inside === "\\" && quote !== "`") {
          output += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (inside === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += current;
    index += 1;
  }
  return output;
}

function parseQuotedUnion(source: string, typeName: string): string[] {
  const match = source.match(new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`));
  expect(match, `contract kind/label completeness: ${typeName} union must be parseable`).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1] ?? "");
}

function parseStringRecord(source: string, constName: string): Record<string, string> {
  const match = source.match(new RegExp(`(?:const|export const) ${constName}\\s*:\\s*[^=]+=\\s*\\{([^}]*)\\}`));
  expect(match, `contract kind/label completeness: ${constName} must be parseable`).not.toBeNull();
  const record: Record<string, string> = {};
  for (const entry of match?.[1].matchAll(/(\w+)\s*:\s*"([^"]*)"/g) ?? []) {
    const key = entry[1];
    const value = entry[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    record[key] = value;
  }
  return record;
}

function detectionKinds(): DetectionKind[] {
  const declared = parseQuotedUnion(readSource("src/shared/types.ts"), "DetectionKind");
  const known = declared.filter(isKnownDetectionKind);
  expect(
    known.length,
    "contract kind/label completeness: every DetectionKind member must be a known kind",
  ).toBe(declared.length);
  return known;
}

describe("contract invariants", () => {
  it("accepts exact NeuralReviewStatus keys and rejects a superset", () => {
    const valid = {
      type: NEURAL_REVIEW_STATUS,
      ready: true,
      loadMilliseconds: 12,
      error: null,
    };
    const extra = { ...valid, extra: "no" };

    expect(
      isNeuralReviewStatus(valid),
      "contract status key sets: NeuralReviewStatus must accept exactly {type, ready, loadMilliseconds, error}",
    ).toBe(true);
    expect(
      isNeuralReviewStatus(extra),
      "contract status key sets: NeuralReviewStatus must reject a superset",
    ).toBe(false);
  });

  it("accepts exact NeuralRuntimeStatus keys and rejects a superset", () => {
    const valid = {
      ready: false,
      loadMilliseconds: null,
      error: "load failed",
      updatedAt: 1,
    };
    const extra = { ...valid, extra: "no" };

    expect(
      isNeuralRuntimeStatus(valid),
      "contract status key sets: NeuralRuntimeStatus must accept exactly {ready, loadMilliseconds, error, updatedAt}",
    ).toBe(true);
    expect(
      isNeuralRuntimeStatus(extra),
      "contract status key sets: NeuralRuntimeStatus must reject a superset",
    ).toBe(false);
  });

  it("forbids silent runtime-manifest numeric fallbacks in parser and offscreen host", () => {
    const files = ["src/shared/neural/runtime-manifest.ts", "src/offscreen.ts"] as const;

    for (const file of files) {
      const code = stripComments(readSource(file));
      for (const fallback of SILENT_MANIFEST_DEFAULTS) {
        expect(
          code.includes(fallback),
          `contract no silent runtime-manifest defaults: ${file} must not contain ${fallback}`,
        ).toBe(false);
      }
    }
  });

  it("gives every DetectionKind a Chinese FINDING_LABELS entry and a token prefix", () => {
    const kinds = detectionKinds();
    const prefixes = parseStringRecord(readSource("src/shared/session-token-map.ts"), "TOKEN_PREFIX");
    const tokens = createSessionTokenMap();

    expect(
      Object.keys(prefixes).sort(),
      "contract kind/label completeness: TOKEN_PREFIX must cover every DetectionKind",
    ).toEqual([...kinds].sort());

    for (const file of FINDING_LABEL_FILES) {
      const labels = parseStringRecord(readSource(file), "FINDING_LABELS");
      expect(
        Object.keys(labels).sort(),
        `contract kind/label completeness: FINDING_LABELS in ${file} must cover every DetectionKind`,
      ).toEqual([...kinds].sort());
      for (const kind of kinds) {
        expect(
          CHINESE.test(labels[kind] ?? ""),
          `contract kind/label completeness: FINDING_LABELS in ${file} must have a Chinese label for ${kind}`,
        ).toBe(true);
      }
    }

    for (const kind of kinds) {
      const token = tokens.getOrCreate(kind, "value");
      expect(
        TOKEN_SHAPE.test(token),
        `contract kind/label completeness: session-token-map.ts must assign a token prefix for ${kind}`,
      ).toBe(true);
    }
  });

  it("keeps the scored eval label map at the historical nine entries", () => {
    const labels = Object.values(KIND_TO_EVAL_LABEL) as string[];

    expect(
      labels.length,
      "contract eval scored label map: KIND_TO_EVAL_LABEL must expose exactly 9 entries",
    ).toBe(9);
    expect(
      [...labels].sort(),
      "contract eval scored label map: values must stay CN_PHONE, EMAIL, CN_ID, BANK_CARD, PERSON, ADDRESS, ACCOUNT_ALIAS, PASSPORT, LICENSE_PLATE",
    ).toEqual([...HISTORICAL_EVAL_LABELS].sort());
  });

  it("keeps popup.ts free of sendMessage after comments are stripped", () => {
    const code = stripComments(readSource("src/popup.ts"));

    expect(
      code.includes("sendMessage"),
      "contract popup stays message-free: src/popup.ts must not contain sendMessage",
    ).toBe(false);
  });
});
