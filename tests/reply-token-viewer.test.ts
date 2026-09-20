import { afterEach, describe, expect, it, vi } from "vitest";

import { createReplyTokenViewer } from "../src/reply-token-viewer.js";
import { createSessionTokenMap } from "../src/shared/session-token-map.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("reply token viewer", () => {
  it("keeps raw values out of document text until a token is activated", () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const reply = document.createElement("article");
    reply.dataset.privacyAssistantReply = "true";
    reply.textContent = "请联系 [[PHONE_001]]";
    document.body.append(reply);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();

    expect(document.body.textContent).toContain("[[PHONE_001]]");
    expect(document.body.textContent).not.toContain("13800138000");
    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();
  });

  it("renders the original only inside a closed shadow root after an explicit click", () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("email", "user@example.com", "user@example.com");
    const reply = document.createElement("article");
    reply.textContent = "邮箱 [[EMAIL_001]]";
    document.body.append(reply);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();
    const host = reply.querySelector<HTMLElement>("[data-privacy-token-host]");

    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
    host?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(document.body.textContent).not.toContain("user@example.com");
  });

  it("does not decorate unknown tokens or text outside a returned container", () => {
    const tokens = createSessionTokenMap();
    const reply = document.createElement("article");
    reply.textContent = "未知 [[PHONE_999]]";
    const outside = document.createElement("p");
    outside.textContent = "已知 [[PHONE_001]]";
    document.body.append(reply, outside);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();

    expect(reply.querySelector("[data-privacy-token-host]")).toBeNull();
    expect(outside.querySelector("[data-privacy-token-host]")).toBeNull();
  });

  it("decorates a mapped token appended by streamed text inside an observed reply", async () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const reply = document.createElement("article");
    const text = document.createTextNode("生成中：");
    reply.append(text);
    document.body.append(reply);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();
    text.data += " [[PHONE_001]]";
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();
  });

  it("decorates a mapped token split across streamed text nodes", () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const reply = document.createElement("article");
    reply.append(document.createTextNode("请联系 [[PHONE_"), document.createTextNode("001]]"));
    document.body.append(reply);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();

    expect(reply.querySelector("[data-privacy-token-host]")?.textContent).toBe("[[PHONE_001]]");
  });

  it("shows an extension-owned reveal layer after a token is activated and hides it after five seconds", () => {
    vi.useFakeTimers();
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const reply = document.createElement("article");
    reply.textContent = "请联系 [[PHONE_001]]";
    document.body.append(reply);

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => true,
    });
    viewer.attach();

    const token = reply.querySelector<HTMLElement>("[data-privacy-token-host]");
    token?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const layer = document.querySelector<HTMLElement>("[data-privacy-reveal-layer='true']");
    expect(layer?.dataset.state).toBe("visible");
    expect(document.body.textContent).not.toContain("13800138000");

    vi.advanceTimersByTime(5000);
    expect(layer?.dataset.state).toBe("hidden");
  });

  it("places a reveal layer above a token near the bottom of the viewport", () => {
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });
    try {
      const tokens = createSessionTokenMap();
      tokens.getOrCreate("phone", "13800138000", "13800138000");
      const reply = document.createElement("article");
      reply.textContent = "请联系 [[PHONE_001]]";
      document.body.append(reply);
      const viewer = createReplyTokenViewer({
        document,
        tokenMap: tokens,
        findContainers: () => [reply],
        isEnabled: () => true,
      });
      viewer.attach();
      const token = reply.querySelector<HTMLElement>("[data-privacy-token-host]");
      Object.defineProperty(token, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ left: 20, top: 84, right: 140, bottom: 92, width: 120, height: 8, x: 20, y: 84, toJSON: () => ({}) }),
      });

      token?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      const layer = document.querySelector<HTMLElement>("[data-privacy-reveal-layer='true']");
      expect(Number.parseFloat(layer?.style.top ?? "NaN")).toBeLessThan(84);
    } finally {
      if (originalInnerHeight === undefined) {
        delete (window as { innerHeight?: number }).innerHeight;
      } else {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
    }
  });

  it("reports when an enabled viewer has not yet found an assistant reply container", () => {
    const diagnostics: unknown[] = [];
    const viewer = createReplyTokenViewer({
      document,
      tokenMap: createSessionTokenMap(),
      findContainers: () => [],
      isEnabled: () => true,
      onDiagnostics: (next) => diagnostics.push(next),
    });

    viewer.attach();

    expect(diagnostics).toContainEqual({ state: "waiting_for_reply", containers: 0, tokens: 0 });
  });

  it("coalesces repeated refresh requests into one container scan", async () => {
    const reply = document.createElement("article");
    document.body.append(reply);
    let scans = 0;
    const viewer = createReplyTokenViewer({
      document,
      tokenMap: createSessionTokenMap(),
      findContainers: () => {
        scans += 1;
        return [reply];
      },
      isEnabled: () => true,
    });
    viewer.attach();
    const baseline = scans;

    viewer.requestRefresh();
    viewer.requestRefresh();
    viewer.requestRefresh();
    await Promise.resolve();

    expect(scans).toBe(baseline + 1);
  });

  it("observes a reply container that appears after the viewer is attached", async () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const replies: HTMLElement[] = [];
    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => replies,
      isEnabled: () => true,
    });
    viewer.attach();

    const reply = document.createElement("article");
    const text = document.createTextNode("生成中：");
    reply.append(text);
    document.body.append(reply);
    replies.push(reply);
    viewer.refresh();
    text.data += " [[PHONE_001]]";
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();
  });

  it("restores extension-owned token hosts when viewing is disabled", () => {
    const tokens = createSessionTokenMap();
    tokens.getOrCreate("phone", "13800138000", "13800138000");
    const reply = document.createElement("article");
    reply.textContent = "请联系 [[PHONE_001]]";
    document.body.append(reply);
    let enabled = true;

    const viewer = createReplyTokenViewer({
      document,
      tokenMap: tokens,
      findContainers: () => [reply],
      isEnabled: () => enabled,
    });
    viewer.attach();
    expect(reply.querySelector("[data-privacy-token-host]")).not.toBeNull();

    enabled = false;
    viewer.refresh();

    expect(reply.querySelector("[data-privacy-token-host]")).toBeNull();
    expect(reply.textContent).toBe("请联系 [[PHONE_001]]");
  });
});
