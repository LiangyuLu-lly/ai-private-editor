import {
  createPreSendController,
  type PreSendController,
  type SensitiveSendDecision,
  type SemanticReviewGateResult,
  type ToastState,
} from "./pre-send.js";
import { createPasteGuard } from "./paste-guard.js";
import {
  createChromeCustomTermsStore,
  createCustomTermsCache,
  DEFAULT_ADVANCED_SETTINGS,
  type CustomTermsCache,
} from "./shared/custom-terms.js";
import { createChromeAuditLogStore, type AuditEventInput, type AuditLogStore } from "./shared/audit-log.js";
import { isFillDraftMessage, isPingMessage, isQueryProtectionStatusMessage } from "./shared/messages.js";
import { createSessionTokenMap } from "./shared/session-token-map.js";
import { createChromeSessionClearSignal, type SessionClearSignal } from "./shared/session-clear.js";
import { createLocalStatisticalSemanticProvider } from "./shared/semantic-review.js";
import { createNeuralReviewClient, MAX_NEURAL_REVIEW_CHARACTERS } from "./shared/neural/client.js";
import {
  combineSemanticProviders,
  createCachedNeuralProvider,
  createNeuralHintCache,
} from "./shared/neural/hint-cache.js";
import { createReplyTokenViewer, findSessionTokenBlocks, type ReplyTokenViewer } from "./reply-token-viewer.js";
import {
  PROTECTION_STATUS_MESSAGE_TYPE,
  type ReplyViewerDiagnostics,
  type ProtectionStatus,
} from "./shared/protection-status.js";
import type { RedactionFinding, RuntimeResponse } from "./shared/types.js";
import { assessSiteAdapterHealth, type SiteAdapterHealth } from "./sites/health.js";
import { readEditorText, writeEditorText } from "./sites/editor.js";
import { getSiteAdapter } from "./sites/registry.js";
import type { EditableElement } from "./sites/types.js";
import { createSensitiveSendConfirmation } from "./sensitive-confirmation.js";
import { resolveScopedAllowlistedTerms } from "./shared/allowlist.js";
import { getDetectionRanges } from "./shared/detector.js";
import {
  buildHighlightRanges,
  createHighlightOverlayFactory,
} from "./shared/highlight-ranges.js";
import { mergeCategoryPolicies } from "./shared/policy-overlay.js";

export type InlineRedactionContext = {
  document: Document;
  url: URL;
  getCurrentUrl?: () => URL;
  runtimeBuildRevision?: string | null;
  customTermsCache?: CustomTermsCache;
  auditLog?: AuditLogStore;
  sessionClearSignal?: SessionClearSignal;
  isUserInitiated?: (event: Event) => boolean;
  afterInput?: (callback: () => void) => void;
  confirmSensitiveSend?: (findings: readonly RedactionFinding[]) => Promise<SensitiveSendDecision>;
  confirmSensitivePaste?: (findings: readonly RedactionFinding[]) => Promise<SensitiveSendDecision>;
  confirmUnreviewedSend?: (reason: string) => Promise<boolean>;
  confirmUnreviewedPaste?: (reason: string) => Promise<boolean>;
  confirmAttachmentSend?: (action: "confirm" | "block", unverified?: boolean) => Promise<boolean>;
  reportProtectionStatus?: (status: ProtectionStatus) => void;
};

const TOAST_TIMEOUT_MS = 3600;
const UNVERIFIED_BANNER_ID = "privacy-composer-unverified-banner";
const HIGHLIGHT_OVERLAY_ID = "privacy-composer-highlight-overlay";
declare const __CONTENT_BUILD_REVISION__: string | undefined;
export const CONTENT_BUILD_REVISION = typeof __CONTENT_BUILD_REVISION__ === "string"
  ? __CONTENT_BUILD_REVISION__
  : "source-test-build";

