import { materializeDraftRedaction, resolveSendAction } from "./shared/detector.js";
import {
  createChromeCustomTermsStore,
  DEFAULT_ADVANCED_SETTINGS,
  type CustomTermsStore,
} from "./shared/custom-terms.js";
import { combineSemanticProviders } from "./shared/neural/hint-cache.js";
import { NEURAL_REVIEW_REQUEST, isNeuralReviewResult } from "./shared/neural/messages.js";
import { createLocalStatisticalSemanticProvider, type SemanticHint, type SemanticReviewProvider } from "./shared/semantic-review.js";
import { createSessionTokenMap, type SessionTokenMap } from "./shared/session-token-map.js";
import type {
  DetectionKind,
  FillDraftMessage,
  FillError,
  FillResponse,
  RedactionFinding,
  SendAction,
  SiteId,
  SiteStatusResponse,
} from "./shared/types.js";

const SITE_LABELS: Record<SiteId, string> = {
  doubao: "豆包网页版",
  deepseek: "DeepSeek 网页版",
  yuanbao: "元宝网页版",
  chatgpt: "ChatGPT 网页版",
  claude: "Claude 网页版",
  gemini: "Gemini 网页版",
  kimi: "Kimi 网页版",
  qwen: "通义千问网页版",
  wenxin: "文心一言网页版",
};

const FINDING_LABELS: Record<DetectionKind, string> = {
  api_key: "API 密钥",
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
  ipv4: "IPv4 地址",
  ipv6: "IPv6 地址",
  local_path: "本机路径",
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

const FILL_ERROR_MESSAGES: Record<FillError, string> = {
  unsupported_site: "当前网页不受支持。",
  site_changed: "当前网页已变化，请重新检查草稿。",
  binding_changed: "当前网页已变化，请重新检查草稿。",
  editor_not_found: "未找到可写入的聊天输入框。",
  write_failed: "无法写入聊天输入框。",
  content_script_unavailable: "无法连接当前网页，请刷新后重试。",
  invalid_message: "填入请求无效。",
};

type ResultState = "neutral" | "ready" | "error";
type PrivateComposerResult = {
  outboundText: string;
  findings: readonly RedactionFinding[];
  sendAction: SendAction;
};
type ActiveTarget = {
  site: SiteId;
  tabId: number;
  bindingKey: string;
};

export type SidePanelGateway = {
  getActiveSite: () => Promise<SiteStatusResponse>;
  fillDraft: (message: FillDraftMessage) => Promise<FillResponse>;
  reviewDraft?: (text: string) => Promise<readonly SemanticHint[] | null>;
};

export type SidePanelSettingsStore = Pick<CustomTermsStore, "read">;

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element as T;
}

function isSiteStatusResponse(value: unknown): value is SiteStatusResponse {
  const response = value as { site?: unknown; tabId?: unknown; bindingKey?: unknown };

  return (
    typeof value === "object" &&
    value !== null &&
    "site" in value &&
    (
      (response.site === null ||
        ((response.site === "doubao" ||
          response.site === "deepseek" ||
          response.site === "yuanbao" ||
          response.site === "chatgpt" ||
          response.site === "claude" ||
          response.site === "gemini" ||
          response.site === "kimi" ||
          response.site === "qwen" ||
          response.site === "wenxin") &&
          typeof response.tabId === "number" &&
          Number.isSafeInteger(response.tabId) &&
          response.tabId >= 0 &&
          typeof response.bindingKey === "string" &&
          response.bindingKey.length >= 16))
    )
  );
}

function isFillResponse(value: unknown): value is FillResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value.ok === true || (value.ok === false && "error" in value && typeof value.error === "string"))
  );
}

export function canBootstrapSidePanel(chromeApi: unknown): boolean {
  if (typeof chromeApi !== "object" || chromeApi === null) {
    return false;
  }

  const runtime = (chromeApi as { runtime?: unknown }).runtime;

  return (
    typeof runtime === "object" &&
    runtime !== null &&
    typeof (runtime as { sendMessage?: unknown }).sendMessage === "function"
  );
}

function createChromeGateway(): SidePanelGateway {
  return {
    async getActiveSite() {
      const response = await chrome.runtime.sendMessage({ type: "PING" });

      return isSiteStatusResponse(response) ? response : { site: null };
    },
    async fillDraft(message) {
      const response = await chrome.runtime.sendMessage(message);

      return isFillResponse(response) ? response : { ok: false, error: "content_script_unavailable" };
    },
    async reviewDraft(text) {
      try {
        const requestId = `sidepanel-${crypto.randomUUID()}`;
        const response = await chrome.runtime.sendMessage({
          type: NEURAL_REVIEW_REQUEST,
          requestId,
          text,
        });
        return isNeuralReviewResult(response, text, requestId) && response.ok ? response.hints : null;
      } catch {
        return null;
      }
    },
  };
}

