import { describe, expect, it } from "vitest";

import { PROTECTION_STATUS_MESSAGE_TYPE } from "../src/shared/protection-status.js";
import {
  createNavigationStatusResetter,
  createToolbarStatusHandler,
  createToolbarStatusHandlers,
  getToolbarPresentation,
  type ToolbarActionApi,
} from "../src/status-worker.js";

type ToolbarCall =
  | { method: "badge"; text: string; tabId: number }
  | { method: "background"; color: string; tabId: number }
  | { method: "text"; color: string; tabId: number }
  | { method: "title"; title: string; tabId: number };

function createActionRecorder(): { action: ToolbarActionApi; calls: ToolbarCall[] } {
  const calls: ToolbarCall[] = [];

  return {
    action: {
      async setBadgeText({ text, tabId }) {
        calls.push({ method: "badge", text, tabId });
      },
      async setBadgeBackgroundColor({ color, tabId }) {
        calls.push({ method: "background", color, tabId });
      },
      async setBadgeTextColor({ color, tabId }) {
        calls.push({ method: "text", color, tabId });
      },
      async setTitle({ title, tabId }) {
        calls.push({ method: "title", title, tabId });
      },
    },
    calls,
  };
}

function createActionRecorderWithBlockedFirstBadge(): {
  action: ToolbarActionApi;
  calls: ToolbarCall[];
  firstBadgeStarted: Promise<void>;
  releaseFirstBadge(): void;
} {
  const calls: ToolbarCall[] = [];
  let releaseFirstBadge = (): void => undefined;
  let badgeCount = 0;
  let markFirstBadgeStarted = (): void => undefined;
  const firstBadgeStarted = new Promise<void>((resolve) => {
    markFirstBadgeStarted = resolve;
  });

  return {
    action: {
      setBadgeText({ text, tabId }) {
        calls.push({ method: "badge", text, tabId });
        badgeCount += 1;
        if (badgeCount !== 1) {
          return Promise.resolve();
        }

        markFirstBadgeStarted();
        return new Promise<void>((resolve) => {
          releaseFirstBadge = resolve;
        });
      },
      async setBadgeBackgroundColor({ color, tabId }) {
        calls.push({ method: "background", color, tabId });
      },
      async setBadgeTextColor({ color, tabId }) {
        calls.push({ method: "text", color, tabId });
      },
      async setTitle({ title, tabId }) {
        calls.push({ method: "title", title, tabId });
      },
    },
    calls,
    firstBadgeStarted,
    releaseFirstBadge: () => releaseFirstBadge(),
  };
}

