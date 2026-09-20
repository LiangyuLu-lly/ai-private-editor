import {
  analyzeDraft,
  getRedactionValues,
  materializeDraftRedaction,
  resolveSendAction,
} from "./shared/detector.js";
import { getAttachmentDecision } from "./attachment-guard.js";
import { resolveScopedAllowlistedTerms } from "./shared/allowlist.js";
import type { AuditEventInput, AuditOutcome } from "./shared/audit-log.js";
import { mergeCategoryPolicies } from "./shared/policy-overlay.js";
import {
  DEFAULT_ADVANCED_SETTINGS,
  type CustomTermsSnapshot,
} from "./shared/custom-terms.js";
import { createSessionTokenMap, type SessionTokenMap } from "./shared/session-token-map.js";
import type { SemanticReviewProvider } from "./shared/semantic-review.js";
import type { RedactionFinding, SensitiveActionDecision } from "./shared/types.js";
import { hideReviewProgress, showReviewProgress } from "./review-progress.js";
import { readEditorText, writeEditorText } from "./sites/editor.js";
import { assessSiteAdapterHealth, type SiteAdapterHealth } from "./sites/health.js";
import type { EditableElement, SendControl, SiteAdapter } from "./sites/types.js";

export type ToastState = "success" | "blocked" | "warning";
export type SensitiveSendDecision = SensitiveActionDecision;
export type SemanticReviewGateResult =
  | { ok: true }
  | { ok: false; reason: string };

export type PreSendDependencies = {
  document: Document;
  url: () => URL;
  notify: (message: string, state: ToastState) => void;
  confirmAttachmentSend?: (action: "confirm" | "block", unverified?: boolean) => Promise<boolean>;
  confirmSensitiveSend?: (findings: readonly RedactionFinding[]) => Promise<SensitiveSendDecision>;
  getCustomTermsSnapshot?: () => CustomTermsSnapshot;
  isUserInitiated?: (event: Event) => boolean;
  afterInput?: (callback: () => void) => void;
  sessionTokenMap?: SessionTokenMap;
  sessionAllowlistedTerms?: Set<string>;
  recordAudit?: (event: AuditEventInput) => void;
  getSemanticReviewProvider?: () => SemanticReviewProvider | undefined;
  ensureSemanticReview?: (text: string) => Promise<SemanticReviewGateResult>;
  confirmUnreviewedSend?: (reason: string) => Promise<boolean>;
};

export type PreSendController = {
  attach(): void;
  detach(): void;
};

const FINDING_LABELS: Record<RedactionFinding["kind"], string> = {
  api_key: "密钥",
  access_token: "访问令牌",
  private_key: "私钥",
  connection_string: "连接字符串",
  phone: "手机号",
  email: "邮箱",
  china_id: "身份证号",
  bank_card: "银行卡号",
  unified_social_credit_code: "统一社会信用代码",
  passport: "护照号",
  license_plate: "车牌号",
  ipv4: "IP 地址",
  ipv6: "IPv6 地址",
  local_path: "本地路径",
  custom_term: "自定义词条",
  person_name: "姓名",
  address: "地址",
  account: "账号",
  labeled_identifier: "编号或标识",
  credential: "凭证",
  private_date: "出生日期",
  private_url: "私密分享链接",
  mac_address: "MAC 地址",
  bank_account: "银行账户",
};

