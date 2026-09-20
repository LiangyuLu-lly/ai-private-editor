import type {
  CategoryPolicyEntry,
  DetectionKind,
  DetectionProfile,
  ReplacementStyle,
  RedactionFinding,
} from "../shared/types.js";
import type { SemanticReviewProvider } from "../shared/semantic-review.js";

export type FileFormat = "text" | "docx" | "xlsx" | "pdf" | "image" | "unknown";
export type FileScanStatus = "clean" | "sensitive" | "partial" | "unscannable";
export type FileScanCoverage = "complete" | "partial" | "none";
export type FileScanReason =
  | "text_limit"
  | "file_limit"
  | "image_limit"
  | "unsupported_format"
  | "parse_failed"
  | "pdf_text_layer_only"
  | "pdf_without_text"
  | "page_limit"
  | "embedded_media"
  | "ocr_low_confidence"
  | "redaction_unavailable"
  | "review_required"
  | "task_cancelled";

export type FileScanFinding = Pick<RedactionFinding, "kind" | "count">;

export type FileScanSummary = {
  reason?: FileScanReason;
  /**
   * 次要原因。用于"需复核"这类高优先原因不吞掉提取阶段未覆盖提示的场景，
   * 避免用户以为文件里没有未扫描的内嵌内容。
   */
  secondaryReason?: FileScanReason;
  pagesWithText?: number;
  pagesWithoutText?: number;
};

export type FileScanResult = {
  status: FileScanStatus;
  format: FileFormat;
  coverage: FileScanCoverage;
  findings: readonly FileScanFinding[];
  summary: FileScanSummary;
  requiresReview?: boolean;
  redactedText?: string;
};

export type FileScanOptions = {
  customTerms?: readonly string[];
  allowlistedTerms?: readonly string[];
  categoryPolicies?: readonly CategoryPolicyEntry[];
  detectionProfile?: DetectionProfile;
  replacementStyle?: ReplacementStyle;
  semanticReviewProvider?: SemanticReviewProvider;
};

export type ExtractedFileText = {
  format: FileFormat;
  coverage: FileScanCoverage;
  text: string;
  summary: FileScanSummary;
};

export type LocalScanFile = {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
};

export type LocalImageFile = Pick<LocalScanFile, "name" | "size" | "type" | "arrayBuffer"> & {
  blob: Blob;
};

export const SCANNABLE_TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "java",
  "go",
  "sql",
  "log",
]);

export function summarizeFindings(findings: readonly RedactionFinding[]): FileScanFinding[] {
  return findings.map(({ kind, count }) => ({ kind, count }));
}

export function hasSensitiveFindings(findings: readonly FileScanFinding[]): boolean {
  return findings.some((finding) => finding.count > 0);
}

/**
 * 校验资源 URL 属于本扩展自身。
 *
 * 仅校验 chrome-extension: 协议不足以排除另一个扩展 ID 下的资源，
 * 因此能取到本扩展 ID 时必须精确匹配 host。取不到 ID（如单元测试环境）时
 * 退回协议校验，不放宽其他条件。
 */
export function assertExtensionLocalUrl(url: string, message: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(message);
  }

  if (parsed.protocol !== "chrome-extension:" || parsed.hostname.length === 0 || parsed.username || parsed.password) {
    throw new Error(message);
  }

  const expectedHost = typeof chrome !== "undefined" && typeof chrome.runtime?.id === "string" && chrome.runtime.id.length > 0
    ? chrome.runtime.id
    : null;
  if (expectedHost !== null && parsed.hostname !== expectedHost) {
    throw new Error(message);
  }
}

export function isKnownDetectionKind(value: string): value is DetectionKind {
  return [
    "api_key",
    "access_token",
    "private_key",
    "connection_string",
    "phone",
    "email",
    "china_id",
    "bank_card",
    "unified_social_credit_code",
    "passport",
    "license_plate",
    "ipv4",
    "ipv6",
    "local_path",
    "custom_term",
    "person_name",
    "address",
    "account",
    "labeled_identifier",
    "credential",
    "private_date",
    "private_url",
    "mac_address",
    "bank_account",
  ].includes(value as DetectionKind);
}
