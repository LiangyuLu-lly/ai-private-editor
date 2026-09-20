import { describe, expect, it, vi } from "vitest";

import {
  configureActionPanel,
  createBackgroundMessageHandler,
  decideWelcomeOpen,
  isFillDraftMessage,
} from "../src/background.js";

const trustedSidePanel = { id: "extension-id", url: "chrome-extension://extension-id/sidepanel.html" };
const bindingKey = "a".repeat(36);

describe("background message boundary", () => {
  it("accepts only a site-bound fill message with the outboundText field", () => {
    expect(isFillDraftMessage({ type: "FILL_DRAFT", outboundText: "[[PHONE_001]]", site: "chatgpt", tabId: 42, bindingKey })).toBe(true);
    expect(isFillDraftMessage({ type: "FILL_DRAFT", outboundText: "[[PHONE_001]]" })).toBe(false);
    expect(isFillDraftMessage({ type: "FILL_DRAFT", site: "chatgpt", tabId: 42, bindingKey, draft: "原文" })).toBe(false);
    expect(isFillDraftMessage({ type: "FILL_DRAFT", outboundText: "[[PHONE_001]]", site: "chatgpt", tabId: 42, bindingKey, draft: "原文" })).toBe(
      false,
    );
  });

  it("relays only a trusted side panel payload without adding or inspecting a draft field", async () => {
    const relayed: unknown[] = [];
    const handleMessage = createBackgroundMessageHandler(
      async (message) => {
        relayed.push(message);
        return { ok: true };
      },
      (sender) => sender.id === trustedSidePanel.id && sender.url === trustedSidePanel.url,
    );

    const fill = { type: "FILL_DRAFT" as const, outboundText: "[[EMAIL_001]]", site: "claude" as const, tabId: 91, bindingKey };
    await expect(handleMessage(fill, trustedSidePanel)).resolves.toEqual({
      ok: true,
    });
    await expect(handleMessage(fill, {})).resolves.toEqual({
      ok: false,
      error: "invalid_message",
    });
    await expect(handleMessage({ type: "FILL_DRAFT", draft: "原文" }, trustedSidePanel)).resolves.toEqual({
      ok: false,
      error: "invalid_message",
    });
    expect(relayed).toEqual([fill]);
  });

  it("returns Gemini from the actual active-tab message boundary for the trusted side panel", async () => {
    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    const query = vi.fn().mockResolvedValue([{ id: 42 }]);
    const sendMessage = vi.fn().mockResolvedValue({ site: "gemini", bindingKey });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          id: trustedSidePanel.id,
          getURL: (path: string) => `chrome-extension://${trustedSidePanel.id}/${path}`,
        },
        tabs: { query, sendMessage },
      },
    });

    try {
      await expect(createBackgroundMessageHandler()({ type: "PING" }, trustedSidePanel)).resolves.toEqual({
        site: "gemini",
        tabId: 42,
        bindingKey,
      });
      expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(sendMessage).toHaveBeenCalledWith(42, { type: "PING" });
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
      }
    }
  });

  it("forwards a checked fill only to its bound tab", async () => {
    const originalChrome = (globalThis as { chrome?: unknown }).chrome;
    const query = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          id: trustedSidePanel.id,
          getURL: (path: string) => `chrome-extension://${trustedSidePanel.id}/${path}`,
        },
        tabs: { query, sendMessage },
      },
    });

    const fill = { type: "FILL_DRAFT" as const, outboundText: "[[PHONE_001]]", site: "doubao" as const, tabId: 91, bindingKey };
    try {
      await expect(createBackgroundMessageHandler()(fill, trustedSidePanel)).resolves.toEqual({ ok: true });
      expect(query).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(91, fill);
    } finally {
      if (originalChrome === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        Object.defineProperty(globalThis, "chrome", { configurable: true, value: originalChrome });
      }
    }
  });

  it("keeps the toolbar action assigned to the settings popup", async () => {
    const setPanelBehavior = vi.fn().mockResolvedValue(undefined);

    await configureActionPanel({ setPanelBehavior });

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });
});

describe("welcome open policy", () => {
  it("opens the first-run page on install and remembers the notice", async () => {
    const markNotice = vi.fn().mockResolvedValue(undefined);
    await expect(decideWelcomeOpen("install", async () => undefined, markNotice)).resolves.toBe("welcome");
    expect(markNotice).toHaveBeenCalledOnce();
  });

  it("opens the update notice once for existing users", async () => {
    const markNotice = vi.fn().mockResolvedValue(undefined);
    await expect(decideWelcomeOpen("update", async () => undefined, markNotice)).resolves.toBe("welcome-update");
    expect(markNotice).toHaveBeenCalledOnce();
    await expect(decideWelcomeOpen("update", async () => true, markNotice)).resolves.toBe("none");
  });

  it("ignores chrome_update", async () => {
    const markNotice = vi.fn();
    await expect(decideWelcomeOpen("chrome_update", async () => undefined, markNotice)).resolves.toBe("none");
    expect(markNotice).not.toHaveBeenCalled();
  });
});
