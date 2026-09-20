import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  badgeTextToPageGuardState,
  createChromePageGuardStatusReader,
  createChromePrivateComposerLauncher,
  createPopupController,
  type PopupController,
  type PrivateComposerLauncher,
} from "../src/popup.js";
import { createAuditLogStore, type AuditLogStorage } from "../src/shared/audit-log.js";
import {
  createCustomTermsStore,
  type CustomTermsSettings,
  type CustomTermsStorage,
} from "../src/shared/custom-terms.js";
import type { SessionClearSignal } from "../src/shared/session-clear.js";

const popupHtmlPath = resolve(process.cwd(), "src", "popup.html");

type PopupStorage = CustomTermsStorage & {
  currentValue(): unknown;
  emit(value: unknown): void;
  listenerCount(): number;
  rejectNextWrite(): void;
  deferNextWrite(): Promise<void>;
  rejectDeferredWrite(): void;
  unsubscribeCalls(): number;
};

function cloneSettings(settings: CustomTermsSettings): CustomTermsSettings {
  const allowlistedTerms = settings.allowlistedTerms ?? [];
  return {
    terms: settings.terms.map((term) => ({ ...term })),
    mode: settings.mode,
    ...(allowlistedTerms.length > 0 ? { allowlistedTerms: [...allowlistedTerms] } : {}),
    ...(settings.siteAllowlist && settings.siteAllowlist.length > 0
      ? { siteAllowlist: settings.siteAllowlist.map((entry) => ({ ...entry })) }
      : {}),
    ...(settings.categoryPolicies && settings.categoryPolicies.length > 0
      ? { categoryPolicies: settings.categoryPolicies.map((policy) => ({ ...policy })) }
      : {}),
    ...(settings.siteCategoryPolicies && settings.siteCategoryPolicies.length > 0
      ? { siteCategoryPolicies: settings.siteCategoryPolicies.map((policy) => ({ ...policy })) }
      : {}),
    ...(settings.settingsVersion !== undefined ? { settingsVersion: settings.settingsVersion } : {}),
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

function createPopupStorage(initialValue: unknown): PopupStorage {
  let value = initialValue;
  let shouldRejectNextWrite = false;
  let shouldDeferNextWrite = false;
  let unsubscribeCount = 0;
  let resolveDeferredWriteStart: (() => void) | null = null;
  let rejectDeferredWrite: ((reason?: unknown) => void) | null = null;
  const listeners = new Set<(nextValue: unknown) => void>();

  return {
    async readValue() {
      return value;
    },
    async writeValue(settings) {
      if (shouldRejectNextWrite) {
        shouldRejectNextWrite = false;
        throw new Error("write rejected");
      }

      if (shouldDeferNextWrite) {
        shouldDeferNextWrite = false;
        return new Promise<void>((_resolve, reject) => {
          rejectDeferredWrite = reject;
          resolveDeferredWriteStart?.();
        });
      }

      value = cloneSettings(settings);
      listeners.forEach((listener) => listener(value));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        unsubscribeCount += 1;
        listeners.delete(listener);
      };
    },
    currentValue: () => value,
    emit(nextValue) {
      value = nextValue;
      listeners.forEach((listener) => listener(nextValue));
    },
    listenerCount: () => listeners.size,
    rejectNextWrite: () => {
      shouldRejectNextWrite = true;
    },
    deferNextWrite: () => {
      shouldDeferNextWrite = true;
      return new Promise<void>((resolve) => {
        resolveDeferredWriteStart = resolve;
      });
    },
    rejectDeferredWrite: () => {
      rejectDeferredWrite?.(new Error("deferred write rejected"));
      rejectDeferredWrite = null;
    },
    unsubscribeCalls: () => unsubscribeCount,
  };
}

function createPopupAuditStorage(initialValue: unknown): AuditLogStorage {
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
  };
}

