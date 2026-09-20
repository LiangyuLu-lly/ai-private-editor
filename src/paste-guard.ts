import {
  analyzeDraft,
  getRedactionValues,
  materializeDraftRedaction,
  resolveSendAction,
} from "./shared/detector.js";
import { resolveScopedAllowlistedTerms } from "./shared/allowlist.js";
import type { AuditEventInput, AuditOutcome } from "./shared/audit-log.js";
import { mergeCategoryPolicies } from "./shared/policy-overlay.js";
import { DEFAULT_ADVANCED_SETTINGS, type CustomTermsSnapshot } from "./shared/custom-terms.js";
import { createSessionTokenMap, type SessionTokenMap } from "./shared/session-token-map.js";
import type { SemanticReviewProvider } from "./shared/semantic-review.js";
import type { RedactionFinding, SensitiveActionDecision } from "./shared/types.js";
import { hideReviewProgress, showReviewProgress } from "./review-progress.js";
import { insertEditorText, isEditorTarget, readEditorText } from "./sites/editor.js";
import { assessSiteAdapterHealth } from "./sites/health.js";
import type { EditableElement, SiteAdapter } from "./sites/types.js";
import type { SemanticReviewGateResult, ToastState } from "./pre-send.js";

export type PasteGuardDependencies = {
  document: Document;
  url: () => URL;
  notify: (message: string, state: ToastState) => void;
  confirmSensitivePaste?: (findings: readonly RedactionFinding[]) => Promise<SensitiveActionDecision>;
  getCustomTermsSnapshot?: () => CustomTermsSnapshot;
  sessionTokenMap?: SessionTokenMap;
  sessionAllowlistedTerms?: Set<string>;
  recordAudit?: (event: AuditEventInput) => void;
  getSemanticReviewProvider?: () => SemanticReviewProvider | undefined;
  ensureSemanticReview?: (text: string) => Promise<SemanticReviewGateResult>;
  confirmUnreviewedPaste?: (reason: string) => Promise<boolean>;
};

