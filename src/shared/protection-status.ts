import type { SiteId } from "./types.js";

export const PROTECTION_STATUS_MESSAGE_TYPE = "REPORT_PROTECTION_STATUS";

export type ProtectionStatusState = "checking" | "protected" | "unverified";

export type ReplyViewerDiagnosticsState = "disabled" | "waiting_for_reply" | "no_tokens" | "ready";

export type ReplyViewerDiagnostics = {
  state: ReplyViewerDiagnosticsState;
  containers: number;
  tokens: number;
};

export type ProtectionStatus = {
  state: ProtectionStatusState;
  site: SiteId;
  replyViewer?: ReplyViewerDiagnostics;
};

export type ProtectionStatusMessage = {
  type: typeof PROTECTION_STATUS_MESSAGE_TYPE;
  status: ProtectionStatus;
};

const SITE_IDS: readonly SiteId[] = [
  "doubao",
  "deepseek",
  "yuanbao",
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "qwen",
  "wenxin",
];
const STATUS_STATES: readonly ProtectionStatusState[] = ["checking", "protected", "unverified"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isReplyViewerDiagnostics(value: unknown): value is ReplyViewerDiagnostics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const diagnostics = value as Record<string, unknown>;
  return (
    hasExactKeys(diagnostics, ["state", "containers", "tokens"]) &&
    typeof diagnostics.state === "string" &&
    ["disabled", "waiting_for_reply", "no_tokens", "ready"].includes(diagnostics.state) &&
    typeof diagnostics.containers === "number" &&
    Number.isSafeInteger(diagnostics.containers) &&
    diagnostics.containers >= 0 &&
    typeof diagnostics.tokens === "number" &&
    Number.isSafeInteger(diagnostics.tokens) &&
    diagnostics.tokens >= 0
  );
}

export function isProtectionStatusMessage(value: unknown): value is ProtectionStatusMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "status"]) ||
    value.type !== PROTECTION_STATUS_MESSAGE_TYPE ||
    !isRecord(value.status) ||
    !hasOnlyKeys(value.status, ["state", "site", "replyViewer"]) ||
    !("state" in value.status) ||
    !("site" in value.status)
  ) {
    return false;
  }

  return (
    typeof value.status.state === "string" &&
    STATUS_STATES.includes(value.status.state as ProtectionStatusState) &&
    typeof value.status.site === "string" &&
    SITE_IDS.includes(value.status.site as SiteId) &&
    (!("replyViewer" in value.status) || isReplyViewerDiagnostics(value.status.replyViewer))
  );
}