function mountPopup(): void {
  const html = readFileSync(popupHtmlPath, "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)));
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id}`);
  }

  return element as T;
}

function submitBatch(value: string, group = "other"): boolean {
  byId<HTMLTextAreaElement>("custom-term-input").value = value;
  byId<HTMLSelectElement>("custom-term-group").value = group;
  return byId<HTMLFormElement>("custom-term-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

function submitAllowlist(value: string): boolean {
  byId<HTMLTextAreaElement>("allowlist-input").value = value;
  return byId<HTMLFormElement>("allowlist-form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

function visibleRows(): NodeListOf<HTMLLIElement> {
  return document.querySelectorAll<HTMLLIElement>(".custom-term-row");
}

function visibleAllowlistRows(): NodeListOf<HTMLLIElement> {
  return document.querySelectorAll<HTMLLIElement>(".allowlist-row");
}

function updateSearch(value: string): void {
  const search = byId<HTMLInputElement>("custom-term-search");
  search.value = value;
  search.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateGroupFilter(value: string): void {
  const filter = byId<HTMLSelectElement>("custom-term-filter-group");
  filter.value = value;
  filter.dispatchEvent(new Event("change", { bubbles: true }));
}

function updateAllowlistSearch(value: string): void {
  const search = byId<HTMLInputElement>("allowlist-search");
  search.value = value;
  search.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("custom terms popup", () => {
  it("ships the compact local-only controls required for grouped batch management", () => {
    const html = readFileSync(popupHtmlPath, "utf8");
    const css = readFileSync(resolve(process.cwd(), "src", "popup.css"), "utf8");

    expect(html).toContain('id="popup-title"');
    expect(html).toContain("把会漏的姓名先写上");
    expect(html).toContain('id="page-guard-status"');
    expect(html).toContain("更多设置");
    expect(html).toContain('id="more-settings"');
    expect(html).toContain('id="open-private-composer"');
    expect(html).toContain('id="private-composer-status"');
    expect(html).toContain("仅保存在此浏览器本地，不会同步或上传。");
    expect(html).toContain('id="custom-term-group"');
    expect(html).toContain('id="custom-term-search"');
    expect(html).toContain('id="custom-term-filter-group"');
    expect(html).toContain('id="strict-redaction-mode"');
    expect(html).toContain('id="allowlist-tab"');
    expect(html).toContain('id="allowlist-form"');
    expect(html).toContain('id="allowlist-input"');
    expect(html).toContain('id="allowlist-scope"');
    expect(html).toContain('id="allowlist-site"');
    expect(html).toContain('id="allowlist-list"');
    expect(html).toContain("白名单命中后会按原文发送");
    expect(html).toContain('id="policy-tab"');
    expect(html).toContain('id="policy-list"');
    expect(html).toContain('id="audit-tab"');
    expect(html).toContain('id="audit-enabled"');
    expect(html).toContain('id="audit-list"');
    expect(html).toContain('id="config-transfer-tab"');
    expect(html).toContain('id="configuration-transfer"');
    expect(html).toContain('id="import-mode"');
    expect(html).toContain('id="protection-tab"');
    expect(html).toContain('id="detection-profile"');
    expect(html).toContain('id="replacement-style"');
    expect(html).toContain('id="reply-token-viewer-enabled"');
    expect(html).toContain('id="attachment-action"');
    expect(html).toContain('id="semantic-review-status"');
    expect(html).toContain('id="open-local-scanner"');
    expect(html).toContain('href="scanner.html"');
    expect(html).toContain('href="popup.css"');
    expect(html).toContain('src="popup.js"');
    expect(css).toContain("width: min(360px, 100vw)");
    expect(css).toContain("min-width: 320px");
    expect(css).toContain(".popup-panel[hidden]");
    expect(css).toContain(".home-submit");
    expect(css).toContain(".more-settings");
  });

  it("returns to the home term form when more settings is closed", async () => {
    mountPopup();
    const controller = createPopupController(document, createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("protection-tab").click();
    expect(byId("custom-terms-panel").hidden).toBe(true);
    expect(byId("protection-panel").hidden).toBe(false);

    const moreSettings = byId<HTMLDetailsElement>("more-settings");
    moreSettings.open = false;
    moreSettings.dispatchEvent(new Event("toggle"));

    expect(byId("custom-terms-panel").hidden).toBe(false);
    expect(byId("protection-panel").hidden).toBe(true);
    expect(byId("custom-terms-tab").getAttribute("aria-selected")).toBe("true");
    controller.dispose();
  });

  it("maps toolbar badge text to ON and OFF", () => {
    expect(badgeTextToPageGuardState("ON")).toBe("on");
    expect(badgeTextToPageGuardState("!")).toBe("off");
    expect(badgeTextToPageGuardState("")).toBe("unknown");
  });

  it("shows ON when the current page is protected", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => "on",
    );
    await controller.initialize();

    const status = byId("page-guard-status");
    expect(status.textContent).toBe("ON");
    expect(status.dataset.state).toBe("on");
    controller.dispose();
  });

  it("shows OFF when the current page is unverified", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => "off",
    );
    await controller.initialize();

    const status = byId("page-guard-status");
    expect(status.textContent).toBe("OFF");
    expect(status.dataset.state).toBe("off");
    controller.dispose();
  });

  it("reads ON from the content-script status query", async () => {
    const reader = createChromePageGuardStatusReader({
      tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async () => ({ status: { state: "protected", site: "doubao" } }),
      },
      action: {
        getBadgeText: async () => "",
      },
    });

    await expect(reader()).resolves.toBe("on");
  });

  it("falls back to the toolbar badge when the page has no content script", async () => {
    const reader = createChromePageGuardStatusReader({
      tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async () => {
          throw new Error("Could not establish connection");
        },
      },
      action: {
        getBadgeText: async () => "!",
      },
    });

    await expect(reader()).resolves.toBe("off");
  });

  it("opens the extension side panel from an explicit popup user action", async () => {
    const getCurrent = vi.fn((callback: (currentWindow: { id?: number }) => void) => callback({ id: 73 }));
    const open = vi.fn().mockResolvedValue(undefined);
    const launcher = createChromePrivateComposerLauncher({
      windows: { getCurrent },
      sidePanel: { open },
    });

    expect(launcher.isAvailable()).toBe(true);
    await launcher.open();
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ windowId: 73 });
  });

  it("keeps the settings popup and exposes private composer as a separate action", async () => {
    mountPopup();
    const open = vi.fn().mockResolvedValue(undefined);
    const launcher: PrivateComposerLauncher = { isAvailable: () => true, open };
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      launcher,
    );
    await controller.initialize();

    byId<HTMLButtonElement>("open-private-composer").click();
    await flushPromises();

    expect(open).toHaveBeenCalledTimes(1);
    expect(byId<HTMLElement>("private-composer-status").textContent).toContain("已打开");
    controller.dispose();
  });

  it("persists the balanced profile and reply token viewer settings", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("protection-tab").click();
    const profile = byId<HTMLSelectElement>("detection-profile");
    profile.value = "balanced";
    profile.dispatchEvent(new Event("change", { bubbles: true }));
    const viewer = byId<HTMLInputElement>("reply-token-viewer-enabled");
    viewer.checked = true;
    viewer.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(storage.currentValue()).toEqual({
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      replyTokenViewerEnabled: true,
    });
    controller.dispose();
  });

  it("enables the local statistical semantic model only with balanced detection", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("protection-tab").click();
    const profile = byId<HTMLSelectElement>("detection-profile");
    profile.value = "balanced";
    profile.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();
    const semanticReview = byId<HTMLSelectElement>("semantic-review");
    expect(semanticReview.disabled).toBe(false);
    semanticReview.value = "local_statistical";
    semanticReview.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(storage.currentValue()).toMatchObject({
      detectionProfile: "balanced",
      semanticReview: "local_statistical",
    });
    controller.dispose();
  });

  it("disables reply token viewing for masked or surrogate output", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace", replyTokenViewerEnabled: true });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("protection-tab").click();
    const style = byId<HTMLSelectElement>("replacement-style");
    style.value = "surrogate";
    style.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    const viewer = byId<HTMLInputElement>("reply-token-viewer-enabled");
    expect(viewer.disabled).toBe(true);
    expect(viewer.checked).toBe(false);
    expect(storage.currentValue()).toEqual({
      terms: [],
      mode: "replace",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
    });
    controller.dispose();
  });

  it("renders and persists exact local allowlist values without treating them as custom terms", async () => {
    mountPopup();
    const storage = createPopupStorage({
      terms: [{ value: "内部项目", group: "project" }],
      mode: "replace",
      allowlistedTerms: ["synthetic-safe-value"],
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    expect(visibleAllowlistRows()).toHaveLength(1);
    expect(byId<HTMLUListElement>("allowlist-list").textContent).toContain("synthetic-safe-value");
    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("内部项目");

    submitAllowlist("<synthetic-safe-value-2>");
    await flushPromises();

    expect(visibleAllowlistRows()).toHaveLength(2);
    expect(byId<HTMLElement>("allowlist-status").textContent).toBe("已添加 1 个白名单值。");
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "内部项目", group: "project" }],
      mode: "replace",
      allowlistedTerms: ["synthetic-safe-value", "<synthetic-safe-value-2>"],
    });
    expect(document.querySelector("img")).toBeNull();
    controller.dispose();
  });

  it("persists a confirmed expiring Gemini-scoped allowlist entry and displays its site label", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true, undefined, undefined, () => true);
    await controller.initialize();

    byId<HTMLSelectElement>("allowlist-scope").value = "site";
    byId<HTMLSelectElement>("allowlist-scope").dispatchEvent(new Event("change", { bubbles: true }));
    byId<HTMLSelectElement>("allowlist-site").value = "gemini";
    byId<HTMLSelectElement>("allowlist-expiry").value = "one_hour";
    submitAllowlist("synthetic-gemini-value");
    await flushPromises();

    expect(visibleAllowlistRows()).toHaveLength(1);
    expect(visibleAllowlistRows()[0]?.textContent).toContain("Gemini");
    expect(storage.currentValue()).toMatchObject({
      terms: [],
      mode: "replace",
      siteAllowlist: [{ value: "synthetic-gemini-value", siteId: "gemini" }],
    });
    expect(Date.parse((storage.currentValue() as { siteAllowlist: Array<{ expiresAt?: string }> }).siteAllowlist[0]?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    controller.dispose();
  });

  it("does not persist a site-scoped allowlist entry until the user confirms its scope", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true, undefined, undefined, () => false);
    await controller.initialize();

    byId<HTMLSelectElement>("allowlist-scope").value = "site";
    byId<HTMLSelectElement>("allowlist-scope").dispatchEvent(new Event("change", { bubbles: true }));
    submitAllowlist("synthetic-sensitive-value");
    await flushPromises();

    expect(storage.currentValue()).toEqual({ terms: [], mode: "replace" });
    expect(byId<HTMLElement>("allowlist-status").textContent).toContain("已取消");
    controller.dispose();
  });

  it("requests a local session-map clear without exporting or storing any page text", async () => {
    mountPopup();
    const requestClear = vi.fn(async () => true);
    const signal: SessionClearSignal = { requestClear, subscribe: () => () => undefined };
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
      undefined,
      undefined,
      undefined,
      signal,
    );
    await controller.initialize();

    byId<HTMLButtonElement>("protection-tab").click();
    byId<HTMLButtonElement>("clear-session-map").click();
    await flushPromises();

    expect(requestClear).toHaveBeenCalledTimes(1);
    expect(byId<HTMLElement>("protection-status").textContent).toContain("已请求清除");
    controller.dispose();
  });

  it("renders and persists an explicit category policy without changing the term or allowlist settings", async () => {
    mountPopup();
    const storage = createPopupStorage({
      terms: [{ value: "项目词", group: "project" }],
      mode: "replace",
      allowlistedTerms: ["safe-value"],
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("policy-tab").click();
    const credentialPolicy = document.querySelector<HTMLSelectElement>('select[data-policy-kind="credential"]');
    if (credentialPolicy === null) {
      throw new Error("Expected credential policy selector");
    }
    credentialPolicy.value = "replace";
    credentialPolicy.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(storage.currentValue()).toEqual({
      terms: [{ value: "项目词", group: "project" }],
      mode: "replace",
      allowlistedTerms: ["safe-value"],
      categoryPolicies: [{ kind: "credential", action: "replace" }],
    });
    expect(byId<HTMLElement>("policy-status").textContent).toContain("已更新类别策略");
    controller.dispose();
  });

  it("shows privacy-only local audit records and persists the explicit audit toggle", async () => {
    mountPopup();
    const settingsStorage = createPopupStorage({ terms: [], mode: "replace" });
    const auditLog = createAuditLogStore(
      createPopupAuditStorage([
        {
          occurredAt: "2026-08-26T10:00:00.000Z",
          siteId: "chatgpt",
          operation: "send",
          outcome: "anonymized",
          findings: [{ kind: "phone", count: 2 }],
        },
      ]),
    );
    const controller = createPopupController(document, createCustomTermsStore(settingsStorage), () => true, auditLog);
    await controller.initialize();

    byId<HTMLButtonElement>("audit-tab").click();
    expect(byId<HTMLUListElement>("audit-list").textContent).toContain("ChatGPT");
    expect(byId<HTMLUListElement>("audit-list").textContent).toContain("手机号 2 项");
    expect(byId<HTMLUListElement>("audit-list").textContent).not.toContain("13800138000");

    const auditEnabled = byId<HTMLInputElement>("audit-enabled");
    auditEnabled.checked = true;
    auditEnabled.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(settingsStorage.currentValue()).toEqual({ terms: [], mode: "replace", auditEnabled: true });
    byId<HTMLButtonElement>("clear-audit-log").click();
    await flushPromises();
    await expect(auditLog.read()).resolves.toEqual({ ok: true, events: [] });
    controller.dispose();
  });

  it("exports configuration and only imports a validated replacement after confirmation", async () => {
    mountPopup();
    const settingsStorage = createPopupStorage({
      terms: [{ value: "导出词", group: "work" }],
      mode: "replace",
      allowlistedTerms: ["safe-export"],
    });
    const auditLog = createAuditLogStore(createPopupAuditStorage([]));
    const controller = createPopupController(
      document,
      createCustomTermsStore(settingsStorage),
      () => true,
      auditLog,
      () => true,
    );
    await controller.initialize();

    byId<HTMLButtonElement>("config-transfer-tab").click();
    byId<HTMLButtonElement>("export-configuration").click();
    const transfer = byId<HTMLTextAreaElement>("configuration-transfer");
    expect(JSON.parse(transfer.value)).toEqual({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "导出词", group: "work" }],
        mode: "replace",
      },
    });

    transfer.value = JSON.stringify({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "导入词", group: "project" }],
        mode: "block",
        allowlistedTerms: ["safe-import"],
      },
    });
    byId<HTMLButtonElement>("import-configuration").click();
    await flushPromises();

    expect(settingsStorage.currentValue()).toEqual({
      terms: [{ value: "导入词", group: "project" }],
      mode: "block",
      allowlistedTerms: ["safe-import"],
    });
    expect(byId<HTMLElement>("config-transfer-status").textContent).toContain("已导入本地配置");
    controller.dispose();
  });

  it("merge-imports allowlist values without deleting existing ones and still confirms replace", async () => {
    mountPopup();
    const settingsStorage = createPopupStorage({
      terms: [{ value: "现有词", group: "work" }],
      mode: "replace",
      allowlistedTerms: ["a"],
    });
    let confirmImport = false;
    const controller = createPopupController(
      document,
      createCustomTermsStore(settingsStorage),
      () => true,
      createAuditLogStore(createPopupAuditStorage([])),
      () => confirmImport,
    );
    await controller.initialize();

    byId<HTMLButtonElement>("config-transfer-tab").click();
    const transfer = byId<HTMLTextAreaElement>("configuration-transfer");
    transfer.value = JSON.stringify({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "导入词", group: "project" }],
        mode: "block",
        allowlistedTerms: ["b"],
      },
    });
    byId<HTMLSelectElement>("import-mode").value = "merge";
    byId<HTMLButtonElement>("import-configuration").click();
    await flushPromises();

    expect(settingsStorage.currentValue()).toEqual({
      terms: [{ value: "导入词", group: "project" }],
      mode: "block",
      allowlistedTerms: ["a", "b"],
    });

    transfer.value = JSON.stringify({
      schemaVersion: 1,
      settings: {
        terms: [{ value: "替换词", group: "other" }],
        mode: "replace",
        allowlistedTerms: ["only-imported"],
      },
    });
    byId<HTMLSelectElement>("import-mode").value = "replace";
    byId<HTMLButtonElement>("import-configuration").click();
    await flushPromises();
    expect(settingsStorage.currentValue()).toEqual({
      terms: [{ value: "导入词", group: "project" }],
      mode: "block",
      allowlistedTerms: ["a", "b"],
    });

    confirmImport = true;
    byId<HTMLButtonElement>("import-configuration").click();
    await flushPromises();
    expect(settingsStorage.currentValue()).toEqual({
      terms: [{ value: "替换词", group: "other" }],
      mode: "replace",
      allowlistedTerms: ["only-imported"],
    });
    controller.dispose();
  });

  it("exports rules without allowlist values until the user explicitly includes them", async () => {
    mountPopup();
    const settingsStorage = createPopupStorage({
      terms: [{ value: "导出词", group: "work" }],
      mode: "replace",
      allowlistedTerms: ["sensitive-export"],
    });
    const controller = createPopupController(document, createCustomTermsStore(settingsStorage), () => true);
    await controller.initialize();

    byId<HTMLButtonElement>("config-transfer-tab").click();
    byId<HTMLButtonElement>("export-configuration").click();

    expect(byId<HTMLTextAreaElement>("configuration-transfer").value).not.toContain("sensitive-export");
    controller.dispose();
  });

  it("filters, removes, and clears allowlist values without changing custom terms", async () => {
    let confirmed = false;
    mountPopup();
    const storage = createPopupStorage({
      terms: [{ value: "保留词", group: "work" }],
      mode: "block",
      allowlistedTerms: ["Alpha-safe", "Beta-safe"],
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => confirmed);
    await controller.initialize();

    updateAllowlistSearch("alpha");
    expect(visibleAllowlistRows()).toHaveLength(1);
    visibleAllowlistRows()[0]?.querySelector<HTMLButtonElement>("button")?.click();
    await flushPromises();

    expect(storage.currentValue()).toEqual({
      terms: [{ value: "保留词", group: "work" }],
      mode: "block",
      allowlistedTerms: ["Beta-safe"],
    });
    updateAllowlistSearch("");
    byId<HTMLButtonElement>("clear-allowlist").click();
    await flushPromises();
    expect(visibleAllowlistRows()).toHaveLength(1);

    confirmed = true;
    byId<HTMLButtonElement>("clear-allowlist").click();
    await flushPromises();
    expect(visibleAllowlistRows()).toHaveLength(0);
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "保留词", group: "work" }],
      mode: "block",
    });
    controller.dispose();
  });

  it("renders a stable empty state and disables clear for an empty local store", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
    );

    await controller.initialize();

    expect(byId<HTMLUListElement>("custom-term-list").querySelector(".custom-term-empty")).not.toBeNull();
    expect(byId<HTMLButtonElement>("clear-custom-terms").disabled).toBe(true);
    expect(byId<HTMLInputElement>("strict-redaction-mode").checked).toBe(false);
    controller.dispose();
  });

  it("adds a two-line batch with its selected group and renders text safely", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
    );
    await controller.initialize();

    expect(submitBatch("青岚项目\n客户编号-A17", "project")).toBe(false);
    await flushPromises();

    expect(visibleRows()).toHaveLength(2);
    expect(visibleRows()[0]?.textContent).toContain("项目");
    expect(visibleRows()[0]?.textContent).toContain("青岚项目");
    expect(visibleRows()[1]?.textContent).toContain("客户编号-A17");
    expect(byId<HTMLTextAreaElement>("custom-term-input").value).toBe("");
    expect(byId<HTMLElement>("custom-term-status").textContent).toBe("已添加 2 个词条。");
    controller.dispose();
  });

  it("preserves the textarea and visible list when a duplicate batch is rejected", async () => {
    mountPopup();
    const storage = createPopupStorage({
      terms: [{ value: "已有词", group: "work" }],
      mode: "replace",
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    submitBatch("新词\n已有词", "project");
    await flushPromises();

    expect(visibleRows()).toHaveLength(1);
    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("已有词");
    expect(byId<HTMLUListElement>("custom-term-list").textContent).not.toContain("新词");
    expect(byId<HTMLTextAreaElement>("custom-term-input").value).toBe("新词\n已有词");
    expect(byId<HTMLElement>("custom-term-status").textContent).toContain("已存在");
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "已有词", group: "work" }],
      mode: "replace",
    });
    controller.dispose();
  });

  it("preserves the textarea and visible list when a local write is rejected", async () => {
    mountPopup();
    const storage = createPopupStorage({
      terms: [{ value: "已有词", group: "work" }],
      mode: "replace",
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();
    storage.rejectNextWrite();

    submitBatch("新词", "project");
    await flushPromises();

    expect(visibleRows()).toHaveLength(1);
    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("已有词");
    expect(byId<HTMLTextAreaElement>("custom-term-input").value).toBe("新词");
    expect(byId<HTMLElement>("custom-term-status").textContent).toBe("无法保存本地自定义词库。");
    expect(storage.currentValue()).toEqual({
      terms: [{ value: "已有词", group: "work" }],
      mode: "replace",
    });
    controller.dispose();
  });

  it("renders user-provided batch terms as text instead of markup", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(createPopupStorage({ terms: [], mode: "replace" })),
      () => true,
    );
    await controller.initialize();

    submitBatch("<img src=x onerror=alert(1)>");
    await flushPromises();

    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    controller.dispose();
  });

  it("combines case-insensitive search and group filtering without shrinking stored terms", async () => {
    mountPopup();
    const storage = createPopupStorage({
      terms: [
        { value: "Alpha项目", group: "project" },
        { value: "ALPHA工作", group: "work" },
        { value: "个人资料", group: "personal" },
      ],
      mode: "replace",
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    updateSearch("alpha");
    updateGroupFilter("work");

    expect(visibleRows()).toHaveLength(1);
    expect(visibleRows()[0]?.textContent).toContain("ALPHA工作");
    expect(storage.currentValue()).toEqual({
      terms: [
        { value: "Alpha项目", group: "project" },
        { value: "ALPHA工作", group: "work" },
        { value: "个人资料", group: "personal" },
      ],
      mode: "replace",
    });
    controller.dispose();
  });

  it("shows a filtered no-result state without treating saved terms as empty", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(
        createPopupStorage({ terms: [{ value: "青岚项目", group: "project" }], mode: "replace" }),
      ),
      () => true,
    );
    await controller.initialize();

    updateSearch("不存在");

    expect(visibleRows()).toHaveLength(0);
    expect(byId<HTMLUListElement>("custom-term-list").querySelector(".custom-term-filter-empty")).not.toBeNull();
    expect(byId<HTMLUListElement>("custom-term-list").querySelector(".custom-term-empty")).toBeNull();
    expect(byId<HTMLButtonElement>("clear-custom-terms").disabled).toBe(false);
    controller.dispose();
  });

  it("persists strict mode and follows an external mode update", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [{ value: "青岚项目", group: "project" }], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    const strictMode = byId<HTMLInputElement>("strict-redaction-mode");
    strictMode.checked = true;
    strictMode.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(storage.currentValue()).toEqual({
      terms: [{ value: "青岚项目", group: "project" }],
      mode: "block",
    });
    expect(strictMode.checked).toBe(true);

    storage.emit({ terms: [{ value: "青岚项目", group: "project" }], mode: "replace" });

    expect(strictMode.checked).toBe(false);
    controller.dispose();
  });

  it("restores the persisted strict mode when its local write fails", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "block" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();
    storage.rejectNextWrite();

    const strictMode = byId<HTMLInputElement>("strict-redaction-mode");
    strictMode.checked = false;
    strictMode.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    expect(strictMode.checked).toBe(true);
    expect(byId<HTMLElement>("custom-term-status").textContent).toBe("无法保存本地自定义词库。");
    controller.dispose();
  });

  it("keeps a newer persisted strict mode after an earlier local mode write fails", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();
    const deferredWriteStarted = storage.deferNextWrite();

    const strictMode = byId<HTMLInputElement>("strict-redaction-mode");
    strictMode.checked = true;
    strictMode.dispatchEvent(new Event("change", { bubbles: true }));
    await deferredWriteStarted;
    storage.emit({ terms: [], mode: "block" });
    storage.rejectDeferredWrite();
    await flushPromises();

    expect(strictMode.checked).toBe(true);
    expect(byId<HTMLElement>("custom-term-status").textContent).toBe("无法保存本地自定义词库。");
    controller.dispose();
  });

  it("removes a row and clears all rows only after confirmation", async () => {
    let confirmed = false;
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(
        createPopupStorage({
          terms: [
            { value: "青岚项目", group: "project" },
            { value: "客户编号-A17", group: "work" },
          ],
          mode: "block",
        }),
      ),
      () => confirmed,
    );
    await controller.initialize();

    visibleRows()[0]?.querySelector<HTMLButtonElement>("button")?.click();
    await flushPromises();
    expect(visibleRows()).toHaveLength(1);

    byId<HTMLButtonElement>("clear-custom-terms").click();
    await flushPromises();
    expect(visibleRows()).toHaveLength(1);

    confirmed = true;
    byId<HTMLButtonElement>("clear-custom-terms").click();
    await flushPromises();
    expect(visibleRows()).toHaveLength(0);
    expect(byId<HTMLButtonElement>("clear-custom-terms").disabled).toBe(true);
    expect(byId<HTMLInputElement>("strict-redaction-mode").checked).toBe(true);
    controller.dispose();
  });

  it("keeps clear available when malformed stored data prevents initial rendering", async () => {
    mountPopup();
    const controller = createPopupController(
      document,
      createCustomTermsStore(
        createPopupStorage({
          terms: [
            { value: "重复词", group: "other" },
            { value: "重复词", group: "other" },
          ],
          mode: "replace",
        }),
      ),
      () => true,
    );

    await controller.initialize();

    expect(byId<HTMLElement>("custom-term-status").textContent).toBe(
      "自定义词库格式异常，未发送。可清空后重新添加。",
    );
    expect(visibleRows()).toHaveLength(0);
    expect(byId<HTMLButtonElement>("clear-custom-terms").disabled).toBe(false);
    controller.dispose();
  });

  it("updates visible terms and mode from a valid incoming local storage change", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [{ value: "旧词", group: "other" }], mode: "replace" });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    storage.emit({
      terms: [
        { value: "新词", group: "personal" },
        { value: "另一词", group: "work" },
      ],
      mode: "block",
    });

    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("新词");
    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("另一词");
    expect(visibleRows()).toHaveLength(2);
    expect(byId<HTMLInputElement>("strict-redaction-mode").checked).toBe(true);
    controller.dispose();
  });

  it("unsubscribes once on disposal and ignores later storage changes", async () => {
    mountPopup();
    const storage = createPopupStorage({ terms: [{ value: "初始词", group: "other" }], mode: "replace" });
    const controller: PopupController = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();

    expect(storage.listenerCount()).toBe(1);
    controller.dispose();
    controller.dispose();
    storage.emit({ terms: [{ value: "后续词", group: "project" }], mode: "block" });

    expect(storage.listenerCount()).toBe(0);
    expect(storage.unsubscribeCalls()).toBe(1);
    expect(byId<HTMLUListElement>("custom-term-list").textContent).toContain("初始词");
    expect(byId<HTMLUListElement>("custom-term-list").textContent).not.toContain("后续词");
  });

  it("exports audit JSON with contentHash and without raw values", async () => {
    // Given: an anonymized audit event with kind counts, and a planted raw sentinel in the draft
    mountPopup();
    const rawSentinel = "PLANTED-RAW-13800138000";
    const settingsStorage = createPopupStorage({ terms: [], mode: "replace" });
    const auditLog = createAuditLogStore(
      createPopupAuditStorage([
        {
          occurredAt: "2026-08-26T10:00:00.000Z",
          siteId: "chatgpt",
          operation: "send",
          outcome: "anonymized",
          findings: [{ kind: "phone", count: 2 }],
        },
      ]),
    );
    const previousCreateObjectURL = URL.createObjectURL;
    const previousRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (() => "blob:audit-export") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      const controller = createPopupController(document, createCustomTermsStore(settingsStorage), () => true, auditLog);
      await controller.initialize();
      byId<HTMLButtonElement>("audit-tab").click();
      byId<HTMLTextAreaElement>("custom-term-input").value = rawSentinel;

      // When: exporting the local audit log
      byId<HTMLButtonElement>("export-audit-log").click();
      await vi.waitFor(() => {
        expect(byId<HTMLTextAreaElement>("audit-export").value.length).toBeGreaterThan(0);
      });

      // Then: payload has contentHash and counts, and never the planted raw sentinel
      const text = byId<HTMLTextAreaElement>("audit-export").value;
      const payload = JSON.parse(text) as {
        contentHash: string;
        events: Array<{ kinds: Array<{ kind: string; count: number }> }>;
      };
      expect(payload.contentHash).toEqual(expect.any(String));
      expect(payload.contentHash.length).toBeGreaterThan(0);
      expect(payload.events[0]?.kinds).toEqual([{ kind: "phone", count: 2 }]);
      expect(text).not.toContain(rawSentinel);
      controller.dispose();
    } finally {
      URL.createObjectURL = previousCreateObjectURL;
      URL.revokeObjectURL = previousRevokeObjectURL;
    }
  });

  it("writes a site overlay without changing global policy", async () => {
    // Given: a global phone=replace policy and the policy panel scoped to ChatGPT
    mountPopup();
    const storage = createPopupStorage({
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "phone", action: "replace" }],
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();
    byId<HTMLButtonElement>("policy-tab").click();
    const scope = byId<HTMLSelectElement>("policy-scope");
    scope.value = "site";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    const site = byId<HTMLSelectElement>("policy-site");
    site.value = "chatgpt";
    site.dispatchEvent(new Event("change", { bubbles: true }));

    // When: setting the ChatGPT phone policy to confirm
    const phonePolicy = document.querySelector<HTMLSelectElement>('select[data-policy-kind="phone"]');
    if (phonePolicy === null) {
      throw new Error("Expected phone policy selector");
    }
    phonePolicy.value = "confirm";
    phonePolicy.dispatchEvent(new Event("change", { bubbles: true }));
    await flushPromises();

    // Then: only the site overlay gains that row; global categoryPolicies is unchanged
    expect(storage.currentValue()).toMatchObject({
      categoryPolicies: [{ kind: "phone", action: "replace" }],
      siteCategoryPolicies: [{ siteId: "chatgpt", kind: "phone", action: "confirm" }],
    });
    controller.dispose();
  });

  it("applies a preset only after in-panel confirm", async () => {
    // Given: stored allowlist + a global policy, and a professional pack with no allowlist values
    mountPopup();
    const packJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "src", "assets", "presets", "work.json"), "utf8"),
    ) as {
      categoryPolicies: Array<{ kind: string; action: string }>;
    };
    expect(packJson).not.toHaveProperty("allowlistedTerms");
    expect(packJson).not.toHaveProperty("terms");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => packJson,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = createPopupStorage({
      terms: [{ value: "保留词", group: "work" }],
      mode: "replace",
      allowlistedTerms: ["keep-allowlist"],
      categoryPolicies: [{ kind: "phone", action: "block" }],
    });
    const controller = createPopupController(document, createCustomTermsStore(storage), () => true);
    await controller.initialize();
    byId<HTMLButtonElement>("policy-tab").click();
    const packSelect = byId<HTMLSelectElement>("preset-pack");
    packSelect.value = "work";
    packSelect.dispatchEvent(new Event("change", { bubbles: true }));

    // When: Apply is clicked
    byId<HTMLButtonElement>("apply-preset").click();
    await flushPromises();

    // Then: settings are unchanged until in-panel Confirm
    expect(storage.currentValue()).toMatchObject({
      terms: [{ value: "保留词", group: "work" }],
      allowlistedTerms: ["keep-allowlist"],
      categoryPolicies: [{ kind: "phone", action: "block" }],
    });

    byId<HTMLButtonElement>("confirm-preset").click();
    await flushPromises();
    expect(storage.currentValue()).toMatchObject({
      terms: [{ value: "保留词", group: "work" }],
      allowlistedTerms: ["keep-allowlist"],
      categoryPolicies: packJson.categoryPolicies,
    });
    controller.dispose();
    vi.unstubAllGlobals();
  });
});