function showToast(document: Document, message: string, state: ToastState): void {
  const body = document.body;

  if (body === null) {
    return;
  }

  document.getElementById("privacy-composer-toast")?.remove();

  const toast = document.createElement("div");
  toast.id = "privacy-composer-toast";
  toast.className = "privacy-composer-toast";
  toast.setAttribute("role", "status");
  toast.dataset.state = state;
  toast.textContent = message;
  body.append(toast);

  document.defaultView?.setTimeout(() => toast.remove(), TOAST_TIMEOUT_MS);
}

function unverifiedBannerMessage(reason: string | undefined): string {
  return reason === undefined
    ? "当前页面未验证，敏感文本可能按原文发送。请刷新或等待适配更新。"
    : `当前页面未验证（${reason}），敏感文本可能按原文发送。请刷新或等待适配更新。`;
}

function showUnverifiedBanner(document: Document, reason: string | undefined): void {
  const body = document.body;
  if (body === null) {
    return;
  }

  let banner = document.getElementById(UNVERIFIED_BANNER_ID);
  if (banner === null) {
    banner = document.createElement("div");
    banner.id = UNVERIFIED_BANNER_ID;
    banner.className = "privacy-composer-toast";
    banner.setAttribute("role", "status");
    banner.dataset.state = "warning";
    body.append(banner);
  }
  banner.textContent = unverifiedBannerMessage(reason);
}

function hideUnverifiedBanner(document: Document): void {
  document.getElementById(UNVERIFIED_BANNER_ID)?.remove();
}

function hideHighlightOverlay(document: Document): void {
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
}

function readRuntimeBuildRevision(): string | null {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getManifest !== "function") {
    return null;
  }

  try {
    const versionName = chrome.runtime.getManifest().version_name;
    return typeof versionName === "string" ? versionName : null;
  } catch {
    return null;
  }
}

function warnStalePageScript(document: Document): void {
  const showWarning = () => showToast(document, "保护规则已更新，请刷新当前网页后继续发送。", "warning");

  if (document.body === null) {
    document.addEventListener("DOMContentLoaded", showWarning, { once: true });
    return;
  }

  showWarning();
}

function reportChromeProtectionStatus(status: ProtectionStatus): void {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return;
  }

  try {
    void chrome.runtime
      .sendMessage({ type: PROTECTION_STATUS_MESSAGE_TYPE, status })
      .catch(() => undefined);
  } catch {
    // The status indicator must never affect the local redaction path.
  }
}

function touchesElement(node: Node, element: Element): boolean {
  return node === element || element.contains(node) || (node instanceof Element && node.contains(element));
}

function isExtensionOwnedNode(node: Node): boolean {
  if (!(node instanceof Element)) {
    return false;
  }

  return (
    node.id.startsWith("privacy-composer-") ||
    node.hasAttribute("data-privacy-token-host") ||
    node.hasAttribute("data-privacy-reveal-layer") ||
    node.closest("[data-privacy-token-host], [data-privacy-reveal-layer]") !== null
  );
}

export type PrivateComposerMessageHandler = (message: unknown) => RuntimeResponse | null;

export function createPrivateComposerBindingKey(): string {
  // 绑定键是侧栏填入请求能否写入本页面的唯一凭据，必须不可预测。
  // 因此不提供 Math.random 回退：可预测的绑定键等于取消这道校验，
  // 而扩展内容脚本环境必定提供 crypto.getRandomValues，取不到即属异常环境，直接失败。
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error("A cryptographic random source is required to bind the private composer.");
  }

  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 输入框里现在有没有非空白文本。
 *
 * 读取失败按"没有"处理：这个判断只用来决定要不要报"未验证"，而站点正在重渲染、读取抛错的那一刻更不该
 * 弹一次警告。
 */
function composerHasText(editor: EditableElement): boolean {
  try {
    return readEditorText(editor).trim().length > 0;
  } catch {
    return false;
  }
}

