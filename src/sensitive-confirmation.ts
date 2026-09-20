import type { DetectionKind, RedactionFinding, SensitiveActionDecision } from "./shared/types.js";

const FINDING_LABELS: Record<DetectionKind, string> = {
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

const DIALOG_ID = "privacy-composer-confirmation";
export type SensitiveConfirmationPurpose = "send" | "paste";

export type SensitiveSendConfirmation = {
  request(
    findings: readonly RedactionFinding[],
    purpose?: SensitiveConfirmationPurpose,
  ): Promise<SensitiveActionDecision>;
  requestUnreviewed(reason: string, purpose?: SensitiveConfirmationPurpose): Promise<boolean>;
  requestAttachment(blocked?: boolean, unverified?: boolean): Promise<boolean>;
  dispose(): void;
};

function summarizeFindings(findings: readonly RedactionFinding[]): string[] {
  const counts = new Map<DetectionKind, { count: number; labels: Set<string>; inferred: boolean }>();

  for (const finding of findings) {
    const existing = counts.get(finding.kind) ?? { count: 0, labels: new Set<string>(), inferred: false };
    existing.count += finding.count;
    finding.labels?.forEach((label) => existing.labels.add(label));
    existing.inferred ||= finding.inferred === true;
    counts.set(finding.kind, existing);
  }

  return [...counts.entries()].map(([kind, summary]) => {
    const label = summary.labels.size > 0
      ? `${[...summary.labels].join(" / ")}（${FINDING_LABELS[kind]}）`
      : FINDING_LABELS[kind];
    const warnings = findings
      .filter((finding) => finding.kind === kind && finding.warning === "credential_too_long")
      .map(() => "值过长，已完整匿名化");
    const inference = summary.inferred ? "（本地语义候选）" : "";
    return `${label} ${summary.count} 项${inference}${warnings.length > 0 ? `（${warnings[0]}）` : ""}`;
  });
}

function appendText(document: Document, parent: HTMLElement, text: string, className?: string): HTMLElement {
  const element = document.createElement("span");
  if (className !== undefined) {
    element.className = className;
  }
  element.textContent = text;
  parent.append(element);
  return element;
}

export function createSensitiveSendConfirmation(document: Document): SensitiveSendConfirmation {
  type QueuedDialog = {
    readonly start: () => void;
    readonly cancel: () => void;
  };

  let pending: { resolve: (decision: SensitiveActionDecision) => void; dialog: HTMLElement } | null = null;
  let keydownListener: ((event: KeyboardEvent) => void) | null = null;
  const queued: QueuedDialog[] = [];

  const pump = (): void => {
    if (pending !== null) {
      return;
    }
    const next = queued.shift();
    if (next === undefined) {
      return;
    }
    next.start();
  };

  const close = (decision: SensitiveActionDecision): void => {
    if (pending === null) {
      return;
    }

    const current = pending;
    pending = null;
    if (keydownListener !== null) {
      document.removeEventListener("keydown", keydownListener, true);
      keydownListener = null;
    }
    current.dialog.remove();
    current.resolve(decision);
    pump();
  };

  const dismissAll = (): void => {
    const leftover = queued.splice(0);
    leftover.forEach((item) => item.cancel());
    close("cancel");
  };

  const request = (
    findings: readonly RedactionFinding[],
    purpose: SensitiveConfirmationPurpose = "send",
  ): Promise<SensitiveActionDecision> => {
    if (pending !== null) {
      return new Promise((resolve) => {
        queued.push({
          start: () => {
            void request(findings, purpose).then(resolve);
          },
          cancel: () => resolve("cancel"),
        });
      });
    }

    const root = document.body ?? document.documentElement;
    if (root === null) {
      return Promise.resolve("cancel");
    }

    const dialog = document.createElement("section");
    dialog.id = DIALOG_ID;
    dialog.className = "privacy-composer-confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "privacy-composer-confirmation-title");

    const title = document.createElement("h2");
    title.id = "privacy-composer-confirmation-title";
    title.textContent = "检测到敏感信息";

    const description = document.createElement("p");
    description.className = "privacy-composer-confirmation-description";
    description.textContent = purpose === "paste"
      ? "粘贴前请确认。可先粘贴匿名化版本；原文粘贴仅适用于本次，白名单不会自动变更。"
      : "发送前请确认。可先发送匿名化版本；原文发送仅适用于本次，白名单不会自动变更。";

    /*
     * 语义候选是猜测，所以要明说，并指向正确的那个按钮。
     *
     * 本地模型在干净文本上的提示率实测 1.7%-10.8%（逐集数字见 ml/docs/r8-model-card.md），也就是说
     * 用户一定会遇到"这明明不是敏感信息"的情况。此时正确动作是"本会话允许"——它把这个值在本会话内
     * 放行，不必每次重来，也不会改动全局白名单。不说的话，用户最可能反复点"仅本次"，或者干脆关掉整个
     * 功能。
     *
     * 这里刻意不显示被标中的原文。`RedactionFinding` 有意不携带原值：它会跨上下文传到侧边栏与
     * background，带上原值等于把敏感文本扩散到更多地方。为了这一句提示去放宽那个类型，是拿隐私设计
     * 换便利。用户能在自己的草稿里看到上下文，所以"哪个词"并非不可知。
     */
    const missNote = document.createElement("p");
    missNote.className = "privacy-composer-confirmation-description";
    missNote.textContent = "上面只列出本次命中。未列出的姓名不会提示。";

    const inferredNote = findings.some((finding) => finding.inferred === true)
      ? (() => {
          const note = document.createElement("p");
          note.className = "privacy-composer-confirmation-description";
          note.textContent = "带“本地语义候选”的项是模型的猜测，可能认错。如果它认错了，选“本会话允许”即可，本次会话内不再提示这个值。";
          return note;
        })()
      : null;

    const list = document.createElement("ul");
    list.className = "privacy-composer-confirmation-list";
    for (const summary of summarizeFindings(findings)) {
      const item = document.createElement("li");
      appendText(document, item, summary);
      list.append(item);
    }

    const actions = document.createElement("div");
    actions.className = "privacy-composer-confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.action = "cancel";
    cancel.textContent = purpose === "paste" ? "取消粘贴" : "取消发送";
    cancel.addEventListener("click", () => close("cancel"));
    const session = document.createElement("button");
    session.type = "button";
    session.dataset.action = "confirm-session";
    session.className = "privacy-composer-confirmation-session";
    session.textContent = purpose === "paste" ? "本会话允许并粘贴" : "本会话允许并发送";
    session.addEventListener("click", () => close("session"));
    const rawOnce = document.createElement("button");
    rawOnce.type = "button";
    rawOnce.dataset.action = "raw-once";
    rawOnce.className = "privacy-composer-confirmation-raw";
    rawOnce.textContent = purpose === "paste" ? "仅本次粘贴原文" : "仅本次发送原文";
    rawOnce.addEventListener("click", () => {
      if (rawOnce.dataset.armed === "true") {
        close("raw_once");
        return;
      }
      rawOnce.dataset.armed = "true";
      rawOnce.textContent = purpose === "paste" ? "再点一次，确认原文粘贴" : "再点一次，确认原文发送";
    });
    const redact = document.createElement("button");
    redact.type = "button";
    redact.dataset.action = "redact";
    redact.className = "privacy-composer-confirmation-redact";
    redact.textContent = purpose === "paste" ? "匿名化粘贴" : "匿名化发送";
    redact.addEventListener("click", () => close("redact"));
    actions.append(redact, cancel, session, rawOnce);

    dialog.append(
      title,
      description,
      list,
      missNote,
      ...(inferredNote === null ? [] : [inferredNote]),
      actions,
    );
    root.append(dialog);
    redact.focus();

    return new Promise<SensitiveActionDecision>((resolve) => {
      pending = { resolve, dialog };
      keydownListener = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissAll();
        }
      };
      document.addEventListener("keydown", keydownListener, true);
    });
  };

  const requestUnreviewed = (reason: string, purpose: SensitiveConfirmationPurpose = "send"): Promise<boolean> => {
    if (pending !== null) {
      return new Promise((resolve) => {
        queued.push({
          start: () => {
            void requestUnreviewed(reason, purpose).then(resolve);
          },
          cancel: () => resolve(false),
        });
      });
    }

    const root = document.body ?? document.documentElement;
    if (root === null) {
      return Promise.resolve(false);
    }

    const dialog = document.createElement("section");
    dialog.id = DIALOG_ID;
    dialog.className = "privacy-composer-confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "privacy-composer-confirmation-title");

    const title = document.createElement("h2");
    title.id = "privacy-composer-confirmation-title";
    title.textContent = "本地语义复核未完成";

    const description = document.createElement("p");
    description.className = "privacy-composer-confirmation-description";
    description.textContent = purpose === "paste"
      ? `${reason}。扩展不会假装已经扫过。请先取消粘贴；按原文交给网页需要再点一次。`
      : `${reason}。扩展不会假装已经扫过。请先取消发送；按原文交给网页需要再点一次。`;

    const actions = document.createElement("div");
    actions.className = "privacy-composer-confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.action = "cancel-unreviewed";
    cancel.textContent = purpose === "paste" ? "取消粘贴" : "取消发送";
    cancel.addEventListener("click", () => close("cancel"));
    const rawOnce = document.createElement("button");
    rawOnce.type = "button";
    rawOnce.dataset.action = "raw-unreviewed-once";
    rawOnce.className = "privacy-composer-confirmation-raw";
    rawOnce.textContent = purpose === "paste" ? "仅本次按原文粘贴" : "仅本次按原文发送";
    rawOnce.addEventListener("click", () => {
      if (rawOnce.dataset.armed === "true") {
        close("raw_once");
        return;
      }
      rawOnce.dataset.armed = "true";
      rawOnce.textContent = purpose === "paste" ? "再点一次，确认原文粘贴" : "再点一次，确认原文发送";
    });
    actions.append(cancel, rawOnce);
    dialog.append(title, description, actions);
    root.append(dialog);
    cancel.focus();

    return new Promise<boolean>((resolve) => {
      pending = { resolve: (decision) => resolve(decision === "raw_once"), dialog };
      keydownListener = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissAll();
        }
      };
      document.addEventListener("keydown", keydownListener, true);
    });
  };

  const requestAttachment = (blocked = false, unverified = false): Promise<boolean> => {
    if (pending !== null) {
      return new Promise((resolve) => {
        queued.push({
          start: () => {
            void requestAttachment(blocked, unverified).then(resolve);
          },
          cancel: () => resolve(false),
        });
      });
    }

    const root = document.body ?? document.documentElement;
    if (root === null) {
      return Promise.resolve(false);
    }

    const dialog = document.createElement("section");
    dialog.id = DIALOG_ID;
    dialog.className = "privacy-composer-confirmation";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "privacy-composer-confirmation-title");

    const title = document.createElement("h2");
    title.id = "privacy-composer-confirmation-title";
    title.textContent = unverified
      ? "无法核验附件状态"
      : blocked
        ? "已阻止未扫描附件发送"
        : "检测到已附加文件";
    const description = document.createElement("p");
    description.className = "privacy-composer-confirmation-description";
    description.textContent = unverified
      ? "当前站点没有可验证的附件节点。为避免附件策略静默失效，本次发送已暂停；扩展不读取文件内容，只有你明确选择本次继续后才会交由网页发送。"
      : blocked
        ? "文件内容未被读取。仅在你明确选择一次性继续后，才会交由网页按原生附件路径发送。"
        : "文件内容未被读取。确认后仍会执行文本脱敏和高风险检测。";

    const actions = document.createElement("div");
    actions.className = "privacy-composer-confirmation-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.dataset.action = "cancel-attachment";
    cancel.textContent = "取消发送";
    cancel.addEventListener("click", () => close("cancel"));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.dataset.action = "confirm-attachment";
    confirm.className = "privacy-composer-confirmation-redact";
    confirm.textContent = unverified || blocked ? "仅本次继续发送" : "继续检查并发送";
    confirm.addEventListener("click", () => close("raw_once"));
    actions.append(cancel, confirm);
    dialog.append(title, description, actions);
    root.append(dialog);
    cancel.focus();

    return new Promise<boolean>((resolve) => {
      pending = { resolve: (decision) => resolve(decision === "raw_once"), dialog };
      keydownListener = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissAll();
        }
      };
      document.addEventListener("keydown", keydownListener, true);
    });
  };

  return {
    request,
    requestUnreviewed,
    requestAttachment,
    dispose() {
      dismissAll();
    },
  };
}