export type PasteGuard = {
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

function readyEmptyTerms(): CustomTermsSnapshot {
  return {
    state: "ready",
    terms: [],
    mode: "replace",
    allowlistedTerms: [],
    ...DEFAULT_ADVANCED_SETTINGS,
  };
}

function stopPaste(event: ClipboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function isPlainTextPaste(event: ClipboardEvent): boolean {
  const clipboardData = event.clipboardData;

  return clipboardData !== null && clipboardData.getData("text/html").length === 0;
}

function successMessage(findings: readonly RedactionFinding[]): string {
  const summary = findings.map((finding) => `${FINDING_LABELS[finding.kind]} ${finding.count} 项`).join("，");

  return `已在粘贴前匿名化：${summary || "敏感信息"}。`;
}

function policyBlockMessage(findings: readonly RedactionFinding[]): string {
  const summary = findings
    .filter((finding) => finding.policy === "block")
    .map((finding) => `${FINDING_LABELS[finding.kind]} ${finding.count} 项`)
    .join("，");

  return `已阻止粘贴：${summary || "敏感信息"}已设为始终阻止。请通过白名单或调整策略后重试。`;
}

function getVerifiedEditor(
  document: Document,
  url: URL,
): { adapter: SiteAdapter; editor: EditableElement } | null {
  const health = assessSiteAdapterHealth(document, url);
  if (health.state !== "ready") {
    return null;
  }

  return { adapter: health.adapter, editor: health.editor };
}

export function createPasteGuard(dependencies: PasteGuardDependencies): PasteGuard {
  const { document, notify, url } = dependencies;
  const getCustomTermsSnapshot = dependencies.getCustomTermsSnapshot ?? readyEmptyTerms;
  const confirmSensitivePaste = dependencies.confirmSensitivePaste;
  const sessionTokenMap = dependencies.sessionTokenMap ?? createSessionTokenMap();
  const sessionAllowlistedTerms = dependencies.sessionAllowlistedTerms ?? new Set<string>();
  const recordAudit = dependencies.recordAudit;
  const getSemanticReviewProvider = dependencies.getSemanticReviewProvider ?? (() => undefined);
  const ensureSemanticReview = dependencies.ensureSemanticReview;
  const confirmUnreviewedPaste = dependencies.confirmUnreviewedPaste;
  let attached = false;
  let confirmationPending = false;

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
        operation: "paste",
        outcome,
        findings: findings.map((finding) => ({ kind: finding.kind, count: finding.count })),
      });
    } catch {
      // Auditing must never affect the local protection path.
    }
  }

  function requestSensitivePasteConfirmation(
    findings: readonly RedactionFinding[],
    originalText: string,
    originalEditorText: string,
    editor: EditableElement,
    auditEnabled: boolean,
    siteId: SiteAdapter["id"],
    materializeAnonymousPaste: () => ReturnType<typeof materializeDraftRedaction>,
    rememberSession: () => void,
  ): void {
    if (confirmationPending) {
      return;
    }

    confirmationPending = true;
    if (confirmSensitivePaste === undefined) {
      confirmationPending = false;
      reportAudit(auditEnabled, siteId, "blocked", findings);
      notify("已停止粘贴：检测到需要确认的敏感信息。", "blocked");
      return;
    }

    void (async () => {
      try {
        const decision = await confirmSensitivePaste(findings);
        if (decision === "cancel") {
          reportAudit(auditEnabled, siteId, "cancelled", findings);
          notify("已取消粘贴。", "blocked");
          return;
        }

        const current = getVerifiedEditor(document, url());
        if (current === null || current.editor !== editor) {
          reportAudit(auditEnabled, siteId, "blocked", findings);
          notify("页面输入框已变化，请重新粘贴。", "warning");
          return;
        }

        if (readEditorText(current.editor) !== originalEditorText) {
          reportAudit(auditEnabled, siteId, "blocked", findings);
          notify("页面输入框已变化，请重新粘贴。", "warning");
          return;
        }

        const result = decision === "redact" ? materializeAnonymousPaste() : null;
        const outboundText = result?.outboundText ?? originalText;
        if (!insertEditorText(editor, outboundText)) {
          reportAudit(auditEnabled, siteId, "blocked", findings);
          notify("当前页面编辑器未验证，未粘贴。", "warning");
          return;
        }

        if (decision === "session") {
          rememberSession();
        }

        if (result !== null) {
          reportAudit(auditEnabled, siteId, "anonymized", result.findings);
          notify(successMessage(result.findings), "success");
          return;
        }

        reportAudit(auditEnabled, siteId, "raw_confirmed", findings);
        notify("已按确认粘贴原文。", "warning");
      } catch {
        reportAudit(auditEnabled, siteId, "blocked", findings);
        notify("确认粘贴失败，未粘贴。", "warning");
      } finally {
        confirmationPending = false;
      }
    })();
  }

  function handlePaste(event: ClipboardEvent): void {
    if (event.defaultPrevented || !isPlainTextPaste(event)) {
      return;
    }

    const verified = getVerifiedEditor(document, url());
    if (verified === null || !isEditorTarget(verified.editor, event.target)) {
      return;
    }

    const rawText = event.clipboardData?.getData("text/plain") ?? "";
    if (rawText.length === 0) {
      return;
    }

    let originalEditorText: string;
    try {
      originalEditorText = readEditorText(verified.editor);
    } catch {
      stopPaste(event);
      notify("当前页面编辑器未验证，未粘贴。", "warning");
      return;
    }

    if (confirmationPending) {
      stopPaste(event);
      notify("正在等待粘贴确认。", "warning");
      return;
    }

    let snapshot: CustomTermsSnapshot;
    try {
      snapshot = getCustomTermsSnapshot();
    } catch {
      stopPaste(event);
      notify("自定义词库读取失败，未粘贴。请检查扩展设置后重试。", "warning");
      return;
    }

    if (snapshot.state === "loading") {
      stopPaste(event);
      notify("自定义词库正在加载，未粘贴。请稍后重试。", "warning");
      return;
    }

    if (snapshot.state === "failed") {
      stopPaste(event);
      notify("自定义词库读取失败，未粘贴。请检查扩展设置后重试。", "warning");
      return;
    }

    const customTerms = snapshot.terms.map((term) => term.value);
    const allowlistedTerms = resolveScopedAllowlistedTerms(snapshot, verified.adapter.id, sessionAllowlistedTerms);
    const categoryPolicies = mergeCategoryPolicies(
      snapshot.categoryPolicies ?? [],
      snapshot.siteCategoryPolicies ?? [],
      verified.adapter.id,
    );
    const detectionProfile = snapshot.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile;
    const replacementStyle = snapshot.replacementStyle ?? DEFAULT_ADVANCED_SETTINGS.replacementStyle;
    // See the note in pre-send.ts: the provider unions the rule path with the neural cache, so
    // every non-off mode uses it and the neural half contributes only when it has a hit.
    const semanticReview = snapshot.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview;
    const semanticReviewProvider = semanticReview !== "off"
      ? getSemanticReviewProvider()
      : undefined;

    const continueWithAnalysis = (pasteStopped: boolean): void => {
      let analysis: ReturnType<typeof analyzeDraft>;
      try {
        analysis = analyzeDraft(rawText, customTerms, allowlistedTerms, categoryPolicies, {
          detectionProfile,
          replacementStyle,
          semanticReviewProvider,
        });
      } catch {
        if (!pasteStopped) {
          stopPaste(event);
        }
        notify("本地检测失败，未粘贴。", "warning");
        return;
      }

      const pasteAction = resolveSendAction(analysis.findings, snapshot.mode);
      if (pasteAction === "block") {
        if (!pasteStopped) {
          stopPaste(event);
        }
        reportAudit(snapshot.auditEnabled === true, verified.adapter.id, "blocked", analysis.findings);
        notify(policyBlockMessage(analysis.findings), "blocked");
        return;
      }

      if (pasteAction === "confirm") {
        if (!pasteStopped) {
          stopPaste(event);
        }
        requestSensitivePasteConfirmation(
          analysis.findings,
          rawText,
          originalEditorText,
          verified.editor,
          snapshot.auditEnabled === true,
          verified.adapter.id,
          () => materializeDraftRedaction(
            rawText,
            customTerms,
            sessionTokenMap,
            allowlistedTerms,
            categoryPolicies,
            { detectionProfile, replacementStyle, semanticReviewProvider },
          ),
          () => {
            getRedactionValues(rawText, customTerms, allowlistedTerms, categoryPolicies, { detectionProfile, semanticReviewProvider }).forEach((value) => {
              sessionAllowlistedTerms.add(value);
            });
          },
        );
        return;
      }

      if (pasteAction === "native") {
        if (!pasteStopped) {
          return;
        }
        // After stopPaste the browser default is dead; native must insert locally.
        if (!insertEditorText(verified.editor, rawText)) {
          notify("当前页面编辑器未验证，未粘贴。请刷新或等待适配更新。", "warning");
        }
        return;
      }

      let result: ReturnType<typeof materializeDraftRedaction>;
      try {
        result = materializeDraftRedaction(rawText, customTerms, sessionTokenMap, allowlistedTerms, categoryPolicies, {
        detectionProfile,
        replacementStyle,
        semanticReviewProvider,
        });
      } catch {
        if (!pasteStopped) {
          stopPaste(event);
        }
        notify("本地检测失败，未粘贴。", "warning");
        return;
      }

      if (!pasteStopped) {
        stopPaste(event);
      }
      if (!insertEditorText(verified.editor, result.outboundText)) {
        notify("当前页面编辑器未验证，未粘贴。请刷新或等待适配更新。", "warning");
        return;
      }

      reportAudit(snapshot.auditEnabled === true, verified.adapter.id, "anonymized", result.findings);
      notify(successMessage(result.findings), "success");
    };

    if (semanticReview === "local_neural" && ensureSemanticReview !== undefined && rawText.length > 0) {
      stopPaste(event);
      confirmationPending = true;
      showReviewProgress(document);
      void (async () => {
        let handedOff = false;
        try {
          const gate = await ensureSemanticReview(rawText);
          hideReviewProgress(document);
          if (!attached) {
            return;
          }

          const current = getVerifiedEditor(document, url());
          if (current === null || current.editor !== verified.editor) {
            notify("页面输入框已变化，请重新粘贴。", "warning");
            return;
          }
          if (readEditorText(current.editor) !== originalEditorText) {
            notify("页面输入框已变化，请重新粘贴。", "warning");
            return;
          }

          if (!gate.ok) {
            if (confirmUnreviewedPaste === undefined) {
              notify(`${gate.reason}，未粘贴。`, "warning");
              return;
            }
            let confirmed = false;
            try {
              confirmed = await confirmUnreviewedPaste(gate.reason);
            } catch {
              notify("复核确认失败，未粘贴。", "warning");
              return;
            }
            if (!confirmed || !attached) {
              if (!confirmed) {
                notify("已取消粘贴。", "blocked");
              }
              return;
            }
            const still = getVerifiedEditor(document, url());
            if (still === null || still.editor !== verified.editor || readEditorText(still.editor) !== originalEditorText) {
              notify("页面输入框已变化，请重新粘贴。", "warning");
              return;
            }
            if (!insertEditorText(verified.editor, rawText)) {
              notify("当前页面编辑器未验证，未粘贴。", "warning");
              return;
            }
            notify("已按确认粘贴原文。", "warning");
            return;
          }

          handedOff = true;
          confirmationPending = false;
          continueWithAnalysis(true);
        } catch {
          hideReviewProgress(document);
          notify("本地语义复核失败，未粘贴。", "warning");
        } finally {
          hideReviewProgress(document);
          if (!handedOff) {
            confirmationPending = false;
          }
        }
      })();
      return;
    }

    continueWithAnalysis(false);
  }

  return {
    attach(): void {
      if (attached) {
        return;
      }

      attached = true;
      document.addEventListener("paste", handlePaste, true);
    },
    detach(): void {
      if (!attached) {
        return;
      }

      attached = false;
      confirmationPending = false;
      document.removeEventListener("paste", handlePaste, true);
    },
  };
}