describe("toolbar protection status", () => {
  it("presents a verified page as protected", () => {
    expect(getToolbarPresentation({ state: "protected", site: "doubao" })).toEqual({
      badgeText: "ON",
      badgeBackgroundColor: "#15803d",
      badgeTextColor: "#ffffff",
      title: "AI 私密编辑：当前页面已保护",
    });
  });

  it("presents unverified and checking pages without treating them as protected", () => {
    expect(getToolbarPresentation({ state: "unverified", site: "deepseek" })).toEqual({
      badgeText: "!",
      badgeBackgroundColor: "#b45309",
      badgeTextColor: "#ffffff",
      title: "AI 私密编辑：当前页面未验证，按网页原生方式发送",
    });
    expect(getToolbarPresentation({ state: "checking", site: "yuanbao" })).toEqual({
      badgeText: "",
      title: "AI 私密编辑：正在检查此页面",
    });
  });

  it("includes a reply-token diagnostic in the protected title without receiving page text", () => {
    expect(getToolbarPresentation({
      state: "protected",
      site: "chatgpt",
      replyViewer: { state: "waiting_for_reply", containers: 0, tokens: 0 },
    })).toEqual({
      badgeText: "ON",
      badgeBackgroundColor: "#15803d",
      badgeTextColor: "#ffffff",
      title: "AI 私密编辑：当前页面已保护；回复令牌查看：未识别助手回复区域",
    });
  });

  it("writes protected status only for the sender tab", async () => {
    const { action, calls } = createActionRecorder();
    const handleStatus = createToolbarStatusHandler(action);

    await handleStatus(
      {
        type: PROTECTION_STATUS_MESSAGE_TYPE,
        status: { state: "protected", site: "doubao" },
      },
      { tabId: 42, documentId: "document-current" },
    );

    expect(calls).toEqual([
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
    ]);
  });

  it("accepts Gemini's protected status for the sender tab", async () => {
    const { action, calls } = createActionRecorder();
    const handleStatus = createToolbarStatusHandler(action);

    await handleStatus(
      {
        type: PROTECTION_STATUS_MESSAGE_TYPE,
        status: { state: "protected", site: "gemini" },
      },
      { tabId: 42, documentId: "document-current" },
    );

    expect(calls[0]).toEqual({ method: "badge", text: "ON", tabId: 42 });
  });

  it("rejects an invalid status payload without changing toolbar state", async () => {
    const { action, calls } = createActionRecorder();
    const handleStatus = createToolbarStatusHandler(action);

    await handleStatus(
      {
        type: PROTECTION_STATUS_MESSAGE_TYPE,
        status: { state: "protected", site: "doubao" },
        draft: "不应传递的原文",
      },
      { tabId: 42, documentId: "document-current" },
    );

    expect(calls).toEqual([]);
  });

  it("clears a tab badge when a new navigation begins", async () => {
    const { action, calls } = createActionRecorder();
    const resetForNavigation = createNavigationStatusResetter(action);

    await resetForNavigation(42, { status: "complete" });
    expect(calls).toEqual([]);

    await resetForNavigation(42, { status: "loading" });

    expect(calls).toEqual([
      { method: "badge", text: "", tabId: 42 },
      { method: "title", title: "管理自定义敏感词", tabId: 42 },
    ]);
  });

  it("clears a badge for an in-document URL change and accepts the current document again", async () => {
    const { action, calls } = createActionRecorder();
    const { handleStatus, resetForNavigation } = createToolbarStatusHandlers(action);
    const protectedStatus = {
      type: PROTECTION_STATUS_MESSAGE_TYPE,
      status: { state: "protected" as const, site: "doubao" as const },
    };

    await handleStatus(protectedStatus, { tabId: 42, documentId: "document-current" });
    await resetForNavigation(42, { url: "https://www.doubao.com/chat/next" });
    await handleStatus(protectedStatus, { tabId: 42, documentId: "document-current" });

    expect(calls).toEqual([
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
      { method: "badge", text: "", tabId: 42 },
      { method: "title", title: "管理自定义敏感词", tabId: 42 },
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
    ]);
  });

  it("ignores a delayed status report from the previous document", async () => {
    const { action, calls } = createActionRecorder();
    const { handleStatus, resetForNavigation } = createToolbarStatusHandlers(action);
    const protectedStatus = {
      type: PROTECTION_STATUS_MESSAGE_TYPE,
      status: { state: "protected" as const, site: "doubao" as const },
    };

    await handleStatus(protectedStatus, { tabId: 42, documentId: "document-old" });
    await resetForNavigation(42, { status: "loading" });
    await handleStatus(protectedStatus, { tabId: 42, documentId: "document-old" });

    expect(calls).toEqual([
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
      { method: "badge", text: "", tabId: 42 },
      { method: "title", title: "管理自定义敏感词", tabId: 42 },
    ]);

    await handleStatus(protectedStatus, { tabId: 42, documentId: "document-new" });

    expect(calls.slice(-4)).toEqual([
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
    ]);
  });

  it("finishes a pending status update before clearing the next page state", async () => {
    const { action, calls, firstBadgeStarted, releaseFirstBadge } = createActionRecorderWithBlockedFirstBadge();
    const { handleStatus, resetForNavigation } = createToolbarStatusHandlers(action);

    const statusUpdate = handleStatus(
      {
        type: PROTECTION_STATUS_MESSAGE_TYPE,
        status: { state: "protected", site: "doubao" },
      },
      { tabId: 42, documentId: "document-current" },
    );
    await firstBadgeStarted;
    const navigationReset = resetForNavigation(42, { status: "loading" });
    releaseFirstBadge();
    await Promise.all([statusUpdate, navigationReset]);

    expect(calls).toEqual([
      { method: "badge", text: "ON", tabId: 42 },
      { method: "background", color: "#15803d", tabId: 42 },
      { method: "text", color: "#ffffff", tabId: 42 },
      { method: "title", title: "AI 私密编辑：当前页面已保护", tabId: 42 },
      { method: "badge", text: "", tabId: 42 },
      { method: "title", title: "管理自定义敏感词", tabId: 42 },
    ]);
  });
});
