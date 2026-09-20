import type { FillDraftMessage, PingMessage } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export function isPingMessage(value: unknown): value is PingMessage {
  return isRecord(value) && value.type === "PING" && hasOnlyKeys(value, ["type"]);
}

export const QUERY_PROTECTION_STATUS_MESSAGE_TYPE = "QUERY_PROTECTION_STATUS";

export type QueryProtectionStatusMessage = {
  type: typeof QUERY_PROTECTION_STATUS_MESSAGE_TYPE;
};

export function isQueryProtectionStatusMessage(value: unknown): value is QueryProtectionStatusMessage {
  return isRecord(value) && value.type === QUERY_PROTECTION_STATUS_MESSAGE_TYPE && hasOnlyKeys(value, ["type"]);
}

export function isFillDraftMessage(value: unknown): value is FillDraftMessage {
  return (
    isRecord(value) &&
    value.type === "FILL_DRAFT" &&
    typeof value.outboundText === "string" &&
    typeof value.bindingKey === "string" &&
    value.bindingKey.length >= 16 &&
    typeof value.tabId === "number" &&
    Number.isSafeInteger(value.tabId) &&
    value.tabId >= 0 &&
    (value.site === "doubao" ||
      value.site === "deepseek" ||
      value.site === "yuanbao" ||
      value.site === "chatgpt" ||
      value.site === "claude" ||
      value.site === "gemini" ||
      value.site === "kimi" ||
      value.site === "qwen" ||
      value.site === "wenxin") &&
    hasOnlyKeys(value, ["type", "outboundText", "site", "tabId", "bindingKey"])
  );
}
