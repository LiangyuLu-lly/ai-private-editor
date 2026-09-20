import { parseCustomTermsSettings, type CustomTermsSettings } from "./custom-terms.js";
import type { CategoryPolicyEntry } from "./types.js";

export const PROFESSIONAL_PRESET_IDS = ["personal", "work", "legal", "medical", "finance", "rd"] as const;
export type ProfessionalPresetId = (typeof PROFESSIONAL_PRESET_IDS)[number];

export const PROFESSIONAL_PRESET_SETTINGS_VERSION = 1;

export type ProfessionalPresetPack = {
  readonly settingsVersion: typeof PROFESSIONAL_PRESET_SETTINGS_VERSION;
  readonly categoryPolicies: readonly CategoryPolicyEntry[];
};

export type ProfessionalPresetParseResult =
  | { readonly ok: true; readonly pack: ProfessionalPresetPack }
  | { readonly ok: false; readonly error: "invalid_preset" };

const PACK_KEYS = ["settingsVersion", "categoryPolicies"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => key in value);
}

export function parseProfessionalPresetPack(value: unknown): ProfessionalPresetParseResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PACK_KEYS) ||
    value.settingsVersion !== PROFESSIONAL_PRESET_SETTINGS_VERSION
  ) {
    return { ok: false, error: "invalid_preset" };
  }

  const parsed = parseCustomTermsSettings({
    terms: [],
    mode: "replace",
    categoryPolicies: value.categoryPolicies,
  });
  if (!parsed.ok || parsed.categoryPolicies === undefined || parsed.categoryPolicies.length === 0) {
    return { ok: false, error: "invalid_preset" };
  }

  return {
    ok: true,
    pack: {
      settingsVersion: PROFESSIONAL_PRESET_SETTINGS_VERSION,
      categoryPolicies: parsed.categoryPolicies.map((policy) => ({
        kind: policy.kind,
        action: policy.action,
      })),
    },
  };
}

export function applyProfessionalPreset(
  settings: CustomTermsSettings,
  pack: ProfessionalPresetPack,
): CustomTermsSettings {
  return {
    ...settings,
    categoryPolicies: pack.categoryPolicies.map((policy) => ({
      kind: policy.kind,
      action: policy.action,
    })),
  };
}
