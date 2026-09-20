import type { SessionTokenMap } from "./shared/session-token-map.js";
import type { ReplyViewerDiagnostics } from "./shared/protection-status.js";

const TOKEN_PATTERN = /\[\[[A-Z0-9_]+\]\]/gu;
const TOKEN_HOST_ATTRIBUTE = "data-privacy-token-host";
const REVEAL_LAYER_ATTRIBUTE = "data-privacy-reveal-layer";
const REVEAL_TIMEOUT_MS = 5000;
const TEXT_BLOCK_SELECTOR = "p, pre, li, blockquote, h1, h2, h3, h4, h5, h6, td, th";

export type ReplyTokenViewerDependencies = {
  document: Document;
  tokenMap: SessionTokenMap;
  findContainers: () => readonly HTMLElement[];
  isEnabled: () => boolean;
  onDiagnostics?: (diagnostics: ReplyViewerDiagnostics | null) => void;
  /**
   * 本次 `findContainers` 的结果是否来自站点自己已取证的助手回复选择器。
   *
   * 只影响诊断文案：按令牌定位时"找不到容器"等于"页面上没有令牌"，不是"没认出回复区域"。
   * 缺省视为 true，保持既有调用方的行为不变。
   */
  usesVerifiedReplyRegions?: () => boolean;
};

export type ReplyTokenViewer = {
  attach(): void;
  refresh(): void;
  requestRefresh(): void;
  clearTokenViews(): void;
  detach(): void;
};

function isTextNode(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

function isInsideTokenHost(node: Node): boolean {
  return node.parentElement !== null && node.parentElement.closest(`[${TOKEN_HOST_ATTRIBUTE}]`) !== null;
}

/**
 * 不能在这些元素里插入令牌宿主：那会破坏用户正在写的草稿，或者篡改站点自己的表单状态。
 */
const EDITABLE_ANCESTOR_SELECTOR =
  "textarea, input, [contenteditable='true'], [contenteditable='plaintext-only'], [contenteditable='']";

/**
 * 站点无关地找出页面上"已发送令牌"所在的文本块。
 *
 * 为什么需要它：回复令牌查看原先只认适配器提供的助手回复选择器，而九个站点里只有 ChatGPT 的选择器是
 * 真实取证过的。豆包和 DeepSeek 用的是 `[data-privacy-assistant-reply='true']`——一个真实站点根本不会
 * 出现的合成属性；Kimi、通义千问、文心一言用的是 ChatGPT 的 `data-message-author-role` 属性；Claude、
 * Gemini、元宝压根没声明。结果是这个功能只在 ChatGPT 上成立，其余八个站点静默失效。
 *
 * 这里不猜任何站点的私有结构，而是反过来找**扩展自己造的令牌**：`[[PHONE_001]]` 这类字符串只可能来自
 * 本扩展，并且必须经过 `tokenMap.hasToken` 确认属于当前页面会话，所以不会去装饰页面上的任意文本。
 *
 * 两处必须排除：
 *   - 可编辑区域（输入框）。往草稿里插入元素会破坏用户正在写的内容和站点的输入状态。
 *   - 已经装饰过的令牌宿主，避免重复包裹。
 * 扩展自己的界面由调用方通过 `isExtensionOwned` 排除。
 *
 * 副作用要说清楚：用户自己已发出的消息气泡里的令牌也会变成可点。那是用户自己输入的原文，点开查看无害，
 * 而且拿不到别的东西——原值只存在于当前页面的内容脚本内存里。
 */
export function findSessionTokenBlocks(
  document: Document,
  tokenMap: SessionTokenMap,
  isExtensionOwned: (node: Node) => boolean,
): HTMLElement[] {
  const root = document.body;
  if (root === null) {
    return [];
  }

  const blocks = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, 4);
  let current = walker.nextNode();

  while (current !== null) {
    if (isTextNode(current) && current.data.includes("[[")) {
      const parent = current.parentElement;
      TOKEN_PATTERN.lastIndex = 0;
      const carriesKnownToken = [...current.data.matchAll(TOKEN_PATTERN)].some((match) =>
        tokenMap.hasToken(match[0]),
      );

      if (
        carriesKnownToken &&
        parent !== null &&
        !isExtensionOwned(parent) &&
        parent.closest(EDITABLE_ANCESTOR_SELECTOR) === null &&
        !isInsideTokenHost(current)
      ) {
        blocks.add(getTextBlock(current, parent));
      }
    }
    current = walker.nextNode();
  }

  return [...blocks];
}

type RevealLayer = {
  show(anchor: HTMLElement, rawValue: string): void;
  hide(): void;
  dispose(): void;
};

