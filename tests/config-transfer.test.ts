import { describe, expect, it } from "vitest";

import {
  applyConfigurationTransfer,
  parseConfigurationTransfer,
  serializeConfigurationTransfer,
} from "../src/shared/config-transfer.js";

describe("configuration transfer", () => {
  it("serializes only validated local configuration and excludes audit records", () => {
    const result = serializeConfigurationTransfer({
      terms: [{ value: "巡检项目", group: "project" }],
      mode: "block",
      allowlistedTerms: ["internal-safe"],
      siteAllowlist: [{ value: "demo-value", siteId: "chatgpt" }],
      categoryPolicies: [{ kind: "phone", action: "confirm" }],
      auditEnabled: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "巡检项目", group: "project" }],
        mode: "block",
        allowlistedTerms: ["internal-safe"],
        siteAllowlist: [{ value: "demo-value", siteId: "chatgpt" }],
        categoryPolicies: [{ kind: "phone", action: "confirm" }],
        auditEnabled: true,
      },
    });
    expect(result.text).not.toContain("localAuditLog");
  });

  it("can export rules without exposing any allowlist values", () => {
    const result = serializeConfigurationTransfer(
      {
        terms: [{ value: "巡检项目", group: "project" }],
        mode: "replace",
        allowlistedTerms: ["sensitive-global-value"],
        siteAllowlist: [{ value: "sensitive-site-value", siteId: "chatgpt" }],
      },
      { includeAllowlist: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "巡检项目", group: "project" }],
        mode: "replace",
      },
    });
    expect(result.text).not.toContain("sensitive-global-value");
    expect(result.text).not.toContain("sensitive-site-value");
  });

  it("fails closed for malformed JSON, an unsupported schema, legacy settings, or unknown keys", () => {
    expect(parseConfigurationTransfer("{")).toEqual({ ok: false, error: "invalid_json" });
    expect(parseConfigurationTransfer(JSON.stringify({ schemaVersion: 2, settings: { terms: [], mode: "replace" } }))).toEqual({
      ok: false,
      error: "unsupported_schema",
    });
    expect(parseConfigurationTransfer(JSON.stringify({ schemaVersion: 1, settings: [] }))).toEqual({
      ok: false,
      error: "invalid_configuration",
    });
    expect(parseConfigurationTransfer(JSON.stringify({ schemaVersion: 1, settings: { terms: [], mode: "replace" }, extra: true }))).toEqual({
      ok: false,
      error: "invalid_configuration",
    });
  });

  it("imports a validated Gemini-scoped allowlist entry", () => {
    expect(
      parseConfigurationTransfer(
        JSON.stringify({
          schemaVersion: 1,
          settings: {
            terms: [],
            mode: "replace",
            siteAllowlist: [{ value: "gemini-safe", siteId: "gemini" }],
          },
        }),
      ),
    ).toEqual({
      ok: true,
      settings: {
        terms: [],
        mode: "replace",
        allowlistedTerms: [],
        siteAllowlist: [{ value: "gemini-safe", siteId: "gemini" }],
      },
    });
  });

  it("round-trips a finite site allowlist expiry", () => {
    const result = serializeConfigurationTransfer({
      terms: [],
      mode: "replace",
      siteAllowlist: [{ value: "site-safe", siteId: "gemini", expiresAt: "2030-01-01T00:00:00.000Z" }],
    });

    expect(result.ok && parseConfigurationTransfer(result.text)).toEqual({
      ok: true,
      settings: {
        terms: [],
        mode: "replace",
        allowlistedTerms: [],
        siteAllowlist: [{ value: "site-safe", siteId: "gemini", expiresAt: "2030-01-01T00:00:00.000Z" }],
      },
    });
  });

  it("merge-import unions allowlist values without deleting existing ones", () => {
    const current = {
      terms: [{ value: "keep-term", group: "work" as const }],
      mode: "replace" as const,
      allowlistedTerms: ["a"],
      siteAllowlist: [{ value: "dup", siteId: "chatgpt" as const, expiresAt: "2030-01-01T00:00:00.000Z" }],
    };
    const importedFile = JSON.stringify({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "imported-term", group: "project" }],
        mode: "block",
        allowlistedTerms: ["b"],
        siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2031-06-01T00:00:00.000Z" }],
      },
    });

    const merged = applyConfigurationTransfer(importedFile, current, { importMode: "merge" });
    expect(merged).toEqual({
      ok: true,
      settings: {
        terms: [{ value: "imported-term", group: "project" }],
        mode: "block",
        allowlistedTerms: ["a", "b"],
        siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2031-06-01T00:00:00.000Z" }],
      },
    });

    const beforeInvalid = {
      terms: current.terms.map((term) => ({ ...term })),
      mode: current.mode,
      allowlistedTerms: [...current.allowlistedTerms],
      siteAllowlist: current.siteAllowlist.map((entry) => ({ ...entry })),
    };
    expect(applyConfigurationTransfer("{", current, { importMode: "merge" })).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(current).toEqual(beforeInvalid);

    const replaced = applyConfigurationTransfer(importedFile, current);
    expect(replaced).toEqual({
      ok: true,
      settings: {
        terms: [{ value: "imported-term", group: "project" }],
        mode: "block",
        allowlistedTerms: ["b"],
        siteAllowlist: [{ value: "dup", siteId: "chatgpt", expiresAt: "2031-06-01T00:00:00.000Z" }],
      },
    });
    expect(replaced.ok && replaced.settings.allowlistedTerms).not.toContain("a");

    expect(
      parseConfigurationTransfer(JSON.stringify({ schemaVersion: 1, settings: { terms: [], mode: "replace" } })),
    ).toEqual({
      ok: true,
      settings: {
        terms: [],
        mode: "replace",
        allowlistedTerms: [],
      },
    });
  });
});
