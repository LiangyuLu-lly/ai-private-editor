import { describe, expect, it, vi } from "vitest";

import {
  MAX_CUSTOM_TERM_LENGTH,
  createChromeCustomTermsStore,
  createCustomTermsCache,
  createCustomTermsStore,
  parseCustomTermsSettings,
  type CustomTermsSnapshot,
  type CustomTermsStorage,
} from "../src/shared/custom-terms.js";

type FakeStorage = CustomTermsStorage & {
  emit(value: unknown): void;
  listenerCount(): number;
  readCount(): number;
  currentValue(): unknown;
  writes: unknown[];
};

type UntypedMutationStore = {
  add(rawTerm: string, group?: string): Promise<unknown>;
  addBatch(rawBatch: string, group: string): Promise<unknown>;
  setMode(mode: string): Promise<unknown>;
};

function createFakeStorage(initialValue: unknown): FakeStorage {
  let value = initialValue;
  let reads = 0;
  const listeners = new Set<(nextValue: unknown) => void>();
  const writes: unknown[] = [];

  return {
    async readValue() {
      reads += 1;
      return value;
    },
    async writeValue(nextValue) {
      writes.push(nextValue);
      value = nextValue;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(nextValue) {
      value = nextValue;
      listeners.forEach((listener) => listener(nextValue));
    },
    listenerCount: () => listeners.size,
    readCount: () => reads,
    currentValue: () => value,
    writes,
  };
}

function createDeferredReadStorage(initialValue: unknown): FakeStorage & { resolveRead(): void } {
  let resolve: (() => void) | null = null;
  let value = initialValue;
  let reads = 0;
  const listeners = new Set<(nextValue: unknown) => void>();
  const writes: unknown[] = [];

  return {
    readValue: () => {
      reads += 1;
      const pendingValue = value;
      return new Promise<unknown>((complete) => {
        resolve = () => complete(pendingValue);
      });
    },
    async writeValue(nextValue) {
      writes.push(nextValue);
      value = nextValue;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(nextValue) {
      value = nextValue;
      listeners.forEach((listener) => listener(nextValue));
    },
    listenerCount: () => listeners.size,
    readCount: () => reads,
    currentValue: () => value,
    resolveRead: () => resolve?.(),
    writes,
  };
}

function createDeferredFirstWriteStorage(initialValue: unknown): FakeStorage & {
  firstWriteStarted(): Promise<void>;
  resolveFirstWrite(): void;
} {
  let value = initialValue;
  let reads = 0;
  let firstWritePending = true;
  let resolveFirstWrite: (() => void) | null = null;
  let resolveFirstWriteStarted: (() => void) | null = null;
  const listeners = new Set<(nextValue: unknown) => void>();
  const writes: unknown[] = [];

  return {
    async readValue() {
      reads += 1;
      return value;
    },
    writeValue(nextValue) {
      writes.push(nextValue);
      if (firstWritePending) {
        firstWritePending = false;
        return new Promise<void>((resolve) => {
          resolveFirstWrite = () => {
            value = nextValue;
            resolve();
          };
          resolveFirstWriteStarted?.();
        });
      }

      value = nextValue;
      return Promise.resolve();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(nextValue) {
      value = nextValue;
      listeners.forEach((listener) => listener(nextValue));
    },
    listenerCount: () => listeners.size,
    readCount: () => reads,
    currentValue: () => value,
    firstWriteStarted: () =>
      new Promise<void>((resolve) => {
        resolveFirstWriteStarted = resolve;
      }),
    resolveFirstWrite: () => resolveFirstWrite?.(),
    writes,
  };
}

function untypedMutationStore(storage: CustomTermsStorage): UntypedMutationStore {
  return createCustomTermsStore(storage) as unknown as UntypedMutationStore;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("custom terms store", () => {
  it("converts a legacy array to grouped replacement settings without writing during read", async () => {
    const storage = createFakeStorage([" 青岚项目 ", "客户编号-A17"]);

    await expect(createCustomTermsStore(storage).read()).resolves.toEqual({
      ok: true,
      terms: [
        { value: "青岚项目", group: "other" },
        { value: "客户编号-A17", group: "other" },
      ],
      mode: "replace",
      allowlistedTerms: [],
    });
    expect(storage.writes).toEqual([]);
  });

  it("round trips valid object settings and persists a changed mode", async () => {
    const storage = createFakeStorage({ terms: [{ value: "项目代号", group: "project" }], mode: "replace" });
    const store = createCustomTermsStore(storage);

    await expect(store.read()).resolves.toEqual({
      ok: true,
      terms: [{ value: "项目代号", group: "project" }],
      mode: "replace",
      allowlistedTerms: [],
    });
    await expect(untypedMutationStore(storage).setMode("block")).resolves.toEqual({
      ok: true,
      terms: [{ value: "项目代号", group: "project" }],
      mode: "block",
      allowlistedTerms: [],
    });
    expect(storage.writes).toEqual([
      { terms: [{ value: "项目代号", group: "project" }], mode: "block", allowlistedTerms: [] },
    ]);
  });

  it("rejects runtime-invalid groups and modes before reading or writing", async () => {
    const addStorage = createFakeStorage(undefined);
    await expect(untypedMutationStore(addStorage).add("词", "team")).resolves.toEqual({
      ok: false,
      error: "invalid_storage",
    });
    expect(addStorage.readCount()).toBe(0);
    expect(addStorage.writes).toEqual([]);

    const batchStorage = createFakeStorage(undefined);
    await expect(untypedMutationStore(batchStorage).addBatch("词", "team")).resolves.toEqual({
      ok: false,
      error: "invalid_storage",
    });
    expect(batchStorage.readCount()).toBe(0);
    expect(batchStorage.writes).toEqual([]);

    const modeStorage = createFakeStorage(undefined);
    await expect(untypedMutationStore(modeStorage).setMode("erase")).resolves.toEqual({
      ok: false,
      error: "invalid_storage",
    });
    expect(modeStorage.readCount()).toBe(0);
    expect(modeStorage.writes).toEqual([]);
  });

  it("fails closed for malformed settings, an invalid mode, or an invalid group", async () => {
    const malformedValues: unknown[] = [
      null,
      { terms: [], mode: "erase" },
      { terms: [{ value: "词", group: "team" }], mode: "replace" },
      { terms: ["词"], mode: "replace" },
      { terms: [{ value: "  ", group: "other" }], mode: "replace" },
      { terms: [{ value: "词", group: "other", extra: true }], mode: "replace" },
    ];

    for (const value of malformedValues) {
      const storage = createFakeStorage(value);
      await expect(createCustomTermsStore(storage).read()).resolves.toEqual({ ok: false, error: "invalid_storage" });
      expect(storage.writes).toEqual([]);
    }
  });

  it("rejects blank-only batches while ignoring blank lines in a valid batch", async () => {
    const storage = createFakeStorage(undefined);
    const store = untypedMutationStore(storage);

    await expect(store.addBatch(" \r\n\n\t\r ", "work")).resolves.toEqual({ ok: false, error: "empty_term" });
    expect(storage.writes).toEqual([]);

    await expect(store.addBatch("甲\r\n\n 乙 \r丙", "work")).resolves.toEqual({
      ok: true,
      terms: [
        { value: "甲", group: "work" },
        { value: "乙", group: "work" },
        { value: "丙", group: "work" },
      ],
      mode: "replace",
      allowlistedTerms: [],
    });
  });

  it("rejects duplicate existing or repeated batch values without a write", async () => {
    const existingStorage = createFakeStorage({
      terms: [{ value: "已有词", group: "personal" }],
      mode: "replace",
    });
    await expect(untypedMutationStore(existingStorage).addBatch("新词\n已有词", "work")).resolves.toEqual({
      ok: false,
      error: "duplicate_term",
      line: 2,
    });
    expect(existingStorage.writes).toEqual([]);

    const duplicateStorage = createFakeStorage(undefined);
    await expect(untypedMutationStore(duplicateStorage).addBatch("新词\r新词", "other")).resolves.toEqual({
      ok: false,
      error: "duplicate_term",
      line: 2,
    });
    expect(duplicateStorage.writes).toEqual([]);
  });

  it("rejects an overlong batch term at its source line without a partial write", async () => {
    const storage = createFakeStorage(undefined);

    await expect(untypedMutationStore(storage).addBatch(`有效词\n${"x".repeat(MAX_CUSTOM_TERM_LENGTH + 1)}`, "project")).resolves.toEqual({
      ok: false,
      error: "term_too_long",
      line: 2,
    });
    expect(storage.writes).toEqual([]);
  });

  it("rejects an overflowing batch without a partial write", async () => {
    const storage = createFakeStorage({
      terms: Array.from({ length: 99 }, (_, index) => ({ value: `词条-${index + 1}`, group: "other" })),
      mode: "block",
    });

    await expect(untypedMutationStore(storage).addBatch("第100条\n第101条", "personal")).resolves.toEqual({
      ok: false,
      error: "term_limit",
      line: 2,
    });
    expect(storage.writes).toEqual([]);
  });

  it("adds a valid multiline batch in order with its selected group in one write", async () => {
    const storage = createFakeStorage({ terms: [{ value: "原有", group: "other" }], mode: "block" });

    await expect(untypedMutationStore(storage).addBatch(" 甲\n乙\r\n丙 ", "project")).resolves.toEqual({
      ok: true,
      terms: [
        { value: "原有", group: "other" },
        { value: "甲", group: "project" },
        { value: "乙", group: "project" },
        { value: "丙", group: "project" },
      ],
      mode: "block",
      allowlistedTerms: [],
    });
    expect(storage.writes).toEqual([
      {
        terms: [
          { value: "原有", group: "other" },
          { value: "甲", group: "project" },
          { value: "乙", group: "project" },
          { value: "丙", group: "project" },
        ],
        mode: "block",
        allowlistedTerms: [],
      },
    ]);
  });

  it("serializes mutations so clearing cannot restore a batch based on an older read", async () => {
    const storage = createDeferredFirstWriteStorage({
      terms: [{ value: "已有词", group: "other" }],
      mode: "replace",
    });
    const store = createCustomTermsStore(storage);
    const firstWriteStarted = storage.firstWriteStarted();
    const addBatch = store.addBatch("新词", "project");

    await firstWriteStarted;
    const clear = store.clear();
    await flushPromises();
    const writesBeforeFirstCompletion = storage.writes.length;
    storage.resolveFirstWrite();

    await Promise.all([addBatch, clear]);

    expect(writesBeforeFirstCompletion).toBe(1);
    expect(storage.currentValue()).toEqual({ terms: [], mode: "replace", allowlistedTerms: [] });
  });

  it("continues queued mutations after a storage write failure", async () => {
    let value: unknown = { terms: [{ value: "已有词", group: "other" }], mode: "block" };
    let writeCount = 0;
    const storage: CustomTermsStorage = {
      readValue: async () => value,
      writeValue: async (nextValue) => {
        writeCount += 1;
        if (writeCount === 1) {
          throw new Error("first write rejected");
        }
        value = nextValue;
      },
      subscribe: () => () => undefined,
    };
    const store = createCustomTermsStore(storage);
    const add = store.add("新词", "project");
    const clear = store.clear();

    await expect(add).resolves.toEqual({ ok: false, error: "storage_write_failed" });
    await expect(clear).resolves.toEqual({ ok: true, terms: [], mode: "block", allowlistedTerms: [] });
    expect(value).toEqual({ terms: [], mode: "block", allowlistedTerms: [] });
  });

  it("keeps the single-term default group and removes by normalized value", async () => {
    const storage = createFakeStorage({ terms: [{ value: "甲", group: "work" }], mode: "block" });
    const store = createCustomTermsStore(storage);

    await expect(store.add("乙")).resolves.toEqual({
      ok: true,
      terms: [{ value: "甲", group: "work" }, { value: "乙", group: "other" }],
      mode: "block",
      allowlistedTerms: [],
    });
    await expect(store.remove(" 甲 ")).resolves.toEqual({
      ok: true,
      terms: [{ value: "乙", group: "other" }],
      mode: "block",
      allowlistedTerms: [],
    });
  });

  it("clears malformed storage into a valid empty replacement configuration", async () => {
    const storage = createFakeStorage({
      terms: [{ value: "重复", group: "other" }, { value: "重复", group: "other" }],
      mode: "block",
    });

    await expect(createCustomTermsStore(storage).clear()).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
    });
    expect(storage.writes).toEqual([{ terms: [], mode: "replace", allowlistedTerms: [] }]);
  });

  it("clears readable settings while preserving block mode", async () => {
    const storage = createFakeStorage({ terms: [{ value: "已有词", group: "work" }], mode: "block" });

    await expect(createCustomTermsStore(storage).clear()).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "block",
      allowlistedTerms: [],
    });
    expect(storage.writes).toEqual([{ terms: [], mode: "block", allowlistedTerms: [] }]);
  });

  it("maps rejected reads and writes without exposing storage errors", async () => {
    const readFailure: CustomTermsStorage = {
      readValue: async () => Promise.reject(new Error("private source value")),
      writeValue: async () => undefined,
      subscribe: () => () => undefined,
    };
    const writeFailure: CustomTermsStorage = {
      readValue: async () => undefined,
      writeValue: async () => Promise.reject(new Error("private destination value")),
      subscribe: () => () => undefined,
    };

    await expect(createCustomTermsStore(readFailure).read()).resolves.toEqual({ ok: false, error: "storage_read_failed" });
    await expect(createCustomTermsStore(readFailure).add("词")).resolves.toEqual({ ok: false, error: "storage_read_failed" });
    await expect(createCustomTermsStore(writeFailure).add("词")).resolves.toEqual({ ok: false, error: "storage_write_failed" });
    await expect(createCustomTermsStore(writeFailure).remove("词")).resolves.toEqual({ ok: false, error: "storage_write_failed" });
    await expect(createCustomTermsStore(writeFailure).clear()).resolves.toEqual({ ok: false, error: "storage_write_failed" });
  });

  it("defaults the allowlist when reading legacy settings", async () => {
    const legacyStorage = createFakeStorage({
      terms: [{ value: "已有词", group: "project" }],
      mode: "replace",
    });

    await expect(createCustomTermsStore(legacyStorage).read()).resolves.toMatchObject({
      ok: true,
      terms: [{ value: "已有词", group: "project" }],
      mode: "replace",
      allowlistedTerms: [],
    });
    expect(legacyStorage.writes).toEqual([]);
  });

  it("accepts a persisted Gemini-scoped allowlist entry", async () => {
    const storage = createFakeStorage({
      terms: [],
      mode: "replace",
      siteAllowlist: [{ value: "gemini-safe", siteId: "gemini" }],
    });

    await expect(createCustomTermsStore(storage).read()).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      siteAllowlist: [{ value: "gemini-safe", siteId: "gemini" }],
    });
  });

  it("adds, removes, and clears exact allowlist values without changing terms or mode", async () => {
    const storage = createFakeStorage({
      terms: [{ value: "项目词", group: "project" }],
      mode: "block",
      allowlistedTerms: ["已有放行值"],
    });
    const store = createCustomTermsStore(storage);

    await expect(store.addAllowlistedBatch("  可放行值\n第二个值  ")).resolves.toMatchObject({
      ok: true,
      terms: [{ value: "项目词", group: "project" }],
      mode: "block",
      allowlistedTerms: ["已有放行值", "可放行值", "第二个值"],
    });
    await expect(store.removeAllowlisted(" 可放行值 ")).resolves.toMatchObject({
      ok: true,
      allowlistedTerms: ["已有放行值", "第二个值"],
    });
    await expect(store.clearAllowlisted()).resolves.toMatchObject({
      ok: true,
      terms: [{ value: "项目词", group: "project" }],
      mode: "block",
      allowlistedTerms: [],
    });
  });

  it("keeps site-scoped allowlist values separate from global values", async () => {
    const storage = createFakeStorage({
      terms: [],
      mode: "replace",
      allowlistedTerms: ["global-value"],
      siteAllowlist: [{ value: "deepseek-value", siteId: "deepseek" }],
    });
    const store = createCustomTermsStore(storage);

    await expect(store.addAllowlistedBatch("doubao-value", { scope: "site", siteId: "doubao" })).resolves.toMatchObject({
      ok: true,
      allowlistedTerms: ["global-value"],
      siteAllowlist: [
        { value: "deepseek-value", siteId: "deepseek" },
        { value: "doubao-value", siteId: "doubao" },
      ],
    });
    expect(storage.currentValue()).toEqual({
      terms: [],
      mode: "replace",
      allowlistedTerms: ["global-value"],
      siteAllowlist: [
        { value: "deepseek-value", siteId: "deepseek" },
        { value: "doubao-value", siteId: "doubao" },
      ],
    });

    await store.removeAllowlisted("deepseek-value", { scope: "site", siteId: "deepseek" });
    await store.clearAllowlisted({ scope: "site", siteId: "doubao" });
    const finalSettings = await store.read();
    expect(finalSettings).toMatchObject({ ok: true, allowlistedTerms: ["global-value"] });
    expect(finalSettings.ok && finalSettings.siteAllowlist ? finalSettings.siteAllowlist : []).toEqual([]);
  });

  it("rejects duplicate or overlong allowlist batches without a partial write", async () => {
    const storage = createFakeStorage({ terms: [], mode: "replace", allowlistedTerms: ["已有放行值"] });
    const store = createCustomTermsStore(storage);

    await expect(store.addAllowlistedBatch("新值\n已有放行值")).resolves.toMatchObject({
      ok: false,
      error: "duplicate_term",
      line: 2,
    });
    await expect(store.addAllowlistedBatch(`有效值\n${"x".repeat(MAX_CUSTOM_TERM_LENGTH + 1)}`)).resolves.toMatchObject({
      ok: false,
      error: "term_too_long",
      line: 2,
    });
    expect(storage.writes).toEqual([]);
  });

  it("persists only explicit per-category policies and preserves them through unrelated term changes", async () => {
    const storage = createFakeStorage({
      terms: [{ value: "项目词", group: "project" }],
      mode: "replace",
      categoryPolicies: [{ kind: "credential", action: "replace" }],
    });
    const store = createCustomTermsStore(storage);

    await expect(store.setCategoryPolicy("phone", "block")).resolves.toEqual({
      ok: true,
      terms: [{ value: "项目词", group: "project" }],
      mode: "replace",
      allowlistedTerms: [],
      categoryPolicies: [
        { kind: "credential", action: "replace" },
        { kind: "phone", action: "block" },
      ],
    });
    await expect(store.add("新增词", "work")).resolves.toMatchObject({
      ok: true,
      categoryPolicies: [
        { kind: "credential", action: "replace" },
        { kind: "phone", action: "block" },
      ],
    });
    await expect(store.setCategoryPolicy("credential", null)).resolves.toMatchObject({
      ok: true,
      categoryPolicies: [{ kind: "phone", action: "block" }],
    });
  });

  it("rejects malformed category policies from local storage", async () => {
    const storage = createFakeStorage({
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "not-a-kind", action: "replace" }],
    });

    await expect(createCustomTermsStore(storage).read()).resolves.toEqual({ ok: false, error: "invalid_storage" });
  });

  it("parses settingsVersion 2 with site overlays and ignores unknown future keys", () => {
    const parsed = parseCustomTermsSettings({
      terms: [],
      mode: "replace",
      settingsVersion: 2,
      siteCategoryPolicies: [{ siteId: "chatgpt", kind: "phone", action: "confirm" }],
      futureKey: 1,
    });

    expect(parsed).toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      settingsVersion: 2,
      siteCategoryPolicies: [{ siteId: "chatgpt", kind: "phone", action: "confirm" }],
    });
    expect(parsed.ok && "futureKey" in parsed).toBe(false);

    expect(
      parseCustomTermsSettings({
        terms: [{ value: "旧词", group: "other" }],
        mode: "replace",
      }),
    ).toEqual({
      ok: true,
      terms: [{ value: "旧词", group: "other" }],
      mode: "replace",
      allowlistedTerms: [],
    });
  });

  it("keeps local auditing disabled unless the user explicitly enables it", async () => {
    const storage = createFakeStorage({ terms: [], mode: "replace" });
    const store = createCustomTermsStore(storage);

    await expect(store.read()).resolves.toEqual({ ok: true, terms: [], mode: "replace", allowlistedTerms: [] });
    await expect(store.setAuditEnabled(true)).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      auditEnabled: true,
    });
    await expect(store.setAuditEnabled(false)).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
    });
  });

  it("replaces settings atomically after runtime validation", async () => {
    const storage = createFakeStorage({
      terms: [{ value: "旧配置", group: "other" }],
      mode: "replace",
      allowlistedTerms: ["old-safe"],
    });
    const store = createCustomTermsStore(storage);

    await expect(store.replace({
      terms: [{ value: "新配置", group: "project" }],
      mode: "block",
      allowlistedTerms: ["new-safe"],
      siteAllowlist: [{ value: "site-safe", siteId: "claude" }],
      categoryPolicies: [{ kind: "credential", action: "confirm" }],
      auditEnabled: true,
    })).resolves.toEqual({
      ok: true,
      terms: [{ value: "新配置", group: "project" }],
      mode: "block",
      allowlistedTerms: ["new-safe"],
      siteAllowlist: [{ value: "site-safe", siteId: "claude" }],
      categoryPolicies: [{ kind: "credential", action: "confirm" }],
      auditEnabled: true,
    });
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "新配置", group: "project" }],
      mode: "block",
      allowlistedTerms: ["new-safe"],
      siteAllowlist: [{ value: "site-safe", siteId: "claude" }],
      categoryPolicies: [{ kind: "credential", action: "confirm" }],
      auditEnabled: true,
    });

    await expect(store.replace({
      terms: [{ value: "  ", group: "other" }],
      mode: "replace",
    })).resolves.toEqual({ ok: false, error: "invalid_storage" });
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "新配置", group: "project" }],
      mode: "block",
      allowlistedTerms: ["new-safe"],
      siteAllowlist: [{ value: "site-safe", siteId: "claude" }],
      categoryPolicies: [{ kind: "credential", action: "confirm" }],
      auditEnabled: true,
    });
  });

  it("persists advanced protection settings and preserves them through term changes", async () => {
    const storage = createFakeStorage({ terms: [], mode: "replace" });
    const store = createCustomTermsStore(storage);

    await expect(store.setAdvancedSettings({
      detectionProfile: "balanced",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: true,
      attachmentAction: "confirm",
      semanticReview: "off",
    })).resolves.toMatchObject({
      ok: true,
      detectionProfile: "balanced",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
      attachmentAction: "confirm",
    });
    await store.add("保密项目", "project");

    expect(storage.currentValue()).toMatchObject({
      detectionProfile: "balanced",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
      attachmentAction: "confirm",
    });
  });

  it("persists the local statistical semantic model mode", async () => {
    const storage = createFakeStorage({ terms: [], mode: "replace" });
    const store = createCustomTermsStore(storage);

    await expect(store.setAdvancedSettings({ semanticReview: "local_statistical" })).resolves.toMatchObject({
      ok: true,
      semanticReview: "local_statistical",
    });
    expect(storage.currentValue()).toMatchObject({ semanticReview: "local_statistical" });
  });

  it("migrates the unused legacy semantic provider setting to off", async () => {
    const storage = createFakeStorage({
      terms: [],
      mode: "replace",
      semanticReview: "local_provider",
    });

    await expect(createCustomTermsStore(storage).read()).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      semanticReview: "off",
    });
  });

  it("normalizes an imported non-token output setting that tries to enable reply viewing", async () => {
    const storage = createFakeStorage({ terms: [], mode: "replace" });
    const store = createCustomTermsStore(storage);

    await expect(store.replace({
      terms: [],
      mode: "replace",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: true,
    })).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
    });
    expect(storage.currentValue()).toEqual({
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
    });
  });

  it("normalizes an existing non-token setting before it reaches the local cache", async () => {
    const storage = createFakeStorage({
      terms: [],
      mode: "replace",
      replacementStyle: "masked",
      replyTokenViewerEnabled: true,
    });

    await expect(createCustomTermsStore(storage).read()).resolves.toEqual({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      replacementStyle: "masked",
      replyTokenViewerEnabled: false,
    });
  });
});

