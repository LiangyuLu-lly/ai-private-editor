import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const KIMI_MATCH_PATTERNS = ["https://www.kimi.com/*"] as const;
const EDITOR_SELECTOR = ".chat-input-editor[contenteditable='true'][role='textbox']";
const COMPOSER_SELECTOR = ".chat-input";
const SEND_SELECTOR = ".chat-editor-action .send-button-container";
const ASSISTANT_REPLY_SELECTOR = "[data-message-author-role='assistant'], [data-message-role='assistant']";
const ATTACHMENT_SELECTOR = "[data-attachment-id], [data-file-id], [data-role='attachment'], .chat-input-attachment, .file-item";

function findEditor(document: Document): HTMLElement | null {
  const editors = document.querySelectorAll(EDITOR_SELECTOR);
  if (editors.length !== 1) {
    return null;
  }
  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findSendControl(document: Document, editor: EditableElement): HTMLDivElement | null {
  if (!(editor instanceof HTMLElement) || editor.ownerDocument !== document) {
    return null;
  }
  const composer = editor.closest(COMPOSER_SELECTOR);
  if (composer === null) {
    return null;
  }
  const controls = composer.querySelectorAll(SEND_SELECTOR);
  if (controls.length !== 1) {
    return null;
  }
  const [control] = controls;
  return control instanceof HTMLDivElement ? control : null;
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return !(sendControl instanceof HTMLDivElement) ||
    sendControl.hasAttribute("disabled") ||
    sendControl.getAttribute("aria-disabled") === "true" ||
    sendControl.classList.contains("disabled");
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;
  return control instanceof HTMLDivElement && control === findSendControl(document, editor);
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
  const composer = editor instanceof HTMLElement ? editor.closest(COMPOSER_SELECTOR) : null;
  if (composer === null) {
    return [];
  }
  return Array.from(composer.querySelectorAll(ATTACHMENT_SELECTOR)).filter(
    (element) => !(element instanceof HTMLInputElement && element.type === "file"),
  );
}

export const kimiAdapter: SiteAdapter = {
  id: "kimi",
  matchPatterns: KIMI_MATCH_PATTERNS,
  matches: (url) => url.protocol === "https:" && url.hostname === "www.kimi.com",
  findEditor,
  findSendControl,
  isSendControlDisabled,
  isSendControlTarget,
  isKeyboardSendGesture,
  findAssistantResponseContainers,
  attachmentDetection: "scoped",
  findComposerAttachments,
};
