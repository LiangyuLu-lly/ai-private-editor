import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const GEMINI_MATCH_PATTERN = "https://gemini.google.com/*";
const EDITOR_SELECTOR = "div.ql-editor.textarea.new-input-ui[contenteditable='true'][role='textbox']";
const COMPOSER_SELECTOR = "div.text-input-field";
const SEND_SELECTOR = ".send-button > button";

function findEditor(document: Document): HTMLElement | null {
  const editors = document.querySelectorAll(EDITOR_SELECTOR);

  if (editors.length !== 1) {
    return null;
  }

  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findSendControl(document: Document, editor: EditableElement): HTMLButtonElement | null {
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
  return control instanceof HTMLButtonElement ? control : null;
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return (
    !(sendControl instanceof HTMLButtonElement) ||
    sendControl.disabled ||
    sendControl.getAttribute("aria-disabled") === "true"
  );
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;

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

export const geminiAdapter: SiteAdapter = {
  id: "gemini",
  matchPatterns: [GEMINI_MATCH_PATTERN],
  matches: (url) => url.protocol === "https:" && url.hostname === "gemini.google.com",
  findEditor,
  findSendControl,
  isSendControlDisabled,
  isSendControlTarget,
  isKeyboardSendGesture,
};
