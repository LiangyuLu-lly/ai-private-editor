import { afterEach, describe, expect, it, vi } from "vitest";

import { createPasteGuard } from "../src/paste-guard.js";
import type { SemanticReviewGateResult } from "../src/pre-send.js";
import type { AuditEventInput } from "../src/shared/audit-log.js";
import type { CustomTermsSnapshot } from "../src/shared/custom-terms.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";
import type { SensitiveActionDecision } from "../src/shared/types.js";

type HarnessOptions = {
  confirmSensitivePaste?: (findings: readonly import("../src/shared/types.js").RedactionFinding[]) => Promise<SensitiveActionDecision>;
  confirmUnreviewedPaste?: (reason: string) => Promise<boolean>;
  ensureSemanticReview?: (text: string) => Promise<SemanticReviewGateResult>;
  getCustomTermsSnapshot?: () => CustomTermsSnapshot;
  recordAudit?: (event: AuditEventInput) => void;
  semanticReviewProvider?: import("../src/shared/semantic-review.js").SemanticReviewProvider;
};

type Harness = {
  controller: ReturnType<typeof createPasteGuard>;
  editor: HTMLDivElement;
  notify: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

const controllers: ReturnType<typeof createPasteGuard>[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const editor = document.createElement("div");
  const sendControl = document.createElement("button");
  const notify = vi.fn();

  editor.id = "prompt-textarea";
  editor.className = "ProseMirror";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "与 ChatGPT 聊天");
  sendControl.id = "composer-submit-button";
  sendControl.setAttribute("data-testid", "send-button");
  document.body.append(editor, sendControl);

  const controller = createPasteGuard({
    document,
    url: () => new URL("https://chatgpt.com/"),
    notify,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    confirmSensitivePaste: options.confirmSensitivePaste,
    confirmUnreviewedPaste: options.confirmUnreviewedPaste,
    ensureSemanticReview: options.ensureSemanticReview,
    getSemanticReviewProvider: () => options.semanticReviewProvider,
    sessionTokenMap: createSessionTokenMap(),
    recordAudit: options.recordAudit,
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, notify, sendControl };
}

function createGeminiHarness(options: HarnessOptions = {}): Harness {
  const composer = document.createElement("div");
  const editor = document.createElement("div");
  const sendHost = document.createElement("gem-icon-button");
  const sendControl = document.createElement("button");
  const notify = vi.fn();

  composer.className = "text-input-field";
  editor.className = "ql-editor ql-blank textarea new-input-ui";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  sendHost.className = "send-button";
  sendHost.append(sendControl);
  composer.append(editor, sendHost);
  document.body.append(composer);

  const controller = createPasteGuard({
    document,
    url: () => new URL("https://gemini.google.com/app"),
    notify,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    confirmSensitivePaste: options.confirmSensitivePaste,
    sessionTokenMap: createSessionTokenMap(),
    recordAudit: options.recordAudit,
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, notify, sendControl };
}

type DoubaoHarness = {
  controller: ReturnType<typeof createPasteGuard>;
  editor: HTMLTextAreaElement;
  notify: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

function createDoubaoHarness(options: HarnessOptions = {}): DoubaoHarness {
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("button");
  const notify = vi.fn();

  sendControl.setAttribute("aria-label", "发送");
  document.body.append(editor, sendControl);

  const controller = createPasteGuard({
    document,
    url: () => new URL("https://www.doubao.com/chat/"),
    notify,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    confirmSensitivePaste: options.confirmSensitivePaste,
    sessionTokenMap: createSessionTokenMap(),
    recordAudit: options.recordAudit,
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, notify, sendControl };
}

function paste(target: EventTarget, plainText: string, html = ""): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      getData(format: string): string {
        if (format === "text/plain") {
          return plainText;
        }

        return format === "text/html" ? html : "";
      },
    },
  });
  target.dispatchEvent(event);
  return event;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.detach());
  document.body.replaceChildren();
});

