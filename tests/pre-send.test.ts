import { afterEach, describe, expect, it, vi } from "vitest";

import { createPreSendController } from "../src/pre-send.js";
import type { SemanticReviewGateResult } from "../src/pre-send.js";
import type { AuditEventInput } from "../src/shared/audit-log.js";
import type { CustomTermsSnapshot } from "../src/shared/custom-terms.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";
import type { SensitiveActionDecision } from "../src/shared/types.js";
import { createLocalStatisticalSemanticProvider } from "../src/shared/semantic-review.js";

type Harness = {
  button: HTMLButtonElement;
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLTextAreaElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

type HarnessOptions = {
  afterInput?: (callback: () => void) => void;
  confirmAttachmentSend?: (action: "confirm" | "block") => Promise<boolean>;
  confirmSensitiveSend?: (findings: readonly import("../src/shared/types.js").RedactionFinding[]) => Promise<SensitiveActionDecision>;
  getCustomTermsSnapshot?: () => CustomTermsSnapshot;
  isUserInitiated?: (event: Event) => boolean;
  sessionTokenMap?: ReturnType<typeof createSessionTokenMap>;
  recordAudit?: (event: AuditEventInput) => void;
  semanticReviewProvider?: import("../src/shared/semantic-review.js").SemanticReviewProvider;
  ensureSemanticReview?: (text: string) => Promise<SemanticReviewGateResult>;
  confirmUnreviewedSend?: (reason: string) => Promise<boolean>;
  url?: URL;
};

type YuanbaoHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLDivElement;
  icon: HTMLSpanElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendControl: HTMLAnchorElement;
};

type DeepSeekHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLTextAreaElement;
  icon: HTMLSpanElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendControl: HTMLDivElement;
};

type ChatGptHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLDivElement;
  icon: HTMLSpanElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

type CurrentChatGptHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLTextAreaElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

type FormAttachmentHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLTextAreaElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  sendControl: HTMLDivElement;
};

type ClaudeHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLDivElement;
  icon: HTMLSpanElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

type GeminiHarness = {
  controller: ReturnType<typeof createPreSendController>;
  editor: HTMLDivElement;
  icon: HTMLSpanElement;
  notify: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendControl: HTMLButtonElement;
};

const controllers: ReturnType<typeof createPreSendController>[] = [];

function createHarness(options: HarnessOptions = {}): Harness {
  const editor = document.createElement("textarea");
  const button = document.createElement("button");
  const send = vi.fn();
  const notify = vi.fn();

  button.setAttribute("aria-label", "发送");
  button.addEventListener("click", send);
  document.body.append(editor, button);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://www.doubao.com/chat/"),
    notify,
    confirmAttachmentSend: options.confirmAttachmentSend,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    sessionTokenMap: options.sessionTokenMap,
    recordAudit: options.recordAudit,
    getSemanticReviewProvider: () => options.semanticReviewProvider,
    ensureSemanticReview: options.ensureSemanticReview,
    confirmUnreviewedSend: options.confirmUnreviewedSend,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { button, controller, editor, notify, send };
}

function click(button: HTMLButtonElement): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });

  button.dispatchEvent(event);
  return event;
}

function createYuanbaoHarness(options: HarnessOptions = {}): YuanbaoHarness {
  const editor = document.createElement("div");
  const icon = document.createElement("span");
  const sendControl = document.createElement("a");
  const send = vi.fn();
  const notify = vi.fn();

  editor.className = "ql-editor ql-blank";
  editor.setAttribute("contenteditable", "true");
  sendControl.id = "yuanbao-send-btn";
  sendControl.setAttribute("aria-label", "发送");
  sendControl.append(icon);
  sendControl.addEventListener("click", send);
  document.body.append(editor, sendControl);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://yuanbao.tencent.com/chat/example"),
    notify,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, icon, notify, send, sendControl };
}

function clickAnchor(target: HTMLElement): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });

  target.dispatchEvent(event);
  return event;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeepSeekHarness(options: HarnessOptions = {}): DeepSeekHarness {
  const composer = document.createElement("section");
  const editor = document.createElement("textarea");
  const icon = document.createElement("span");
  const sendControl = document.createElement("div");
  const send = vi.fn();
  const notify = vi.fn();

  editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
  sendControl.setAttribute("role", "button");
  sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
  sendControl.append(icon);
  sendControl.addEventListener("click", send);
  composer.append(editor, sendControl);
  document.body.append(composer);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://chat.deepseek.com/"),
    notify,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, icon, notify, send, sendControl };
}

function createChatGptHarness(options: HarnessOptions = {}): ChatGptHarness {
  const editor = document.createElement("div");
  const icon = document.createElement("span");
  const sendControl = document.createElement("button");
  const send = vi.fn();
  const notify = vi.fn();

  editor.id = "prompt-textarea";
  editor.className = "ProseMirror";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "与 ChatGPT 聊天");
  sendControl.id = "composer-submit-button";
  sendControl.setAttribute("data-testid", "send-button");
  sendControl.append(icon);
  sendControl.addEventListener("click", send);
  document.body.append(editor, sendControl);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://chatgpt.com/"),
    notify,
    confirmAttachmentSend: options.confirmAttachmentSend,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, icon, notify, send, sendControl };
}

