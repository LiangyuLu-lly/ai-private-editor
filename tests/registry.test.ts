import { describe, expect, it } from "vitest";

import { getRegisteredSiteAdapters, getSiteAdapter } from "../src/sites/registry.js";

function dispatchKeyboardGesture(
  target: EventTarget,
  event: KeyboardEvent,
  callback: (event: KeyboardEvent) => boolean | undefined,
): boolean | undefined {
  let result: boolean | undefined;

  target.addEventListener("keydown", (receivedEvent) => {
    result = callback(receivedEvent as KeyboardEvent);
  }, { once: true });
  target.dispatchEvent(event);
  return result;
}

describe("site adapter registry", () => {
  it("recognizes only a verified send button and normal Enter from the chat editor", () => {
    const adapter = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const editor = document.createElement("div");
    const editorChild = document.createElement("span");
    const send = document.createElement("button");
    const unrelated = document.createElement("button");

    editor.setAttribute("contenteditable", "true");
    editor.append(editorChild);
    send.setAttribute("aria-label", "发送");
    document.body.append(editor, unrelated, send);

    expect(adapter?.findSendControl(document, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, document, editor)).toBe(true);
    expect(adapter?.isSendControlTarget(unrelated, document, editor)).toBe(false);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, keyCode: 229 }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
    expect(
      dispatchKeyboardGesture(document.body, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
    expect(
      dispatchKeyboardGesture(editorChild, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
  });

  it("prefers the Doubao editor paired with its send control over a search textarea", () => {
    const adapter = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const page = document.implementation.createHTMLDocument();
    const search = page.createElement("textarea");
    const composer = page.createElement("section");
    const editor = page.createElement("textarea");
    const send = page.createElement("button");

    search.setAttribute("placeholder", "搜索历史对话");
    editor.setAttribute("placeholder", "发消息");
    editor.setAttribute("contenteditable", "true");
    send.id = "flow-end-msg-send";
    composer.append(editor, send);
    page.body.append(search, composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
  });

  it("pairs a Doubao send control with the editor in the same composer root", () => {
    const adapter = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("section");
    const editor = page.createElement("textarea");
    const send = page.createElement("button");
    const unrelatedSend = page.createElement("button");

    editor.setAttribute("contenteditable", "true");
    send.id = "flow-end-msg-send";
    unrelatedSend.setAttribute("aria-label", "发送");
    composer.append(editor, send);
    page.body.append(unrelatedSend, composer);

    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
    expect(adapter?.isSendControlTarget(unrelatedSend, page, editor)).toBe(false);
  });

  it("matches only the supported chat hosts", () => {
    expect(getSiteAdapter(new URL("https://www.doubao.com/chat/"))?.id).toBe("doubao");
    expect(getSiteAdapter(new URL("https://doubao.com/"))?.id).toBe("doubao");
    expect(getSiteAdapter(new URL("https://chat.deepseek.com/"))?.id).toBe("deepseek");
    expect(getSiteAdapter(new URL("https://yuanbao.tencent.com/chat/example"))?.id).toBe("yuanbao");
    expect(getSiteAdapter(new URL("https://chatgpt.com/"))?.id).toBe("chatgpt");
    expect(getSiteAdapter(new URL("https://claude.ai/new"))?.id).toBe("claude");
    expect(getSiteAdapter(new URL("https://gemini.google.com/app"))?.id).toBe("gemini");
    expect(getSiteAdapter(new URL("https://www.kimi.com/"))?.id).toBe("kimi");
    expect(getSiteAdapter(new URL("https://www.qianwen.com/"))?.id).toBe("qwen");
    expect(getSiteAdapter(new URL("https://yiyan.baidu.com/"))?.id).toBe("wenxin");
    expect(getSiteAdapter(new URL("https://wenxin.baidu.com/"))?.id).toBe("wenxin");
  });

  it("recognizes DeepSeek's unique role-button control and its icon", () => {
    const adapter = getSiteAdapter(new URL("https://chat.deepseek.com/"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("textarea");
    const send = page.createElement("div");
    const icon = page.createElement("span");

    editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
    send.setAttribute("role", "button");
    send.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
    send.append(icon);
    page.body.append(editor, send);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
  });

  it("leaves an ambiguous DeepSeek role-button layout unverified", () => {
    const adapter = getSiteAdapter(new URL("https://chat.deepseek.com/"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("textarea");

    editor.setAttribute("placeholder", "给 DeepSeek 发送消息 ");
    for (let index = 0; index < 2; index += 1) {
      const send = page.createElement("div");
      send.setAttribute("role", "button");
      send.className = "ds-button ds-button--primary ds-button--filled ds-button--circle";
      page.body.append(send);
    }
    page.body.prepend(editor);

    expect(adapter?.findSendControl(page, editor)).toBeNull();
  });

  it("recognizes Yuanbao's verified Quill editor and exact send anchor", () => {
    const adapter = getSiteAdapter(new URL("https://yuanbao.tencent.com/chat/example"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const send = page.createElement("a");
    const icon = page.createElement("span");

    editor.className = "ql-editor ql-blank";
    editor.setAttribute("contenteditable", "true");
    send.id = "yuanbao-send-btn";
    send.setAttribute("aria-label", "发送");
    send.append(icon);
    page.body.append(editor, send);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(false);
  });

  it("rejects Yuanbao lookalikes and malformed send controls", () => {
    const adapter = getSiteAdapter(new URL("https://yuanbao.tencent.com/chat/example"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const nonAnchor = page.createElement("div");
    const missingName = page.createElement("a");

    editor.className = "ql-editor";
    editor.setAttribute("contenteditable", "true");
    nonAnchor.id = "yuanbao-send-btn";
    nonAnchor.setAttribute("aria-label", "发送");
    missingName.id = "yuanbao-send-btn";
    page.body.append(editor, nonAnchor, missingName);

    expect(adapter?.findSendControl(page, editor)).toBeNull();
    expect(getSiteAdapter(new URL("https://yuanbao.tencent.com.example.com/chat/example"))).toBeNull();
    expect(getSiteAdapter(new URL("http://yuanbao.tencent.com/chat/example"))).toBeNull();
  });

  it("rejects an ambiguous Yuanbao layout with multiple Quill editors", () => {
    const adapter = getSiteAdapter(new URL("https://yuanbao.tencent.com/chat/example"));
    const page = document.implementation.createHTMLDocument();
    const firstEditor = page.createElement("div");
    const secondEditor = page.createElement("div");

    firstEditor.className = "ql-editor";
    firstEditor.setAttribute("contenteditable", "true");
    secondEditor.className = "ql-editor";
    secondEditor.setAttribute("contenteditable", "true");
    page.body.append(firstEditor, secondEditor);

    expect(adapter?.findEditor(page)).toBeNull();
  });

  it("rejects an ambiguous Yuanbao layout with multiple exact send anchors", () => {
    const adapter = getSiteAdapter(new URL("https://yuanbao.tencent.com/chat/example"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const firstSend = page.createElement("a");
    const secondSend = page.createElement("a");

    editor.className = "ql-editor";
    editor.setAttribute("contenteditable", "true");
    for (const send of [firstSend, secondSend]) {
      send.id = "yuanbao-send-btn";
      send.setAttribute("aria-label", "发送");
    }
    page.body.append(editor, firstSend, secondSend);

    expect(adapter?.findSendControl(page, editor)).toBeNull();
  });

  it("exposes exact manifest patterns for every registered adapter", () => {
    expect(getRegisteredSiteAdapters().flatMap((adapter) => adapter.matchPatterns)).toEqual([
      "https://www.doubao.com/*",
      "https://doubao.com/*",
      "https://chat.deepseek.com/*",
      "https://yuanbao.tencent.com/*",
      "https://chatgpt.com/*",
      "https://claude.ai/*",
      "https://gemini.google.com/*",
      "https://www.kimi.com/*",
      "https://www.qianwen.com/*",
      "https://yiyan.baidu.com/*",
      "https://wenxin.baidu.com/*",
    ]);
  });

  it("keeps nine adapters covering eleven hosts, including unverified sites", () => {
    const adapters = getRegisteredSiteAdapters();
    const patterns = adapters.flatMap((adapter) => adapter.matchPatterns);

    expect(adapters).toHaveLength(9);
    expect(patterns).toHaveLength(11);
    expect(new Set(adapters.map((adapter) => adapter.id))).toEqual(new Set([
      "doubao",
      "deepseek",
      "yuanbao",
      "chatgpt",
      "claude",
      "gemini",
      "kimi",
      "qwen",
      "wenxin",
    ]));

    for (const [url, id] of [
      ["https://yuanbao.tencent.com/chat/example", "yuanbao"],
      ["https://claude.ai/new", "claude"],
      ["https://www.kimi.com/", "kimi"],
      ["https://www.qianwen.com/", "qwen"],
      ["https://yiyan.baidu.com/", "wenxin"],
      ["https://wenxin.baidu.com/", "wenxin"],
    ] as const) {
      expect(getSiteAdapter(new URL(url))?.id).toBe(id);
    }
  });

  it("recognizes ChatGPT's observed ProseMirror composer and exact send button", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const send = page.createElement("button");
    const icon = page.createElement("span");

    editor.id = "prompt-textarea";
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "与 ChatGPT 聊天");
    send.id = "composer-submit-button";
    send.setAttribute("data-testid", "send-button");
    send.append(icon);
    page.body.append(editor, send);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
  });

  it("recognizes ChatGPT's current authenticated textarea composer and scoped submit button", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("form");
    const editor = page.createElement("textarea");
    const send = page.createElement("button");
    const icon = page.createElement("span");

    composer.className = "wm-composer-composer";
    editor.id = "mobile-composer-prompt";
    editor.className = "wm-composer-textarea";
    editor.setAttribute("aria-label", "与 ChatGPT 聊天");
    send.type = "submit";
    send.setAttribute("data-composer-submit", "");
    send.setAttribute("data-send-label", "发送消息");
    send.setAttribute("aria-label", "发送消息");
    send.append(icon);
    composer.append(editor, send);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    send.setAttribute("aria-disabled", "true");
    expect(adapter?.isSendControlDisabled(send)).toBe(true);
  });

  it("does not treat ChatGPT's stop-generation button as a send control", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("form");
    const editor = page.createElement("textarea");
    const stop = page.createElement("button");

    composer.className = "wm-composer-composer";
    editor.id = "mobile-composer-prompt";
    stop.type = "submit";
    stop.setAttribute("data-composer-submit", "");
    stop.setAttribute("data-stop-label", "停止生成");
    stop.setAttribute("aria-label", "停止生成");
    composer.append(editor, stop);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBeNull();
  });

  it("accepts non-Chinese data-send-label", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("form");
    const editor = page.createElement("textarea");
    const send = page.createElement("button");

    composer.className = "wm-composer-composer";
    editor.id = "mobile-composer-prompt";
    send.type = "submit";
    send.setAttribute("data-composer-submit", "");
    send.setAttribute("data-send-label", "Send message");
    composer.append(editor, send);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
  });

  it("fails closed when both ChatGPT composer layouts are present", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const desktopEditor = page.createElement("div");
    const currentEditor = page.createElement("textarea");

    desktopEditor.id = "prompt-textarea";
    desktopEditor.className = "ProseMirror";
    desktopEditor.setAttribute("contenteditable", "true");
    desktopEditor.setAttribute("role", "textbox");
    currentEditor.id = "mobile-composer-prompt";
    page.body.append(desktopEditor, currentEditor);

    expect(adapter?.findEditor(page)).toBeNull();
  });

  it("uses ChatGPT's one visible composer when the alternate layout is explicitly hidden", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const desktopEditor = page.createElement("div");
    const desktopSend = page.createElement("button");
    const hiddenMobileEditor = page.createElement("textarea");

    desktopEditor.id = "prompt-textarea";
    desktopEditor.className = "ProseMirror";
    desktopEditor.setAttribute("contenteditable", "true");
    desktopEditor.setAttribute("role", "textbox");
    desktopSend.id = "composer-submit-button";
    desktopSend.setAttribute("data-testid", "send-button");
    hiddenMobileEditor.id = "mobile-composer-prompt";
    hiddenMobileEditor.hidden = true;
    page.body.append(desktopEditor, desktopSend, hiddenMobileEditor);

    expect(adapter?.findEditor(page)).toBe(desktopEditor);
    expect(adapter?.findSendControl(page, desktopEditor)).toBe(desktopSend);
  });

  it("selects only ChatGPT assistant reply containers with the observed role marker", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const userReply = page.createElement("li");
    const assistantReply = page.createElement("li");
    const unrelated = page.createElement("div");

    userReply.setAttribute("data-message-role", "user");
    assistantReply.setAttribute("data-message-role", "assistant");
    unrelated.setAttribute("data-message-role", "assistant");
    page.body.append(userReply, assistantReply, unrelated);

    expect(adapter?.findAssistantResponseContainers?.(page)).toEqual([assistantReply]);
  });

  it("selects ChatGPT's current assistant role container and ignores hidden or editable lookalikes", () => {
    const adapter = getSiteAdapter(new URL("https://chatgpt.com/"));
    const page = document.implementation.createHTMLDocument();
    const currentAssistantReply = page.createElement("article");
    const hiddenAssistantReply = page.createElement("article");
    const editableAssistantReply = page.createElement("div");

    currentAssistantReply.setAttribute("data-message-author-role", "assistant");
    hiddenAssistantReply.setAttribute("data-message-author-role", "assistant");
    hiddenAssistantReply.hidden = true;
    editableAssistantReply.setAttribute("data-message-author-role", "assistant");
    editableAssistantReply.setAttribute("contenteditable", "true");
    page.body.append(currentAssistantReply, hiddenAssistantReply, editableAssistantReply);

    expect(adapter?.findAssistantResponseContainers?.(page)).toEqual([currentAssistantReply]);
  });

  it("does not treat an unverified generic assistant role as a reply container", () => {
    for (const url of [
      new URL("https://www.kimi.com/"),
      new URL("https://www.qianwen.com/"),
      new URL("https://wenxin.baidu.com/"),
    ]) {
      const adapter = getSiteAdapter(url);
      const page = document.implementation.createHTMLDocument();
      const genericRole = page.createElement("div");

      genericRole.setAttribute("data-role", "assistant");
      page.body.append(genericRole);

      expect(adapter?.findAssistantResponseContainers?.(page)).toEqual([]);
    }
  });

  it("recognizes Claude's observed Tiptap composer and exact send control", () => {
    const adapter = getSiteAdapter(new URL("https://claude.ai/new"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const send = page.createElement("button");
    const icon = page.createElement("span");

    editor.className = "tiptap ProseMirror";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Write your prompt to Claude");
    send.setAttribute("data-testid", "chat-input-send");
    send.setAttribute("aria-label", "Send message");
    send.append(icon);
    page.body.append(editor, send);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
  });

  it("uses Gemini's send control from the same observed composer container", () => {
    const adapter = getSiteAdapter(new URL("https://gemini.google.com/app"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const editor = page.createElement("div");
    const sendHost = page.createElement("gem-icon-button");
    const send = page.createElement("button");
    const icon = page.createElement("span");
    const unrelatedHost = page.createElement("gem-icon-button");
    const unrelatedSend = page.createElement("button");

    composer.className = "text-input-field";
    editor.className = "ql-editor ql-blank textarea new-input-ui";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "为 Gemini 输入提示");
    sendHost.className = "send-button";
    send.append(icon);
    sendHost.append(send);
    unrelatedHost.className = "send-button";
    unrelatedHost.append(unrelatedSend);
    composer.append(editor, sendHost);
    page.body.append(composer, unrelatedHost);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(icon, page, editor)).toBe(true);
    expect(adapter?.isSendControlTarget(unrelatedSend, page, editor)).toBe(false);
    expect(
      dispatchKeyboardGesture(editor, new KeyboardEvent("keydown", { key: "Enter", bubbles: true }), (event) =>
        adapter?.isKeyboardSendGesture(event, editor),
      ),
    ).toBe(true);
  });

  it("finds send when host is not gem-icon-button", () => {
    const adapter = getSiteAdapter(new URL("https://gemini.google.com/app"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const editor = page.createElement("div");
    const sendHost = page.createElement("div");
    const send = page.createElement("button");

    composer.className = "text-input-field";
    editor.className = "ql-editor ql-blank textarea new-input-ui";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    sendHost.className = "send-button";
    sendHost.append(send);
    composer.append(editor, sendHost);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
  });

  it("recognizes Kimi's observed editor and send container and rejects ambiguity", () => {
    const adapter = getSiteAdapter(new URL("https://www.kimi.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const editor = page.createElement("div");
    const action = page.createElement("div");
    const send = page.createElement("div");

    composer.className = "chat-input";
    editor.className = "chat-input-editor";
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    action.className = "chat-editor-action";
    send.className = "send-button-container";
    action.append(send);
    composer.append(editor, action);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);

    const secondSend = page.createElement("div");
    secondSend.className = "send-button-container";
    action.append(secondSend);
    expect(adapter?.findSendControl(page, editor)).toBeNull();
  });

  it("recognizes Qwen's observed contenteditable editor and labeled send button", () => {
    const adapter = getSiteAdapter(new URL("https://www.qianwen.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const middle = page.createElement("div");
    const measure = page.createElement("div");
    const editor = page.createElement("div");
    const send = page.createElement("button");

    measure.setAttribute("data-testid", "chat-input-content-measure");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    send.setAttribute("aria-label", "发送消息");
    measure.append(editor);
    middle.append(measure);
    composer.append(middle, send);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
    send.classList.add("cursor-not-allowed");
    expect(adapter?.isSendControlDisabled(send)).toBe(true);
  });

  it("leaves Qwen unverified when its send button is outside the observed composer container", () => {
    const adapter = getSiteAdapter(new URL("https://www.qianwen.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const middle = page.createElement("div");
    const measure = page.createElement("div");
    const editor = page.createElement("div");
    const send = page.createElement("button");

    measure.setAttribute("data-testid", "chat-input-content-measure");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    send.setAttribute("aria-label", "发送消息");
    measure.append(editor);
    middle.append(measure);
    composer.append(middle);
    page.body.append(composer, send);

    expect(adapter?.findSendControl(page, editor)).toBeNull();
  });

  it("finds send with extra wrapper above measure", () => {
    const adapter = getSiteAdapter(new URL("https://www.qianwen.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const extra = page.createElement("div");
    const middle = page.createElement("div");
    const measure = page.createElement("div");
    const editor = page.createElement("div");
    const send = page.createElement("button");

    measure.setAttribute("data-testid", "chat-input-content-measure");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    send.setAttribute("aria-label", "发送消息");
    measure.append(editor);
    middle.append(measure);
    extra.append(middle);
    composer.append(extra, send);
    page.body.append(composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
  });

  it("scopes editor to measure when other contenteditables exist", () => {
    const adapter = getSiteAdapter(new URL("https://www.qianwen.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const middle = page.createElement("div");
    const measure = page.createElement("div");
    const editor = page.createElement("div");
    const send = page.createElement("button");
    const other = page.createElement("div");

    measure.setAttribute("data-testid", "chat-input-content-measure");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    other.setAttribute("contenteditable", "true");
    other.setAttribute("role", "textbox");
    send.setAttribute("aria-label", "发送消息");
    measure.append(editor);
    middle.append(measure);
    composer.append(middle, send);
    page.body.append(other, composer);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
  });

  it("recognizes Wenxin's observed textarea and submit span", () => {
    const adapter = getSiteAdapter(new URL("https://wenxin.baidu.com/"));
    const page = document.implementation.createHTMLDocument();
    const root = page.createElement("div");
    const editor = page.createElement("textarea");
    const send = page.createElement("span");

    root.id = "ci-root";
    editor.id = "chat-textarea";
    send.className = "ci-submit-button";
    root.append(editor, send);
    page.body.append(root);

    expect(adapter?.findEditor(page)).toBe(editor);
    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
    expect(getSiteAdapter(new URL("https://wenxin.baidu.com.example.com/"))).toBeNull();
    expect(getSiteAdapter(new URL("http://yiyan.baidu.com/"))).toBeNull();
  });

  it("limits Wenxin attachment detection to the observed input container", () => {
    const adapter = getSiteAdapter(new URL("https://wenxin.baidu.com/"));
    const page = document.implementation.createHTMLDocument();
    const composer = page.createElement("div");
    const editor = page.createElement("textarea");
    const inside = page.createElement("div");
    const outside = page.createElement("div");

    composer.className = "ci-container";
    editor.id = "chat-textarea";
    inside.className = "ci-file-item";
    outside.className = "ci-file-item";
    composer.append(editor, inside);
    page.body.append(composer, outside);

    expect(adapter?.findComposerAttachments?.(page, editor)).toEqual([inside]);
  });

  it("does not claim attachment inspection where the adapter has no scoped DOM evidence", () => {
    const doubao = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const deepseek = getSiteAdapter(new URL("https://chat.deepseek.com/"));
    const kimi = getSiteAdapter(new URL("https://www.kimi.com/"));
    const qwen = getSiteAdapter(new URL("https://www.qianwen.com/"));
    const wenxin = getSiteAdapter(new URL("https://wenxin.baidu.com/"));

    expect(doubao?.attachmentDetection).toBeUndefined();
    expect(doubao?.findComposerAttachments).toBeUndefined();
    expect(deepseek?.attachmentDetection).toBeUndefined();
    expect(deepseek?.findComposerAttachments).toBeUndefined();
    expect(kimi?.attachmentDetection).toBe("scoped");
    expect(qwen?.attachmentDetection).toBe("scoped");
    expect(wenxin?.attachmentDetection).toBe("scoped");
  });

  it("recognizes Doubao's current unlabeled send button by its stable ID", () => {
    const adapter = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const send = page.createElement("button");

    editor.setAttribute("contenteditable", "true");
    send.id = "flow-end-msg-send";
    page.body.append(editor, send);

    expect(adapter?.findSendControl(page, editor)).toBe(send);
    expect(adapter?.isSendControlTarget(send, page, editor)).toBe(true);
  });

  it("rejects a non-button that reuses Doubao's send ID", () => {
    const adapter = getSiteAdapter(new URL("https://www.doubao.com/chat/"));
    const page = document.implementation.createHTMLDocument();
    const editor = page.createElement("div");
    const lookalike = page.createElement("div");

    editor.setAttribute("contenteditable", "true");
    lookalike.id = "flow-end-msg-send";
    page.body.append(editor, lookalike);

    expect(adapter?.findSendControl(page, editor)).toBeNull();
    expect(adapter?.isSendControlTarget(lookalike, page, editor)).toBe(false);
  });

  it("rejects lookalike and unsupported hosts", () => {
    expect(getSiteAdapter(new URL("https://www.doubao.com.example.com/"))).toBeNull();
    expect(getSiteAdapter(new URL("http://www.doubao.com/chat/"))).toBeNull();
    expect(getSiteAdapter(new URL("http://chat.deepseek.com/"))).toBeNull();
    expect(getSiteAdapter(new URL("https://chatgpt.example.com/"))).toBeNull();
    expect(getSiteAdapter(new URL("https://claude.ai.example.com/new"))).toBeNull();
    expect(getSiteAdapter(new URL("https://gemini.google.com.example.com/app"))).toBeNull();
    expect(getSiteAdapter(new URL("http://gemini.google.com/app"))).toBeNull();
    expect(getSiteAdapter(new URL("https://chat.deepseek.com/sign_in"))).toBeNull();
  });
});