export function createPrivateComposerMessageHandler(
  document: Document,
  getCurrentUrl: () => URL,
  bindingKey = createPrivateComposerBindingKey(),
): PrivateComposerMessageHandler {
  return (message) => {
    const adapter = getSiteAdapter(getCurrentUrl());

    if (isPingMessage(message)) {
      return adapter === null ? { site: null } : { site: adapter.id, bindingKey };
    }

    if (!isFillDraftMessage(message)) {
      return null;
    }

    if (adapter === null) {
      return { ok: false, error: "unsupported_site" };
    }
    if (message.site !== adapter.id) {
      return { ok: false, error: "site_changed" };
    }
    if (message.bindingKey !== bindingKey) {
      return { ok: false, error: "binding_changed" };
    }

    /*
     * 填入路径只依赖输入框，不依赖发送按钮。
     *
     * 这里原先用的是完整的 `assessSiteAdapterHealth`，于是发送按钮不可用或尚未渲染时就返回
     * `editor_not_found`，界面上正是用户报告的"检测不到输入框"。Gemini 在输入框为空时根本不渲染发送
     * 按钮，所以侧边栏"填入网页"在刚打开的空白页面上必然失败——而私密编辑器的典型用法恰恰就是往空
     * 输入框里填。
     *
     * 放宽这一处不降低隐私性：填入的是侧边栏已经脱敏过的出站文本，而且填入不发送。发送路径能否验证
     * 由 pre-send.ts 在真实发送那一刻独立判断，工具栏徽标也仍然按完整健康检查显示，所以不会因为这次
     * 写入成功就宣称页面已受保护。
     */
    const editor = adapter.findEditor(document);
    if (editor === null) {
      return { ok: false, error: "editor_not_found" };
    }

    return writeEditorText(editor, message.outboundText)
      ? { ok: true }
      : { ok: false, error: "write_failed" };
  };
}

