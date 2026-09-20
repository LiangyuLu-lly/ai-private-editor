import { mergeAllowlists } from "./allowlist.js";
import {
  parseCustomTermsSettings,
  type CustomTermsSettings,
} from "./custom-terms.js";

export const CONFIGURATION_TRANSFER_SCHEMA_VERSION = 1;

export type ConfigurationTransferError = "invalid_json" | "unsupported_schema" | "invalid_configuration";
export type ConfigurationTransferParseResult =
  | { ok: true; settings: CustomTermsSettings }
  | { ok: false; error: ConfigurationTransferError };
export type ConfigurationTransferSerializeResult =
  | { ok: true; text: string }
  | { ok: false; error: "invalid_configuration" };

export type ConfigurationTransferSerializeOptions = {
  includeAllowlist?: boolean;
};

export type ConfigurationImportMode = "replace" | "merge";

export type ConfigurationTransferImportOptions = {
  readonly importMode?: ConfigurationImportMode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => key in value);
}

function cloneSettings(settings: CustomTermsSettings, includeAllowlist = true): CustomTermsSettings {
  return {
    terms: settings.terms.map((term) => ({ value: term.value, group: term.group })),
    mode: settings.mode,
    ...(includeAllowlist ? { allowlistedTerms: [...(settings.allowlistedTerms ?? [])] } : {}),
    ...(includeAllowlist && settings.siteAllowlist && settings.siteAllowlist.length > 0
      ? { siteAllowlist: settings.siteAllowlist.map((entry) => ({ ...entry })) }
      : {}),
    ...(settings.categoryPolicies && settings.categoryPolicies.length > 0
      ? { categoryPolicies: settings.categoryPolicies.map((policy) => ({ kind: policy.kind, action: policy.action })) }
      : {}),
    ...(settings.auditEnabled ? { auditEnabled: true } : {}),
    ...(settings.detectionProfile !== undefined ? { detectionProfile: settings.detectionProfile } : {}),
    ...(settings.replacementStyle !== undefined ? { replacementStyle: settings.replacementStyle } : {}),
    ...(settings.replyTokenViewerEnabled !== undefined
      ? { replyTokenViewerEnabled: settings.replyTokenViewerEnabled }
      : {}),
    ...(settings.attachmentAction !== undefined ? { attachmentAction: settings.attachmentAction } : {}),
    ...(settings.semanticReview !== undefined ? { semanticReview: settings.semanticReview } : {}),
  };
}

export function parseConfigurationTransfer(text: string): ConfigurationTransferParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }

  if (!isRecord(payload) || !hasExactKeys(payload, ["schemaVersion", "settings"])) {
    return { ok: false, error: "invalid_configuration" };
  }
  if (payload.schemaVersion !== CONFIGURATION_TRANSFER_SCHEMA_VERSION) {
    return typeof payload.schemaVersion === "number"
      ? { ok: false, error: "unsupported_schema" }
      : { ok: false, error: "invalid_configuration" };
  }

  const parsed = parseCustomTermsSettings(payload.settings);
  return parsed.ok
    ? { ok: true, settings: cloneSettings(parsed) }
    : { ok: false, error: "invalid_configuration" };
}

export function applyConfigurationTransfer(
  text: string,
  current: CustomTermsSettings,
  options: ConfigurationTransferImportOptions = {},
): ConfigurationTransferParseResult {
  const parsed = parseConfigurationTransfer(text);
  if (!parsed.ok) {
    return parsed;
  }

  const importMode = options.importMode ?? "replace";
  if (importMode === "replace") {
    return parsed;
  }
  if (importMode === "merge") {
    const merged = mergeAllowlists(current, parsed.settings);
    return {
      ok: true,
      settings: cloneSettings({
        ...parsed.settings,
        allowlistedTerms: merged.allowlistedTerms,
        siteAllowlist: merged.siteAllowlist,
      }),
    };
  }

  const unreachable: never = importMode;
  throw new Error(`unexpected import mode: ${String(unreachable)}`);
}

export function serializeConfigurationTransfer(
  settings: CustomTermsSettings,
  options: ConfigurationTransferSerializeOptions = {},
): ConfigurationTransferSerializeResult {
  const parsed = parseCustomTermsSettings(settings);
  if (!parsed.ok) {
    return { ok: false, error: "invalid_configuration" };
  }

  return {
    ok: true,
    text: JSON.stringify(
      {
        schemaVersion: CONFIGURATION_TRANSFER_SCHEMA_VERSION,
        settings: cloneSettings(parsed, options.includeAllowlist !== false),
      },
      null,
      2,
    ),
  };
}
