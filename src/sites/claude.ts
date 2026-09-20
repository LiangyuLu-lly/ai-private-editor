import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const CLAUDE_MATCH_PATTERN = "https://claude.ai/*";
const EDITOR_SELECTOR = "div.tiptap.ProseMirror[contenteditable='true'][role='textbox']";
const SEND_SELECTOR = "button[data-testid='chat-input-send']";

function findEditor(document: Document): HTMLElement | null {
  const editors = document.querySelectorAll(EDITOR_SELECTOR);

  if (editors.length !== 1) {
    return null;
  }

  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findSendControl(document: Document): HTMLButtonElement | null {
  const controls = document.querySelectorAll(SEND_SELECTOR);

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

function isSendControlTarget(target: EventTarget | null, document: Document): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;

  return control instanceof HTMLButtonElement && control === findSendControl(document);
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

export const claudeAdapter: SiteAdapter = {
  id: "claude",
  matchPatterns: [CLAUDE_MATCH_PATTERN],
  matches: (url) =>
    url.protocol === "https:" &&
    url.hostname === "claude.ai" &&
    !url.pathname.startsWith("/login") &&
    !url.pathname.startsWith("/logout"),
  findEditor,
  findSendControl: (document) => findSendControl(document),
  isSendControlDisabled,
  isSendControlTarget: (target, document) => isSendControlTarget(target, document),
  isKeyboardSendGesture,
};
