import type { EditableElement } from "./types.js";

export const DEFAULT_EDITOR_SELECTORS = [
  "textarea:not([disabled]):not([readonly])",
  "[contenteditable='true'][role='textbox']",
  "[contenteditable='plaintext-only'][role='textbox']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
] as const;

function isWritableTextInput(element: HTMLInputElement): boolean {
  return !element.disabled && !element.readOnly && ["text", "search", ""].includes(element.type);
}

function isContentEditableElement(element: HTMLElement): boolean {
  const contentEditable = element.getAttribute("contenteditable");

  return element.isContentEditable || contentEditable === "true" || contentEditable === "plaintext-only";
}

function isWritableEditableElement(element: Element): element is EditableElement {
  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }

  if (element instanceof HTMLInputElement) {
    return isWritableTextInput(element);
  }

  return element instanceof HTMLElement && isContentEditableElement(element);
}

function dispatchInput(editor: EditableElement): void {
  const inputEvent =
    typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: null })
      : new Event("input", { bubbles: true });

  editor.dispatchEvent(inputEvent);
}

function setNativeControlValue(editor: HTMLTextAreaElement | HTMLInputElement, text: string): boolean {
  const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  if (typeof setter !== "function") {
    return false;
  }

  setter.call(editor, text);
  return true;
}

export function findEditableElement(
  root: ParentNode,
  selectors: readonly string[] = DEFAULT_EDITOR_SELECTORS,
): EditableElement | null {
  return findEditableElements(root, selectors)[0] ?? null;
}

export function findEditableElements(
  root: ParentNode,
  selectors: readonly string[] = DEFAULT_EDITOR_SELECTORS,
): EditableElement[] {
  const editors: EditableElement[] = [];
  const seen = new Set<Element>();

  for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) {
      if (seen.has(element)) {
        continue;
      }

      if (isWritableEditableElement(element)) {
        seen.add(element);
        editors.push(element);
      }
    }
  }

  return editors;
}

export function findNearestComposerRoot(
  document: Document,
  editor: EditableElement,
  sendControl: Element,
): Element | null {
  if (editor.ownerDocument !== document || sendControl.ownerDocument !== document) {
    return null;
  }

  let current: Element | null = editor;
  while (current !== null && current !== document.body && current !== document.documentElement) {
    if (current.contains(sendControl)) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

export function readEditorText(editor: EditableElement): string {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value;
  }

  const text = editor.innerText;

  if (text) {
    return text.replace(/\r\n?/gu, "\n");
  }

  const copy = editor.cloneNode(true) as HTMLElement;

  for (const lineBreak of copy.querySelectorAll("br")) {
    lineBreak.replaceWith("\n");
  }

  return (copy.textContent || "").replace(/\r\n?/gu, "\n");
}

export function isEditorTarget(editor: EditableElement, target: EventTarget | null): boolean {
  return target instanceof Node && (target === editor || editor.contains(target));
}

export function writeEditorText(editor: EditableElement, text: string): boolean {
  if (!isWritableEditableElement(editor)) {
    return false;
  }

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    if (!setNativeControlValue(editor, text)) {
      return false;
    }
  } else {
    editor.focus();
    editor.textContent = text;
  }

  dispatchInput(editor);
  return true;
}

export function insertEditorText(editor: EditableElement, text: string): boolean {
  if (!isWritableEditableElement(editor)) {
    return false;
  }

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    const nextText = `${editor.value.slice(0, start)}${text}${editor.value.slice(end)}`;

    if (!setNativeControlValue(editor, nextText)) {
      return false;
    }

    const cursor = start + text.length;
    editor.setSelectionRange(cursor, cursor);
    dispatchInput(editor);
    return true;
  }

  const selection = editor.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

  if (range !== null && editor.contains(range.commonAncestorContainer)) {
    range.deleteContents();
    const textNode = editor.ownerDocument.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    editor.focus();
    editor.append(editor.ownerDocument.createTextNode(text));
  }

  dispatchInput(editor);
  return true;
}