describe("custom terms cache", () => {
  it("receives grouped terms and mode from a local storage change", async () => {
    const storage = createFakeStorage(undefined);
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    await flushPromises();
    storage.emit({ terms: [{ value: "新词", group: "project" }], mode: "block" });

    expect(cache.getSnapshot()).toEqual({
      state: "ready",
      terms: [{ value: "新词", group: "project" }],
      mode: "block",
      allowlistedTerms: [],
      detectionProfile: "balanced",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
      semanticReview: "local_neural",
    });
  });

  it("does not let a late initial read overwrite a newer grouped storage change", async () => {
    const storage = createDeferredReadStorage({ terms: [{ value: "旧词", group: "other" }], mode: "replace" });
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    storage.emit({ terms: [{ value: "新词", group: "work" }], mode: "block" });
    storage.resolveRead();
    await flushPromises();

    expect(cache.getSnapshot()).toEqual({
      state: "ready",
      terms: [{ value: "新词", group: "work" }],
      mode: "block",
      allowlistedTerms: [],
      detectionProfile: "balanced",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
      semanticReview: "local_neural",
    });
  });

  it("ignores an initial read that resolves after cache disposal", async () => {
    const storage = createDeferredReadStorage({ terms: [{ value: "旧词", group: "other" }], mode: "replace" });
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    cache.dispose();
    storage.resolveRead();
    await flushPromises();

    expect(cache.getSnapshot()).toEqual({ state: "loading" });
  });

  it("moves to failed when a changed local value is malformed", async () => {
    const storage = createFakeStorage(undefined);
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    await flushPromises();
    storage.emit({ terms: [{ value: "有效词", group: "other" }], mode: "erase" });

    expect(cache.getSnapshot()).toEqual({ state: "failed" });
  });

  it("notifies a cache subscriber about storage updates and stops after unsubscribe", async () => {
    const storage = createFakeStorage(undefined);
    const cache = createCustomTermsCache(createCustomTermsStore(storage));
    const snapshots: CustomTermsSnapshot[] = [];
    const unsubscribe = cache.subscribe((snapshot) => snapshots.push(snapshot));

    cache.start();
    await flushPromises();
    storage.emit({ terms: [{ value: "新词", group: "project" }], mode: "replace" });

    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toEqual({
      state: "ready",
      terms: [{ value: "新词", group: "project" }],
      mode: "replace",
      allowlistedTerms: [],
      detectionProfile: "balanced",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
      semanticReview: "local_neural",
    });

    unsubscribe();
    storage.emit({ terms: [{ value: "不应通知", group: "other" }], mode: "replace" });
    expect(snapshots).toHaveLength(2);
  });

  it("subscribes before reading and removes the listener on disposal", async () => {
    let subscribed = false;
    const storage = createFakeStorage(undefined);
    const originalRead = storage.readValue;
    storage.readValue = () => {
      expect(subscribed).toBe(true);
      return originalRead();
    };
    const originalSubscribe = storage.subscribe;
    storage.subscribe = (listener) => {
      subscribed = true;
      return originalSubscribe(listener);
    };
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    await flushPromises();
    expect(cache.getSnapshot()).toEqual({
      state: "ready",
      terms: [],
      mode: "replace",
      allowlistedTerms: [],
      detectionProfile: "balanced",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
      semanticReview: "local_neural",
    });
    expect(storage.listenerCount()).toBe(1);
    cache.dispose();
    expect(storage.listenerCount()).toBe(0);
  });

  it("materializes the recommended advanced defaults when storage is empty", async () => {
    const storage = createFakeStorage(undefined);
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    expect(storage.currentValue()).toMatchObject({
      detectionProfile: "balanced",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
      semanticReview: "local_neural",
    });
    expect(cache.getSnapshot()).toMatchObject({
      state: "ready",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    });
  });

  it("fills only missing advanced fields in an older configuration", async () => {
    const storage = createFakeStorage({
      terms: [{ value: "旧词", group: "project" }],
      mode: "replace",
      detectionProfile: "conservative",
      semanticReview: "off",
    });
    const cache = createCustomTermsCache(createCustomTermsStore(storage));

    cache.start();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();

    expect(storage.currentValue()).toMatchObject({
      detectionProfile: "conservative",
      semanticReview: "off",
      replacementStyle: "token",
      replyTokenViewerEnabled: false,
      attachmentAction: "warn",
    });
    expect(cache.getSnapshot()).toMatchObject({
      state: "ready",
      detectionProfile: "conservative",
      semanticReview: "off",
    });
  });
});

