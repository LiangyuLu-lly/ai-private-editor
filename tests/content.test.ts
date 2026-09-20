import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapInlineRedaction,
  CONTENT_BUILD_REVISION,
  createPrivateComposerMessageHandler,
} from "../src/content.js";
import { createPasteGuard } from "../src/paste-guard.js";
import { createSensitiveSendConfirmation } from "../src/sensitive-confirmation.js";
import { assessSiteAdapterHealth } from "../src/sites/health.js";
import type { PreSendController, SemanticReviewGateResult } from "../src/pre-send.js";
import type { AuditLogStore } from "../src/shared/audit-log.js";
import type { CustomTermsCache, CustomTermsSnapshot } from "../src/shared/custom-terms.js";
import type { SessionClearSignal } from "../src/shared/session-clear.js";
import type { RedactionFinding } from "../src/shared/types.js";

const controllers: PreSendController[] = [];
let restoreChrome: (() => void) | undefined;

function track(controller: PreSendController | null): PreSendController | null {
  if (controller !== null) {
    controllers.push(controller);
  }

  return controller;
}

function createStaticCache(initial: CustomTermsSnapshot): CustomTermsCache & {
  setSnapshot(next: CustomTermsSnapshot): void;
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  let snapshot = initial;
  const listeners = new Set<(next: CustomTermsSnapshot) => void>();

  return {
    start: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
    setSnapshot(next) {
      snapshot = next;
      listeners.forEach((listener) => listener(snapshot));
    },
  };
}

function paste(target: EventTarget, plainText: string): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      getData(format: string): string {
        return format === "text/plain" ? plainText : "";
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
  restoreChrome?.();
  restoreChrome = undefined;
});

