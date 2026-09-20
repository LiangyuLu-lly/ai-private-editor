import { afterEach, describe, expect, it } from "vitest";

import { assessSiteAdapterHealth } from "../src/sites/health.js";

const DOUBAO_URL = new URL("https://www.doubao.com/chat/");
const DEEPSEEK_URL = new URL("https://chat.deepseek.com/");
const YUANBAO_URL = new URL("https://yuanbao.tencent.com/chat/example");
const CHATGPT_URL = new URL("https://chatgpt.com/");
const CLAUDE_URL = new URL("https://claude.ai/new");
const GEMINI_URL = new URL("https://gemini.google.com/app");
const KIMI_URL = new URL("https://www.kimi.com/");
const QWEN_URL = new URL("https://www.qianwen.com/");
const WENXIN_URL = new URL("https://wenxin.baidu.com/");

function appendEditor(): HTMLDivElement {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  return editor;
}

function appendSendControl(): HTMLButtonElement {
  const sendControl = document.createElement("button");
  sendControl.setAttribute("aria-label", "发送");
  document.body.append(sendControl);
  return sendControl;
}

function appendYuanbaoEditor(): HTMLDivElement {
  const editor = document.createElement("div");
  editor.className = "ql-editor ql-blank";
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  return editor;
}

function appendYuanbaoSendControl(): HTMLAnchorElement {
  const sendControl = document.createElement("a");
  sendControl.id = "yuanbao-send-btn";
  sendControl.setAttribute("aria-label", "发送");
  document.body.append(sendControl);
  return sendControl;
}

function appendDeepSeekComposer(): { editor: HTMLTextAreaElement; sendControl: HTMLDivElement } {
  const composer = document.createElement("section");
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("div");

  editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
  sendControl.setAttribute("role", "button");
  sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
  composer.append(editor, sendControl);
  document.body.append(composer);

  return { editor, sendControl };
}

function appendChatGptComposer(): { editor: HTMLDivElement; sendControl: HTMLButtonElement } {
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

  return { editor, sendControl };
}

function appendChatGptLocaleComposer(): { editor: HTMLTextAreaElement; sendControl: HTMLButtonElement } {
  const composer = document.createElement("form");
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("button");

  composer.className = "wm-composer-composer";
  editor.id = "mobile-composer-prompt";
  editor.className = "wm-composer-textarea";
  editor.setAttribute("aria-label", "与 ChatGPT 聊天");
  sendControl.type = "submit";
  sendControl.setAttribute("data-composer-submit", "");
  sendControl.setAttribute("data-send-label", "发送消息");
  sendControl.setAttribute("aria-label", "发送消息");
  composer.append(editor, sendControl);
  document.body.append(composer);

  return { editor, sendControl };
}

function appendClaudeComposer(): { editor: HTMLDivElement; sendControl: HTMLButtonElement } {
  const editor = document.createElement("div");
  const sendControl = document.createElement("button");

  editor.className = "tiptap ProseMirror";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "Write your prompt to Claude");
  sendControl.setAttribute("data-testid", "chat-input-send");
  sendControl.setAttribute("aria-label", "Send message");
  document.body.append(editor, sendControl);

  return { editor, sendControl };
}

function appendGeminiComposer(includeSendControl = true): { editor: HTMLDivElement; sendControl: HTMLButtonElement | null } {
  const composer = document.createElement("div");
  const editor = document.createElement("div");
  const sendHost = document.createElement("gem-icon-button");
  const sendControl = document.createElement("button");

  composer.className = "text-input-field";
  editor.className = "ql-editor ql-blank textarea new-input-ui";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "为 Gemini 输入提示");
  if (includeSendControl) {
    sendHost.className = "send-button";
    sendHost.append(sendControl);
    composer.append(editor, sendHost);
  } else {
    composer.append(editor);
  }
  document.body.append(composer);

  return { editor, sendControl: includeSendControl ? sendControl : null };
}

function appendKimiComposer(): { editor: HTMLDivElement; sendControl: HTMLDivElement } {
  const composer = document.createElement("div");
  const editor = document.createElement("div");
  const action = document.createElement("div");
  const sendControl = document.createElement("div");
  composer.className = "chat-input";
  editor.className = "chat-input-editor";
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  action.className = "chat-editor-action";
  sendControl.className = "send-button-container";
  action.append(sendControl);
  composer.append(editor, action);
  document.body.append(composer);
  return { editor, sendControl };
}