describe("Chrome custom terms adapter", () => {
  it("uses only the local key and writes the new settings object", async () => {
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>();
    const get = vi.fn(async () => ({}));
    const set = vi.fn(async () => undefined);
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: { get, set },
          onChanged: {
            addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => listeners.add(listener),
            removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => listeners.delete(listener),
          },
        },
      },
    });

    try {
      const store = createChromeCustomTermsStore();
      await expect(store.read()).resolves.toEqual({ ok: true, terms: [], mode: "replace", allowlistedTerms: [] });
      await expect(store.add("本地词", "personal")).resolves.toEqual({
        ok: true,
        terms: [{ value: "本地词", group: "personal" }],
        mode: "replace",
        allowlistedTerms: [],
      });
      expect(get).toHaveBeenCalledWith("customTerms");
      expect(set).toHaveBeenCalledWith({
        customTerms: {
          terms: [{ value: "本地词", group: "personal" }],
          mode: "replace",
          allowlistedTerms: [],
        },
      });
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
    }
  });

  it("maps a rejected local set call to a write failure", async () => {
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: { get: async () => ({}), set: async () => Promise.reject(new Error("storage set rejected")) },
          onChanged: { addListener: () => undefined, removeListener: () => undefined },
        },
      },
    });

    try {
      await expect(createChromeCustomTermsStore().add("本地词")).resolves.toEqual({ ok: false, error: "storage_write_failed" });
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
    }
  });

  it("forwards only local customTerms changes through the settings parser", () => {
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>();
    const originalChrome = globalThis.chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        storage: {
          local: { get: async () => ({}), set: async () => undefined },
          onChanged: {
            addListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => listeners.add(listener),
            removeListener: (listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => listeners.delete(listener),
          },
        },
      },
    });

    try {
      const received: unknown[] = [];
      const unsubscribe = createChromeCustomTermsStore().subscribe((result) => received.push(result));
      listeners.forEach((listener) => listener({ customTerms: { newValue: undefined } }, "sync"));
      listeners.forEach((listener) => listener({ unrelated: { newValue: undefined } }, "local"));
      listeners.forEach((listener) =>
        listener({ customTerms: { newValue: { terms: [{ value: "同步词", group: "work" }], mode: "block" } } }, "local"),
      );

      expect(received).toEqual([
        { ok: true, terms: [{ value: "同步词", group: "work" }], mode: "block", allowlistedTerms: [] },
      ]);
      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
    }
  });
});
