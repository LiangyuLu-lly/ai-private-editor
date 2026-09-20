import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  createAuditLogStore,
  exportAuditLog,
  type AuditLogStorage,
} from "../src/shared/audit-log.js";

function createStorage(initialValue: unknown): AuditLogStorage & { currentValue(): unknown } {
  let value = initialValue;
  const listeners = new Set<(nextValue: unknown) => void>();

  return {
    async readValue() {
      return value;
    },
    async writeValue(nextValue) {
      value = nextValue;
      listeners.forEach((listener) => listener(nextValue));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentValue: () => value,
  };
}

describe("local audit log", () => {
  it("stores only site, outcome, category, and count without retaining raw values or labels", async () => {
    const storage = createStorage(undefined);
    const store = createAuditLogStore(storage, () => "2026-08-26T10:00:00.000Z");

    await expect(
      store.append({
        siteId: "chatgpt",
        operation: "send",
        outcome: "anonymized",
        findings: [
          { kind: "phone", count: 2, labels: ["手机号"] },
          { kind: "credential", count: 1, labels: ["数据库密码"] },
        ],
      } as unknown as Parameters<typeof store.append>[0]),
    ).resolves.toEqual({ ok: true });

    expect(storage.currentValue()).toEqual([
      {
        occurredAt: "2026-08-26T10:00:00.000Z",
        siteId: "chatgpt",
        operation: "send",
        outcome: "anonymized",
        findings: [
          { kind: "phone", count: 2 },
          { kind: "credential", count: 1 },
        ],
      },
    ]);
    expect(JSON.stringify(storage.currentValue())).not.toContain("数据库密码");
    expect(JSON.stringify(storage.currentValue())).not.toContain("synthetic-test-password");
  });

  it("keeps the newest bounded set of audit events and clears them locally", async () => {
    const storage = createStorage(undefined);
    let call = 0;
    const store = createAuditLogStore(storage, () => `2026-08-26T10:00:${String(call++).padStart(2, "0")}.000Z`);

    for (let index = 0; index < 101; index += 1) {
      await store.append({
        siteId: "doubao",
        operation: "paste",
        outcome: "blocked",
        findings: [{ kind: "phone", count: 1 }],
      });
    }

    const read = await store.read();
    expect(read.ok && read.events).toHaveLength(100);
    if (read.ok) {
      expect(read.events[0]?.occurredAt).toBe("2026-08-26T10:00:01.000Z");
    }
    await expect(store.clear()).resolves.toEqual({ ok: true });
    await expect(store.read()).resolves.toEqual({ ok: true, events: [] });
  });

  it("fails closed when persisted audit records do not match the privacy-only schema", async () => {
    const storage = createStorage([
      {
        occurredAt: "2026-08-26T10:00:00.000Z",
        siteId: "chatgpt",
        operation: "send",
        outcome: "anonymized",
        findings: [{ kind: "phone", count: 1, value: "13800138000" }],
      },
    ]);

    await expect(createAuditLogStore(storage).read()).resolves.toEqual({ ok: false, error: "invalid_storage" });
  });

  it("accepts persisted Gemini audit summaries without raw values", async () => {
    const storage = createStorage([
      {
        occurredAt: "2026-08-26T10:00:00.000Z",
        siteId: "gemini",
        operation: "send",
        outcome: "anonymized",
        findings: [{ kind: "phone", count: 1 }],
      },
    ]);

    await expect(createAuditLogStore(storage).read()).resolves.toEqual({
      ok: true,
      events: [
        {
          occurredAt: "2026-08-26T10:00:00.000Z",
          siteId: "gemini",
          operation: "send",
          outcome: "anonymized",
          findings: [{ kind: "phone", count: 1 }],
        },
      ],
    });
  });

  it("exports at most 100 events with a sha256 digest and no finding values", async () => {
    const SENTINEL = "SENTINEL_RAW_DRAFT_VALUE_never_in_findings";
    const storage = createStorage(undefined);
    let call = 0;
    const store = createAuditLogStore(storage, () => `2026-08-26T10:00:${String(call++).padStart(2, "0")}.000Z`);

    for (let index = 0; index < 101; index += 1) {
      await store.append({
        siteId: "chatgpt",
        operation: "send",
        outcome: "anonymized",
        findings: [{ kind: "phone", count: 1, value: SENTINEL }],
      } as unknown as Parameters<typeof store.append>[0]);
    }

    const exported = await exportAuditLog(store);

    expect(exported.schemaVersion).toBe(1);
    expect(exported.events).toHaveLength(100);
    expect(exported.events[0]).toEqual({
      site: "chatgpt",
      operation: "send",
      outcome: "anonymized",
      kinds: [{ kind: "phone", count: 1 }],
    });
    expect(exported.events.every((event) => Object.keys(event).sort().join(",") === "kinds,operation,outcome,site")).toBe(
      true,
    );
    expect(exported.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(exported)).not.toContain(SENTINEL);

    const canonicalEvent = {
      kinds: [{ count: 1, kind: "phone" }],
      operation: "send",
      outcome: "anonymized",
      site: "chatgpt",
    };
    const canonical = JSON.stringify({
      events: Array.from({ length: 100 }, () => canonicalEvent),
      schemaVersion: 1,
    });
    expect(exported.contentHash).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
  });
});
