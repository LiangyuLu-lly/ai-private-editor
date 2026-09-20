import { findEditableElements, findNearestComposerRoot, isEditorTarget } from "./editor.js";
import type { EditableElement, SiteAdapter } from "./types.js";

/*
 * 这些选择器**不能**带 `:not([disabled])`。
 *
 * 带上以后，豆包在输入框为空时给发送按钮加的 `disabled` 属性会让所有选择器一个都匹配不上，于是
 * `findSendControls` 返回空数组，症状有两层：
 *
 *   1. `findSendControl` 直接返回 null，健康检查判 `send_control_not_found`，页面提示"当前页面未验证"。
 *   2. 更误导的是 `findEditor` 也跟着坏掉——它靠 `findSendControls` 做配对来从多个可编辑元素里挑出真正
 *      的输入框；一个控件都找不到时配对为空，多输入框的真实页面于是返回 null，报的是"找不到输入框"。
 *      用户看到的正是"其实是有输入框的，但不输入字符就说没检测到"。
 *
 * 也就是说，把禁用状态过滤写进选择器等于把"现在能不能发送"混进了"这是不是发送按钮"。禁用是输入框为空
 * 时的空闲状态，不是身份特征。可用性判断由 `isSendControlDisabled`（下方，检查 `sendControl.disabled`）
 * 在 pre-send.ts 的发送时刻单独回答。
 *
 * 注意 CSS 属性选择器匹配的是**属性节点**，不是 JS 属性：`Object.defineProperty(button, "disabled", …)`
 * 这样的 fixture 绕得过 `:not([disabled])`，曾经因此让单元测试全绿而真实豆包依旧误报。回归用例请用
 * `setAttribute("disabled", "")`（tests/health.test.ts 里那条 "real disabled attribute"）。
 */
const SEND_SELECTORS = [
  "#flow-end-msg-send",
  "button[aria-label='发送']",
  "button[aria-label*='发送']",
  "button[title*='发送']",
  "button[type='submit']",
] as const;
const ASSISTANT_REPLY_SELECTOR = "[data-privacy-assistant-reply='true']";

function findSendControls(document: Document): HTMLButtonElement[] {
  const controls: HTMLButtonElement[] = [];
  const seen = new Set<HTMLButtonElement>();

  for (const selector of SEND_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      if (element instanceof HTMLButtonElement && !seen.has(element)) {
        seen.add(element);
        controls.push(element);
      }
    }
  }

  return controls;
}

function hasNonBodyParent(element: Element, document: Document): boolean {
  const parent = element.parentElement;
  return parent !== null && parent !== document.body && parent !== document.documentElement;
}

function hasSharedComposerRoot(document: Document, editor: EditableElement, sendControl: Element): boolean {
  return findNearestComposerRoot(document, editor, sendControl) !== null;
}

function findEditor(document: Document): EditableElement | null {
  const editors = findEditableElements(document);
  if (editors.length === 0) {
    return null;
  }

  const controls = findSendControls(document);
  const pairedEditors = editors.filter((editor) =>
    controls.some((control) => hasSharedComposerRoot(document, editor, control)),
  );

  if (pairedEditors.length === 1) {
    return pairedEditors[0];
  }

  if (pairedEditors.length > 1 || editors.length > 1) {
    return null;
  }

  return editors[0];
}

function findSendControl(document: Document, editor: EditableElement): HTMLButtonElement | null {
  const controls = findSendControls(document);
  const pairedControls = controls.filter((control) => hasSharedComposerRoot(document, editor, control));

  if (pairedControls.length === 1) {
    return pairedControls[0];
  }

  if (pairedControls.length > 1) {
    return null;
  }

  if (controls.length !== 1) {
    return null;
  }

  const [control] = controls;
  if (hasNonBodyParent(editor, document) && hasNonBodyParent(control, document)) {
    return null;
  }

  return control;
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTORS.join(",")) : null;

  return control instanceof HTMLButtonElement && control === findSendControl(document, editor);
}

function isKeyboardSendGesture(event: KeyboardEvent, editor: EditableElement): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    isEditorTarget(editor, event.target)
  );
}

export const doubaoAdapter: SiteAdapter = {
  id: "doubao",
  matchPatterns: ["https://www.doubao.com/*", "https://doubao.com/*"],
  matches: (url) =>
    url.protocol === "https:" && (url.hostname === "www.doubao.com" || url.hostname === "doubao.com"),
  findEditor,
  findSendControl,
  isSendControlDisabled: (sendControl) => !(sendControl instanceof HTMLButtonElement) || sendControl.disabled,
  isSendControlTarget,
  isKeyboardSendGesture: (event, editor) => isKeyboardSendGesture(event, editor),
  findAssistantResponseContainers: (document) =>
    Array.from(document.querySelectorAll(ASSISTANT_REPLY_SELECTOR)).filter((element): element is HTMLElement => element instanceof HTMLElement),
};
