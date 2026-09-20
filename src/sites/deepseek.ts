import { findEditableElement, findNearestComposerRoot, isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const SEND_SELECTOR = "div[role='button'].ds-button--primary.ds-button--filled.ds-button--circle";
const HIGH_SIGNAL_EDITOR_SELECTORS = [
  "textarea[placeholder*='DeepSeek']:not([disabled]):not([readonly])",
  "textarea[placeholder*='发送消息']:not([disabled]):not([readonly])",
  "[contenteditable='true'][role='textbox'][aria-label*='DeepSeek']",
] as const;
const DISABLED_CLASS = "ds-button--disabled";
const ASSISTANT_REPLY_SELECTOR = "[data-privacy-assistant-reply='true']";

function findSendControl(document: Document): HTMLDivElement | null {
  const controls = document.querySelectorAll(SEND_SELECTOR);

  if (controls.length !== 1) {
    return null;
  }

  const [control] = controls;
  return control instanceof HTMLDivElement ? control : null;
}

function findEditor(document: Document): EditableElement | null {
  const highSignalEditors = [...new Set(HIGH_SIGNAL_EDITOR_SELECTORS.flatMap((selector) =>
    Array.from(document.querySelectorAll(selector)),
  ))].filter((element): element is EditableElement =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLElement,
  );

  if (highSignalEditors.length === 1) {
    return highSignalEditors[0];
  }

  const genericEditors = Array.from(
    document.querySelectorAll("textarea:not([disabled]):not([readonly]), [contenteditable='true'][role='textbox']"),
  );
  if (genericEditors.length !== 1) {
    return null;
  }

  return findEditableElement(document, [
    "textarea:not([disabled]):not([readonly])",
    "[contenteditable='true'][role='textbox']",
  ]);
}

function isSendControlTarget(target: EventTarget | null, document: Document): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;

  return control instanceof HTMLDivElement && control === findSendControl(document);
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return (
    !(sendControl instanceof HTMLDivElement) ||
    sendControl.hasAttribute("disabled") ||
    sendControl.getAttribute("aria-disabled") === "true" ||
    sendControl.classList.contains(DISABLED_CLASS)
  );
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

export const deepseekAdapter: SiteAdapter = {
  id: "deepseek",
  matchPatterns: ["https://chat.deepseek.com/*"],
  matches: (url) =>
    url.protocol === "https:" && url.hostname === "chat.deepseek.com" && !url.pathname.startsWith("/sign_in"),
  findEditor,
  findSendControl: (document) => findSendControl(document),
  findComposerRoot: (document, editor, sendControl) => findNearestComposerRoot(document, editor, sendControl),
  isSendControlDisabled,
  isSendControlTarget: (target, document) => isSendControlTarget(target, document),
  isKeyboardSendGesture: (event, editor) => isKeyboardSendGesture(event, editor),
  findAssistantResponseContainers: (document) =>
    Array.from(document.querySelectorAll(ASSISTANT_REPLY_SELECTOR)).filter((element): element is HTMLElement => element instanceof HTMLElement),
};
