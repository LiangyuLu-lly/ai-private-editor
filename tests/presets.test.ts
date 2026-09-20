import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCustomTermsSettings } from "../src/shared/custom-terms.js";
import {
  applyProfessionalPreset,
  parseProfessionalPresetPack,
} from "../src/shared/professional-presets.js";
import type { CategoryPolicyAction, DetectionKind } from "../src/shared/types.js";

const PRESET_IDS = ["personal", "work", "legal", "medical", "finance", "rd"] as const;

const DETECTION_KINDS: Record<DetectionKind, true> = {
  api_key: true,
  access_token: true,
  private_key: true,
  connection_string: true,
  phone: true,
  email: true,
  china_id: true,
  bank_card: true,
  unified_social_credit_code: true,
  passport: true,
  license_plate: true,
  ipv4: true,
  ipv6: true,
  local_path: true,
  custom_term: true,
  person_name: true,
  address: true,
  account: true,
  labeled_identifier: true,
  credential: true,
  private_date: true,
  private_url: true,
  mac_address: true,
  bank_account: true,
};

const CATEGORY_POLICY_ACTIONS: Record<CategoryPolicyAction, true> = {
  replace: true,
  confirm: true,
  block: true,
};

const EMPTY_SETTINGS = { terms: [], mode: "replace" as const };

const EXPECTED_ACTION_MAPS = {
  personal: {
    api_key: "confirm",
    access_token: "confirm",
    private_key: "confirm",
    connection_string: "confirm",
    credential: "confirm",
    phone: "replace",
    email: "replace",
    china_id: "confirm",
    bank_card: "confirm",
    bank_account: "confirm",
    passport: "confirm",
    person_name: "confirm",
    address: "confirm",
    labeled_identifier: "confirm",
    private_date: "confirm",
    account: "confirm",
    private_url: "confirm",
  },
  work: {
    api_key: "confirm",
    access_token: "confirm",
    private_key: "confirm",
    connection_string: "confirm",
    credential: "confirm",
    phone: "replace",
    email: "replace",
    person_name: "confirm",
    address: "confirm",
    unified_social_credit_code: "confirm",
    labeled_identifier: "confirm",
    local_path: "replace",
    china_id: "confirm",
    passport: "confirm",
    bank_account: "confirm",
    account: "confirm",
    private_url: "confirm",
    private_date: "confirm",
  },
  legal: {
    api_key: "confirm",
    access_token: "confirm",
    private_key: "confirm",
    connection_string: "confirm",
    credential: "confirm",
    phone: "confirm",
    email: "confirm",
    china_id: "confirm",
    passport: "confirm",
    person_name: "confirm",
    address: "confirm",
    bank_account: "confirm",
    unified_social_credit_code: "confirm",
    labeled_identifier: "confirm",
    private_date: "confirm",
    bank_card: "confirm",
    license_plate: "confirm",
    private_url: "confirm",
    account: "confirm",
  },
  medical: {
    api_key: "confirm",
    access_token: "confirm",
    private_key: "confirm",
    connection_string: "confirm",
    credential: "confirm",
    phone: "confirm",
    email: "confirm",
    china_id: "confirm",
    person_name: "confirm",
    address: "confirm",
    private_date: "confirm",
    labeled_identifier: "confirm",
    bank_card: "confirm",
    passport: "confirm",
    bank_account: "confirm",
    account: "confirm",
    license_plate: "confirm",
    ipv4: "confirm",
    ipv6: "confirm",
    mac_address: "confirm",
    private_url: "confirm",
  },
  finance: {
    api_key: "confirm",
    access_token: "confirm",
    private_key: "block",
    connection_string: "block",
    credential: "block",
    bank_card: "confirm",
    bank_account: "confirm",
    china_id: "confirm",
    unified_social_credit_code: "confirm",
    phone: "confirm",
    email: "confirm",
    person_name: "confirm",
    account: "confirm",
    labeled_identifier: "confirm",
    passport: "confirm",
    private_url: "confirm",
    address: "confirm",
  },
  rd: {
    api_key: "block",
    access_token: "block",
    private_key: "block",
    connection_string: "block",
    credential: "block",
    local_path: "confirm",
    ipv4: "confirm",
    ipv6: "confirm",
    mac_address: "confirm",
    phone: "replace",
    email: "replace",
    account: "confirm",
  },
} as const satisfies Record<(typeof PRESET_IDS)[number], Record<string, CategoryPolicyAction>>;

