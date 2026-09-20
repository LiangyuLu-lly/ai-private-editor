import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canBootstrapSidePanel,
  SidePanelController,
  type SidePanelGateway,
  type SidePanelSettingsStore,
} from "../src/sidepanel.js";
import type { SiteId, SiteStatusResponse } from "../src/shared/types.js";

const sidePanelHtml = readFileSync(resolve(process.cwd(), "src", "sidepanel.html"), "utf8");

function mountPanel(): void {
  const body = sidePanelHtml.match(/<body>([\s\S]*)<\/body>/u)?.[1];

  if (!body) {
    throw new Error("sidepanel.html is missing a body element");
  }

  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gu, "");
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id}`);
  }

  return element as T;
}

function activeTarget(site: SiteId, tabId = 42, bindingKey = "a".repeat(36)): SiteStatusResponse {
  return { site, tabId, bindingKey };
}

function createGateway(site: SiteId | null = "doubao"): SidePanelGateway {
  return {
    getActiveSite: vi.fn().mockResolvedValue(site === null ? { site: null } : activeTarget(site)),
    fillDraft: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function createSettingsStore(
  result: Awaited<ReturnType<SidePanelSettingsStore["read"]>> = {
    ok: true,
    terms: [],
    mode: "replace",
    allowlistedTerms: [],
  },
): SidePanelSettingsStore {
  return { read: vi.fn().mockResolvedValue(result) };
}

async function checkDraft(text: string): Promise<void> {
  const draft = byId<HTMLTextAreaElement>("draft-input");
  draft.value = text;
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  byId<HTMLButtonElement>("check-button").click();
  await vi.waitFor(() => expect(byId<HTMLButtonElement>("check-button").disabled).toBe(false));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("side-panel private composer", () => {
  it("starts only when Chrome runtime messaging is available", () => {
    expect(canBootstrapSidePanel(undefined)).toBe(false);
    expect(canBootstrapSidePanel({})).toBe(false);
    expect(canBootstrapSidePanel({ runtime: { sendMessage: () => Promise.resolve() } })).toBe(true);
  });

  it("uses current local settings, sends only the checked outbound text, and clears private state after fill", async () => {
    mountPanel();
    const gateway = createGateway();
    const controller = new SidePanelController(document, gateway, createSettingsStore());
    const draft = byId<HTMLTextAreaElement>("draft-input");
    const preview = byId<HTMLElement>("outbound-preview");
    const fillButton = byId<HTMLButtonElement>("fill-button");

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(preview.textContent).toBe("请联系 [[PHONE_001]]");
    expect(fillButton.disabled).toBe(false);

    fillButton.click();
    await vi.waitFor(() => expect(gateway.fillDraft).toHaveBeenCalledTimes(1));

    expect(gateway.fillDraft).toHaveBeenCalledWith({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "doubao",
      tabId: 42,
      bindingKey: "a".repeat(36),
    });
    expect(draft.value).toBe("");
    expect(preview.textContent).toBe("");
    expect(byId<HTMLElement>("result-status").textContent).toContain("已填入网页");
  });

  it("anonymizes a high-risk secret instead of exposing the draft to the page", async () => {
    mountPanel();
    const gateway = createGateway();
    const controller = new SidePanelController(document, gateway, createSettingsStore());

    await controller.initialize();
    await checkDraft("sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ");

    const preview = byId<HTMLElement>("outbound-preview").textContent ?? "";
    expect(preview).toContain("[[");
    expect(preview).not.toContain("sk-proj-");
    expect(byId<HTMLButtonElement>("fill-button").disabled).toBe(false);
  });

  it("does not apply global or site allowlist values in the private composer", async () => {
    mountPanel();
    const settings = createSettingsStore({
      ok: true,
      terms: [],
      mode: "replace",
      allowlistedTerms: ["13800138000"],
      siteAllowlist: [{ value: "13800138000", siteId: "doubao" }],
    });
    const controller = new SidePanelController(document, createGateway(), settings);

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("请联系 [[PHONE_001]]");
    expect(byId<HTMLElement>("result-status").textContent).toContain("不使用白名单放行");
  });

  it("honors an always-block category policy by withholding the fill action", async () => {
    mountPanel();
    const gateway = createGateway();
    const controller = new SidePanelController(document, gateway, createSettingsStore({
      ok: true,
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "phone", action: "block" }],
    }));

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(byId<HTMLButtonElement>("fill-button").disabled).toBe(true);
    expect(byId<HTMLElement>("result-status").textContent).toContain("始终阻止");
    byId<HTMLButtonElement>("fill-button").click();
    expect(gateway.fillDraft).not.toHaveBeenCalled();
  });

  it("labels confirmation-class findings before permitting anonymous fill", async () => {
    mountPanel();
    const gateway = createGateway();
    const controller = new SidePanelController(document, gateway, createSettingsStore({
      ok: true,
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "phone", action: "confirm" }],
    }));

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(byId<HTMLButtonElement>("fill-button").textContent).toBe("确认匿名化填入");
    expect(byId<HTMLElement>("result-status").textContent).toContain("需确认项");
    byId<HTMLButtonElement>("fill-button").click();
    await vi.waitFor(() => expect(gateway.fillDraft).toHaveBeenCalledTimes(1));
    expect(gateway.fillDraft).toHaveBeenCalledWith(expect.objectContaining({ outboundText: "请联系 [[PHONE_001]]" }));
  });

  it("uses configured custom terms and replacement style", async () => {
    mountPanel();
    const controller = new SidePanelController(document, createGateway(), createSettingsStore({
      ok: true,
      terms: [{ value: "青岚项目", group: "project" }],
      mode: "replace",
      replacementStyle: "surrogate",
    }));

    await controller.initialize();
    await checkDraft("请检查青岚项目");

    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("请检查<敏感项-001>");
  });

  it("uses a local neural review result when the private composer requests it", async () => {
    mountPanel();
    const gateway: SidePanelGateway = {
      ...createGateway(),
      reviewDraft: vi.fn().mockResolvedValue([
        { kind: "person_name", start: 3, end: 6, score: 0.9, requiresConfirmation: true },
      ]),
    };
    const controller = new SidePanelController(document, gateway, createSettingsStore({
      ok: true,
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    }));

    await controller.initialize();
    await checkDraft("请联系周妍舒确认");

    expect(gateway.reviewDraft).toHaveBeenCalledWith("请联系周妍舒确认");
    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("请联系[[PERSON_001]]确认");
    expect(byId<HTMLButtonElement>("fill-button").textContent).toBe("确认匿名化填入");
  });

  it("keeps private-composer protection available when the local neural review is unavailable", async () => {
    mountPanel();
    const gateway: SidePanelGateway = {
      ...createGateway(),
      reviewDraft: vi.fn().mockResolvedValue(null),
    };
    const controller = new SidePanelController(document, gateway, createSettingsStore({
      ok: true,
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    }));

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("请联系 [[PHONE_001]]");
    expect(byId<HTMLElement>("result-status").textContent).toContain("本地神经模型未就绪");
  });

  it("fails closed when local protection settings cannot be read", async () => {
    mountPanel();
    const gateway = createGateway();
    const controller = new SidePanelController(document, gateway, createSettingsStore({
      ok: false,
      error: "storage_read_failed",
    }));

    await controller.initialize();
    await checkDraft("请联系 13800138000");

    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("");
    expect(byId<HTMLButtonElement>("fill-button").disabled).toBe(true);
    expect(byId<HTMLElement>("result-status").textContent).toContain("无法读取本地保护设置");
    expect(gateway.fillDraft).not.toHaveBeenCalled();
  });

  it("invalidates a checked outbound text when the active site changes", async () => {
    mountPanel();
    const gateway: SidePanelGateway = {
      getActiveSite: vi.fn()
        .mockResolvedValueOnce(activeTarget("doubao"))
        .mockResolvedValueOnce(activeTarget("doubao"))
        .mockResolvedValueOnce(activeTarget("chatgpt", 43, "b".repeat(36))),
      fillDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new SidePanelController(document, gateway, createSettingsStore());

    await controller.initialize();
    await checkDraft("请联系 13800138000");
    byId<HTMLButtonElement>("fill-button").click();

    await vi.waitFor(() => expect(byId<HTMLElement>("result-status").textContent).toContain("网页已变化"));
    expect(gateway.fillDraft).not.toHaveBeenCalled();
    expect(byId<HTMLButtonElement>("fill-button").disabled).toBe(true);
  });

  it("invalidates a checked outbound text when the same tab receives a new document binding", async () => {
    mountPanel();
    const gateway: SidePanelGateway = {
      getActiveSite: vi.fn()
        .mockResolvedValueOnce(activeTarget("doubao", 42, "a".repeat(36)))
        .mockResolvedValueOnce(activeTarget("doubao", 42, "a".repeat(36)))
        .mockResolvedValueOnce(activeTarget("doubao", 42, "b".repeat(36))),
      fillDraft: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new SidePanelController(document, gateway, createSettingsStore());

    await controller.initialize();
    await checkDraft("请联系 13800138000");
    byId<HTMLButtonElement>("fill-button").click();

    await vi.waitFor(() => expect(byId<HTMLElement>("result-status").textContent).toContain("网页已变化"));
    expect(gateway.fillDraft).not.toHaveBeenCalled();
  });

  it("discloses when no supported detector matched the draft", async () => {
    mountPanel();
    const controller = new SidePanelController(document, createGateway(), createSettingsStore());

    await controller.initialize();
    await checkDraft("请把这段话改得更简洁。");

    expect(byId<HTMLElement>("outbound-preview").textContent).toBe("请把这段话改得更简洁。");
    expect(byId<HTMLElement>("result-status").textContent).toContain("出站文本与草稿相同");
  });

  it("disables filling on an unsupported active page", async () => {
    mountPanel();
    const controller = new SidePanelController(document, createGateway(null), createSettingsStore());

    await controller.initialize();

    expect(byId<HTMLButtonElement>("fill-button").disabled).toBe(true);
    expect(byId<HTMLElement>("site-status").textContent).toContain("当前网页不受支持");
  });

  it("renders Yuanbao's current site label when the gateway reports it", async () => {
    mountPanel();
    const controller = new SidePanelController(document, createGateway("yuanbao"), createSettingsStore());

    await controller.initialize();

    expect(byId<HTMLElement>("site-status").textContent).toContain("元宝网页版");
  });

  it("renders Gemini's current site label when the gateway reports it", async () => {
    mountPanel();
    const controller = new SidePanelController(document, createGateway("gemini"), createSettingsStore());

    await controller.initialize();

    expect(byId<HTMLElement>("site-status").textContent).toContain("Gemini 网页版");
  });
});