function formatFindings(findings: readonly RedactionFinding[]): string {
  return findings.map((finding) => `${FINDING_LABELS[finding.kind]} ${finding.count} 项`).join("，");
}

export class SidePanelController {
  private readonly siteStatus: HTMLElement;
  private readonly resultStatus: HTMLElement;
  private readonly draftInput: HTMLTextAreaElement;
  private readonly preview: HTMLElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly fillButton: HTMLButtonElement;
  private readonly semanticReviewProvider = createLocalStatisticalSemanticProvider();
  private activeTarget: ActiveTarget | null = null;
  private result: PrivateComposerResult | null = null;
  private previewTokenMap: SessionTokenMap | null = null;
  private resultMessage = "等待本地检查";
  private resultState: ResultState = "neutral";
  private draftRevision = 0;
  private checking = false;

  constructor(
    private readonly document: Document,
    private readonly gateway: SidePanelGateway,
    private readonly settingsStore: SidePanelSettingsStore = createChromeCustomTermsStore(),
  ) {
    this.siteStatus = requiredElement(document, "site-status");
    this.resultStatus = requiredElement(document, "result-status");
    this.draftInput = requiredElement(document, "draft-input");
    this.preview = requiredElement(document, "outbound-preview");
    this.checkButton = requiredElement(document, "check-button");
    this.clearButton = requiredElement(document, "clear-button");
    this.fillButton = requiredElement(document, "fill-button");
  }

  async initialize(): Promise<void> {
    this.draftInput.addEventListener("input", () => this.invalidateResult());
    this.checkButton.addEventListener("click", () => {
      void this.checkDraft();
    });
    this.clearButton.addEventListener("click", () => this.clearDraft());
    this.fillButton.addEventListener("click", () => {
      void this.fillPage();
    });
    this.render();
    await this.refreshActiveSite();
  }

  private releasePreviewTokenMap(): void {
    this.previewTokenMap?.clear();
    this.previewTokenMap = null;
  }

  private async refreshActiveSite(): Promise<void> {
    try {
      const response = await this.gateway.getActiveSite();
      this.activeTarget = response.site === null ? null : response;
    } catch {
      this.activeTarget = null;
    }
    this.renderSiteStatus();
    this.render();
  }

  private renderSiteStatus(): void {
    if (this.activeTarget) {
      this.siteStatus.textContent = `已连接：${SITE_LABELS[this.activeTarget.site]}`;
      this.siteStatus.dataset.state = "ready";
      return;
    }

    this.siteStatus.textContent = "当前网页不受支持";
    this.siteStatus.dataset.state = "unsupported";
  }

  private render(): void {
    const hasDraft = this.draftInput.value.trim().length > 0;

    this.checkButton.disabled = !hasDraft || this.checking;
    this.clearButton.disabled = this.checking;
    this.fillButton.disabled =
      this.checking ||
      !this.activeTarget ||
      this.result === null ||
      this.result.sendAction === "block" ||
      this.result.outboundText.length === 0;
    this.fillButton.textContent = this.result?.sendAction === "confirm" ? "确认匿名化填入" : "填入网页";
    this.resultStatus.textContent = this.resultMessage;
    this.resultStatus.dataset.state = this.resultState;
    this.preview.textContent = this.result?.outboundText ?? "";
  }

  private invalidateResult(): void {
    this.draftRevision += 1;
    this.releasePreviewTokenMap();
    this.result = null;
    this.resultMessage = "草稿已变更，请重新检查。";
    this.resultState = "neutral";
    this.render();
  }

