import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const CHATGPT_MATCH_PATTERN = "https://chatgpt.com/*";
const EDITOR_SELECTORS = [
  "div#prompt-textarea.ProseMirror[contenteditable='true'][role='textbox']",
  "textarea#mobile-composer-prompt:not([disabled]):not([readonly])",
] as const;
const DESKTOP_SEND_SELECTOR = "button#composer-submit-button[data-testid='send-button']";
const CURRENT_SEND_SELECTOR = "button[data-composer-submit][data-send-label][type='submit']";
const CURRENT_COMPOSER_SELECTOR = "form.wm-composer-composer";
const ASSISTANT_REPLY_SELECTORS = [
  "li[data-message-role='assistant']",
  "[data-message-author-role='assistant']",
] as const;

function uniqueElements<T extends Element>(elements: readonly Element[]): T[] {
  return [...new Set(elements)].filter((element): element is T => element instanceof Element && !isHidden(element));
}

function findEditor(document: Document): HTMLElement | null {
  const editors = uniqueElements<HTMLElement>(
    EDITOR_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
  );

  if (editors.length !== 1) {
    return null;
  }

  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findSendControl(document: Document, editor: EditableElement): HTMLButtonElement | null {
  const controls: Element[] = [];

  if (editor.matches(EDITOR_SELECTORS[0])) {
    controls.push(...document.querySelectorAll(DESKTOP_SEND_SELECTOR));
  } else if (editor.matches(EDITOR_SELECTORS[1])) {
    const composer = editor.closest(CURRENT_COMPOSER_SELECTOR);
    if (composer === null) {
      return null;
    }
    controls.push(...composer.querySelectorAll(CURRENT_SEND_SELECTOR));
  }

  const uniqueControls = uniqueElements<HTMLButtonElement>(controls);

  if (uniqueControls.length !== 1) {
    return null;
  }

  return uniqueControls[0];
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  return (
    !(sendControl instanceof HTMLButtonElement) ||
    sendControl.disabled ||
    sendControl.getAttribute("aria-disabled") === "true"
  );
}

function isSendControlTarget(target: EventTarget | null, document: Document, editor: EditableElement): boolean {
  const control = target instanceof Element
    ? target.closest(`${DESKTOP_SEND_SELECTOR}, ${CURRENT_SEND_SELECTOR}`)
    : null;

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

function isHidden(element: Element): boolean {
  let current: Element | null = element;

  while (current !== null) {
    const computedStyle = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (
      (current instanceof HTMLElement && current.hidden) ||
      current.getAttribute("aria-hidden") === "true" ||
      (current instanceof HTMLElement && current.style.display === "none") ||
      (current instanceof HTMLElement && current.style.visibility === "hidden") ||
      computedStyle?.display === "none" ||
      computedStyle?.visibility === "hidden"
    ) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

function isInsideEditableElement(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element.getAttribute("contenteditable") === "true" ||
    element.getAttribute("contenteditable") === "plaintext-only" ||
    element.closest("[contenteditable='true'], [contenteditable='plaintext-only']") !== null
  );
}

function findAssistantResponseContainers(document: Document): readonly HTMLElement[] {
  const candidates = [...new Set(
    ASSISTANT_REPLY_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
  )].filter((element): element is HTMLElement =>
    element instanceof HTMLElement && !isHidden(element) && !isInsideEditableElement(element),
  );

  return candidates.filter((candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)));
}

export const chatgptAdapter: SiteAdapter = {
  id: "chatgpt",
  matchPatterns: [CHATGPT_MATCH_PATTERN],
  matches: (url) => url.protocol === "https:" && url.hostname === "chatgpt.com",
  findEditor,
  findSendControl,
  isSendControlDisabled,
  isSendControlTarget,
  isKeyboardSendGesture,
  findAssistantResponseContainers,
};