export function bootstrapInlineRedaction(
  context: InlineRedactionContext = {
    document,
    url: new URL(window.location.href),
    getCurrentUrl: () => new URL(window.location.href),
  },
): PreSendController | null {
  const getCurrentUrl = context.getCurrentUrl ?? (() => context.url);
  const adapter = getSiteAdapter(getCurrentUrl());
  if (adapter === null) {
    return null;
  }

  const runtimeBuildRevision = context.runtimeBuildRevision === undefined
    ? readRuntimeBuildRevision()
    : context.runtimeBuildRevision;
  if (runtimeBuildRevision !== null && runtimeBuildRevision !== CONTENT_BUILD_REVISION) {
    warnStalePageScript(context.document);
    return null;
  }

  let lastReportedStatus: ProtectionStatus | null = null;
  const handlePrivateComposerMessage = createPrivateComposerMessageHandler(context.document, getCurrentUrl);
  const runtimeMessageListener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): void => {
    if (isQueryProtectionStatusMessage(message)) {
      sendResponse({ status: lastReportedStatus });
      return;
    }
    const response = handlePrivateComposerMessage(message);
    if (response !== null) {
      sendResponse(response);
    }
  };
  const canReceivePrivateComposerMessages =
    typeof chrome !== "undefined" &&
    typeof chrome.runtime?.onMessage?.addListener === "function" &&
    typeof chrome.runtime.onMessage.removeListener === "function";
  if (canReceivePrivateComposerMessages) {
    chrome.runtime.onMessage.addListener(runtimeMessageListener);
  }

  const cache = context.customTermsCache ?? createCustomTermsCache(createChromeCustomTermsStore());
  const auditLog = context.auditLog ?? createChromeAuditLogStore();
  const sessionTokenMap = createSessionTokenMap();
  const sessionAllowlistedTerms = new Set<string>();
  /*
   * Semantic review is the union of two providers.
   *
   * The rule and lexicon path is synchronous and always available. The neural half reads a cache
   * that the offscreen model fills while the user types, keyed on the exact draft text; a miss
   * returns nothing for the synchronous preview path, while the R9 send gate forces an exact final
   * review before allowing the page's native event to re-enter.
   *
   * The model is normally warmed while typing. The send controller also calls `reviewNow` for
   * the exact final draft, after stopping the native event, so the page cannot send a stale or
   * unreviewed value.
   */
  const neuralHintCache = createNeuralHintCache();
  const localSemanticProvider = combineSemanticProviders(
    createLocalStatisticalSemanticProvider(),
    createCachedNeuralProvider(neuralHintCache),
  );
  const neuralReviewClient = createNeuralReviewClient({
    cache: neuralHintCache,
    transport: (message) => chrome.runtime.sendMessage(message),
  });
  const canEnsureSemanticReview =
    typeof chrome !== "undefined" && typeof chrome.runtime?.sendMessage === "function";

  const ensureSemanticReview = async (text: string): Promise<SemanticReviewGateResult> => {
    const snapshot = cache.getSnapshot();
    // Inline unit harnesses do not expose Chrome's runtime bridge. They exercise the synchronous
    // rule path; a real extension content script always has this bridge, and then an unavailable
    // model is surfaced to the user instead of being silently treated as reviewed.
    if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
      return { ok: true };
    }
    if (snapshot.state !== "ready") {
      return { ok: false, reason: "本地语义复核未完成" };
    }
    if ((snapshot.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview) !== "local_neural") {
      return { ok: false, reason: "本地语义模型未启用" };
    }
    if (text.length === 0) {
      return { ok: true };
    }
    if (text.length > MAX_NEURAL_REVIEW_CHARACTERS) {
      return { ok: false, reason: `当前草稿超过本地语义复核上限（${MAX_NEURAL_REVIEW_CHARACTERS} 个字符）` };
    }
    const reviewed = await neuralReviewClient.reviewNow(text);
    const latest = cache.getSnapshot();
    if (reviewed) {
      return { ok: true };
    }
    if (latest.state !== "ready") {
      return { ok: false, reason: "本地语义复核未完成" };
    }
    if ((latest.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview) !== "local_neural") {
      return { ok: false, reason: "本地语义模型未启用" };
    }
    return { ok: false, reason: "本地语义模型暂时不可用或复核未完成" };
  };

  /*
   * Ask the offscreen model to review the draft as it is typed.
   *
   * Runs on `input` in the capture phase so it sees the composer regardless of how the site
   * handles the event. Everything expensive is behind the client's debounce and length tier, and
   * a review is only requested when the user has opted into the neural mode.
   */
  const scheduleNeuralReview = (event: Event): void => {
    const snapshot = cache.getSnapshot();
    if (
      snapshot.state !== "ready" ||
      (snapshot.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview) !== "local_neural"
    ) {
      return;
    }
    const health = assessSiteAdapterHealth(document, new URL(location.href));
    if (health.state !== "ready") {
      return;
    }
    // Only the composer's own input matters; a search box on the same page must not be sent.
    if (event.target !== health.editor) {
      return;
    }
    try {
      neuralReviewClient.schedule(readEditorText(health.editor));
    } catch {
      // Reading the editor can throw while the site re-renders. A missed review is a cache
      // miss; the send-time gate will surface that state if the draft is submitted before a
      // successful exact review is cached.
    }
  };
  const sessionClearSignal = context.sessionClearSignal ?? createChromeSessionClearSignal();
  const reportProtectionStatus = context.reportProtectionStatus ?? reportChromeProtectionStatus;
  let lastReportedStatusKey: string | null = null;
  let highlightRangeKey = "";
  const highlightOverlayFactory = createHighlightOverlayFactory(context.document);
  let replyViewerDiagnostics: ReplyViewerDiagnostics | undefined;
  let statusObserver: MutationObserver | null = null;
  let statusCheckQueued = false;
  let statusTrackingDisposed = false;
  let lastCheckedUrl = getCurrentUrl().href;
  let verifiedEditor: Element | null = null;
  let verifiedSendControl: Element | null = null;
  const sensitiveConfirmation = context.confirmSensitiveSend === undefined || context.confirmSensitivePaste === undefined ||
    context.confirmAttachmentSend === undefined
    ? createSensitiveSendConfirmation(context.document)
    : null;
  let confirmationDisposed = false;
  let replyTokenViewer: ReplyTokenViewer | null = null;
  let replyTokenViewerUnsubscribe: (() => void) | null = null;
  let sessionClearUnsubscribe: (() => void) | null = null;

  const recordAudit = (event: AuditEventInput): void => {
    try {
      void Promise.resolve(auditLog.append(event)).catch(() => undefined);
    } catch {
      // Local audit failures must never affect local protection.
    }
  };

  /*
   * 未验证的原因，写进提示文案。
   *
   * 徽标与提示本来就有了，所以失效不是静默的；缺的是**原因**。用户报"这个站不工作了"时，如果提示里
   * 带着到底哪一步没找到，开发者就知道该改哪个选择器，否则只能从零复现。
   *
   * 只出现在提示里，不进 `ProtectionStatus` 消息：那个协议跨上下文并且有严格校验器，为一句诊断文案
   * 加字段要连带改校验、类型与测试，而收益只在诊断层面。
   */
  const unverifiedReasonText = (reason: Extract<SiteAdapterHealth, { state: "unverified" }>["reason"]): string => {
    switch (reason) {
      case "editor_not_found":
        return "找不到输入框";
      case "composer_root_not_found":
        return "输入区结构与预期不符";
      default:
        return "页面结构与预期不符";
    }
  };

  const syncHighlightOverlay = (editor: EditableElement): void => {
    if (statusTrackingDisposed) {
      return;
    }

    let text: string;
    try {
      text = readEditorText(editor);
    } catch {
      highlightRangeKey = "";
      hideHighlightOverlay(context.document);
      return;
    }

    const snapshot = cache.getSnapshot();
    const customTerms = snapshot.state === "ready" ? snapshot.terms.map((term) => term.value) : [];
    const allowlistedTerms = snapshot.state === "ready"
      ? resolveScopedAllowlistedTerms(snapshot, adapter.id, sessionAllowlistedTerms)
      : [];
    const categoryPolicies = snapshot.state === "ready"
      ? mergeCategoryPolicies(snapshot.categoryPolicies ?? [], snapshot.siteCategoryPolicies ?? [], adapter.id)
      : [];
    const detectionProfile = snapshot.state === "ready"
      ? snapshot.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile
      : DEFAULT_ADVANCED_SETTINGS.detectionProfile;
    const semanticReview = snapshot.state === "ready"
      ? snapshot.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview
      : "off";
    const ranges = buildHighlightRanges(
      text,
      getDetectionRanges(text, customTerms, allowlistedTerms, categoryPolicies, {
        detectionProfile,
        ...(semanticReview === "off" ? {} : { semanticReviewProvider: localSemanticProvider }),
      }),
    );
    const nextKey = ranges.map((range) => `${range.kind}:${range.start}:${range.end}`).join("|");
    const existing = context.document.getElementById(HIGHLIGHT_OVERLAY_ID);
    if (ranges.length === 0) {
      highlightRangeKey = "";
      hideHighlightOverlay(context.document);
      return;
    }
    if (existing !== null && existing.previousElementSibling === editor && highlightRangeKey === nextKey) {
      return;
    }

    const overlay = highlightOverlayFactory.create(ranges);
    overlay.id = HIGHLIGHT_OVERLAY_ID;
    if (existing !== null && existing.previousElementSibling === editor) {
      existing.replaceChildren(...Array.from(overlay.children));
      highlightRangeKey = nextKey;
      return;
    }

    existing?.remove();
    editor.insertAdjacentElement("afterend", overlay);
    highlightRangeKey = nextKey;
  };

  const reportStatus = (state: ProtectionStatus["state"], reason?: string): void => {
    const status: ProtectionStatus = {
      state,
      site: adapter.id,
      ...(replyViewerDiagnostics === undefined ? {} : { replyViewer: replyViewerDiagnostics }),
    };
    const statusKey = JSON.stringify(status);
    if (lastReportedStatusKey === statusKey) {
      return;
    }

    lastReportedStatusKey = statusKey;
    lastReportedStatus = status;
    switch (state) {
      case "unverified":
        showUnverifiedBanner(context.document, reason);
        break;
      case "protected":
      case "checking":
        hideUnverifiedBanner(context.document);
        break;
    }
    reportProtectionStatus(status);
  };

  const checkStatus = (): void => {
    statusCheckQueued = false;
    if (statusTrackingDisposed) {
      return;
    }

    const currentUrl = getCurrentUrl();
    lastCheckedUrl = currentUrl.href;
    const health = assessSiteAdapterHealth(context.document, currentUrl);
    if (health.state === "ready") {
      verifiedEditor = health.editor;
      verifiedSendControl = health.sendControl;

      /*
       * 发送控件不在 DOM 里时，用"输入框里有没有字"来决定这算空闲还是失效。
       *
       * 健康检查本身不再要求发送控件存在（见 src/sites/health.ts）：多数站点在输入框为空时不渲染发送
       * 按钮，把那当失效会让每个站点每次打开页面都误报。但"看不到发送按钮"和"选择器已失效"在 DOM 上
       * 是同一个观察结果，所以徽标这一层需要一个判别依据：
       *
       *   - 输入框是空的 → 空闲状态。没有要保护的文本，报 protected 不构成任何虚假承诺，而且粘贴拦截、
       *     输入时语义检查、Enter/表单提交拦截此刻都已经挂上了。
       *   - 输入框里有字却仍然找不到发送按钮 → 点击这条路已经无法被识别（pre-send 对点击一律返回
       *     false），此时报 protected 就是假称已保护。老实报未验证，顺带给出定位选择器需要的原因。
       *
       * 首次击键的竞态：站点通常在插入文本的同一次渲染里插入按钮，而状态检查由 MutationObserver 触发
       * 并经 queueMicrotask 合并，所以这里读到的是同一批 DOM 变更之后的状态。万一站点分两帧渲染，
       * 下一批变更会立刻把状态改回 protected。
       */
      if (health.sendControl === null && composerHasText(health.editor)) {
        reportStatus("unverified", "找不到发送按钮");
        highlightRangeKey = "";
        hideHighlightOverlay(context.document);
        return;
      }

      reportStatus("protected");
      syncHighlightOverlay(health.editor);
      return;
    }

    verifiedEditor = null;
    verifiedSendControl = null;
    reportStatus(
      context.document.readyState === "complete" ? "unverified" : "checking",
      health.state === "unverified" ? unverifiedReasonText(health.reason) : undefined,
    );
    highlightRangeKey = "";
    hideHighlightOverlay(context.document);
  };

  const needsStatusCheck = (mutations: readonly MutationRecord[]): boolean => {
    if (lastCheckedUrl !== getCurrentUrl().href || verifiedEditor === null || verifiedSendControl === null) {
      return true;
    }
    const editor = verifiedEditor;
    const sendControl = verifiedSendControl;
    if (!editor.isConnected || !sendControl.isConnected) {
      return true;
    }

    return mutations.some((mutation) => {
      if (
        mutation.type === "attributes" &&
        !isExtensionOwnedNode(mutation.target) &&
        (touchesElement(mutation.target, editor) || touchesElement(mutation.target, sendControl))
      ) {
        return true;
      }
      const targetIsDocumentRoot = mutation.target === context.document.body || mutation.target === context.document.documentElement;
      if (
        mutation.type === "childList" &&
        !targetIsDocumentRoot &&
        !isExtensionOwnedNode(mutation.target) &&
        (touchesElement(mutation.target, editor) || touchesElement(mutation.target, sendControl))
      ) {
        return true;
      }
      return Array.from(mutation.addedNodes).some(
        (node) => !isExtensionOwnedNode(node) && (touchesElement(node, editor) || touchesElement(node, sendControl)),
      ) || Array.from(mutation.removedNodes).some(
        (node) => !isExtensionOwnedNode(node) && (touchesElement(node, editor) || touchesElement(node, sendControl)),
      );
    });
  };

  const queueStatusCheck = (): void => {
    if (statusTrackingDisposed || statusCheckQueued) {
      return;
    }

    statusCheckQueued = true;
    queueMicrotask(checkStatus);
  };

  reportStatus("checking");
  if (typeof MutationObserver !== "undefined") {
    statusObserver = new MutationObserver((mutations) => {
      if (needsStatusCheck(mutations)) {
        queueStatusCheck();
      }
      if (mutations.some((mutation) => mutation.type === "childList")) {
        replyTokenViewer?.requestRefresh();
      }
    });
    statusObserver.observe(context.document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-disabled", "aria-label", "class", "contenteditable", "disabled", "id"],
    });
  }
  context.document.defaultView?.addEventListener("load", queueStatusCheck, { once: true });
  queueStatusCheck();

  cache.start();
  sessionClearUnsubscribe = sessionClearSignal.subscribe(() => {
    sessionTokenMap.clear();
    sessionAllowlistedTerms.clear();
    replyTokenViewer?.clearTokenViews();
    showToast(context.document, "已清除当前页面的会话令牌映射和本会话放行。", "success");
  });

  const inner = createPreSendController({
    document: context.document,
    url: getCurrentUrl,
    notify: (message, state) => showToast(context.document, message, state),
    getCustomTermsSnapshot: () => cache.getSnapshot(),
    sessionTokenMap,
    isUserInitiated: context.isUserInitiated,
    afterInput: context.afterInput,
    sessionAllowlistedTerms,
    recordAudit,
    getSemanticReviewProvider: () => localSemanticProvider,
    confirmAttachmentSend:
      context.confirmAttachmentSend ?? ((action, unverified) =>
        sensitiveConfirmation?.requestAttachment(action === "block", unverified === true) ?? Promise.resolve(false)),
    confirmSensitiveSend:
      context.confirmSensitiveSend ?? ((findings) => sensitiveConfirmation?.request(findings, "send") ?? Promise.resolve("cancel")),
    ...(canEnsureSemanticReview ? { ensureSemanticReview } : {}),
    ...(canEnsureSemanticReview ? {
      confirmUnreviewedSend:
      context.confirmUnreviewedSend ?? ((reason) => sensitiveConfirmation?.requestUnreviewed(reason) ?? Promise.resolve(false)),
    } : {}),
  });
  const pasteGuard = createPasteGuard({
    document: context.document,
    url: getCurrentUrl,
    notify: (message, state) => showToast(context.document, message, state),
    getCustomTermsSnapshot: () => cache.getSnapshot(),
    sessionTokenMap,
    sessionAllowlistedTerms,
    recordAudit,
    getSemanticReviewProvider: () => localSemanticProvider,
    confirmSensitivePaste:
      context.confirmSensitivePaste ?? ((findings) => sensitiveConfirmation?.request(findings, "paste") ?? Promise.resolve("cancel")),
    ...(canEnsureSemanticReview ? { ensureSemanticReview } : {}),
    ...(canEnsureSemanticReview ? {
      confirmUnreviewedPaste:
      context.confirmUnreviewedPaste ?? ((reason) => sensitiveConfirmation?.requestUnreviewed(reason, "paste") ?? Promise.resolve(false)),
    } : {}),
  });
  /*
   * 输入也要触发一次状态复查。
   *
   * MutationObserver 看不到 textarea 的 value 变化，而"输入框里有没有字"现在参与徽标判定（见
   * checkStatus）：站点改版导致发送按钮选择器失效时，只有等到输入框里真的有字才该报未验证。少了这一条，
   * 那种情况会一直停在 protected，等于假称已保护。
   */
  const handleComposerInput = (event: Event): void => {
    scheduleNeuralReview(event);
    if (verifiedEditor !== null && event.target === verifiedEditor) {
      queueStatusCheck();
    }
  };

  inner.attach();
  pasteGuard.attach();
  context.document.addEventListener("input", handleComposerInput, true);
  {
    /*
     * 回复令牌查看不再要求站点声明助手回复选择器。
     *
     * 九个适配器里只有 ChatGPT 的回复选择器是真实取证过的，所以这个功能此前只在 ChatGPT 上成立，其余
     * 八个站点静默失效（豆包/DeepSeek 用的是真实站点不存在的合成属性，Kimi/通义千问/文心一言借用了
     * ChatGPT 的属性，Claude/Gemini/元宝压根没声明）。
     *
     * 现在优先用站点已取证的选择器（更精确），找不到就退回按扩展自己的令牌定位——那不依赖任何站点私有
     * 结构，并且只装饰经 tokenMap 确认过的本会话令牌。
     */
    const findVerifiedReplyRegions = (): readonly HTMLElement[] =>
      adapter.findAssistantResponseContainers?.(context.document) ?? [];

    replyTokenViewer = createReplyTokenViewer({
      document: context.document,
      tokenMap: sessionTokenMap,
      findContainers: () => {
        const verified = findVerifiedReplyRegions();
        return verified.length > 0
          ? verified
          : findSessionTokenBlocks(context.document, sessionTokenMap, isExtensionOwnedNode);
      },
      usesVerifiedReplyRegions: () => findVerifiedReplyRegions().length > 0,
      onDiagnostics: (diagnostics) => {
        replyViewerDiagnostics = diagnostics ?? undefined;
        checkStatus();
      },
      isEnabled: () => {
        const snapshot = cache.getSnapshot();
        return snapshot.state === "ready" && snapshot.replyTokenViewerEnabled === true && snapshot.replacementStyle !== "masked" && snapshot.replacementStyle !== "surrogate";
      },
    });
    replyTokenViewer.attach();
    replyTokenViewerUnsubscribe = cache.subscribe(() => replyTokenViewer?.refresh());
  }

  let cacheDisposed = false;

  return {
    attach(): void {
      inner.attach();
    },
    detach(): void {
      inner.detach();
      pasteGuard.detach();
      context.document.removeEventListener("input", handleComposerInput, true);
      neuralReviewClient.dispose();
      replyTokenViewer?.detach();
      replyTokenViewer = null;
      replyTokenViewerUnsubscribe?.();
      replyTokenViewerUnsubscribe = null;
      sessionClearUnsubscribe?.();
      sessionClearUnsubscribe = null;
      if (canReceivePrivateComposerMessages) {
        chrome.runtime.onMessage.removeListener(runtimeMessageListener);
      }

      if (cacheDisposed) {
        return;
      }

      cacheDisposed = true;
      statusTrackingDisposed = true;
      hideUnverifiedBanner(context.document);
      highlightRangeKey = "";
      hideHighlightOverlay(context.document);
      if (!confirmationDisposed) {
        confirmationDisposed = true;
        sensitiveConfirmation?.dispose();
      }
      statusObserver?.disconnect();
      context.document.defaultView?.removeEventListener("load", queueStatusCheck);
      cache.dispose();
    },
  };
}

function bootstrapWhenReady(): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootstrapInlineRedaction(), { once: true });
    return;
  }

  bootstrapInlineRedaction();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapWhenReady();
}
