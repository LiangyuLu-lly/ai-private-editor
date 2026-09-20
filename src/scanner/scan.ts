import { materializeDraftRedaction } from "../shared/detector.js";
import { createSessionTokenMap } from "../shared/session-token-map.js";
import type { FileScanOptions, FileScanResult, FileFormat } from "./types.js";
import { hasSensitiveFindings, summarizeFindings } from "./types.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

function textBytes(input: string): number {
  return new TextEncoder().encode(input).byteLength;
}

export function scanPlainText(
  input: string,
  options: FileScanOptions = {},
  format: FileFormat = "text",
): FileScanResult {
  if (textBytes(input) > MAX_EXTRACTED_TEXT_BYTES) {
    return {
      status: "unscannable",
      format,
      coverage: "none",
      findings: [],
      summary: { reason: "text_limit" },
    };
  }

  const result = materializeDraftRedaction(
    input,
    options.customTerms ?? [],
    createSessionTokenMap(),
    options.allowlistedTerms ?? [],
    options.categoryPolicies ?? [],
    {
      detectionProfile: options.detectionProfile ?? "conservative",
      replacementStyle: options.replacementStyle ?? "token",
      semanticReviewProvider: options.semanticReviewProvider,
    },
  );
  const findings = summarizeFindings(result.findings);
  const sensitive = hasSensitiveFindings(findings);
  const requiresReview = result.findings.some((finding) => finding.policy === "confirm");

  if (requiresReview) {
    return {
      status: "partial",
      format,
      coverage: "partial",
      findings,
      summary: { reason: "review_required" },
      requiresReview: true,
      ...(sensitive ? { redactedText: result.outboundText } : {}),
    };
  }

  return {
    status: sensitive ? "sensitive" : "clean",
    format,
    coverage: "complete",
    findings,
    summary: {},
    ...(sensitive ? { redactedText: result.outboundText } : {}),
  };
}

export function createRedactedTextBlob(text: string): Blob {
  return new Blob([text], { type: "text/plain;charset=utf-8" });
}