describe("inline content bootstrap", () => {
  it("accepts only a site-bound outbound text from the private composer", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    const handleMessage = createPrivateComposerMessageHandler(
      document,
      () => new URL("https://www.doubao.com/chat/"),
      "a".repeat(36),
    );

    expect(handleMessage({ type: "PING" })).toEqual({ site: "doubao", bindingKey: "a".repeat(36) });
    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "doubao",
      tabId: 42,
      bindingKey: "a".repeat(36),
    })).toEqual({ ok: true });
    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(editor.value).not.toContain("13800138000");
    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "chatgpt",
      tabId: 42,
      bindingKey: "a".repeat(36),
    })).toEqual({
      ok: false,
      error: "site_changed",
    });
    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "doubao",
      tabId: 42,
      bindingKey: "b".repeat(36),
    })).toEqual({
      ok: false,
      error: "binding_changed",
    });
    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "[[PHONE_001]]",
      site: "doubao",
      tabId: 42,
      bindingKey: "a".repeat(36),
      draft: "原文",
    })).toBeNull();
  });

  it("fills a Gemini composer that has not rendered its send button yet", () => {
    // Gemini 在输入框为空时不渲染发送按钮，因此这里故意只放输入框。
    // 私密编辑器的典型用法就是往空输入框里填，填入路径不能因为发送按钮缺席而失败——
    // 用户看到的正是"检测不到输入框"。填入不发送，出站文本也已在侧边栏脱敏过。
    const editor = document.createElement("div");
    editor.className = "ql-editor textarea new-input-ui";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    document.body.append(editor);

    const geminiUrl = new URL("https://gemini.google.com/app");
    const handleMessage = createPrivateComposerMessageHandler(document, () => geminiUrl, "c".repeat(36));

    // 前提：发送按钮此刻确实不存在，否则这条断言就测不到想测的东西。
    const health = assessSiteAdapterHealth(document, geminiUrl);
    expect(health).toMatchObject({ state: "ready" });
    expect(health.state === "ready" ? health.sendControl : undefined).toBeNull();

    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "gemini",
      tabId: 7,
      bindingKey: "c".repeat(36),
    })).toEqual({ ok: true });
    expect(editor.textContent).toBe("请联系 [[PHONE_001]]");
  });

  it("refuses to fill when the composer itself is missing", () => {
    const handleMessage = createPrivateComposerMessageHandler(
      document,
      () => new URL("https://gemini.google.com/app"),
      "d".repeat(36),
    );

    expect(handleMessage({
      type: "FILL_DRAFT",
      outboundText: "请联系 [[PHONE_001]]",
      site: "gemini",
      tabId: 7,
      bindingKey: "d".repeat(36),
    })).toEqual({ ok: false, error: "editor_not_found" });
  });

  it("keeps a supported page in checking state until loading completes", async () => {
    const ownReadyState = Object.getOwnPropertyDescriptor(document, "readyState");
    let readyState: DocumentReadyState = "loading";
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => readyState,
    });
    const reportedStatuses: unknown[] = [];

    try {
      track(
        bootstrapInlineRedaction({
          document,
          url: new URL("https://www.doubao.com/chat/"),
          reportProtectionStatus: (status) => reportedStatuses.push(status),
        }),
      );
      await Promise.resolve();

      expect(reportedStatuses).toContainEqual({ state: "checking", site: "doubao" });
      expect(reportedStatuses).not.toContainEqual({ state: "unverified", site: "doubao" });

      readyState = "complete";
      window.dispatchEvent(new Event("load"));
      await Promise.resolve();

      expect(reportedStatuses).toContainEqual({ state: "unverified", site: "doubao" });
    } finally {
      if (ownReadyState === undefined) {
        delete (document as { readyState?: DocumentReadyState }).readyState;
      } else {
        Object.defineProperty(document, "readyState", ownReadyState);
      }
    }
  });

  it("answers QUERY_PROTECTION_STATUS with the last reported page state", async () => {
    const listeners: Array<(message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => void> = [];
    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          onMessage: {
            addListener: (listener: (typeof listeners)[number]) => {
              listeners.push(listener);
            },
            removeListener: vi.fn(),
          },
          sendMessage: vi.fn(() => Promise.resolve(undefined)),
        },
      },
    });
    restoreChrome = () => {
      if (originalChrome === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
        return;
      }
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
    };

    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        runtimeBuildRevision: CONTENT_BUILD_REVISION,
      }),
    );
    await flushPromises();

    expect(listeners).toHaveLength(1);
    let response: unknown;
    listeners[0]?.({ type: "QUERY_PROTECTION_STATUS" }, {}, (value) => {
      response = value;
    });
    expect(response).toEqual({ status: { state: "protected", site: "doubao" } });
  });

  it("shows an explicit local warning when a supported page remains unverified", async () => {
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://chatgpt.com/"),
        runtimeBuildRevision: CONTENT_BUILD_REVISION,
      }),
    );
    await flushPromises();

    expect(document.getElementById("privacy-composer-unverified-banner")?.textContent).toContain("可能按原文发送");
  });

  it("keeps an unverified banner until health is ready", async () => {
    const reportedStatuses: unknown[] = [];
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        reportProtectionStatus: (status) => reportedStatuses.push(status),
      }),
    );
    await flushPromises();

    expect(reportedStatuses).toContainEqual({ state: "unverified", site: "doubao" });

    const banner = document.getElementById("privacy-composer-unverified-banner");
    const toast = document.getElementById("privacy-composer-toast");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("敏感文本可能按原文发送");
    expect(banner).not.toBe(toast);

    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    await flushPromises();

    expect(reportedStatuses).toContainEqual({ state: "protected", site: "doubao" });
    expect(document.getElementById("privacy-composer-unverified-banner")).toBeNull();
  });

  it("reports protection only after the supported page exposes a verified editor and send control", async () => {
    const reportedStatuses: unknown[] = [];
    const context = {
      document,
      url: new URL("https://www.doubao.com/chat/"),
      isUserInitiated: () => true,
      afterInput: (callback: () => void) => callback(),
      reportProtectionStatus: (status: unknown) => reportedStatuses.push(status),
    };

    track(bootstrapInlineRedaction(context));

    expect(reportedStatuses).not.toContainEqual({ state: "protected", site: "doubao" });

    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);

    await Promise.resolve();
    await Promise.resolve();

    expect(reportedStatuses).toContainEqual({ state: "protected", site: "doubao" });
  });

  it("renders highlight marks from ranges without copying matched text into dataset", async () => {
    const phone = "13800138000";
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    sendButton.setAttribute("aria-label", "发送");
    editor.value = `请联系 ${phone}`;
    document.body.append(editor, sendButton);

    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
      }),
    );
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();

    const marks = Array.from(document.querySelectorAll<HTMLElement>("[data-kind]"));
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.dataset.kind).toBeDefined();
      expect(mark.dataset.value).toBeUndefined();
    }
    expect(marks.map((mark) => mark.textContent ?? "").join("")).not.toBe(phone);
  });

  it("reports Gemini's empty composer as protected but flags a draft with no send button", async () => {
    const composer = document.createElement("div");
    const editor = document.createElement("div");
    const reportedStatuses: unknown[] = [];

    composer.className = "text-input-field";
    editor.className = "ql-editor ql-blank textarea new-input-ui";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    composer.append(editor);
    document.body.append(composer);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://gemini.google.com/app"),
        reportProtectionStatus: (status) => reportedStatuses.push(status),
      }),
    );
    await flushPromises();

    // 空输入 + 没有发送按钮 = 空闲状态。没有要保护的文本，而粘贴拦截、输入时语义检查和 Enter 拦截
    // 此刻都已经挂上，所以报 protected 不构成虚假承诺。旧行为在这里报未验证，于是每次打开页面都弹一次
    // 假警报，这正是用户报告的缺陷。
    expect(reportedStatuses).toContainEqual({ state: "protected", site: "gemini" });

    // 输入框里有字了，发送按钮却还是找不到 —— 这时点击那条路确实没被验证过（pre-send 对 null 的点击
    // 一律返回 false），继续报 protected 就是假称已保护。必须翻成未验证。
    editor.textContent = "请联系 13800138000";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();

    expect(reportedStatuses.at(-1)).toEqual({ state: "unverified", site: "gemini" });

    const sendHost = document.createElement("gem-icon-button");
    const sendButton = document.createElement("button");
    sendHost.className = "send-button";
    sendHost.append(sendButton);
    composer.append(sendHost);
    await flushPromises();

    expect(reportedStatuses.at(-1)).toEqual({ state: "protected", site: "gemini" });
  });

  it("rechecks the current URL after a supported page soft-navigates to an excluded route", async () => {
    const composer = document.createElement("section");
    const editor = document.createElement("textarea");
    const sendControl = document.createElement("div");
    const send = vi.fn();
    const reportedStatuses: unknown[] = [];
    let currentUrl = new URL("https://chat.deepseek.com/chat/");

    sendControl.setAttribute("role", "button");
    sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
    sendControl.addEventListener("click", send);
    composer.append(editor, sendControl);
    document.body.append(composer);
    track(
      bootstrapInlineRedaction({
        document,
        url: currentUrl,
        getCurrentUrl: () => currentUrl,
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        reportProtectionStatus: (status) => reportedStatuses.push(status),
      }),
    );
    await Promise.resolve();

    expect(reportedStatuses).toContainEqual({ state: "protected", site: "deepseek" });

    currentUrl = new URL("https://chat.deepseek.com/sign_in");
    document.body.append(document.createElement("section"));
    await Promise.resolve();
    await Promise.resolve();

    editor.value = "请联系 13800138000";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sendControl.dispatchEvent(event);

    expect(reportedStatuses).toContainEqual({ state: "unverified", site: "deepseek" });
    expect(event.defaultPrevented).toBe(false);
    expect(editor.value).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("installs the pre-send controller only for a supported chat URL", () => {
    const controller = track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
      }),
    );

    expect(controller).not.toBeNull();
    expect(document.getElementById("privacy-composer-toast")).toBeNull();
    const cache = createStaticCache({
      state: "ready",
      terms: [{ value: "不应读取", group: "other" }],
      mode: "replace",
    });

    expect(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://example.com/"),
        customTermsCache: cache,
      }),
    ).toBeNull();
    expect(cache.start).not.toHaveBeenCalled();
  });

  it("does not protect with a page script from an older extension revision", () => {
    const cache = createStaticCache({ state: "ready", terms: [], mode: "replace" });
    const staleContext = {
      document,
      url: new URL("https://www.doubao.com/chat/"),
      customTermsCache: cache,
      runtimeBuildRevision: "outdated-build",
    };

    const controller = track(bootstrapInlineRedaction(staleContext));

    expect(controller).toBeNull();
    expect(cache.start).not.toHaveBeenCalled();
    expect(document.getElementById("privacy-composer-toast")?.textContent).toContain("规则已更新");
  });

  it("preloads the local cache but leaves an unhealthy Yuanbao send attempt on the native path", () => {
    const editor = document.createElement("div");
    const sendControl = document.createElement("a");
    const send = vi.fn();
    const getSnapshot = vi.fn<() => CustomTermsSnapshot>(() => ({ state: "ready", terms: [], mode: "block" }));
    const cache: CustomTermsCache = {
      start: vi.fn(),
      getSnapshot,
      subscribe: () => () => undefined,
      dispose: vi.fn(),
    };

    editor.className = "ql-editor";
    editor.setAttribute("contenteditable", "true");
    sendControl.id = "yuanbao-send-btn";
    sendControl.setAttribute("aria-label", "发送");
    sendControl.className = "style__send-btn___RwTm5 style__send-btn--disabled___mhfdQ";
    sendControl.addEventListener("click", send);
    document.body.append(editor, sendControl);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://yuanbao.tencent.com/chat/example"),
        customTermsCache: cache,
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
      }),
    );

    editor.textContent = "请联系 13800138000";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sendControl.dispatchEvent(event);

    expect(cache.start).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.textContent).toBe("请联系 13800138000");
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.getElementById("privacy-composer-toast")).toBeNull();
    // 这里原先还断言 getSnapshot 从未被调用。那条断言属于旧模型：置灰的发送控件曾经被判成"适配失效"，
    // 而"失效页面不读词库快照"是一条文档化的隐私边界。现在置灰只是空闲状态，这个页面是**已验证**的
    // （只是这一次手势因为按钮不可用而不接管），读取本地设置快照本身就在职责范围内——回复令牌查看器
    // 就要靠它判断该功能有没有被用户打开。
    //
    // 真正要守住的是"这次被放过的手势没有动过草稿"，那由上面三条断言覆盖：原文未改写、网站自己的发送
    // 照常发生、没有弹任何扩展提示。
  });

  it("renders a non-original success toast after local replacement and replay", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
      }),
    );
    editor.value = "请联系 13800138000";

    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const toast = document.getElementById("privacy-composer-toast");

    expect(editor.value).toBe("请联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    expect(toast?.dataset.state).toBe("success");
    expect(toast?.textContent).toContain("已匿名化发送");
    expect(toast?.textContent).not.toContain("13800138000");
  });

  it("writes a privacy-only audit event through the injected local audit store when the user enabled auditing", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const append = vi.fn();
    const auditLog: Pick<AuditLogStore, "append"> = { append };

    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        auditLog: auditLog as AuditLogStore,
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace", auditEnabled: true }),
      }),
    );
    editor.value = "请联系 13800138000";

    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(append).toHaveBeenCalledWith({
      siteId: "doubao",
      operation: "send",
      outcome: "anonymized",
      findings: [{ kind: "phone", count: 1 }],
    });
  });

  it("keeps token assignments stable across sends in one page document", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
      }),
    );

    editor.value = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.value).toBe("请联系 [[PHONE_001]]");

    editor.value = "请先联系 13900139000，再联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(editor.value).toBe("请先联系 [[PHONE_002]]，再联系 [[PHONE_001]]");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("clears a page's session token map when the local clear signal is received", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    let clearPageSession = (): void => undefined;
    const signal: SessionClearSignal = {
      requestClear: async () => true,
      subscribe(listener) {
        clearPageSession = listener;
        return () => {
          clearPageSession = () => undefined;
        };
      },
    };

    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        sessionClearSignal: signal,
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
      }),
    );

    editor.value = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.value).toContain("[[PHONE_001]]");

    editor.value = "请联系 13900139000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(editor.value).toContain("[[PHONE_002]]");

    clearPageSession();
    expect(document.getElementById("privacy-composer-toast")?.textContent).toContain("已清除当前页面");
    editor.value = "请联系 13900139000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(editor.value).toContain("[[PHONE_001]]");
  });

  it("decorates tokens added by a later assistant reply without exposing the raw value in the DOM", async () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");

    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({
          state: "ready",
          terms: [],
          mode: "replace",
          replyTokenViewerEnabled: true,
        }),
      }),
    );

    editor.value = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const reply = document.createElement("article");
    reply.dataset.privacyAssistantReply = "true";
    reply.textContent = "已记录 [[PHONE_001]]";
    document.body.append(reply);
    await flushPromises();

    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("13800138000");
  });

  it("decorates tokens in a reply that carries no privacy attribute at all", async () => {
    // 上一条测试自己给回复元素加了 data-privacy-assistant-reply，而那是个真实站点根本不会出现的合成
    // 属性——豆包和 DeepSeek 的适配器就是靠它"声明"支持回复令牌查看的。于是功能看着有测试，实际只在
    // ChatGPT（唯一取证过选择器的站点）上成立，用户在其余站点上点不出任何东西。
    //
    // 这里的回复元素不带任何扩展私有标记，就像真实页面那样。装饰改为按扩展自己造的令牌定位，
    // 所以不依赖任何站点私有结构。
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");

    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({
          state: "ready",
          terms: [],
          mode: "replace",
          replyTokenViewerEnabled: true,
        }),
      }),
    );

    editor.value = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const reply = document.createElement("div");
    reply.textContent = "已记录 [[PHONE_001]]";
    document.body.append(reply);
    await flushPromises();

    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();
    expect(document.body.textContent).not.toContain("13800138000");
  });

  it("never decorates a token inside the composer itself", async () => {
    // 装饰是往 DOM 里插元素。插进输入框会破坏用户正在写的草稿和站点自己的输入状态，
    // 所以按令牌定位时必须排除可编辑区域——而输入框里恰恰一定有刚被改写出来的令牌。
    const editor = document.createElement("div");
    const sendButton = document.createElement("button");

    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({
          state: "ready",
          terms: [],
          mode: "replace",
          replyTokenViewerEnabled: true,
        }),
      }),
    );

    editor.textContent = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(editor.textContent).toContain("[[PHONE_001]]");
    expect(editor.querySelector("[data-privacy-token-host]")).toBeNull();
  });

  it("removes reply token controls when a local setting switches away from token output", async () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const cache = createStaticCache({
      state: "ready",
      terms: [],
      mode: "replace",
      replyTokenViewerEnabled: true,
    });

    sendButton.setAttribute("aria-label", "发送");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: cache,
      }),
    );

    editor.value = "请联系 13800138000";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const reply = document.createElement("article");
    reply.dataset.privacyAssistantReply = "true";
    reply.textContent = "已记录 [[PHONE_001]]";
    document.body.append(reply);
    await flushPromises();
    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();

    cache.setSnapshot({
      state: "ready",
      terms: [],
      mode: "replace",
      replacementStyle: "surrogate",
      replyTokenViewerEnabled: false,
    });
    await flushPromises();

    expect(reply.querySelector("[data-privacy-token-host]")).toBeNull();
    expect(reply.textContent).toBe("已记录 [[PHONE_001]]");
  });

  it("uses a ready injected cache for a custom term and disposes it with the controller", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    const cache = createStaticCache({
      state: "ready",
      terms: [{ value: "青岚项目", group: "project" }],
      mode: "replace",
    });
    const controller = track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: cache,
      }),
    );

    editor.value = "青岚项目";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(cache.start).toHaveBeenCalledTimes(1);
    expect(editor.value).toBe("[[CUSTOM_001]]");
    expect(send).toHaveBeenCalledTimes(1);
    controller?.detach();
    controller?.detach();
    expect(cache.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor text and prompts before a strict-mode send", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({
          state: "ready",
          terms: [{ value: "青岚项目", group: "project" }],
          mode: "block",
        }),
      }),
    );
    editor.value = "请整理青岚项目的测试安排。";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sendButton.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(editor.value).toBe("请整理青岚项目的测试安排。");
    expect(send).not.toHaveBeenCalled();
    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("自定义词条 1 项");
  });

  it("blocks through the content integration path while an injected cache is loading", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    const cache = createStaticCache({ state: "loading" });
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: cache,
      }),
    );
    editor.value = "等待词库加载时不应发送";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sendButton.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(document.getElementById("privacy-composer-toast")?.textContent).toContain("词库正在加载");
  });

  it("reads the current cache snapshot for each send gesture", () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    document.body.append(editor, sendButton);
    const cache = createStaticCache({
      state: "ready",
      terms: [{ value: "旧词", group: "other" }],
      mode: "replace",
    });
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: cache,
      }),
    );

    cache.setSnapshot({
      state: "ready",
      terms: [{ value: "新词", group: "other" }],
      mode: "replace",
    });
    editor.value = "新词";
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(editor.value).toBe("[[CUSTOM_001]]");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses a paste-specific confirmation before putting a high-risk value into ChatGPT's verified editor", async () => {
    const editor = document.createElement("div");
    const sendButton = document.createElement("button");

    editor.id = "prompt-textarea";
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "与 ChatGPT 聊天");
    sendButton.id = "composer-submit-button";
    sendButton.setAttribute("data-testid", "send-button");
    document.body.append(editor, sendButton);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://chatgpt.com/"),
        customTermsCache: createStaticCache({ state: "ready", terms: [], mode: "replace" }),
      }),
    );

    const event = paste(editor, "数据库密码：synthetic-test-password");

    expect(event.defaultPrevented).toBe(true);
    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("粘贴前请确认");
    document.querySelector<HTMLButtonElement>('[data-action="redact"]')?.click();
    await flushPromises();

    expect(editor.textContent).toBe("数据库密码：[[CREDENTIAL_001]]");
  });

  it("shows a live status while neural review is pending on paste and removes it after", async () => {
    const clipboardText = "今天只讨论接口设计，先整理需求，再安排测试。";
    const neuralSnapshot = {
      state: "ready" as const,
      terms: [],
      mode: "replace" as const,
      detectionProfile: "balanced" as const,
      semanticReview: "local_neural" as const,
    };

    const mountEditor = (): HTMLDivElement => {
      const editor = document.createElement("div");
      const sendControl = document.createElement("button");
      editor.id = "prompt-textarea";
      editor.className = "ProseMirror";
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("role", "textbox");
      editor.setAttribute("aria-label", "与 ChatGPT 聊天");
      sendControl.id = "composer-submit-button";
      sendControl.setAttribute("data-testid", "send-button");
      document.body.append(editor, sendControl);
      return editor;
    };

    let releaseOk!: (result: SemanticReviewGateResult) => void;
    const okEditor = mountEditor();
    const okGuard = createPasteGuard({
      document,
      url: () => new URL("https://chatgpt.com/"),
      notify: vi.fn(),
      getCustomTermsSnapshot: () => neuralSnapshot,
      ensureSemanticReview: () => new Promise<SemanticReviewGateResult>((resolve) => {
        releaseOk = resolve;
      }),
    });
    okGuard.attach();
    track(okGuard);

    paste(okEditor, clipboardText);
    const pending = document.getElementById("privacy-composer-review-progress");
    expect(pending).not.toBeNull();
    expect(pending?.getAttribute("role")).toBe("status");
    expect(pending?.textContent).toBe("正在本地复核…");
    expect(pending?.textContent).not.toContain(clipboardText);

    releaseOk({ ok: true });
    await flushPromises();
    await flushPromises();
    expect(document.getElementById("privacy-composer-review-progress")).toBeNull();

    okGuard.detach();
    document.body.replaceChildren();

    let releaseFail!: (result: SemanticReviewGateResult) => void;
    const failEditor = mountEditor();
    const failGuard = createPasteGuard({
      document,
      url: () => new URL("https://chatgpt.com/"),
      notify: vi.fn(),
      getCustomTermsSnapshot: () => neuralSnapshot,
      ensureSemanticReview: () => new Promise<SemanticReviewGateResult>((resolve) => {
        releaseFail = resolve;
      }),
    });
    failGuard.attach();
    track(failGuard);

    paste(failEditor, clipboardText);
    const pendingFail = document.getElementById("privacy-composer-review-progress");
    expect(pendingFail).not.toBeNull();
    expect(pendingFail?.getAttribute("role")).toBe("status");
    expect(pendingFail?.textContent).toBe("正在本地复核…");

    releaseFail({ ok: false, reason: "本地语义模型暂时不可用或复核未完成" });
    await flushPromises();
    await flushPromises();
    expect(document.getElementById("privacy-composer-review-progress")).toBeNull();
  });

  it("does not treat a draft as reviewed when local_neural flips off before ensureSemanticReview", async () => {
    const clipboardText = "今天只讨论接口设计，先整理需求，再安排测试。";
    const neuralReady: CustomTermsSnapshot = {
      state: "ready",
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "local_neural",
    };
    const flippedOff: CustomTermsSnapshot = {
      state: "ready",
      terms: [],
      mode: "replace",
      detectionProfile: "balanced",
      semanticReview: "off",
    };
    const cache = createStaticCache(neuralReady);
    const readSnapshot = cache.getSnapshot;
    let armed = false;
    let armedReads = 0;
    cache.getSnapshot = () => {
      if (!armed) {
        return readSnapshot();
      }
      armedReads += 1;
      return armedReads === 1 ? readSnapshot() : flippedOff;
    };

    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    const sendMessage = vi.fn(() => Promise.resolve(undefined));
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime: { sendMessage } },
    });
    restoreChrome = () => {
      if (originalChrome === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
        return;
      }
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
    };

    const confirmUnreviewedPaste = vi.fn(async () => false);
    const editor = document.createElement("div");
    const sendControl = document.createElement("button");
    editor.id = "prompt-textarea";
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "与 ChatGPT 聊天");
    sendControl.id = "composer-submit-button";
    sendControl.setAttribute("data-testid", "send-button");
    document.body.append(editor, sendControl);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://chatgpt.com/"),
        customTermsCache: cache,
        confirmUnreviewedPaste,
      }),
    );
    await flushPromises();

    armed = true;
    armedReads = 0;
    const event = paste(editor, clipboardText);
    await flushPromises();
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(confirmUnreviewedPaste).toHaveBeenCalledWith("本地语义模型未启用");
    expect(editor.textContent).toBe("");
  });

  it("shows a content-free attachment confirmation before a protected send", async () => {
    const editor = document.createElement("textarea");
    const sendButton = document.createElement("button");
    const attachment = document.createElement("div");
    const send = vi.fn();

    sendButton.setAttribute("aria-label", "发送");
    sendButton.addEventListener("click", send);
    attachment.dataset.privacyComposerAttachment = "true";
    document.body.append(editor, sendButton, attachment);
    track(
      bootstrapInlineRedaction({
        document,
        url: new URL("https://www.doubao.com/chat/"),
        isUserInitiated: () => true,
        afterInput: (callback) => callback(),
        customTermsCache: createStaticCache({
          state: "ready",
          terms: [],
          mode: "replace",
          attachmentAction: "confirm",
        }),
      }),
    );

    editor.value = "普通文本";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    sendButton.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("无法核验附件状态");
    expect(document.getElementById("privacy-composer-confirmation")?.textContent).not.toContain("privacyComposerAttachment");
    document.querySelector<HTMLButtonElement>('[data-action="confirm-attachment"]')?.click();
    await flushPromises();
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("sensitive send confirmation", () => {
  const findings: RedactionFinding[] = [
    { kind: "phone", decision: "replace", count: 2 },
    { kind: "credential", decision: "block", count: 1 },
  ];

  it("summarizes categories and counts without exposing raw values", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request(findings);
    const dialog = document.getElementById("privacy-composer-confirmation");

    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.textContent).toContain("手机号 2 项");
    expect(dialog?.textContent).toContain("凭证 1 项");
    expect(dialog?.textContent).toContain("未列出的姓名不会提示");
    expect(dialog?.textContent).not.toContain("synthetic-test-password");

    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(decision).resolves.toBe("cancel");
    expect(document.getElementById("privacy-composer-confirmation")).toBeNull();
    confirmation.dispose();
  });

  it("offers anonymous delivery as the primary confirmation action", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request(findings);
    const dialog = document.getElementById("privacy-composer-confirmation");

    expect(dialog?.textContent).toContain("匿名化版本");
    expect(document.querySelector<HTMLButtonElement>('[data-action="redact"]')?.textContent).toBe("匿名化发送");
    document.querySelector<HTMLButtonElement>('[data-action="redact"]')?.click();

    await expect(decision).resolves.toBe("redact");
    confirmation.dispose();
  });

  it("resolves raw_once only when the raw-send action is explicitly confirmed", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request(findings);
    let settled = false;
    void decision.then(() => {
      settled = true;
    });

    document.querySelector<HTMLButtonElement>('[data-action="raw-once"]')?.click();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-action="raw-once"]')?.textContent).toContain("再点一次");
    document.querySelector<HTMLButtonElement>('[data-action="raw-once"]')?.click();

    await expect(decision).resolves.toBe("raw_once");
    expect(document.getElementById("privacy-composer-confirmation")).toBeNull();
    confirmation.dispose();
  });

  it("shows safe field labels when the detector provides them", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request([
      { kind: "credential", decision: "block", count: 1, labels: ["数据库密码"] },
    ]);

    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("数据库密码");
    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("凭证");
    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(decision).resolves.toBe("cancel");
    confirmation.dispose();
  });

  it("identifies a confirmation-only local semantic candidate without exposing its source text", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request([
      { kind: "person_name", decision: "replace", count: 1, policy: "confirm", inferred: true },
    ]);

    const dialog = document.getElementById("privacy-composer-confirmation");
    expect(dialog?.textContent).toContain("本地语义候选");
    expect(dialog?.textContent).not.toContain("张默言");
    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(decision).resolves.toBe("cancel");
    confirmation.dispose();
  });

  it("warns that an oversized credential was fully anonymized without exposing any value", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request([
      { kind: "credential", decision: "block", count: 1, warning: "credential_too_long" },
    ]);

    const text = document.getElementById("privacy-composer-confirmation")?.textContent ?? "";
    expect(text).toContain("值过长");
    expect(text).toContain("完整匿名化");
    expect(text).not.toContain("synthetic-oversized-secret");
    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(decision).resolves.toBe("cancel");
    confirmation.dispose();
  });

  it("supports a session-only allow decision without persisting the value", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request([
      { kind: "phone", decision: "replace", count: 1 },
    ]);

    document.querySelector<HTMLButtonElement>('[data-action="confirm-session"]')?.click();

    await expect(decision).resolves.toBe("session");
    confirmation.dispose();
  });

  it("uses paste-specific labels when raw text needs paste confirmation", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.request(findings, "paste");

    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("粘贴前请确认");
    expect(document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.textContent).toBe("取消粘贴");
    expect(document.querySelector<HTMLButtonElement>('[data-action="confirm-session"]')?.textContent).toBe("本会话允许并粘贴");
    expect(document.querySelector<HTMLButtonElement>('[data-action="redact"]')?.textContent).toBe("匿名化粘贴");
    expect(document.querySelector<HTMLButtonElement>('[data-action="raw-once"]')?.textContent).toBe("仅本次粘贴原文");
    document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

    await expect(decision).resolves.toBe("cancel");
    confirmation.dispose();
  });

  it("uses a content-free attachment confirmation without a session allow option", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const decision = confirmation.requestAttachment();

    expect(document.getElementById("privacy-composer-confirmation")?.textContent).toContain("文件内容未被读取");
    expect(document.querySelector('[data-action="confirm-session"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-action="confirm-attachment"]')?.click();

    await expect(decision).resolves.toBe(true);
    confirmation.dispose();
  });

  it("treats Escape as cancellation and does not create duplicate dialogs", async () => {
    const confirmation = createSensitiveSendConfirmation(document);
    const first = confirmation.request(findings);
    const second = confirmation.request(findings);

    expect(document.querySelectorAll("#privacy-composer-confirmation")).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await expect(first).resolves.toBe("cancel");
    await expect(second).resolves.toBe("cancel");
    confirmation.dispose();
  });
});