function stopSubmission(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function afterTwoAnimationFrames(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function readyEmptyTerms(): CustomTermsSnapshot {
  return {
    state: "ready",
    terms: [],
    mode: "replace",
    allowlistedTerms: [],
    ...DEFAULT_ADVANCED_SETTINGS,
  };
}

function successMessage(findings: readonly RedactionFinding[]): string {
  const summary = findings.map((finding) => `${FINDING_LABELS[finding.kind]} ${finding.count} 项`).join("，");

  return `已匿名化发送：${summary || "敏感信息"}。`;
}

function policyBlockMessage(findings: readonly RedactionFinding[]): string {
  const summary = findings
    .filter((finding) => finding.policy === "block")
    .map((finding) => `${FINDING_LABELS[finding.kind]} ${finding.count} 项`)
    .join("，");

  return `已阻止发送：${summary || "敏感信息"}已设为始终阻止。请通过白名单或调整策略后重试。`;
}

function isControlTarget(target: EventTarget | null, control: SendControl): boolean {
  return target instanceof Node && (target === control || control.contains(target));
}

function isReplayClick(event: Event, replayControl: SendControl | null): boolean {
  if (event.type !== "click" || replayControl === null) {
    return false;
  }

  return isControlTarget(event.target, replayControl);
}

function isReplayEvent(event: Event, replayControl: SendControl | null): boolean {
  if (replayControl === null) {
    return false;
  }

  if (isReplayClick(event, replayControl)) {
    return true;
  }

  return event.type === "submit" && event.target instanceof HTMLFormElement && event.target.contains(replayControl);
}

/**
 * 现在能不能代替用户按下站点自己的发送控件。
 *
 * 两种情况都返回 null：控件此刻不在 DOM 里（输入框为空时的空闲状态，或选择器已失效），或者控件被站点
 * 禁用。调用方一律退回 `warnManualSend()`——改写好的草稿留在输入框里，由用户自己发送，不假装已发出。
 */
function resolveActivatableSendControl(health: SiteAdapterHealth): SendControl | null {
  if (health.state !== "ready" || health.sendControl === null) {
    return null;
  }

  return health.adapter.isSendControlDisabled(health.sendControl) ? null : health.sendControl;
}

function isRecognizedGesture(
  event: Event,
  adapter: SiteAdapter,
  document: Document,
  editor: EditableElement,
  sendControl: SendControl | null,
): boolean {
  if (event.type === "click") {
    // 发送控件此刻不可解析时，任何点击都不算发送手势。绝不去猜"composer 里的某个按钮大概是发送"，
    // 那会把附件、麦克风、停止生成都误当成发送。Enter 和表单提交不受影响，它们不需要发送控件。
    return (
      sendControl !== null &&
      isControlTarget(event.target, sendControl) &&
      adapter.isSendControlTarget(event.target, document, editor)
    );
  }

  if (event.type === "keydown" && event instanceof KeyboardEvent) {
    return adapter.isKeyboardSendGesture(event, editor);
  }

  return event.type === "submit" && event.target instanceof HTMLFormElement && event.target.contains(editor);
}

function sameAttachmentElements(expected: readonly Element[] | null, actual: readonly Element[]): boolean {
  return (
    expected !== null &&
    expected.length === actual.length &&
    expected.every((attachment, index) => attachment === actual[index])
  );
}

type AttachmentSnapshot = {
  state: "scoped" | "unavailable";
  elements: readonly Element[];
};

function readAttachmentSnapshot(
  adapter: SiteAdapter,
  document: Document,
  editor: EditableElement,
): AttachmentSnapshot {
  if (adapter.attachmentDetection !== "scoped" || adapter.findComposerAttachments === undefined) {
    return { state: "unavailable", elements: [] };
  }

  return { state: "scoped", elements: adapter.findComposerAttachments(document, editor) };
}

function sameAttachmentSnapshot(expected: AttachmentSnapshot | null, actual: AttachmentSnapshot): boolean {
  return expected !== null && expected.state === actual.state && sameAttachmentElements(expected.elements, actual.elements);
}

export function createPreSendController(dependencies: PreSendDependencies): PreSendController {
  const { document, notify, url } = dependencies;
  const getCustomTermsSnapshot = dependencies.getCustomTermsSnapshot ?? readyEmptyTerms;
  const confirmSensitiveSend = dependencies.confirmSensitiveSend;
  const confirmAttachmentSend = dependencies.confirmAttachmentSend;
  const isUserInitiated = dependencies.isUserInitiated ?? ((event: Event) => event.isTrusted);
  const afterInput = dependencies.afterInput ?? afterTwoAnimationFrames;
  const sessionTokenMap = dependencies.sessionTokenMap ?? createSessionTokenMap();
  const getSemanticReviewProvider = dependencies.getSemanticReviewProvider ?? (() => undefined);
  const ensureSemanticReview = dependencies.ensureSemanticReview;
  const confirmUnreviewedSend = dependencies.confirmUnreviewedSend;
  const recordAudit = dependencies.recordAudit;
  let attached = false;
  let replacementInProgress = false;
  let confirmationPending = false;
  let replayControl: SendControl | null = null;
  let rawOnceReplayDraft: string | null = null;
  let reviewedReplayControl: SendControl | null = null;
  let reviewedReplayDraft: string | null = null;
  let attachmentConfirmationPending = false;
  let attachmentReplayControl: SendControl | null = null;
  let attachmentApprovedDraft: string | null = null;
  let attachmentApprovedSnapshot: AttachmentSnapshot | null = null;
  let attachmentReplayPassThrough = false;
  let attachmentReplayObserved = false;
  const sessionAllowlistedTerms = dependencies.sessionAllowlistedTerms ?? new Set<string>();

  const clearAttachmentReplay = (): void => {
    attachmentReplayControl = null;
    attachmentApprovedDraft = null;
    attachmentApprovedSnapshot = null;
    attachmentReplayPassThrough = false;
    attachmentReplayObserved = false;
  };

  const deferAttachmentReplayCleanup = (control: SendControl): void => {
    queueMicrotask(() => {
      if (attachmentReplayControl === control && attachmentReplayPassThrough) {
        clearAttachmentReplay();
      }
    });
  };

  const clearReviewedReplay = (): void => {
    reviewedReplayControl = null;
    reviewedReplayDraft = null;
  };

  const deferReviewedReplayCleanup = (control: SendControl): void => {
    queueMicrotask(() => {
      if (reviewedReplayControl === control) {
        clearReviewedReplay();
      }
    });
  };

  function reportAudit(
    auditEnabled: boolean,
    siteId: SiteAdapter["id"],
    outcome: AuditOutcome,
    findings: readonly RedactionFinding[],
  ): void {
    if (!auditEnabled || recordAudit === undefined || findings.length === 0) {
      return;
    }

    try {
      recordAudit({
        siteId,
        operation: "send",
        outcome,
        findings: findings.map((finding) => ({ kind: finding.kind, count: finding.count })),
      });
    } catch {
      // Auditing must never affect the local protection path.
    }
  }

  function warnManualSend(): void {
    notify("已替换敏感信息，请手动发送。", "warning");
  }

  function replayReplacement(
    findings: readonly RedactionFinding[],
    attachmentSnapshot?: AttachmentSnapshot,
  ): void {
    try {
      if (!attached) {
        return;
      }

      const health = assessSiteAdapterHealth(document, url());
      const activatable = resolveActivatableSendControl(health);

      if (health.state !== "ready" || activatable === null) {
        warnManualSend();
        return;
      }

      if (
        attachmentSnapshot !== undefined &&
        !sameAttachmentSnapshot(
          attachmentSnapshot,
          readAttachmentSnapshot(health.adapter, document, health.editor),
        )
      ) {
        notify("附件或页面已变化，未发送。", "warning");
        return;
      }

      replayControl = activatable;
      activatable.click();
      notify(successMessage(findings), "success");
    } catch {
      warnManualSend();
    } finally {
      replayControl = null;
      replacementInProgress = false;
    }
  }

  function requestSensitiveConfirmation(
    findings: readonly RedactionFinding[],
    fallbackMessage: string,
    originalText: string,
    auditEnabled: boolean,
    siteId: SiteAdapter["id"],
    materializeAnonymousDraft: () => ReturnType<typeof materializeDraftRedaction>,
    rememberSession?: () => void,
    attachmentSnapshot?: AttachmentSnapshot,
  ): void {
    if (confirmationPending) {
      return;
    }

    confirmationPending = true;

    if (confirmSensitiveSend === undefined) {
      confirmationPending = false;
      reportAudit(auditEnabled, siteId, "blocked", findings);
      notify(fallbackMessage, "blocked");
      return;
    }

    void (async () => {
      try {
        const decision = await confirmSensitiveSend(findings);
        if (decision === "cancel") {
          reportAudit(auditEnabled, siteId, "cancelled", findings);
          notify("已取消发送。", "blocked");
          confirmationPending = false;
          return;
        }

        afterInput(() => {
          try {
            if (!attached) {
              reportAudit(auditEnabled, siteId, "blocked", findings);
              return;
            }

            const health = assessSiteAdapterHealth(document, url());
            const activatable = resolveActivatableSendControl(health);
            if (health.state !== "ready" || activatable === null) {
              reportAudit(auditEnabled, siteId, "blocked", findings);
              warnManualSend();
              return;
            }

            if (readEditorText(health.editor) !== originalText) {
              reportAudit(auditEnabled, siteId, "blocked", findings);
              notify("草稿已变化，请重新发送。", "warning");
              return;
            }

            if (
              attachmentSnapshot !== undefined &&
              !sameAttachmentSnapshot(
                attachmentSnapshot,
                readAttachmentSnapshot(health.adapter, document, health.editor),
              )
            ) {
              reportAudit(auditEnabled, siteId, "blocked", findings);
              notify("草稿、附件或页面已变化，请重新发送。", "warning");
              return;
            }

            if (decision === "redact") {
              const result = materializeAnonymousDraft();
              if (!writeEditorText(health.editor, result.outboundText)) {
                reportAudit(auditEnabled, siteId, "blocked", findings);
                notify("当前页面编辑器未验证，未发送。请刷新或等待适配更新。", "warning");
                return;
              }

              reportAudit(auditEnabled, siteId, "anonymized", result.findings);
              replacementInProgress = true;
              try {
                afterInput(() => replayReplacement(result.findings, attachmentSnapshot));
              } catch {
                replacementInProgress = false;
                warnManualSend();
              }
              return;
            }

            replayControl = activatable;
            activatable.click();
            if (decision === "session") {
              rememberSession?.();
            }
            reportAudit(auditEnabled, siteId, "raw_confirmed", findings);
            notify("已按确认发送原文。", "warning");
          } catch {
            reportAudit(auditEnabled, siteId, "blocked", findings);
            notify("确认发送失败，未发送。", "warning");
          } finally {
            replayControl = null;
            confirmationPending = false;
          }
        });
      } catch {
        confirmationPending = false;
        reportAudit(auditEnabled, siteId, "blocked", findings);
        notify("确认发送失败，未发送。", "warning");
      }
    })();
  }

  function handleSubmission(event: Event): void {
    const reviewedReplay = isReplayEvent(event, reviewedReplayControl);
    const reviewedDraft = reviewedReplay ? reviewedReplayDraft : null;
    if (reviewedReplay) {
      // A submit button emits click and then submit before the same review can be released.
      if (event.type === "submit") {
        clearReviewedReplay();
      }
    }
    const attachmentReplay = isReplayEvent(event, attachmentReplayControl);
    if (attachmentReplay) {
      attachmentReplayObserved = true;
    }
    const health = assessSiteAdapterHealth(document, url());

    /*
     * 发送按钮**被站点禁用**时不接管这次手势。
     *
     * 这道判断以前长在 `assessSiteAdapterHealth` 里，靠"禁用 → unverified"顺带挡住。那个位置是错的：
     * 所有 AI 站在输入框为空时都会禁用发送按钮，于是每个站点每次打开页面都会误报"当前页面未验证"，
     * 并且 `state !== "ready"` 还挡住了侧边栏的填入路径、粘贴拦截和输入时语义检查。所以判断被移到
     * 这里——手势层才是"现在这个动作能不能真的发出去"的正确位置。
     *
     * 不加这一条的话行为会变：DeepSeek / Kimi / 元宝的发送控件是 div 或 a，带 disabled **类**时照样
     * 派发 click，于是扩展会去接管一次根本发不出去的点击，把草稿改写掉再提示"请手动发送"。不是泄漏，
     * 但是用户没要求过的改写。tests/pre-send.test.ts 里那几条 "leaves … on the native path" 就是钉这个的。
     *
     * 注意"禁用"和"不存在"要分开处理，只有前者在这里短路：
     *   - 禁用 = 站点明确说了现在发不出去，那么这次手势是空操作，接管它只会白改一次草稿。
     *   - 不存在 = 我们看不到按钮（空输入时的空闲状态，或选择器已失效）。此时点击不可能被识别成发送
     *     手势（`isRecognizedGesture` 在 sendControl 为 null 时对点击一律返回 false），但 Enter 和表单
     *     提交照样拦——它们本来就不需要发送按钮，而选择器失效时用户按 Enter 是真能发出去的。旧行为在
     *     这种情况下完全不拦，原文直接发走。
     */
    if (
      health.state !== "ready" ||
      (health.sendControl !== null && health.adapter.isSendControlDisabled(health.sendControl)) ||
      !isRecognizedGesture(event, health.adapter, document, health.editor, health.sendControl)
    ) {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      return;
    }

    if (isReplayEvent(event, replayControl)) {
      if (rawOnceReplayDraft !== null) {
        let currentText: string | null = null;
        try {
          currentText = health.state === "ready" ? readEditorText(health.editor) : null;
        } catch {
          currentText = null;
        }
        if (health.state !== "ready" || currentText !== rawOnceReplayDraft) {
          replayControl = null;
          rawOnceReplayDraft = null;
          stopSubmission(event);
          notify("草稿、页面或发送按钮已变化，请重新发送。", "warning");
          return;
        }
      }
      return;
    }

    if (attachmentReplay && attachmentReplayPassThrough) {
      clearAttachmentReplay();
      return;
    }

    if (!attachmentReplay && !reviewedReplay && !isUserInitiated(event)) {
      stopSubmission(event);
      return;
    }

    if (replacementInProgress) {
      stopSubmission(event);
      return;
    }

    if (confirmationPending || attachmentConfirmationPending) {
      stopSubmission(event);
      return;
    }

    let rawText: string;
    let attachmentSnapshot: AttachmentSnapshot;

    try {
      rawText = readEditorText(health.editor);
      attachmentSnapshot = readAttachmentSnapshot(health.adapter, document, health.editor);
    } catch {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("本地检测或附件检查失败，已停止提交。", "warning");
      return;
    }

    if (reviewedReplay && rawText !== reviewedDraft) {
      clearReviewedReplay();
      stopSubmission(event);
      notify("草稿、页面或发送按钮已变化，请重新发送。", "warning");
      return;
    }

    if (!rawText && attachmentSnapshot.state === "scoped" && attachmentSnapshot.elements.length === 0) {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      return;
    }

    let snapshot: CustomTermsSnapshot;
    try {
      snapshot = getCustomTermsSnapshot();
    } catch {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("自定义词库读取失败，未发送。请检查扩展设置后重试。", "warning");
      return;
    }

    if (snapshot.state === "loading") {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("自定义词库正在加载，未发送。请稍后重试。", "warning");
      return;
    }

    if (snapshot.state === "failed") {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("自定义词库读取失败，未发送。请检查扩展设置后重试。", "warning");
      return;
    }

    const attachmentAlreadyApproved =
      attachmentReplay &&
      attachmentApprovedDraft === rawText &&
      sameAttachmentSnapshot(attachmentApprovedSnapshot, attachmentSnapshot);
    if (!attachmentAlreadyApproved) {
      if (attachmentReplay) {
        clearAttachmentReplay();
      } else {
        attachmentApprovedDraft = null;
        attachmentApprovedSnapshot = null;
      }
    }
    const attachmentDecision = getAttachmentDecision(
      snapshot.attachmentAction ?? "warn",
      attachmentSnapshot.elements,
      attachmentSnapshot.state,
    );
    if (!rawText && attachmentDecision.action === "allow") {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      return;
    }
    if (!attachmentAlreadyApproved && attachmentDecision.action === "warn") {
      notify("检测到已附加文件，文件内容未被读取。", "warning");
    }
    if (
      !attachmentAlreadyApproved &&
      (attachmentDecision.action === "confirm" || attachmentDecision.action === "block")
    ) {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      if (confirmAttachmentSend === undefined) {
        notify(
          attachmentDecision.unverified === true
            ? "当前站点无法核验附件状态，已停止发送。请确认后重试发送。"
            : attachmentDecision.action === "block"
              ? "已阻止发送：附件未扫描。请确认后重试发送。"
              : "检测到已附加文件，文件内容未被读取。请确认后重试发送。",
          "warning",
        );
        return;
      }
      attachmentConfirmationPending = true;
      const confirmation = attachmentDecision.unverified === true
        ? confirmAttachmentSend(attachmentDecision.action, true)
        : confirmAttachmentSend(attachmentDecision.action);
      void confirmation.then(
        (confirmed) => {
          attachmentConfirmationPending = false;
          if (!confirmed) {
            notify("已取消发送。", "blocked");
            return;
          }
          if (!attached) {
            return;
          }
          try {
            const current = assessSiteAdapterHealth(document, url());
            const currentAttachmentSnapshot =
              current.state === "ready"
                ? readAttachmentSnapshot(current.adapter, document, current.editor)
                : null;
            if (
              current.state !== "ready" ||
              readEditorText(current.editor) !== rawText ||
              !sameAttachmentSnapshot(attachmentSnapshot, currentAttachmentSnapshot ?? { state: "unavailable", elements: [] })
            ) {
              notify("草稿、附件或页面已变化，请重新发送。", "warning");
              return;
            }
            const activatable = resolveActivatableSendControl(current);
            if (activatable === null) {
              // 附件路径不改写草稿，所以这里不是"已替换，请手动发送"，而是这次动作没有被代为执行。
              notify("发送按钮当前不可用，未发送。请手动发送。", "warning");
              return;
            }
            attachmentReplayControl = activatable;
            attachmentApprovedDraft = rawText;
            attachmentApprovedSnapshot = currentAttachmentSnapshot;
            attachmentReplayPassThrough = false;
            attachmentReplayObserved = false;
            activatable.click();
            if (!attachmentReplayObserved) {
              clearAttachmentReplay();
            }
          } catch {
            clearAttachmentReplay();
            notify("附件确认失败，未发送。", "warning");
          }
        },
        () => {
          attachmentConfirmationPending = false;
          notify("附件确认失败，未发送。", "warning");
        },
      );
      return;
    }

    const semanticReview = snapshot.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview;
    if (!reviewedReplay && rawText.length > 0 && semanticReview === "local_neural" && ensureSemanticReview !== undefined) {
      stopSubmission(event);
      showReviewProgress(document);
      confirmationPending = true;
      void ensureSemanticReview(rawText).then(async (gate) => {
        hideReviewProgress(document);
        let handedOff = false;
        try {
          if (!attached) {
            return;
          }

          if (gate.ok) {
            try {
              const current = assessSiteAdapterHealth(document, url());
              const currentText = current.state === "ready" ? readEditorText(current.editor) : null;
              const activatable = current.state === "ready" ? resolveActivatableSendControl(current) : null;
              if (current.state !== "ready" || currentText !== rawText || activatable === null) {
                notify("草稿、页面或发送按钮已变化，请重新发送。", "warning");
                return;
              }
              handedOff = true;
              confirmationPending = false;
              reviewedReplayControl = activatable;
              reviewedReplayDraft = rawText;
              activatable.click();
              deferReviewedReplayCleanup(activatable);
            } catch {
              clearReviewedReplay();
              notify("本地语义复核完成，但页面已变化，未发送。", "warning");
            }
            return;
          }

          const requestRawOnce = async (): Promise<void> => {
            if (confirmUnreviewedSend === undefined) {
              notify(`${gate.reason}，未发送。`, "warning");
              return;
            }
            let confirmed = false;
            try {
              confirmed = await confirmUnreviewedSend(gate.reason);
            } catch {
              notify("复核确认失败，未发送。", "warning");
              return;
            }
            if (!confirmed || !attached) {
              if (!confirmed) {
                notify("已取消发送。", "blocked");
              }
              return;
            }
            afterInput(() => {
              try {
                const current = assessSiteAdapterHealth(document, url());
                const currentText = current.state === "ready" ? readEditorText(current.editor) : null;
                const activatable = current.state === "ready" ? resolveActivatableSendControl(current) : null;
                if (current.state !== "ready" || currentText !== rawText || activatable === null) {
                  notify("草稿、页面或发送按钮已变化，请重新发送。", "warning");
                  return;
                }
                replayControl = activatable;
                rawOnceReplayDraft = rawText;
                activatable.click();
                if (rawOnceReplayDraft === null) {
                  return;
                }
                notify("已按确认发送原文。", "warning");
              } catch {
                notify("确认发送失败，未发送。", "warning");
              } finally {
                replayControl = null;
                rawOnceReplayDraft = null;
              }
            });
          };
          await requestRawOnce();
        } finally {
          if (!handedOff) {
            confirmationPending = false;
          }
        }
      }).catch(() => {
        hideReviewProgress(document);
        confirmationPending = false;
        notify("本地语义复核失败，未发送。", "warning");
      });
      return;
    }

    const customTerms = snapshot.terms.map((term) => term.value);
    const allowlistedTerms = resolveScopedAllowlistedTerms(snapshot, health.adapter.id, sessionAllowlistedTerms);
    const categoryPolicies = mergeCategoryPolicies(
      snapshot.categoryPolicies ?? [],
      snapshot.siteCategoryPolicies ?? [],
      health.adapter.id,
    );
    const detectionProfile = snapshot.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile;
    const replacementStyle = snapshot.replacementStyle ?? DEFAULT_ADVANCED_SETTINGS.replacementStyle;
    // Any mode other than "off" uses the provider. The provider is a union of the rule/lexicon
    // path and the neural cache; the neural half is simply empty unless the offscreen model
    // reviewed this exact draft, so no branch is needed here.
    const semanticReviewProvider = semanticReview !== "off"
      ? getSemanticReviewProvider()
      : undefined;
    let analysis: ReturnType<typeof analyzeDraft>;
    try {
      analysis = analyzeDraft(
        rawText,
        customTerms,
        allowlistedTerms,
        categoryPolicies,
        { detectionProfile, replacementStyle, semanticReviewProvider },
      );
    } catch {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("本地检测失败，已停止提交。", "warning");
      return;
    }

    const sendAction = resolveSendAction(analysis.findings, snapshot.mode);
    if (sendAction === "block") {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      reportAudit(snapshot.auditEnabled === true, health.adapter.id, "blocked", analysis.findings);
      notify(policyBlockMessage(analysis.findings), "blocked");
      return;
    }

    if (sendAction === "confirm") {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      requestSensitiveConfirmation(
        analysis.findings,
        snapshot.mode === "block"
          ? "已阻止发送：严格模式检测到敏感信息。"
          : "已停止发送：检测到需要确认的敏感信息。",
        rawText,
        snapshot.auditEnabled === true,
        health.adapter.id,
        () => materializeDraftRedaction(
          rawText,
          customTerms,
          sessionTokenMap,
          allowlistedTerms,
          categoryPolicies,
          { detectionProfile, replacementStyle, semanticReviewProvider },
        ),
        () => {
          getRedactionValues(
            rawText,
            customTerms,
            allowlistedTerms,
            categoryPolicies,
            { detectionProfile, semanticReviewProvider },
          ).forEach((value) => {
            sessionAllowlistedTerms.add(value);
          });
        },
        attachmentAlreadyApproved ? attachmentSnapshot : undefined,
      );
      return;
    }

    if (sendAction === "native") {
      if (attachmentReplay && attachmentReplayControl !== null) {
        attachmentReplayPassThrough = true;
        deferAttachmentReplayCleanup(attachmentReplayControl);
      }
      return;
    }

    let result: ReturnType<typeof materializeDraftRedaction>;
    try {
      result = materializeDraftRedaction(
        rawText,
        customTerms,
        sessionTokenMap,
        allowlistedTerms,
        categoryPolicies,
        { detectionProfile, replacementStyle, semanticReviewProvider },
      );
    } catch {
      if (attachmentReplay) {
        clearAttachmentReplay();
      }
      stopSubmission(event);
      notify("本地检测失败，已停止提交。", "warning");
      return;
    }

    const attachmentSnapshotForReplay = attachmentAlreadyApproved ? attachmentSnapshot : undefined;
    if (attachmentReplay) {
      clearAttachmentReplay();
    }
    stopSubmission(event);

    if (!writeEditorText(health.editor, result.outboundText)) {
      notify("当前页面编辑器未验证，已停止提交。请刷新或等待适配更新。", "warning");
      return;
    }

    reportAudit(snapshot.auditEnabled === true, health.adapter.id, "anonymized", result.findings);
    replacementInProgress = true;

    const scheduleReplay = (): void => {
      try {
        afterInput(() => replayReplacement(result.findings, attachmentSnapshotForReplay));
      } catch {
        replacementInProgress = false;
        warnManualSend();
      }
    };
    if (attachmentReplay || reviewedReplay) {
      queueMicrotask(scheduleReplay);
    } else {
      scheduleReplay();
    }
  }

  return {
    attach(): void {
      if (attached) {
        return;
      }

      attached = true;
      document.addEventListener("click", handleSubmission, true);
      document.addEventListener("keydown", handleSubmission, true);
      document.addEventListener("submit", handleSubmission, true);
    },
    detach(): void {
      if (!attached) {
        return;
      }

      attached = false;
      replayControl = null;
      rawOnceReplayDraft = null;
      clearReviewedReplay();
      clearAttachmentReplay();
      replacementInProgress = false;
      confirmationPending = false;
      attachmentConfirmationPending = false;
      document.removeEventListener("click", handleSubmission, true);
      document.removeEventListener("keydown", handleSubmission, true);
      document.removeEventListener("submit", handleSubmission, true);
    },
  };
}
