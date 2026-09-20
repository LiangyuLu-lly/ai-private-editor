import { isEditorTarget } from "./editor.js";
import type { EditableElement, SendControl, SiteAdapter } from "./types.js";

const YUANBAO_MATCH_PATTERN = "https://yuanbao.tencent.com/*";
const EDITOR_SELECTOR = ".ql-editor[contenteditable='true']";
const SEND_SELECTOR = "a#yuanbao-send-btn[aria-label='发送']";
const DISABLED_CLASS_TOKEN = /(?:^|__)send-btn--disabled(?:___|$)/u;

function findEditor(document: Document): EditableElement | null {
  const editors = document.querySelectorAll(EDITOR_SELECTOR);

  if (editors.length !== 1) {
    return null;
  }

  const [editor] = editors;
  return editor instanceof HTMLElement ? editor : null;
}

function findSendControl(document: Document): HTMLAnchorElement | null {
  const controls = document.querySelectorAll(SEND_SELECTOR);

  if (controls.length !== 1) {
    return null;
  }

  const [control] = controls;
  return control instanceof HTMLAnchorElement ? control : null;
}

function isSendControlDisabled(sendControl: SendControl): boolean {
  if (!(sendControl instanceof HTMLAnchorElement)) {
    return true;
  }

  return (
    sendControl.hasAttribute("disabled") ||
    sendControl.getAttribute("aria-disabled") === "true" ||
    Array.from(sendControl.classList).some((className) => DISABLED_CLASS_TOKEN.test(className))
  );
}

function isSendControlTarget(target: EventTarget | null, document: Document): boolean {
  const control = target instanceof Element ? target.closest(SEND_SELECTOR) : null;

  return control instanceof HTMLAnchorElement && control === findSendControl(document);
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

export const yuanbaoAdapter: SiteAdapter = {
  id: "yuanbao",
  matchPatterns: [YUANBAO_MATCH_PATTERN],
  matches: (url) => url.protocol === "https:" && url.hostname === "yuanbao.tencent.com",
  findEditor,
  findSendControl: (document) => findSendControl(document),
  isSendControlDisabled,
  isSendControlTarget: (target, document) => isSendControlTarget(target, document),
  isKeyboardSendGesture,
};