function readPackJson(id: (typeof PRESET_IDS)[number]): unknown {
  const text = readFileSync(resolve(__dirname, `../src/assets/presets/${id}.json`), "utf8");
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("professional preset packs", () => {
  describe.each(PRESET_IDS)("%s", (id) => {
    it("keeps only settingsVersion and categoryPolicies keys", () => {
      // Given: a shipped JSON pack on disk
      const raw = readPackJson(id);

      // When: inspecting the pack object
      expect(isRecord(raw)).toBe(true);
      if (!isRecord(raw)) {
        return;
      }

      // Then: no allowlist, custom terms, or extra fields that could hold PII
      expect(Object.keys(raw).sort()).toEqual(["categoryPolicies", "settingsVersion"]);
      expect(raw).not.toHaveProperty("allowlistedTerms");
      expect(raw).not.toHaveProperty("terms");
    });

    it("parses against the settings schema with at least one valid policy", () => {
      // Given: a shipped JSON pack
      const raw = readPackJson(id);

      // When: the pack loader validates it and the settings schema accepts the policies
      const parsed = parseProfessionalPresetPack(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const asSettings = parseCustomTermsSettings({
        terms: [],
        mode: "replace",
        categoryPolicies: parsed.pack.categoryPolicies,
      });

      // Then: one or more policies, every kind/action in the closed unions
      expect(asSettings.ok).toBe(true);
      expect(parsed.pack.categoryPolicies.length).toBeGreaterThan(0);
      for (const policy of parsed.pack.categoryPolicies) {
        expect(DETECTION_KINDS[policy.kind]).toBe(true);
        expect(CATEGORY_POLICY_ACTIONS[policy.action]).toBe(true);
      }
    });

    it("applies onto empty settings as the expected action map", () => {
      // Given: empty settings and a validated pack
      const parsed = parseProfessionalPresetPack(readPackJson(id));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }

      // When: applying the pack to empty settings
      const applied = applyProfessionalPreset(EMPTY_SETTINGS, parsed.pack);
      const actionMap = Object.fromEntries(
        (applied.categoryPolicies ?? []).map((policy) => [policy.kind, policy.action]),
      );

      // Then: the overlay is exactly the pinned map for this pack
      expect(actionMap).toEqual(EXPECTED_ACTION_MAPS[id]);
      expect(applied.terms).toEqual([]);
      expect(applied.allowlistedTerms).toBeUndefined();
    });
  });

  it.each([
    ["terms", { settingsVersion: 1, categoryPolicies: [{ kind: "phone", action: "replace" }], terms: [] }],
    [
      "allowlistedTerms",
      {
        settingsVersion: 1,
        categoryPolicies: [{ kind: "phone", action: "replace" }],
        allowlistedTerms: [],
      },
    ],
    ["extra", { settingsVersion: 1, categoryPolicies: [{ kind: "phone", action: "replace" }], extra: true }],
    ["empty categoryPolicies", { settingsVersion: 1, categoryPolicies: [] }],
    ["unknown kind", { settingsVersion: 1, categoryPolicies: [{ kind: "not_a_kind", action: "replace" }] }],
    ["unknown action", { settingsVersion: 1, categoryPolicies: [{ kind: "phone", action: "ignore" }] }],
  ] as const)("rejects a pack that includes %s", (_label, value) => {
    // Given: a pack payload that is not a policy-only overlay
    // When: parsing at the pack boundary
    const parsed = parseProfessionalPresetPack(value);

    // Then: fail closed
    expect(parsed).toEqual({ ok: false, error: "invalid_preset" });
  });
});