function createCurrentChatGptHarness(options: HarnessOptions = {}): CurrentChatGptHarness {
  const composer = document.createElement("form");
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("button");
  const send = vi.fn();
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const notify = vi.fn();

  composer.className = "wm-composer-composer";
  editor.id = "mobile-composer-prompt";
  editor.className = "wm-composer-textarea";
  editor.setAttribute("aria-label", "与 ChatGPT 聊天");
  sendControl.type = "submit";
  sendControl.setAttribute("data-composer-submit", "");
  sendControl.setAttribute("data-send-label", "发送消息");
  sendControl.setAttribute("aria-label", "发送消息");
  sendControl.addEventListener("click", send);
  composer.addEventListener("submit", submit);
  composer.append(editor, sendControl);
  document.body.append(composer);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://chatgpt.com/"),
    notify,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    ensureSemanticReview: options.ensureSemanticReview,
    confirmUnreviewedSend: options.confirmUnreviewedSend,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, notify, send, submit, sendControl };
}

function createFormAttachmentHarness(options: HarnessOptions = {}): FormAttachmentHarness {
  const composer = document.createElement("form");
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("div");
  const send = vi.fn(() => composer.requestSubmit());
  const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
  const notify = vi.fn();

  editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
  sendControl.setAttribute("role", "button");
  sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
  composer.addEventListener("submit", submit);
  sendControl.addEventListener("click", send);
  composer.append(editor, sendControl);
  document.body.append(composer);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://chat.deepseek.com/"),
    notify,
    confirmAttachmentSend: options.confirmAttachmentSend,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, notify, send, submit, sendControl };
}

function createClaudeHarness(options: HarnessOptions = {}): ClaudeHarness {
  const editor = document.createElement("div");
  const icon = document.createElement("span");
  const sendControl = document.createElement("button");
  const send = vi.fn();
  const notify = vi.fn();

  editor.className = "tiptap ProseMirror";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "Write your prompt to Claude");
  sendControl.setAttribute("data-testid", "chat-input-send");
  sendControl.setAttribute("aria-label", "Send message");
  sendControl.append(icon);
  sendControl.addEventListener("click", send);
  document.body.append(editor, sendControl);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://claude.ai/new"),
    notify,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, icon, notify, send, sendControl };
}

function createGeminiHarness(options: HarnessOptions = {}): GeminiHarness {
  const composer = document.createElement("div");
  const editor = document.createElement("div");
  const sendHost = document.createElement("gem-icon-button");
  const icon = document.createElement("span");
  const sendControl = document.createElement("button");
  const send = vi.fn();
  const notify = vi.fn();

  composer.className = "text-input-field";
  editor.className = "ql-editor ql-blank textarea new-input-ui";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "为 Gemini 输入提示");
  sendHost.className = "send-button";
  sendControl.append(icon);
  sendControl.addEventListener("click", send);
  sendHost.append(sendControl);
  composer.append(editor, sendHost);
  document.body.append(composer);

  const controller = createPreSendController({
    document,
    url: () => options.url ?? new URL("https://gemini.google.com/app"),
    notify,
    confirmSensitiveSend: options.confirmSensitiveSend,
    getCustomTermsSnapshot: options.getCustomTermsSnapshot,
    isUserInitiated: options.isUserInitiated ?? (() => true),
    afterInput: options.afterInput ?? ((callback) => callback()),
  });
  controller.attach();
  controllers.push(controller);

  return { controller, editor, icon, notify, send, sendControl };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.detach());
  document.body.replaceChildren();
});

