import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const WENXIN_MATCH_PATTERNS = ["https://yiyan.baidu.com/*", "https://wenxin.baidu.com/*"] as const;
const EDITOR_SELECTOR = "textarea#chat-textarea";
const SEND_SELECTOR = ".ci-submit-button";
const COMPOSER_SELECTOR = ".ci-container";
const ASSISTANT_REPLY_SELECTOR = "[data-message-author-role='assistant'], [data-message-role='assistant']";
const ATTACHMENT_SELECTOR = "[data-attachment-id], [data-file-id], .ci-upload-item, .ci-file-item";

function findEditor(document: Document): HTMLTextAreaElement | null {
  const editors = document.querySelectorAll(EDITOR_SELECTOR);
  if (editors.length !== 1) {
    return null;
  }
  const [editor] = editors;
  return editor instanceof HTMLTextAreaElement && !editor.disabled && !editor.readOnly ? editor : null;
}

function findSendControl(document: Document, editor: EditableElement): HTMLSpanElement | null {
  if (!(editor instanceof HTMLTextAreaElement) || editor.ownerDocument !== document) {
    return null;
  }
  let ancestor: HTMLElement | null = editor;
  while (ancestor !== null) {
    const controls = ancestor.querySelectorAll(SEND_SELECTOR);
    if (controls.length === 1) {
      const [control] = controls;
      return control instanceof HTMLSpanElement ? control : null;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return !(sendControl instanceof HTMLSpanElement) ||
    sendControl.hasAttribute("disabled") ||
    sendControl.getAttribute("aria-disabled") === "true" ||
    [...sendControl.classList].some((className) => /(?:^|-)disabled(?:-|$)/u.test(className));
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;
  return control instanceof HTMLSpanElement && control === findSendControl(document, editor);
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
  if (!(editor instanceof HTMLTextAreaElement)) {
    return [];
  }
  const composer = editor.closest(COMPOSER_SELECTOR);
  return composer === null ? [] : Array.from(composer.querySelectorAll(ATTACHMENT_SELECTOR));
}

export const wenxinAdapter: SiteAdapter = {
  id: "wenxin",
  matchPatterns: WENXIN_MATCH_PATTERNS,
  matches: (url) => url.protocol === "https:" && (url.hostname === "yiyan.baidu.com" || url.hostname === "wenxin.baidu.com"),
  findEditor,
  findSendControl,
  isSendControlDisabled,
  isSendControlTarget,
  isKeyboardSendGesture,
  findAssistantResponseContainers,
  attachmentDetection: "scoped",
  findComposerAttachments,
};