describe("paste guard", () => {
  it("replaces plain-text PII before it enters a verified chat editor", () => {
    const { editor, notify } = createHarness();

    editor.textContent = "前缀：";
    const event = paste(editor, "请联系 13800138000");

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("前缀：请联系 [[PHONE_001]]");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化"), "success");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("13800138000"), expect.anything());
  });

  it("replaces plain-text PII before it enters Gemini's observed editor", () => {
    const { editor, notify } = createGeminiHarness();

    const event = paste(editor, "请联系 13800138000");

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化"), "success");
  });

  it("reports only a category count for an enabled local audit after anonymized paste", () => {
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { editor } = createHarness({
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    paste(editor, "请联系 13800138000");

    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "chatgpt",
      operation: "paste",
      outcome: "anonymized",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("leaves rich-text paste on the native page path", () => {
    const { editor, notify } = createHarness();

    const event = paste(editor, "请联系 13800138000", "<strong>请联系 13800138000</strong>");

    expect(event.defaultPrevented).toBe(false);
    expect(editor.textContent).toBe("");
    expect(notify).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before inserting a high-risk plain-text credential", async () => {
    const confirmSensitivePaste = vi.fn(async () => "raw_once" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { editor, notify } = createHarness({
      confirmSensitivePaste,
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    const event = paste(editor, "数据库密码：synthetic-test-password");
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe("数据库密码：synthetic-test-password");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已按确认粘贴原文"), "warning");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "chatgpt",
      operation: "paste",
      outcome: "raw_confirmed",
      findings: [{ kind: "credential", count: 1 }],
    });
  });

  it("requires confirmation before inserting a local statistical semantic candidate", async () => {
    const confirmSensitivePaste = vi.fn(async () => "cancel" as const);
    const { controller: guard, editor } = createHarness({
      confirmSensitivePaste,
      semanticReviewProvider: createLocalStatisticalSemanticProvider(),
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_statistical",
      }),
    });

    const event = paste(editor, "客户王小明会跟进这件事。");
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(editor.textContent).toBe("");
    guard.detach();
  });

  it("requires confirmation for a balanced conversational person candidate even without the optional model", async () => {
    const confirmSensitivePaste = vi.fn(async () => "cancel" as const);
    const { controller: guard, editor } = createHarness({
      confirmSensitivePaste,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
      }),
    });

    const event = paste(editor, "请联系张默言。");
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    guard.detach();
  });

  it("anonymizes a high-risk plain-text credential when confirmation chooses redaction", async () => {
    const confirmSensitivePaste = vi.fn(async () => "redact" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { editor, notify } = createHarness({
      confirmSensitivePaste,
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    const event = paste(editor, "数据库密码：synthetic-test-password");
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe("数据库密码：[[CREDENTIAL_001]]");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化：凭证 1 项"), "success");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "chatgpt",
      operation: "paste",
      outcome: "anonymized",
      findings: [{ kind: "credential", count: 1 }],
    });
  });

  it("records a policy-blocked paste without storing any pasted value", () => {
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { editor } = createHarness({
      recordAudit,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        auditEnabled: true,
        categoryPolicies: [{ kind: "phone", action: "block" }],
      }),
    });

    paste(editor, "请联系 13800138000");

    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "chatgpt",
      operation: "paste",
      outcome: "blocked",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("honors a chatgpt site overlay while doubao stays on global policy", async () => {
    const overlaySnapshot: CustomTermsSnapshot = {
      state: "ready",
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "phone", action: "replace" }],
      siteCategoryPolicies: [{ siteId: "chatgpt", kind: "phone", action: "confirm" }],
    };
    const confirmSensitivePaste = vi.fn(async () => "cancel" as const);

    const chatgpt = createHarness({
      confirmSensitivePaste,
      getCustomTermsSnapshot: () => overlaySnapshot,
    });
    const chatgptEvent = paste(chatgpt.editor, "请联系 13800138000");
    await flushPromises();

    expect(chatgptEvent.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledTimes(1);
    expect(chatgpt.editor.textContent).toBe("");
    expect(chatgpt.notify).not.toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化"), "success");

    chatgpt.controller.detach();
    document.body.replaceChildren();
    confirmSensitivePaste.mockClear();

    const doubao = createDoubaoHarness({
      confirmSensitivePaste,
      getCustomTermsSnapshot: () => overlaySnapshot,
    });
    const doubaoEvent = paste(doubao.editor, "请联系 13800138000");
    await flushPromises();

    expect(doubaoEvent.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).not.toHaveBeenCalled();
    expect(doubao.editor.value).toBe("请联系 [[PHONE_001]]");
    expect(doubao.notify).toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化"), "success");
  });

  it("keeps a confirmed paste value in the current page session only", async () => {
    const confirmSensitivePaste = vi.fn(async () => "session" as const);
    const { editor } = createHarness({ confirmSensitivePaste });

    const first = paste(editor, "数据库密码：synthetic-test-password");
    await flushPromises();
    editor.textContent = "";
    const second = paste(editor, "数据库密码：synthetic-test-password");

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
    expect(confirmSensitivePaste).toHaveBeenCalledTimes(1);
  });

  it("does not remember a session value when the confirmed paste target changes", async () => {
    let resolveDecision!: (decision: SensitiveActionDecision) => void;
    const confirmSensitivePaste = vi.fn(
      () => new Promise<SensitiveActionDecision>((resolve) => {
        resolveDecision = resolve;
      }),
    );
    const { editor } = createHarness({ confirmSensitivePaste });

    const first = paste(editor, "数据库密码：synthetic-test-password");
    editor.textContent = "页面已变化";
    resolveDecision("session");
    await flushPromises();
    editor.textContent = "";

    const second = paste(editor, "数据库密码：synthetic-test-password");

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(confirmSensitivePaste).toHaveBeenCalledTimes(2);
  });

  it("stops plain-text paste while the local vocabulary is not ready", () => {
    const { editor, notify } = createHarness({ getCustomTermsSnapshot: () => ({ state: "loading" }) });

    const event = paste(editor, "请联系 13800138000");

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("词库正在加载"), "warning");
  });

  it("does not intercept a paste outside the verified editor", () => {
    const { notify } = createHarness();
    const unrelated = document.createElement("textarea");
    document.body.append(unrelated);

    const event = paste(unrelated, "请联系 13800138000");

    expect(event.defaultPrevented).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("still protects a paste when the send control is absent, because pasting never needs it", () => {
    // 反转了先前的期望。粘贴拦截只需要一个已确认的输入框：它把脱敏后的文本插进输入框，从头到尾不碰
    // 发送按钮。先前要求发送按钮同时存在，于是在**每个站点刚打开、输入框为空**的那段时间里粘贴保护
    // 是关着的（ChatGPT 空输入时发送按钮被语音按钮取代，Gemini 根本不渲染）。往空输入框里粘一个手机号
    // 恰恰是最典型的用法，却正好落在保护关闭的窗口里。
    const { editor, notify, sendControl } = createHarness();
    sendControl.remove();

    const event = paste(editor, "请联系 13800138000");

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已在粘贴前匿名化"), "success");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("13800138000"), expect.anything());
  });

  it("does not natively insert unreviewed local_neural clipboard text", async () => {
    let release!: (result: SemanticReviewGateResult) => void;
    const ensureSemanticReview = vi.fn(
      () => new Promise<SemanticReviewGateResult>((resolve) => { release = resolve; }),
    );
    const confirmUnreviewedPaste = vi.fn(async () => false);
    const clipboardText = "今天只讨论接口设计，先整理需求，再安排测试。";
    const neuralSnapshot = (): CustomTermsSnapshot => ({
      state: "ready",
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    });
    const { controller, editor } = createHarness({
      ensureSemanticReview,
      confirmUnreviewedPaste,
      getCustomTermsSnapshot: neuralSnapshot,
    });

    const event = paste(editor, clipboardText);
    expect(event.defaultPrevented).toBe(true);
    expect(ensureSemanticReview).toHaveBeenCalledWith(clipboardText);
    expect(editor.textContent).toBe("");
    expect(confirmUnreviewedPaste).not.toHaveBeenCalled();

    release({ ok: true });
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editor.textContent).toBe(clipboardText);
    expect(confirmUnreviewedPaste).not.toHaveBeenCalled();

    controller.detach();
    document.body.replaceChildren();

    const failedReview = vi.fn(async (): Promise<SemanticReviewGateResult> => ({
      ok: false,
      reason: "本地语义模型暂时不可用或复核未完成",
    }));
    const cancelUnreviewed = vi.fn(async () => false);
    const { controller: cancelController, editor: cancelEditor } = createHarness({
      ensureSemanticReview: failedReview,
      confirmUnreviewedPaste: cancelUnreviewed,
      getCustomTermsSnapshot: neuralSnapshot,
    });
    const cancelEvent = paste(cancelEditor, clipboardText);
    await flushPromises();
    await flushPromises();

    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(cancelUnreviewed).toHaveBeenCalledWith("本地语义模型暂时不可用或复核未完成");
    expect(cancelEditor.textContent).toBe("");

    cancelController.detach();
    document.body.replaceChildren();

    const rawOnceUnreviewed = vi.fn(async () => true);
    const { editor: rawEditor } = createHarness({
      ensureSemanticReview: failedReview,
      confirmUnreviewedPaste: rawOnceUnreviewed,
      getCustomTermsSnapshot: neuralSnapshot,
    });
    const rawEvent = paste(rawEditor, clipboardText);
    await flushPromises();
    await flushPromises();

    expect(rawEvent.defaultPrevented).toBe(true);
    expect(rawOnceUnreviewed).toHaveBeenCalledWith("本地语义模型暂时不可用或复核未完成");
    expect(rawEditor.textContent).toBe(clipboardText);
  });
});
