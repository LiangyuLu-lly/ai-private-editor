import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const QWEN_MATCH_PATTERNS = ["https://www.qianwen.com/*"] as const;
const EDITOR_SELECTOR = "[contenteditable='true'][role='textbox']";
const MEASURE_SELECTOR = "[data-testid='chat-input-content-measure']";
const SEND_SELECTOR = "button[aria-label='发送消息']";
const ASSISTANT_REPLY_SELECTOR = "[data-message-author-role='assistant'], [data-message-role='assistant']";
const ATTACHMENT_SELECTOR = "[data-attachment-id], [data-file-id], [data-role='attachment'], .file-item, .attachment-item";

function findEditor(document: Document): HTMLElement | null {
  const measures = document.querySelectorAll(MEASURE_SELECTOR);
  const [measure] = measures;
  const scope = measures.length === 1 && measure !== undefined ? measure : document;
  const editors = scope.querySelectorAll(EDITOR_SELECTOR);
  if (editors.length !== 1) {
    return null;
  }
  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findComposerRoot(editor: HTMLElement): HTMLElement | null {
  const measure = editor.closest(MEASURE_SELECTOR);
  if (!(measure instanceof HTMLElement)) {
    return null;
  }

  let current = measure.parentElement;
  while (current !== null && current !== current.ownerDocument.body) {
    const controls = current.querySelectorAll(SEND_SELECTOR);
    if (controls.length === 1) {
      return current;
    }
    if (controls.length > 1) {
      return null;
    }
    current = current.parentElement;
  }
  return null;
}

function findSendControl(document: Document, editor: EditableElement): HTMLButtonElement | null {
  if (!(editor instanceof HTMLElement) || editor.ownerDocument !== document) {
    return null;
  }
  const composer = findComposerRoot(editor);
  if (composer === null) {
    return null;
  }
  const controls = composer.querySelectorAll(SEND_SELECTOR);
  if (controls.length !== 1) {
    return null;
  }
  const [control] = controls;
  return control instanceof HTMLButtonElement ? control : null;
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return !(sendControl instanceof HTMLButtonElement) ||
    sendControl.disabled ||
    sendControl.getAttribute("aria-disabled") === "true" ||
    sendControl.classList.contains("cursor-not-allowed");
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;
  return control instanceof HTMLButtonElement && control === findSendControl(document, editor);
}

function isKeyboardSendGesture(event: KeyboardEvent, editor: EditableElement): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey &&
    !event.isComposing && event.keyCode !== 229 && isEditorTarget(editor, event.target);
}

function findAssistantResponseContainers(document: Document): readonly HTMLElement[] {
  return Array.from(document.querySelectorAll(ASSISTANT_REPLY_SELECTOR)).filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}

function findComposerAttachments(document: Document, editor: EditableElement): readonly Element[] {
  if (!(editor instanceof HTMLElement)) {
    return [];
  }
  const composer = findComposerRoot(editor);
  if (composer === null) {
    return [];
  }
  return Array.from(composer.querySelectorAll(ATTACHMENT_SELECTOR));
}

export const qwenAdapter: SiteAdapter = {
  id: "qwen",
  matchPatterns: QWEN_MATCH_PATTERNS,
  matches: (url) => url.protocol === "https:" && url.hostname === "www.qianwen.com",
  findEditor,
  findSendControl,
  isSendControlDisabled,
  isSendControlTarget,
  isKeyboardSendGesture,
  findAssistantResponseContainers,
  attachmentDetection: "scoped",
  findComposerAttachments,
};