describe("pre-send controller", () => {
  it("replaces PII before replaying ChatGPT's verified send button once", () => {
    const { editor, icon, notify, send } = createChatGptHarness();

    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(icon);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replaces PII before replaying ChatGPT's current authenticated submit button", () => {
    const { editor, notify, send, submit, sendControl } = createCurrentChatGptHarness();

    editor.value = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("allows a confirmed attachment-only form replay through click and submit once", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { editor, send, submit, sendControl } = createFormAttachmentHarness({
      confirmAttachmentSend,
      isUserInitiated: (event) => event.type === "click" && event.target === sendControl,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    sendControl.parentElement?.append(attachment);
    const event = clickAnchor(sendControl);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmAttachmentSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("");
  });

  it("redacts sensitive text before a confirmed attachment form replay", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { editor, send, submit, sendControl } = createFormAttachmentHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    sendControl.parentElement?.append(attachment);
    editor.value = "请联系 13800138000";
    const event = clickAnchor(sendControl);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmAttachmentSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("clears the attachment replay bypass after a non-form replay", async () => {
    let initialEvent: MouseEvent | null = null;
    const confirmAttachmentSend = vi.fn(async () => true);
    const { button, send } = createHarness({
      confirmAttachmentSend,
      isUserInitiated: (event) => event === initialEvent,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);
    initialEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(initialEvent);
    await flushPromises();
    await flushPromises();

    const secondEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(secondEvent);

    expect(confirmAttachmentSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(secondEvent.defaultPrevented).toBe(true);
  });

  it("clears attachment approval when the replay control does not dispatch a click", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { button, send } = createHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);
    button.click = vi.fn();
    click(button);
    await flushPromises();
    await flushPromises();
    const retry = click(button);
    await flushPromises();

    expect(confirmAttachmentSend).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
    expect(retry.defaultPrevented).toBe(true);
  });

  it("replays Claude's verified send button after normal Enter", () => {
    const { editor, notify, send } = createClaudeHarness();

    editor.textContent = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replaces PII before replaying Gemini's composer-local send button once", () => {
    const { editor, icon, notify, send } = createGeminiHarness();

    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(icon);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replays Gemini's verified send button after normal Enter", () => {
    const { editor, notify, send } = createGeminiHarness();

    editor.textContent = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replaces PII before replaying DeepSeek's verified role button once", () => {
    const { editor, icon, notify, send } = createDeepSeekHarness();

    editor.value = "请联系 13800138000";
    const event = clickAnchor(icon);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replays DeepSeek's verified role button after normal Enter", () => {
    const { editor, notify, send } = createDeepSeekHarness();

    editor.value = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("leaves DeepSeek's disabled role button on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { editor, notify, send, sendControl } = createDeepSeekHarness({ getCustomTermsSnapshot });

    sendControl.classList.add("ds-button--disabled");
    editor.value = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("replaces PII before replaying a verified Yuanbao send anchor once", () => {
    const { editor, icon, notify, send } = createYuanbaoHarness();

    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(icon);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("replays the verified Yuanbao send anchor after normal Enter", () => {
    const { editor, notify, send } = createYuanbaoHarness();

    editor.textContent = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("leaves a disabled Yuanbao send anchor on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { editor, notify, send, sendControl } = createYuanbaoHarness({ getCustomTermsSnapshot });

    sendControl.className = "style__send-btn___RwTm5 style__send-btn--disabled___mhfdQ";
    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.textContent).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled attribute", (sendControl: HTMLAnchorElement) => sendControl.setAttribute("disabled", "")],
    ["aria-disabled", (sendControl: HTMLAnchorElement) => sendControl.setAttribute("aria-disabled", "true")],
  ])("leaves a Yuanbao anchor with %s on the native path", (_label, disable) => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { editor, notify, send, sendControl } = createYuanbaoHarness({ getCustomTermsSnapshot });

    disable(sendControl);
    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.textContent).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("redacts through a Yuanbao anchor with aria-disabled=false", () => {
    const { editor, notify, send, sendControl } = createYuanbaoHarness();

    sendControl.setAttribute("aria-disabled", "false");
    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("redacts through a Yuanbao anchor with a near-miss disabled class", () => {
    const { editor, notify, send, sendControl } = createYuanbaoHarness();

    sendControl.className = "style__send-btn--disabledly___mhfdQ";
    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("leaves an ambiguous Yuanbao editor layout on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { editor, notify, send, sendControl } = createYuanbaoHarness({ getCustomTermsSnapshot });
    const secondEditor = document.createElement("div");

    secondEditor.className = "ql-editor";
    secondEditor.setAttribute("contenteditable", "true");
    document.body.prepend(secondEditor);
    editor.textContent = "请联系 13800138000";
    const event = clickAnchor(sendControl);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.textContent).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("still stops an Enter send when the Yuanbao send-anchor layout is ambiguous", () => {
    // 两个一模一样的发送锚点分不出哪个是真的，所以健康检查交出的 sendControl 是 null，点击这条路不可能
    // 被接管。但 Enter 不需要发送按钮，用户按下去是真能发出去的——旧行为在这里完全不拦，原文直接发走。
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { editor, notify, send, sendControl } = createYuanbaoHarness({ getCustomTermsSnapshot });
    const secondSendControl = document.createElement("a");

    secondSendControl.id = "yuanbao-send-btn";
    secondSendControl.setAttribute("aria-label", "发送");
    document.body.append(secondSendControl);
    editor.textContent = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.anything(), "blocked");
    expect(sendControl).not.toBe(secondSendControl);
  });

  it("replaces recognized PII before replaying the verified send button once", () => {
    const { button, editor, notify, send } = createHarness();

    editor.value = "请联系 13800138000，邮箱 li@example.com";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 [[PHONE_001]]，邮箱 [[EMAIL_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("returns to local text redaction after an attachment confirmation", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { button, editor, notify, send } = createHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);
    editor.value = "请联系 13800138000";
    const event = click(button);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmAttachmentSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before an attachment-only send", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { button, editor, send } = createHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);
    const event = click(button);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("");
    expect(confirmAttachmentSend).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not replay an attachment send when its attachment changes during confirmation", async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmAttachmentSend = vi.fn(
      () => new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve;
      }),
    );
    const composer = document.createElement("section");
    const editor = document.createElement("div");
    const action = document.createElement("div");
    const sendControl = document.createElement("div");
    const notify = vi.fn();
    const send = vi.fn();
    const attachment = document.createElement("div");

    composer.className = "chat-input";
    editor.className = "chat-input-editor";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    action.className = "chat-editor-action";
    sendControl.className = "send-button-container";
    attachment.dataset.attachmentId = "first";
    sendControl.addEventListener("click", send);
    action.append(sendControl);
    composer.append(editor, action, attachment);
    document.body.append(composer);
    const controller = createPreSendController({
      document,
      url: () => new URL("https://www.kimi.com/"),
      notify,
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
      isUserInitiated: () => true,
      afterInput: (callback) => callback(),
    });
    controller.attach();
    controllers.push(controller);

    const event = clickAnchor(sendControl);
    const replacement = document.createElement("div");

    replacement.dataset.attachmentId = "replacement";
    attachment.replaceWith(replacement);
    resolveConfirmation?.(true);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("草稿、附件或页面已变化，请重新发送。", "warning");
  });

  it("rechecks a scoped attachment before replaying a redacted draft", async () => {
    let replay: (() => void) | undefined;
    const confirmAttachmentSend = vi.fn(async () => true);
    const composer = document.createElement("section");
    const editor = document.createElement("div");
    const action = document.createElement("div");
    const sendControl = document.createElement("div");
    const attachment = document.createElement("div");
    const notify = vi.fn();
    const send = vi.fn();

    composer.className = "chat-input";
    editor.className = "chat-input-editor";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.textContent = "请联系 13800138000";
    action.className = "chat-editor-action";
    sendControl.className = "send-button-container";
    attachment.dataset.attachmentId = "first";
    sendControl.addEventListener("click", send);
    action.append(sendControl);
    composer.append(editor, action, attachment);
    document.body.append(composer);
    const controller = createPreSendController({
      document,
      url: () => new URL("https://www.kimi.com/"),
      notify,
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
      isUserInitiated: () => true,
      afterInput: (callback) => { replay = callback; },
    });
    controller.attach();
    controllers.push(controller);

    const event = clickAnchor(sendControl);
    await flushPromises();
    await flushPromises();
    const replacement = document.createElement("div");

    replacement.dataset.attachmentId = "replacement";
    attachment.replaceWith(replacement);
    replay?.();

    expect(event.defaultPrevented).toBe(true);
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("附件或页面已变化，未发送。", "warning");
  });

  it("does not replay an attachment send after the controller is detached", async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirmAttachmentSend = vi.fn(
      () => new Promise<boolean>((resolve) => {
        resolveConfirmation = resolve;
      }),
    );
    const { button, controller, send } = createHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "confirm" }),
    });
    const attachment = document.createElement("div");

    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);
    click(button);
    controller.detach();
    resolveConfirmation?.(true);
    await flushPromises();
    await flushPromises();

    expect(send).not.toHaveBeenCalled();
  });

  it("stops an unscanned attachment until an explicit one-time override", async () => {
    const confirmAttachmentSend = vi.fn(async () => true);
    const { button, editor, send } = createHarness({
      confirmAttachmentSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", attachmentAction: "block" }),
    });
    const attachment = document.createElement("div");
    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(attachment);

    editor.value = "普通文本";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmAttachmentSend).toHaveBeenCalledWith("block", true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports only a category count for an enabled local audit after anonymized send", () => {
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { button, editor } = createHarness({
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    editor.value = "请联系 13800138000";
    click(button);

    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "anonymized",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("reuses a session token across two verified send gestures", () => {
    const { button, editor, send } = createHarness({ sessionTokenMap: createSessionTokenMap() });

    editor.value = "请联系 13800138000";
    click(button);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");

    editor.value = "再次联系 13800138000，并联系 13900139000";
    click(button);

    expect(editor.value).toBe("再次联系 [[PHONE_001]]，并联系 [[PHONE_002]]");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not reserve a session token when strict mode blocks the send", () => {
    const sessionTokenMap = createSessionTokenMap();
    let mode: "replace" | "block" = "block";
    const { button, editor, send } = createHarness({
      sessionTokenMap,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode }),
    });

    editor.value = "请联系 13800138000";
    click(button);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();

    mode = "replace";
    editor.value = "请联系 13800138000";
    click(button);

    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("blocks a second untrusted send click after the controller replay", () => {
    let initialClick: Event | null = null;
    const { button, editor, send } = createHarness({
      isUserInitiated: (event) => event === initialClick,
    });

    editor.value = "请联系 13800138000";
    initialClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(initialClick);
    button.click();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("blocks a high-risk credential before strict mode without changing the editor or sending", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "block" }),
    });

    editor.value = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toContain("sk-proj-");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已阻止发送：严格模式检测到敏感信息。", "blocked");
  });

  it("blocks an explicitly labeled password before it reaches the verified send control", () => {
    const { button, editor, notify, send } = createHarness();

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("数据库密码：synthetic-test-password");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已停止发送：检测到需要确认的敏感信息。", "blocked");
  });

  it("uses a category replacement policy to anonymize a credential before replaying send", () => {
    const { button, editor, send } = createHarness({
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        categoryPolicies: [{ kind: "credential", action: "replace" }],
      }),
    });

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("数据库密码：[[CREDENTIAL_001]]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops a category explicitly configured as always blocked without opening a raw-send confirmation", async () => {
    const confirmSensitiveSend = vi.fn(async () => "raw_once" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { button, editor, notify, send } = createHarness({
      confirmSensitiveSend,
      recordAudit,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        categoryPolicies: [{ kind: "phone", action: "block" }],
        auditEnabled: true,
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();
    expect(confirmSensitiveSend).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("始终阻止"), "blocked");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "blocked",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("uses a category confirmation policy before sending a replaceable value raw", async () => {
    const confirmSensitiveSend = vi.fn(async () => "raw_once" as const);
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        categoryPolicies: [{ kind: "phone", action: "confirm" }],
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("honors a chatgpt site overlay while doubao stays on global policy", async () => {
    const overlaySnapshot: CustomTermsSnapshot = {
      state: "ready",
      terms: [],
      mode: "replace",
      categoryPolicies: [{ kind: "phone", action: "replace" }],
      siteCategoryPolicies: [{ siteId: "chatgpt", kind: "phone", action: "confirm" }],
    };
    const confirmSensitiveSend = vi.fn(async () => "cancel" as const);

    const chatgpt = createChatGptHarness({
      confirmSensitiveSend,
      getCustomTermsSnapshot: () => overlaySnapshot,
    });
    chatgpt.editor.textContent = "请联系 13800138000";
    const chatgptEvent = click(chatgpt.sendControl);
    await flushPromises();

    expect(chatgptEvent.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(chatgpt.editor.textContent).toBe("请联系 13800138000");
    expect(chatgpt.send).not.toHaveBeenCalled();

    chatgpt.controller.detach();
    document.body.replaceChildren();
    confirmSensitiveSend.mockClear();

    const doubao = createHarness({
      confirmSensitiveSend,
      getCustomTermsSnapshot: () => overlaySnapshot,
    });
    doubao.editor.value = "请联系 13800138000";
    const doubaoEvent = click(doubao.button);
    await flushPromises();

    expect(doubaoEvent.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).not.toHaveBeenCalled();
    expect(doubao.editor.value).toBe("请联系 [[PHONE_001]]");
    expect(doubao.send).toHaveBeenCalledTimes(1);
  });

  it("shows a confirmation path for a high-risk credential and keeps the draft when cancelled", async () => {
    const confirmSensitiveSend = vi.fn(async () => "cancel" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { button, editor, notify, send } = createHarness({
      confirmSensitiveSend,
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("数据库密码：synthetic-test-password");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已取消发送。", "blocked");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "cancelled",
      findings: [{ kind: "credential", count: 1 }],
    });
  });

  it("anonymizes a high-risk credential after confirmation chooses redaction", async () => {
    const confirmSensitiveSend = vi.fn(async () => "redact" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { button, editor, notify, send } = createHarness({
      confirmSensitiveSend,
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("数据库密码：[[CREDENTIAL_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送：凭证 1 项"), "success");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "anonymized",
      findings: [{ kind: "credential", count: 1 }],
    });
  });

  it("requires confirmation for a local statistical semantic candidate", async () => {
    const confirmSensitiveSend = vi.fn(async () => "cancel" as const);
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      semanticReviewProvider: createLocalStatisticalSemanticProvider(),
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_statistical",
      }),
    });

    editor.value = "客户王小明会跟进这件事。";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(editor.value).toBe("客户王小明会跟进这件事。");
    expect(send).not.toHaveBeenCalled();
  });

  it("requires confirmation for a balanced conversational person candidate even without the optional model", async () => {
    const confirmSensitiveSend = vi.fn(async () => "cancel" as const);
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
      }),
    });

    editor.value = "请联系张默言。";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("stops the native event until the exact final draft has a neural review", async () => {
    let release!: (result: SemanticReviewGateResult) => void;
    const ensureSemanticReview = vi.fn(
      () => new Promise<SemanticReviewGateResult>((resolve) => { release = resolve; }),
    );
    const { button, editor, send } = createHarness({
      ensureSemanticReview,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_neural",
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);
    expect(event.defaultPrevented).toBe(true);
    expect(ensureSemanticReview).toHaveBeenCalledWith("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();
    expect(editor.value).toBe("请联系 13800138000");

    release({ ok: true });
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("shows a live status while neural review is pending and removes it after", async () => {
    const neuralSnapshot = (): CustomTermsSnapshot => ({
      state: "ready",
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    });
    const draft = "今天只讨论接口设计，先整理需求，再安排测试。";

    let release!: (result: SemanticReviewGateResult) => void;
    const { button, editor } = createHarness({
      ensureSemanticReview: () => new Promise<SemanticReviewGateResult>((resolve) => {
        release = resolve;
      }),
      getCustomTermsSnapshot: neuralSnapshot,
    });

    editor.value = draft;
    click(button);

    const pending = document.getElementById("privacy-composer-review-progress");
    expect(pending).not.toBeNull();
    expect(pending?.getAttribute("role")).toBe("status");
    expect(pending?.textContent).toBe("正在本地复核…");
    expect(pending?.textContent).not.toContain(draft);

    release({ ok: true });
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.getElementById("privacy-composer-review-progress")).toBeNull();

    click(button);
    const pendingFail = document.getElementById("privacy-composer-review-progress");
    expect(pendingFail).not.toBeNull();
    expect(pendingFail?.getAttribute("role")).toBe("status");
    expect(pendingFail?.textContent).toBe("正在本地复核…");

    release({ ok: false, reason: "本地语义模型暂时不可用或复核未完成" });
    await flushPromises();
    await flushPromises();
    expect(document.getElementById("privacy-composer-review-progress")).toBeNull();
  });

  it("stops send when the draft changes while neural review is pending", async () => {
    let release!: (result: SemanticReviewGateResult) => void;
    const ensureSemanticReview = vi.fn(
      () => new Promise<SemanticReviewGateResult>((resolve) => { release = resolve; }),
    );
    const { button, editor, send, notify } = createHarness({
      ensureSemanticReview,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_neural",
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);
    expect(event.defaultPrevented).toBe(true);
    expect(ensureSemanticReview).toHaveBeenCalledWith("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();

    editor.value = "改为讨论测试计划";
    release({ ok: true });
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("草稿、页面或发送按钮已变化，请重新发送。", "warning");
  });

  it("stops a second send while neural review is pending", async () => {
    let release!: (result: SemanticReviewGateResult) => void;
    const ensureSemanticReview = vi.fn(
      () => new Promise<SemanticReviewGateResult>((resolve) => { release = resolve; }),
    );
    const { button, editor, send } = createHarness({
      ensureSemanticReview,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_neural",
      }),
    });

    editor.value = "请联系 13800138000";
    const first = click(button);
    expect(first.defaultPrevented).toBe(true);
    expect(ensureSemanticReview).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    const second = click(button);
    expect(second.defaultPrevented).toBe(true);
    expect(ensureSemanticReview).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    release({ ok: true });
    await flushPromises();
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps exact neural review valid through a native submit-button click and form submission", async () => {
    let reviews = 0;
    const { editor, submit, sendControl } = createCurrentChatGptHarness({
      ensureSemanticReview: () => ++reviews === 1
        ? Promise.resolve({ ok: true })
        : new Promise<SemanticReviewGateResult>(() => {}),
      getCustomTermsSnapshot: () => ({
        state: "ready", terms: [], mode: "replace", semanticReview: "local_neural",
      }),
    });
    editor.value = "今天只讨论接口设计，先整理需求，再安排测试。";

    click(sendControl);
    await flushPromises();
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(reviews).toBe(1);
    expect(editor.value).toBe("今天只讨论接口设计，先整理需求，再安排测试。");
  });

  it("rejects a draft changed by the page between reviewed click and form submit", async () => {
    let reviews = 0;
    const { editor, submit, sendControl, notify } = createCurrentChatGptHarness({
      ensureSemanticReview: () => ++reviews === 1
        ? Promise.resolve({ ok: true })
        : new Promise<SemanticReviewGateResult>(() => {}),
      getCustomTermsSnapshot: () => ({
        state: "ready", terms: [], mode: "replace", semanticReview: "local_neural",
      }),
    });
    editor.value = "只讨论接口设计";
    sendControl.addEventListener("click", () => { editor.value = "改为讨论测试计划"; });

    click(sendControl);
    await flushPromises();
    await flushPromises();

    expect(submit).not.toHaveBeenCalled();
    expect(reviews).toBe(1);
    expect(notify).toHaveBeenCalledWith("草稿、页面或发送按钮已变化，请重新发送。", "warning");
  });

  it.each(["click", "submit"] as const)("expires an unobserved reviewed replay before a later untrusted %s", async (gesture) => {
    const initialGesture = new MouseEvent("click", { bubbles: true, cancelable: true });
    let cancelledReplay = false;
    const { editor, sendControl, submit } = createCurrentChatGptHarness({
      isUserInitiated: (event) => event === initialGesture,
      ensureSemanticReview: async () => ({ ok: true }),
      getCustomTermsSnapshot: () => ({
        state: "ready", terms: [], mode: "replace", semanticReview: "local_neural",
      }),
    });
    editor.value = "今天只讨论接口设计。";
    const cancelReplay = (event: Event): void => {
      if (event !== initialGesture && !cancelledReplay) {
        cancelledReplay = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("click", cancelReplay, true);
    try {
      sendControl.dispatchEvent(initialGesture);
      await flushPromises();
      await flushPromises();
      expect(cancelledReplay).toBe(true);
      expect(submit).not.toHaveBeenCalled();

      const laterGesture = gesture === "click"
        ? new MouseEvent("click", { bubbles: true, cancelable: true })
        : new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: sendControl });
      const target = gesture === "click" ? sendControl : sendControl.form!;
      target.dispatchEvent(laterGesture);
      await flushPromises();

      expect(laterGesture.defaultPrevented).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(editor.value).toBe("今天只讨论接口设计。");
    } finally {
      window.removeEventListener("click", cancelReplay, true);
    }
  });

  it("requires an explicit one-time raw-send confirmation when the neural review fails", async () => {
    const confirmUnreviewedSend = vi.fn(async () => true);
    const ensureSemanticReview = vi.fn(async (): Promise<SemanticReviewGateResult> => ({
      ok: false,
      reason: "本地语义模型暂时不可用或复核未完成",
    }));
    const { button, editor, send } = createHarness({
      ensureSemanticReview,
      confirmUnreviewedSend,
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        detectionProfile: "balanced",
        semanticReview: "local_neural",
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmUnreviewedSend).toHaveBeenCalledWith("本地语义模型暂时不可用或复核未完成");
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-reads the editor before a raw-once replayControl click is treated as replay", async () => {
    const confirmUnreviewedSend = vi.fn(async () => true);
    const { editor, submit, sendControl, notify } = createCurrentChatGptHarness({
      confirmUnreviewedSend,
      ensureSemanticReview: async (): Promise<SemanticReviewGateResult> => ({
        ok: false,
        reason: "本地语义模型暂时不可用或复核未完成",
      }),
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        semanticReview: "local_neural",
      }),
    });
    editor.value = "只讨论接口设计";
    sendControl.addEventListener("click", () => { editor.value = "改为讨论测试计划"; });

    click(sendControl);
    await flushPromises();
    await flushPromises();

    expect(submit).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("草稿、页面或发送按钮已变化，请重新发送。", "warning");
    expect(notify).not.toHaveBeenCalledWith("已按确认发送原文。", "warning");
    expect(editor.value).toBe("改为讨论测试计划");
  });

  it("uses the recommended profile when an older snapshot omits advanced fields", async () => {
    const confirmSensitiveSend = vi.fn(async () => "cancel" as const);
    const review = vi.fn(() => [{
      kind: "person_name" as const,
      start: 0,
      end: 3,
      score: 0.9,
      requiresConfirmation: true as const,
    }]);
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      semanticReviewProvider: { review },
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace" }),
    });

    editor.value = "林芷妍请处理";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(review).toHaveBeenCalledWith("林芷妍请处理");
    expect(confirmSensitiveSend).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "person_name", policy: "confirm" }),
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("applies only the matching site's allowlist before detection", () => {
    const { button, editor, send } = createHarness({
      url: new URL("https://www.doubao.com/chat/"),
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        allowlistedTerms: [],
        siteAllowlist: [{ value: "13800138000", siteId: "deepseek" }],
      }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
  });

  it("allows a value from the current site's allowlist to use the native path", () => {
    const { button, editor, send } = createHarness({
      url: new URL("https://www.doubao.com/chat/"),
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [],
        mode: "replace",
        allowlistedTerms: [],
        siteAllowlist: [{ value: "synthetic-test-password", siteId: "doubao", expiresAt: "2099-01-01T00:00:00.000Z" }],
      }),
    });

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("数据库密码：synthetic-test-password");
  });

  it("replays the verified control once with the original draft after an explicit raw confirmation", async () => {
    const confirmSensitiveSend = vi.fn(async () => "raw_once" as const);
    const recordAudit = vi.fn<(event: AuditEventInput) => void>();
    const { button, editor, notify, send } = createHarness({
      confirmSensitiveSend,
      recordAudit,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
    });

    editor.value = "数据库密码：synthetic-test-password";
    const event = click(button);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("数据库密码：synthetic-test-password");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("已按确认发送原文。", "warning");
    expect(recordAudit).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "raw_confirmed",
      findings: [{ kind: "credential", count: 1 }],
    });
  });

  it("remembers confirmed values only for the current page session", async () => {
    const confirmSensitiveSend = vi.fn(async () => "session" as const);
    const { button, editor, send } = createHarness({ confirmSensitiveSend });

    editor.value = "数据库密码：synthetic-test-password";
    click(button);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    editor.value = "数据库密码：synthetic-test-password";
    const secondEvent = click(button);

    expect(secondEvent.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
  });

  it("does not remember a session value when the confirmed draft becomes stale", async () => {
    const confirmSensitiveSend = vi.fn(async () => "session" as const);
    let firstReplay = true;
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      afterInput: (callback) => {
        if (firstReplay) {
          firstReplay = false;
          editor.value = "草稿已变化";
        }
        callback();
      },
    });

    editor.value = "数据库密码：synthetic-test-password";
    click(button);
    await flushPromises();

    editor.value = "数据库密码：synthetic-test-password";
    const secondEvent = click(button);

    expect(secondEvent.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(0);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(2);
  });

  it("does not open a second confirmation while the first decision is pending", async () => {
    let resolveDecision!: (decision: SensitiveActionDecision) => void;
    const confirmSensitiveSend = vi.fn(
      () => new Promise<SensitiveActionDecision>((resolve) => {
        resolveDecision = resolve;
      }),
    );
    const { button, editor, send } = createHarness({ confirmSensitiveSend });

    editor.value = "数据库密码：synthetic-test-password";
    const firstEvent = click(button);
    const secondEvent = click(button);

    expect(firstEvent.defaultPrevented).toBe(true);
    expect(secondEvent.defaultPrevented).toBe(true);
    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    resolveDecision("cancel");
    await flushPromises();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not replay a stale control when the page becomes unverified before confirmation", async () => {
    let resolveDecision!: (decision: SensitiveActionDecision) => void;
    const confirmSensitiveSend = vi.fn(
      () => new Promise<SensitiveActionDecision>((resolve) => {
        resolveDecision = resolve;
      }),
    );
    const { button, editor, notify, send } = createHarness({ confirmSensitiveSend });

    editor.value = "数据库密码：synthetic-test-password";
    click(button);
    button.removeAttribute("aria-label");
    resolveDecision("raw_once");
    await flushPromises();

    expect(send).not.toHaveBeenCalled();
    expect(editor.value).toBe("数据库密码：synthetic-test-password");
    expect(notify).toHaveBeenCalledWith("已替换敏感信息，请手动发送。", "warning");
  });

  it("does not replay a different draft after confirmation was opened", async () => {
    let resolveDecision!: (decision: SensitiveActionDecision) => void;
    const confirmSensitiveSend = vi.fn(
      () => new Promise<SensitiveActionDecision>((resolve) => {
        resolveDecision = resolve;
      }),
    );
    const { button, editor, notify, send } = createHarness({ confirmSensitiveSend });

    editor.value = "数据库密码：synthetic-test-password";
    click(button);
    editor.value = "这是一段后来改过的草稿";
    resolveDecision("raw_once");
    await flushPromises();

    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("草稿已变化，请重新发送。", "warning");
  });

  it("replaces recognized PII when normal Enter is the send gesture", () => {
    const { editor, notify, send } = createHarness();

    editor.value = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("blocks a high-risk credential when normal Enter is the send gesture", () => {
    const { editor, notify, send } = createHarness();

    editor.value = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已停止发送"), "blocked");
  });

  it("leaves unmatched text on the normal site send path", () => {
    const { button, editor, notify, send } = createHarness();

    editor.value = "请把这段无害文本改短。";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请把这段无害文本改短。");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("replaces a ready custom term before replaying the verified send button", () => {
    const { button, editor, send } = createHarness({
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [{ value: "青岚项目", group: "project" }],
        mode: "replace",
      }),
    });

    editor.value = "请整理青岚项目的测试安排。";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请整理[[CUSTOM_001]]的测试安排。");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads one vocabulary snapshot for an eligible nonempty send", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({
      state: "ready",
      terms: [],
      mode: "replace",
    }));
    const { button, editor } = createHarness({ getCustomTermsSnapshot });

    editor.value = "请联系 13800138000";
    click(button);

    expect(getCustomTermsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("blocks a strict-mode custom term without changing the editor or replaying send", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({
        state: "ready",
        terms: [{ value: "青岚项目", group: "project" }],
        mode: "block",
      }),
    });

    editor.value = "请整理青岚项目的测试安排。";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请整理青岚项目的测试安排。");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已阻止发送：严格模式检测到敏感信息。", "blocked");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("已匿名化发送"), "success");
  });

  it("blocks replaceable PII in strict mode without changing the editor or replaying send", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "block" }),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已阻止发送：严格模式检测到敏感信息。", "blocked");
  });

  it("allows a strict-mode replaceable value to be sent raw after confirmation", async () => {
    const confirmSensitiveSend = vi.fn(async () => "raw_once" as const);
    const { button, editor, send } = createHarness({
      confirmSensitiveSend,
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "block" }),
    });

    editor.value = "请联系 13800138000";
    click(button);
    await flushPromises();

    expect(confirmSensitiveSend).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves unmatched strict-mode text on the native send path", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({ state: "ready", terms: [], mode: "block" }),
    });

    editor.value = "请把这段无害文本改短。";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请把这段无害文本改短。");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves an unsupported page on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot,
      url: new URL("https://chatgpt.com/"),
    });

    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("leaves a supported page without an editor on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { button, editor, notify, send } = createHarness({ getCustomTermsSnapshot });

    editor.remove();
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("leaves a supported page without a verified send control on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { button, editor, notify, send } = createHarness({ getCustomTermsSnapshot });

    button.removeAttribute("aria-label");
    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("leaves a disabled supported control on the native path without reading the vocabulary", () => {
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { button, editor, notify, send } = createHarness({ getCustomTermsSnapshot });

    button.disabled = true;
    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(getCustomTermsSnapshot).not.toHaveBeenCalled();
  });

  it("still stops an Enter send when the healthy host exposes no send control", () => {
    // 发送按钮不可解析（这里靠去掉 aria-label 模拟站点改版或空输入时不渲染）时，Enter 仍然要拦。
    // 这是本次修复的核心权衡：健康检查不再因为找不到发送按钮就整体放弃，于是 Enter 这条路多了一层保护，
    // 而点击那条路因为没有可信目标依然不接管。
    const getCustomTermsSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const { button, editor, notify } = createHarness({ getCustomTermsSnapshot });

    button.removeAttribute("aria-label");
    editor.value = "请联系 13800138000";
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请联系 13800138000");
    expect(getCustomTermsSnapshot).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.anything(), "blocked");
  });

  it.each([
    ["loading", "自定义词库正在加载，未发送。请稍后重试。"],
    ["failed", "自定义词库读取失败，未发送。请检查扩展设置后重试。"],
  ] as const)("stops a recognized send while the vocabulary is %s", (state, message) => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({ state }),
    });

    editor.value = "包含任何待发送文本";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("包含任何待发送文本");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(message, "warning");
  });

  it("stops an empty send while the attachment state and vocabulary are both unavailable", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => ({ state: "loading" }),
    });

    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("自定义词库正在加载，未发送。请稍后重试。", "warning");
  });

  it("stops a recognized send when the vocabulary snapshot getter throws", () => {
    const { button, editor, notify, send } = createHarness({
      getCustomTermsSnapshot: () => {
        throw new Error("storage unavailable");
      },
    });

    editor.value = "包含任何待发送文本";
    const event = click(button);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("包含任何待发送文本");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("自定义词库读取失败，未发送。请检查扩展设置后重试。", "warning");
  });

  it("does not treat Shift+Enter, composition, or keyCode 229 as send gestures", () => {
    const { editor, notify, send } = createHarness();

    editor.value = "请联系 13800138000";
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));

    expect(editor.value).toBe("请联系 13800138000");
    expect(send).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("retains token text and warns when health changes after replacement", () => {
    let replayControl: HTMLButtonElement | null = null;
    const { button, editor, notify, send } = createHarness({
      afterInput: (callback) => {
        replayControl?.setAttribute("disabled", "");
        callback();
      },
    });

    replayControl = button;
    editor.value = "请联系 13800138000";
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("已替换敏感信息，请手动发送。", "warning");
  });

  it("blocks a form submission containing the verified editor when it finds a high-risk credential", () => {
    const form = document.createElement("form");
    const editor = document.createElement("textarea");
    const button = document.createElement("button");
    const notify = vi.fn();
    const send = vi.fn();

    button.type = "submit";
    button.setAttribute("aria-label", "发送");
    form.addEventListener("submit", send);
    form.append(editor, button);
    document.body.append(form);

    const controller = createPreSendController({
      document,
      url: () => new URL("https://www.doubao.com/chat/"),
      notify,
      isUserInitiated: () => true,
      afterInput: (callback) => callback(),
    });
    controller.attach();
    controllers.push(controller);
    editor.value = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ";

    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已停止发送"), "blocked");
  });

  it("detaches capture listeners", () => {
    const { button, controller, editor, notify, send } = createHarness();

    controller.detach();
    editor.value = "请联系 13800138000";
    const event = click(button);

    expect(event.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});