function createRevealLayer(document: Document): RevealLayer {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let hideTimer: number | null = null;

  const clearTimer = (): void => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const hide = (): void => {
    clearTimer();
    if (host === null || shadow === null) {
      return;
    }

    shadow.replaceChildren();
    host.dataset.state = "hidden";
    host.style.visibility = "hidden";
  };

  const ensure = (): boolean => {
    if (host !== null && shadow !== null && host.isConnected) {
      return true;
    }

    const root = document.body ?? document.documentElement;
    if (root === null) {
      return false;
    }

    host = document.createElement("div");
    host.setAttribute(REVEAL_LAYER_ATTRIBUTE, "true");
    host.dataset.state = "hidden";
    host.setAttribute("aria-live", "polite");
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    host.style.visibility = "hidden";
    shadow = host.attachShadow({ mode: "closed" });
    root.append(host);
    return true;
  };

  return {
    show(anchor, rawValue): void {
      if (!ensure() || host === null || shadow === null) {
        return;
      }

      clearTimer();
      const rect = anchor.getBoundingClientRect();
      host.style.maxWidth = "min(360px, calc(100vw - 16px))";
      const view = document.defaultView;
      const viewportWidth = view?.innerWidth ?? 1024;
      const viewportHeight = view?.innerHeight ?? 768;
      const estimatedWidth = Math.min(360, Math.max(180, rect.width));
      const measuredHeight = host.getBoundingClientRect().height || 42;
      const belowTop = rect.bottom + 6;
      const top = belowTop + measuredHeight <= viewportHeight - 8
        ? belowTop
        : Math.max(8, rect.top - measuredHeight - 6);
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, viewportWidth - estimatedWidth - 8),
      );
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.visibility = "visible";
      host.dataset.state = "visible";

      const style = document.createElement("style");
      style.textContent =
        ":host{display:block;font:12px/1.4 system-ui,sans-serif} .privacy-token-value{display:block;max-width:360px;overflow-wrap:anywhere;padding:6px 8px;border:1px solid #0f766e;border-radius:4px;background:#ecfdf5;color:#134e4a;box-shadow:0 6px 18px rgb(15 118 110 / 24%)}";
      const value = document.createElement("span");
      value.className = "privacy-token-value";
      value.textContent = rawValue;
      shadow.replaceChildren(style, value);

      hideTimer = window.setTimeout(hide, REVEAL_TIMEOUT_MS);
    },
    hide,
    dispose(): void {
      clearTimer();
      shadow?.replaceChildren();
      host?.remove();
      host = null;
      shadow = null;
    },
  };
}

function createTokenHost(
  document: Document,
  token: string,
  tokenMap: SessionTokenMap,
  isEnabled: () => boolean,
  revealLayer: RevealLayer,
): HTMLElement {
  const host = document.createElement("span");
  host.setAttribute(TOKEN_HOST_ATTRIBUTE, "true");
  host.setAttribute("data-privacy-token", token);
  host.setAttribute("role", "button");
  host.setAttribute("tabindex", "0");
  host.setAttribute("aria-label", "查看已匿名化内容");
  host.title = "点击查看当前页面内存中的原值";
  host.textContent = token;

  const reveal = (): void => {
    if (!isEnabled()) {
      revealLayer.hide();
      return;
    }

    const rawValue = tokenMap.getRawValue(token);
    if (rawValue === null) {
      revealLayer.hide();
      return;
    }
    revealLayer.show(host, rawValue);
  };

  host.addEventListener("click", reveal);
  host.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      reveal();
    }
  });
  return host;
}

function getTextBlock(node: Text, container: HTMLElement): HTMLElement {
  let current = node.parentElement;

  while (current !== null && current !== container) {
    if (current.matches(TEXT_BLOCK_SELECTOR)) {
      return current;
    }
    current = current.parentElement;
  }

  return container;
}

type TextSegment = {
  node: Text;
  start: number;
  end: number;
};

function decorateTextBlock(
  block: HTMLElement,
  document: Document,
  tokenMap: SessionTokenMap,
  isEnabled: () => boolean,
  revealLayer: RevealLayer,
): void {
  const walker = document.createTreeWalker(block, 4);
  const textNodes: Text[] = [];
  let current = walker.nextNode();

  while (current !== null) {
    if (isTextNode(current) && !isInsideTokenHost(current) && current.data.length > 0) {
      textNodes.push(current);
    }
    current = walker.nextNode();
  }

  const segments: TextSegment[] = [];
  let source = "";
  for (const node of textNodes) {
    const start = source.length;
    source += node.data;
    segments.push({ node, start, end: source.length });
  }

  const findSegment = (index: number, isEnd: boolean): TextSegment | null => {
    return segments.find((segment) =>
      isEnd
        ? index > segment.start && index <= segment.end
        : index >= segment.start && index < segment.end,
    ) ?? null;
  };

  TOKEN_PATTERN.lastIndex = 0;
  const matches = [...source.matchAll(TOKEN_PATTERN)]
    .filter((match) => tokenMap.hasToken(match[0]))
    .reverse();

  for (const match of matches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const startSegment = findSegment(start, false);
    const endSegment = findSegment(end, true);
    if (startSegment === null || endSegment === null || !startSegment.node.isConnected || !endSegment.node.isConnected) {
      continue;
    }

    const range = document.createRange();
    range.setStart(startSegment.node, start - startSegment.start);
    range.setEnd(endSegment.node, end - endSegment.start);
    range.deleteContents();
    range.insertNode(createTokenHost(document, match[0], tokenMap, isEnabled, revealLayer));
  }
}

