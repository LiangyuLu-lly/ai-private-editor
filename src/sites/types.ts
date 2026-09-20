import type { SiteId } from "../shared/types.js";

export type { SiteId } from "../shared/types.js";

export type EditableElement = HTMLTextAreaElement | HTMLInputElement | HTMLElement;
export type SendControl = HTMLButtonElement | HTMLAnchorElement | HTMLDivElement | HTMLSpanElement;

export type SiteAdapter = {
  id: SiteId;
  matchPatterns: readonly string[];
  matches: (url: URL) => boolean;
  findEditor: (document: Document) => EditableElement | null;
  findSendControl: (document: Document, editor: EditableElement) => SendControl | null;
  findComposerRoot?: (
    document: Document,
    editor: EditableElement,
    sendControl: SendControl,
  ) => Element | null;
  isSendControlDisabled: (sendControl: SendControl) => boolean;
  isSendControlTarget: (target: EventTarget | null, document: Document, editor: EditableElement) => boolean;
  isKeyboardSendGesture: (event: KeyboardEvent, editor: EditableElement) => boolean;
  findAssistantResponseContainers?: (document: Document) => readonly HTMLElement[];
  /**
   * Set only when the adapter has a composer-scoped attachment selector covered by a DOM fixture.
   * Without it, confirm/block policies fail safely instead of treating an unknown attachment state as empty.
   */
  attachmentDetection?: "scoped";
  findComposerAttachments?: (document: Document, editor: EditableElement) => readonly Element[];
};