  private async checkDraft(): Promise<void> {
    const draft = this.draftInput.value;
    const revision = this.draftRevision;

    if (draft.trim().length === 0 || this.checking) {
      return;
    }

    this.checking = true;
    this.releasePreviewTokenMap();
    this.result = null;
    this.resultMessage = "正在本地生成出站文本。";
    this.resultState = "neutral";
    this.render();

    try {
      await this.refreshActiveSite();
      if (!this.activeTarget) {
        this.resultMessage = "当前网页不受支持，未生成出站文本。";
        this.resultState = "error";
        return;
      }

      const settings = await this.settingsStore.read();
      if (this.draftRevision !== revision || this.draftInput.value !== draft) {
        return;
      }
      if (!settings.ok) {
        this.resultMessage = "无法读取本地保护设置，未生成出站文本。";
        this.resultState = "error";
        return;
      }

      const detectionProfile = settings.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile;
      let semanticReviewProvider: SemanticReviewProvider | undefined;
      let neuralUnavailable = false;
      if (settings.semanticReview === "local_statistical") {
        semanticReviewProvider = this.semanticReviewProvider;
      } else if (settings.semanticReview === "local_neural") {
        let neuralHints: readonly SemanticHint[] | null = null;
        try {
          neuralHints = await (this.gateway.reviewDraft?.(draft) ?? Promise.resolve(null));
        } catch {
          neuralHints = null;
        }
        if (this.draftRevision !== revision || this.draftInput.value !== draft) {
          return;
        }
        neuralUnavailable = neuralHints === null;
        semanticReviewProvider = neuralHints === null
          ? this.semanticReviewProvider
          : combineSemanticProviders(this.semanticReviewProvider, {
            review: (input) => input === draft ? neuralHints : [],
          });
      }

      const tokenMap = createSessionTokenMap();
      const result = materializeDraftRedaction(
        draft,
        settings.terms.map((term) => term.value),
        tokenMap,
        [],
        settings.categoryPolicies ?? [],
        {
          detectionProfile,
          replacementStyle: settings.replacementStyle ?? DEFAULT_ADVANCED_SETTINGS.replacementStyle,
          semanticReviewProvider,
        },
      );

      if (this.draftRevision !== revision || this.draftInput.value !== draft) {
        tokenMap.clear();
        return;
      }

      this.previewTokenMap = tokenMap;
      const sendAction = resolveSendAction(result.findings, settings.mode);
      this.result = { ...result, sendAction };
      const ignoresAllowlist = (settings.allowlistedTerms?.length ?? 0) + (settings.siteAllowlist?.length ?? 0) > 0;
      const neuralNotice = neuralUnavailable ? " 本地神经模型未就绪，已按规则/统计路径生成。" : "";
      if (sendAction === "block") {
        this.resultMessage = `当前类别策略设为始终阻止，未生成可填入文本。${neuralNotice}`;
        this.resultState = "error";
      } else if (sendAction === "confirm") {
        this.resultMessage = `已生成匿名化出站文本：${formatFindings(result.findings)}。发现需确认项，请确认匿名化填入。${neuralNotice}`;
        this.resultState = "ready";
      } else {
        this.resultMessage = result.findings.length === 0
          ? `未命中现有规则，出站文本与草稿相同。${neuralNotice}`
          : `已生成匿名化出站文本：${formatFindings(result.findings)}。${ignoresAllowlist ? " 私密编辑器不使用白名单放行。" : ""}${neuralNotice}`;
        this.resultState = "ready";
      }
    } catch {
      this.releasePreviewTokenMap();
      this.result = null;
      this.resultMessage = "本地检测失败，未生成出站文本。";
      this.resultState = "error";
    } finally {
      this.checking = false;
      this.render();
    }
  }

  private clearDraft(): void {
    this.draftInput.value = "";
    this.draftRevision += 1;
    this.releasePreviewTokenMap();
    this.result = null;
    this.resultMessage = "草稿已清空。";
    this.resultState = "neutral";
    this.render();
  }

  private async fillPage(): Promise<void> {
    const result = this.result;
    const expectedTarget = this.activeTarget;

    if (!expectedTarget || result === null || result.sendAction === "block" || this.checking) {
      return;
    }

    this.checking = true;
    this.render();
    try {
      const activePage = await this.gateway.getActiveSite();
      if (
        activePage.site === null ||
        activePage.site !== expectedTarget.site ||
        activePage.tabId !== expectedTarget.tabId ||
        activePage.bindingKey !== expectedTarget.bindingKey
      ) {
        this.activeTarget = activePage.site === null ? null : activePage;
        this.releasePreviewTokenMap();
        this.result = null;
        this.resultMessage = "当前网页已变化，请重新检查草稿。";
        this.resultState = "error";
        this.renderSiteStatus();
        return;
      }

      const response = await this.gateway.fillDraft({
        type: "FILL_DRAFT",
        outboundText: result.outboundText,
        site: expectedTarget.site,
        tabId: expectedTarget.tabId,
        bindingKey: expectedTarget.bindingKey,
      });

      if (!response.ok) {
        this.resultMessage = FILL_ERROR_MESSAGES[response.error];
        this.resultState = "error";
        return;
      }

      this.draftInput.value = "";
      this.draftRevision += 1;
      this.releasePreviewTokenMap();
      this.result = null;
      this.resultMessage = "已填入网页，请在页面确认后手动发送。";
      this.resultState = "ready";
    } catch {
      this.resultMessage = "无法连接当前网页，请刷新后重试。";
      this.resultState = "error";
    } finally {
      this.checking = false;
      this.render();
    }
  }
}

export async function bootstrapSidePanel(document: Document = window.document): Promise<SidePanelController> {
  const controller = new SidePanelController(document, createChromeGateway());
  await controller.initialize();
  return controller;
}

if (canBootstrapSidePanel(globalThis.chrome)) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void bootstrapSidePanel();
    });
  } else {
    void bootstrapSidePanel();
  }
}