function decorateContainer(
  container: HTMLElement,
  document: Document,
  tokenMap: SessionTokenMap,
  isEnabled: () => boolean,
  revealLayer: RevealLayer,
): void {
  const blocks = new Set<HTMLElement>();
  const walker = document.createTreeWalker(container, 4);
  let current = walker.nextNode();
  while (current !== null) {
    if (isTextNode(current) && !isInsideTokenHost(current) && current.data.length > 0) {
      blocks.add(getTextBlock(current, container));
    }
    current = walker.nextNode();
  }

  for (const block of blocks) {
    decorateTextBlock(block, document, tokenMap, isEnabled, revealLayer);
  }
}

function restoreContainer(container: HTMLElement, document: Document): void {
  for (const host of container.querySelectorAll<HTMLElement>(`[${TOKEN_HOST_ATTRIBUTE}]`)) {
    const token = host.getAttribute("data-privacy-token");
    if (token !== null) {
      host.replaceWith(document.createTextNode(token));
    }
  }
}

export function createReplyTokenViewer(dependencies: ReplyTokenViewerDependencies): ReplyTokenViewer {
  const { document, tokenMap, findContainers, isEnabled, onDiagnostics } = dependencies;
  const usesVerifiedReplyRegions = dependencies.usesVerifiedReplyRegions ?? (() => true);
  let attached = false;
  let observer: MutationObserver | null = null;
  let refreshQueued = false;
  const observedContainers = new Set<HTMLElement>();
  const revealLayer = createRevealLayer(document);
  let lastDiagnosticsKey = "";
  let diagnosticsReported = false;

  const reportDiagnostics = (containers: readonly HTMLElement[]): void => {
    const uniqueContainers = [...new Set(containers)];
    if (!isEnabled()) {
      if (diagnosticsReported) {
        diagnosticsReported = false;
        lastDiagnosticsKey = "";
        onDiagnostics?.(null);
      }
      return;
    }

    let tokens = 0;
    for (const container of uniqueContainers) {
      TOKEN_PATTERN.lastIndex = 0;
      for (const match of (container.textContent ?? "").matchAll(TOKEN_PATTERN)) {
        if (tokenMap.hasToken(match[0])) {
          tokens += 1;
        }
      }
    }

    /*
     * `waiting_for_reply`（"未识别回复区域"）只在**依赖站点私有选择器**时才有意义。
     *
     * 走 findSessionTokenBlocks 的站点是反过来按令牌定位的：页面上有已发送令牌就一定能找到容器，没有
     * 令牌就一定找不到。此时把"找不到容器"报成"未识别回复区域"是错的，真实情况是"暂无令牌"。
     */
    const diagnostics: ReplyViewerDiagnostics = {
      state: tokens > 0
        ? "ready"
        : usesVerifiedReplyRegions() && uniqueContainers.length === 0
          ? "waiting_for_reply"
          : "no_tokens",
      containers: uniqueContainers.length,
      tokens,
    };
    const key = JSON.stringify(diagnostics);
    if (key !== lastDiagnosticsKey) {
      lastDiagnosticsKey = key;
      diagnosticsReported = true;
      onDiagnostics?.(diagnostics);
    }
  };

  const observeContainer = (container: HTMLElement): void => {
    if (observer === null || observedContainers.has(container)) {
      return;
    }
    observedContainers.add(container);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
  };

  const refresh = (): void => {
    refreshQueued = false;
    if (!attached) {
      return;
    }

    /*
     * 功能关闭时不做任何容器搜索。
     *
     * 这个顺序是要紧的：回复令牌查看**默认关闭**，而没有站点回复选择器时定位令牌要遍历整篇文档的文本
     * 节点。原先的写法先 findContainers() 再判断开关，于是所有没开这个功能的用户都要白付一次遍历，而且
     * 助手回复流式输出期间每一批 DOM 变更都会触发一次。这里改成先看开关，关闭时只把之前装饰过的令牌还
     * 原回纯文本。
     */
    if (!isEnabled()) {
      reportDiagnostics([]);
      if (document.body !== null) {
        restoreContainer(document.body, document);
      }
      revealLayer.hide();
      return;
    }

    const containers = findContainers().filter(
      (container) => container.ownerDocument === document && container.isConnected,
    );
    reportDiagnostics(containers);

    for (const container of containers) {
      observeContainer(container);
      decorateContainer(container, document, tokenMap, isEnabled, revealLayer);
    }
  };

  const queueRefresh = (): void => {
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    queueMicrotask(refresh);
  };

  return {
    attach(): void {
      if (attached) {
        return;
      }
      attached = true;
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(queueRefresh);
      }
      refresh();
    },
    refresh,
    requestRefresh: queueRefresh,
    clearTokenViews(): void {
      const containers = findContainers().filter(
        (container) => container.ownerDocument === document && container.isConnected,
      );
      for (const container of containers) {
        restoreContainer(container, document);
      }
      revealLayer.hide();
      reportDiagnostics(containers);
    },
    detach(): void {
      attached = false;
      observer?.disconnect();
      observer = null;
      refreshQueued = false;
      observedContainers.clear();
      revealLayer.dispose();
    },
  };
}
