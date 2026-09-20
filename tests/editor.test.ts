import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findEditableElement,
  findEditableElements,
  insertEditorText,
  isEditorTarget,
  readEditorText,
  writeEditorText,
} from "../src/sites/editor.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("editor helpers", () => {
  it("reads native and contenteditable editors without treating a login input as an editor", () => {
    const textarea = document.createElement("textarea");
    const richEditor = document.createElement("div");
    const child = document.createElement("span");

    textarea.value = "第一行\n第二行";
    richEditor.setAttribute("contenteditable", "true");
    richEditor.innerHTML = "第一行<br>第二行";
    richEditor.append(child);

    expect(readEditorText(textarea)).toBe("第一行\n第二行");
    expect(readEditorText(richEditor)).toBe("第一行\n第二行");
    expect(isEditorTarget(richEditor, child)).toBe(true);
    expect(isEditorTarget(textarea, document.body)).toBe(false);
  });

  it("writes a textarea through the native setter and dispatches input", () => {
    const editor = document.createElement("textarea");
    const onInput = vi.fn();
    const sendButton = document.createElement("button");
    const onSend = vi.fn();

    editor.addEventListener("input", onInput);
    sendButton.addEventListener("click", onSend);
    document.body.append(editor, sendButton);

    expect(writeEditorText(editor, "[[PHONE_001]]")).toBe(true);
    expect(editor.value).toBe("[[PHONE_001]]");
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("writes contenteditable editors and dispatches input", () => {
    const editor = document.createElement("div");
    const onInput = vi.fn();

    editor.setAttribute("contenteditable", "true");
    editor.addEventListener("input", onInput);

    expect(writeEditorText(editor, "[[EMAIL_001]]")).toBe(true);
    expect(editor.textContent).toBe("[[EMAIL_001]]");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("inserts plain text into the current textarea selection and dispatches input", () => {
    const editor = document.createElement("textarea");
    const onInput = vi.fn();

    editor.value = "开始结束";
    editor.setSelectionRange(2, 2);
    editor.addEventListener("input", onInput);
    document.body.append(editor);

    expect(insertEditorText(editor, "[[PHONE_001]]")).toBe(true);
    expect(editor.value).toBe("开始[[PHONE_001]]结束");
    expect(editor.selectionStart).toBe(15);
    expect(editor.selectionEnd).toBe(15);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("inserts plain text into a contenteditable selection and dispatches input", () => {
    const editor = document.createElement("div");
    const onInput = vi.fn();

    editor.setAttribute("contenteditable", "true");
    editor.textContent = "开始结束";
    editor.addEventListener("input", onInput);
    document.body.append(editor);
    const textNode = editor.firstChild;
    const selection = document.getSelection();
    const range = document.createRange();

    if (textNode === null || selection === null) {
      throw new Error("Expected the test editor to have a text node and selection");
    }

    range.setStart(textNode, 2);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(insertEditorText(editor, "[[EMAIL_001]]")).toBe(true);
    expect(editor.textContent).toBe("开始[[EMAIL_001]]结束");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("finds the first safe editable element and refuses disabled controls", () => {
    const disabled = document.createElement("textarea");
    const editor = document.createElement("textarea");
    const plainDiv = document.createElement("div");

    disabled.disabled = true;
    document.body.append(disabled, plainDiv, editor);

    expect(findEditableElement(document)).toBe(editor);
    expect(writeEditorText(disabled, "[[IPV4_001]]")).toBe(false);
    expect(writeEditorText(plainDiv, "[[IPV4_001]]")).toBe(false);
  });

  it("returns unique writable editors in document order", () => {
    const first = document.createElement("textarea");
    const second = document.createElement("div");
    const disabled = document.createElement("textarea");

    second.setAttribute("contenteditable", "true");
    disabled.disabled = true;
    document.body.append(first, disabled, second);

    expect(findEditableElements(document)).toEqual([first, second]);
  });

  it("does not treat a generic text input as a chat editor", () => {
    const loginInput = document.createElement("input");

    loginInput.type = "text";
    document.body.append(loginInput);

    expect(findEditableElement(document)).toBeNull();
  });
});