function appendQwenComposer(): { editor: HTMLDivElement; sendControl: HTMLButtonElement } {
  const composer = document.createElement("div");
  const middle = document.createElement("div");
  const measure = document.createElement("div");
  const editor = document.createElement("div");
  const sendControl = document.createElement("button");
  measure.setAttribute("data-testid", "chat-input-content-measure");
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  sendControl.setAttribute("aria-label", "发送消息");
  measure.append(editor);
  middle.append(measure);
  composer.append(middle, sendControl);
  document.body.append(composer);
  return { editor, sendControl };
}

function appendWenxinComposer(): { editor: HTMLTextAreaElement; sendControl: HTMLSpanElement } {
  const root = document.createElement("div");
  const editor = document.createElement("textarea");
  const sendControl = document.createElement("span");
  root.id = "ci-root";
  editor.id = "chat-textarea";
  sendControl.className = "ci-submit-button";
  root.append(editor, sendControl);
  document.body.append(root);
  return { editor, sendControl };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("site adapter health", () => {
  it("leaves an unsupported host outside the verified adapter path", () => {
    expect(assessSiteAdapterHealth(document, new URL("https://example.com/"))).toEqual({ state: "unsupported" });
  });

  it("marks a supported host without an editor as unverified", () => {
    expect(assessSiteAdapterHealth(document, DOUBAO_URL)).toMatchObject({
      state: "unverified",
      adapter: { id: "doubao" },
      reason: "editor_not_found",
    });
  });

  it("stays ready with a null send control when no send button exists yet", () => {
    // 发送按钮不在 DOM 里是**空闲状态**：ChatGPT 空输入时把它换成语音按钮，Gemini 干脆不插入。
    // 判定为失效会连带关掉粘贴拦截、输入时语义检查和侧栏填入，而这三条只需要输入框。
    // 交出 sendControl: null，让 pre-send 在手势那一刻决定能不能动作。
    const editor = appendEditor();

    const result = assessSiteAdapterHealth(document, DOUBAO_URL);

    expect(result).toMatchObject({ state: "ready", adapter: { id: "doubao" } });
    if (result.state !== "ready") {
      throw new Error("Expected the fixture to be healthy");
    }

    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBeNull();
  });

  it("stays ready while the send control is merely disabled, which is the idle state on every site", () => {
    // 反转了先前的期望，理由是先前那条把一个空闲状态当成了失效。
    //
    // 所有 AI 聊天站在输入框为空时都会禁用（或不渲染）发送按钮，所以旧行为让扩展在每个站点、每次
    // 打开页面时都弹"当前页面未验证（发送按钮当前不可用），敏感文本可能按原文发送"并挂橙色警告，先
    // 打几个字才转绿；同时 `state !== "ready"` 还挡住了侧边栏的填入路径，导致刚打开页面时"填入网页"
    // 直接失败。两者都在真实浏览器里复现过。
    //
    // 判断"现在能不能动作"是 pre-send.ts 的事，它在真实发送那一刻独立检查
    // `isSendControlDisabled` 并在不可用时走 warnManualSend()，所以这里放过不会放过任何实际发送。
    appendEditor();
    const sendControl = appendSendControl();
    Object.defineProperty(sendControl, "disabled", { configurable: true, value: true });

    expect(assessSiteAdapterHealth(document, DOUBAO_URL)).toMatchObject({
      state: "ready",
      adapter: { id: "doubao" },
    });
  });

  it("stays ready when the send button carries a real disabled attribute", () => {
    // 上一条用 Object.defineProperty 只设了 JS 属性，**没有**生成 `disabled` 属性节点。
    // 豆包的发送选择器里带 `:not([disabled])`，而 CSS 属性选择器匹配的是属性节点，所以那条 fixture
    // 恰好绕过了这个过滤器，测试全绿而真实豆包依旧报"该页面未验证"。React 给 button 设 disabled 会
    // 反射成属性，因此这里必须用 setAttribute 才是真实形状。
    const editor = appendEditor();
    const sendControl = appendSendControl();
    sendControl.setAttribute("disabled", "");

    const result = assessSiteAdapterHealth(document, DOUBAO_URL);

    expect(result).toMatchObject({ state: "ready", adapter: { id: "doubao" } });
    if (result.state !== "ready") {
      throw new Error("Expected the fixture to be healthy");
    }

    // 输入框和发送按钮都必须被交出来：置灰是空闲状态，不是适配失效。
    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
    // 置灰本身仍要被识别出来，pre-send 靠它决定不派发 click 而是提示手动发送。
    expect(result.adapter.isSendControlDisabled(sendControl)).toBe(true);
  });

  it("stays ready with an empty editor, because that is what a freshly opened page looks like", () => {
    // 直指用户报告的那个现象：什么都不填时提示检测不到输入框，先打几个字才正常。
    const editor = appendEditor();
    const sendControl = appendSendControl();
    sendControl.setAttribute("disabled", "");
    if (editor instanceof HTMLTextAreaElement) {
      editor.value = "";
    }

    const result = assessSiteAdapterHealth(document, DOUBAO_URL);
    expect(result.state).toBe("ready");
    // 编辑器必须被交出来：侧边栏的填入路径要用它，而那条路径此前在这个状态下是坏的。
    expect(result.state === "ready" ? result.editor : null).toBe(editor);
  });

  it("returns the exact verified adapter, editor, and enabled send control", () => {
    const editor = appendEditor();
    const sendControl = appendSendControl();
    const result = assessSiteAdapterHealth(document, DOUBAO_URL);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("Expected the fixture to be healthy");
    }

    expect(result.adapter.id).toBe("doubao");
    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
  });

  it("leaves a Doubao editor and send control in separate composer roots unverified", () => {
    const editorRoot = document.createElement("section");
    const sendRoot = document.createElement("section");
    const editor = document.createElement("textarea");
    const sendControl = document.createElement("button");

    editorRoot.append(editor);
    sendControl.setAttribute("aria-label", "发送");
    sendRoot.append(sendControl);
    document.body.append(editorRoot, sendRoot);

    const result = assessSiteAdapterHealth(document, DOUBAO_URL);

    // 配不上对的发送控件不会被交出来，所以点击这条路依然不可能被接管（pre-send 对 null 的点击一律
    // 返回 false）。但输入框本身是确认过的，粘贴拦截和 Enter 拦截照样挂上。
    expect(result).toMatchObject({ state: "ready", adapter: { id: "doubao" } });
    expect(result.state === "ready" ? result.sendControl : undefined).toBeNull();
  });

  it("returns DeepSeek's observed unique role-button send control", () => {
    const { editor, sendControl } = appendDeepSeekComposer();
    const result = assessSiteAdapterHealth(document, DEEPSEEK_URL);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("Expected the DeepSeek fixture to be healthy");
    }

    expect(result.adapter.id).toBe("deepseek");
    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
  });

  it("does not select a generic search box outside DeepSeek's chat composer", () => {
    const search = document.createElement("textarea");
    const composer = document.createElement("section");
    const editor = document.createElement("textarea");
    const sendControl = document.createElement("div");

    search.setAttribute("placeholder", "搜索历史对话");
    editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
    sendControl.setAttribute("role", "button");
    sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
    composer.append(editor, sendControl);
    document.body.append(search, composer);

    const result = assessSiteAdapterHealth(document, DEEPSEEK_URL);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("Expected the DeepSeek composer to be healthy");
    }

    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
  });

  it("marks a DeepSeek editor and send control from separate roots as unverified", () => {
    const editor = document.createElement("textarea");
    const sendControl = document.createElement("div");

    editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
    sendControl.setAttribute("role", "button");
    sendControl.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
    document.body.append(editor, sendControl);

    expect(assessSiteAdapterHealth(document, DEEPSEEK_URL)).toMatchObject({
      state: "unverified",
      adapter: { id: "deepseek" },
      reason: "composer_root_not_found",
    });
  });

  it("keeps DeepSeek's observed disabled role button ready", () => {
    const { sendControl } = appendDeepSeekComposer();
    sendControl.classList.add("ds-button--disabled");

    const health = assessSiteAdapterHealth(document, DEEPSEEK_URL);

    expect(health).toMatchObject({
      // `ds-button--disabled` 是 DeepSeek 输入框为空时的类，也就是刚打开页面的样子，不是适配失效。
      // 见 src/sites/health.ts 里去掉这道判断的理由。
      state: "ready",
      adapter: { id: "deepseek" },
    });
    if (health.state !== "ready") {
      throw new Error("Expected the DeepSeek composer to be healthy");
    }

    expect(health.adapter.isSendControlDisabled(sendControl)).toBe(true);
  });

  it("keeps the observed disabled Yuanbao public page ready", () => {
    appendYuanbaoEditor();
    const sendControl = appendYuanbaoSendControl();
    sendControl.className = "style__send-btn___RwTm5 style__send-btn--disabled___mhfdQ";

    const health = assessSiteAdapterHealth(document, YUANBAO_URL);

    expect(health).toMatchObject({
      // 未登录的元宝公开页把发送按钮一直置灰，但适配器照样能挂上拦截。
      // 「现在能不能点」由 src/pre-send.ts 的手势处理器判断，health 只回答「能不能挂拦截」。
      state: "ready",
      adapter: { id: "yuanbao" },
    });
    if (health.state !== "ready") {
      throw new Error("Expected the Yuanbao composer to be healthy");
    }

    // 置灰本身仍要被识别出来，pre-send 靠它决定不派发 click 而是提示手动发送。
    expect(health.adapter.isSendControlDisabled(sendControl)).toBe(true);
  });

  it.each([
    ["disabled attribute", (sendControl: HTMLAnchorElement) => sendControl.setAttribute("disabled", "")],
    ["aria-disabled", (sendControl: HTMLAnchorElement) => sendControl.setAttribute("aria-disabled", "true")],
  ])("keeps a Yuanbao send anchor with %s ready", (_label, disable) => {
    appendYuanbaoEditor();
    const sendControl = appendYuanbaoSendControl();
    disable(sendControl);

    const health = assessSiteAdapterHealth(document, YUANBAO_URL);

    expect(health).toMatchObject({
      // 输入框为空时置灰是空闲状态，不是适配失效；发送时机的判断留给 pre-send。
      state: "ready",
      adapter: { id: "yuanbao" },
    });
    if (health.state !== "ready") {
      throw new Error("Expected the Yuanbao composer to be healthy");
    }

    expect(health.adapter.isSendControlDisabled(sendControl)).toBe(true);
  });

  // 下面两条断言的对象是 `isSendControlDisabled` 本身，不是 health 的 state。
  // health 已经不再看发送按钮的可用性（见 src/sites/health.ts），所以断言 state 会恒真、
  // 等于什么都没测；而这两个边界仍然要钉住，因为 pre-send.ts 靠它决定是否派发 click。
  it("treats aria-disabled=false as an enabled Yuanbao send anchor", () => {
    appendYuanbaoEditor();
    const sendControl = appendYuanbaoSendControl();
    sendControl.setAttribute("aria-disabled", "false");

    const health = assessSiteAdapterHealth(document, YUANBAO_URL);
    if (health.state !== "ready") {
      throw new Error("Expected the Yuanbao composer to be healthy");
    }

    expect(health.adapter.isSendControlDisabled(sendControl)).toBe(false);
  });

  it("does not mistake a near-miss Yuanbao class token for the disabled state", () => {
    appendYuanbaoEditor();
    const sendControl = appendYuanbaoSendControl();
    sendControl.className = "style__send-btn--disabledly___mhfdQ";

    const health = assessSiteAdapterHealth(document, YUANBAO_URL);
    if (health.state !== "ready") {
      throw new Error("Expected the Yuanbao composer to be healthy");
    }

    expect(health.adapter.isSendControlDisabled(sendControl)).toBe(false);
  });

  it("leaves an ambiguous Yuanbao editor layout unverified", () => {
    appendYuanbaoEditor();
    appendYuanbaoEditor();
    appendYuanbaoSendControl();

    expect(assessSiteAdapterHealth(document, YUANBAO_URL)).toMatchObject({
      state: "unverified",
      adapter: { id: "yuanbao" },
      reason: "editor_not_found",
    });
  });

  it("refuses to pick a send anchor from an ambiguous Yuanbao layout", () => {
    appendYuanbaoEditor();
    appendYuanbaoSendControl();
    appendYuanbaoSendControl();

    const result = assessSiteAdapterHealth(document, YUANBAO_URL);

    // 两个一模一样的发送锚点分不出哪个是真的，所以一个都不交出来——绝不能去点错的那个。
    expect(result).toMatchObject({ state: "ready", adapter: { id: "yuanbao" } });
    expect(result.state === "ready" ? result.sendControl : undefined).toBeNull();
  });

  it("returns the exact enabled Yuanbao Quill editor and send anchor", () => {
    const editor = appendYuanbaoEditor();
    const sendControl = appendYuanbaoSendControl();
    const result = assessSiteAdapterHealth(document, YUANBAO_URL);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("Expected the Yuanbao fixture to be healthy");
    }

    expect(result.adapter.id).toBe("yuanbao");
    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
  });

  it("stays ready on Gemini's empty composer, before its nested send button appears", () => {
    // 用户报告的现象：打开支持的站点、什么都不填，就提示检测不到输入框。Gemini 是最极端的一种——
    // 空输入时发送按钮根本不在 DOM 里。
    const { editor } = appendGeminiComposer(false);

    const result = assessSiteAdapterHealth(document, GEMINI_URL);

    expect(result).toMatchObject({ state: "ready", adapter: { id: "gemini" } });
    if (result.state !== "ready") {
      throw new Error("Expected the Gemini fixture to be healthy");
    }

    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBeNull();
  });

  it.each([
    ["ChatGPT", CHATGPT_URL, appendChatGptComposer, "chatgpt"],
    ["Claude", CLAUDE_URL, appendClaudeComposer, "claude"],
    ["Gemini", GEMINI_URL, appendGeminiComposer, "gemini"],
    ["Kimi", KIMI_URL, appendKimiComposer, "kimi"],
    ["Qwen", QWEN_URL, appendQwenComposer, "qwen"],
    ["Wenxin", WENXIN_URL, appendWenxinComposer, "wenxin"],
  ] as const)("returns the exact enabled %s composer", (_name, url, appendComposer, expectedSite) => {
    const { editor, sendControl } = appendComposer();
    const result = assessSiteAdapterHealth(document, url);

    expect(result.state).toBe("ready");
    if (result.state !== "ready") {
      throw new Error("Expected the fixture to be healthy");
    }

    expect(result.adapter.id).toBe(expectedSite);
    expect(result.editor).toBe(editor);
    expect(result.sendControl).toBe(sendControl);
  });

  it("keeps the qwen send control inside the two-ancestor input component", () => {
    const { editor, sendControl } = appendQwenComposer();
    const ready = assessSiteAdapterHealth(document, QWEN_URL);

    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") {
      throw new Error("Expected the Qwen fixture to be healthy");
    }
    expect(ready.sendControl).toBe(sendControl);

    const measure = editor.closest("[data-testid='chat-input-content-measure']");
    const middle = measure instanceof HTMLElement ? measure.parentElement : null;
    const composer = middle?.parentElement ?? null;
    if (middle === null || composer === null) {
      throw new Error("Expected the Qwen measure element to sit two ancestors below the composer");
    }
    document.body.append(sendControl);

    // Missing send is idle-ready (health.ts). Ancestor walk stops before document.body,
    // so a send sibling of the composer under body is not handed back.
    const loosened = assessSiteAdapterHealth(document, QWEN_URL);
    expect(loosened.state === "ready" ? loosened.sendControl : null).toBeNull();
  });

  it("requires ChatGPT's locale send label instead of any composer submit button", () => {
    const { sendControl } = appendChatGptLocaleComposer();
    const ready = assessSiteAdapterHealth(document, CHATGPT_URL);

    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") {
      throw new Error("Expected the ChatGPT locale fixture to be healthy");
    }
    expect(ready.sendControl).toBe(sendControl);

    sendControl.removeAttribute("data-send-label");

    const loosened = assessSiteAdapterHealth(document, CHATGPT_URL);
    expect(loosened.state === "ready" ? loosened.sendControl : null).toBeNull();
  });

  it("keeps Gemini's send control inside the same text-input-field container", () => {
    const { editor, sendControl } = appendGeminiComposer();
    if (sendControl === null) {
      throw new Error("Expected the Gemini fixture to include a send control");
    }
    const ready = assessSiteAdapterHealth(document, GEMINI_URL);

    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") {
      throw new Error("Expected the Gemini fixture to be healthy");
    }
    expect(ready.sendControl).toBe(sendControl);

    const sendHost = sendControl.parentElement;
    if (sendHost === null || editor.closest(".text-input-field") === null) {
      throw new Error("Expected Gemini's send host to start inside text-input-field");
    }
    document.body.append(sendHost);

    const loosened = assessSiteAdapterHealth(document, GEMINI_URL);
    expect(loosened.state === "ready" ? loosened.sendControl : null).toBeNull();
  });

  it("requires DeepSeek's hashed ds-button classes and a unique matching control", () => {
    const { sendControl } = appendDeepSeekComposer();
    const ready = assessSiteAdapterHealth(document, DEEPSEEK_URL);

    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") {
      throw new Error("Expected the DeepSeek fixture to be healthy");
    }
    expect(ready.sendControl).toBe(sendControl);

    sendControl.className = "ds-button";
    const withoutHashes = assessSiteAdapterHealth(document, DEEPSEEK_URL);
    expect(withoutHashes.state === "ready" ? withoutHashes.sendControl : null).toBeNull();

    document.body.replaceChildren();
    const duplicate = appendDeepSeekComposer();
    const twin = document.createElement("div");
    twin.setAttribute("role", "button");
    twin.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
    duplicate.sendControl.parentElement?.append(twin);

    const ambiguous = assessSiteAdapterHealth(document, DEEPSEEK_URL);
    expect(ambiguous.state === "ready" ? ambiguous.sendControl : null).toBeNull();
  });
});
