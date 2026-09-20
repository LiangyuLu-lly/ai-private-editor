import {
  createChromeCustomTermsStore,
  type CustomTerm,
  type CustomTermGroup,
  type CustomTermsMutationResult,
  type CustomTermsReadResult,
  type CustomTermsSettings,
  type CustomTermsStore,
  type AllowlistTarget,
  type RedactionMode,
  DEFAULT_ADVANCED_SETTINGS,
} from "./shared/custom-terms.js";
import {
  createChromeAuditLogStore,
  exportAuditLog,
  type AuditEvent,
  type AuditLogReadResult,
  type AuditLogStore,
} from "./shared/audit-log.js";
import { mergeCategoryPolicies } from "./shared/policy-overlay.js";
import {
  applyProfessionalPreset,
  parseProfessionalPresetPack,
  PROFESSIONAL_PRESET_IDS,
  type ProfessionalPresetId,
} from "./shared/professional-presets.js";
import {
  applyConfigurationTransfer,
  serializeConfigurationTransfer,
  type ConfigurationImportMode,
} from "./shared/config-transfer.js";
import { readNeuralRuntimeStatus } from "./shared/neural/runtime-status.js";
import { createChromeSessionClearSignal, type SessionClearSignal } from "./shared/session-clear.js";
import type {
  AttachmentAction,
  CategoryPolicyAction,
  DetectionKind,
  DetectionProfile,
  ReplacementStyle,
  SemanticReviewMode,
  SiteId,
} from "./shared/types.js";

const ERROR_MESSAGES = {
  empty_term: "请输入至少一个词条。",
  term_too_long: "单个词条不能超过 120 个字符。",
  duplicate_term: "该词条已存在。",
  term_limit: "最多保存 100 个词条。",
  invalid_storage: "自定义词库格式异常，未发送。可清空后重新添加。",
  storage_read_failed: "无法读取本地自定义词库。",
  storage_write_failed: "无法保存本地自定义词库。",
} as const;

const GROUP_LABELS: Record<CustomTermGroup, string> = {
  personal: "个人",
  work: "工作",
  project: "项目",
  other: "其他",
};

const SITE_LABELS: Record<SiteId, string> = {
  doubao: "豆包",
  deepseek: "DeepSeek",
  yuanbao: "元宝",
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "通义千问",
  wenxin: "文心一言",
};

const DETECTION_KIND_LABELS: Record<DetectionKind, string> = {
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

const DETECTION_KINDS = Object.keys(DETECTION_KIND_LABELS) as DetectionKind[];
const DEFAULT_CONFIRM_KINDS = new Set<DetectionKind>([
  "api_key",
  "access_token",
  "private_key",
  "connection_string",
  "credential",
]);

const POLICY_OPTION_LABELS: Record<CategoryPolicyAction | "default", string> = {
  default: "默认（内置规则）",
  replace: "自动匿名化",
  confirm: "发送前确认",
  block: "始终阻止",
};

const AUDIT_OPERATION_LABELS = {
  send: "发送",
  paste: "粘贴",
} as const;

const AUDIT_OUTCOME_LABELS = {
  anonymized: "已匿名化",
  raw_confirmed: "已确认原文",
  cancelled: "已取消",
  blocked: "已阻止",
} as const;

const EMPTY_SETTINGS: CustomTermsSettings = { terms: [], mode: "replace", allowlistedTerms: [] };

export type PopupController = {
  initialize(): Promise<void>;
  dispose(): void;
};

export type PrivateComposerLauncher = {
  isAvailable(): boolean;
  open(): Promise<void>;
};

export type PageGuardState = "on" | "off" | "unknown";

export type PageGuardStatusReader = () => Promise<PageGuardState>;

export function badgeTextToPageGuardState(badgeText: string): PageGuardState {
  if (badgeText === "ON") {
    return "on";
  }
  if (badgeText === "!") {
    return "off";
  }
  return "unknown";
}

export function pageGuardPresentation(state: PageGuardState): { text: string; title: string } {
  switch (state) {
    case "on":
      return { text: "ON", title: "当前页已接管" };
    case "off":
      return { text: "OFF", title: "当前页未保护，按网页原生发送" };
    case "unknown":
      return { text: "—", title: "当前页未接管或正在检查" };
  }
}

function isPageGuardQueryResult(value: unknown): value is { status: { state?: string } | null } {
  return typeof value === "object" && value !== null && "status" in value;
}

export function createChromePageGuardStatusReader(
  chromeApi: unknown = typeof chrome === "undefined" ? undefined : chrome,
): PageGuardStatusReader {
  return async () => {
    const api = chromeApi as {
      tabs?: {
        query: (queryInfo: { active: boolean; currentWindow: boolean }) => Promise<Array<{ id?: number }>>;
        sendMessage: (tabId: number, message: { type: string }) => Promise<unknown>;
      };
      action?: {
        getBadgeText: (details: { tabId: number }) => Promise<string>;
      };
    } | undefined;

    if (typeof api?.tabs?.query !== "function") {
      return "unknown";
    }

    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId !== "number") {
        return "unknown";
      }

      if (typeof api.tabs.sendMessage === "function") {
        try {
          const response = await api.tabs.sendMessage(tabId, { type: "QUERY_PROTECTION_STATUS" });
          if (isPageGuardQueryResult(response) && response.status !== null && response.status !== undefined) {
            if (response.status.state === "protected") {
              return "on";
            }
            if (response.status.state === "unverified") {
              return "off";
            }
            return "unknown";
          }
        } catch {
          // No content script in this tab.
        }
      }

      if (typeof api.action?.getBadgeText === "function") {
        return badgeTextToPageGuardState(await api.action.getBadgeText({ tabId }));
      }

      return "unknown";
    } catch {
      return "unknown";
    }
  };
}

type SidePanelLauncherApi = {
  sidePanel?: {
    open: (options: { windowId: number }) => Promise<void>;
  };
  windows?: {
    getCurrent: (callback: (currentWindow: { id?: number }) => void) => void;
  };
};

function asSidePanelLauncherApi(value: unknown): SidePanelLauncherApi | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as SidePanelLauncherApi;
  return typeof candidate.sidePanel?.open === "function" && typeof candidate.windows?.getCurrent === "function"
    ? candidate
    : null;
}

export function createChromePrivateComposerLauncher(
  chromeApi: unknown = typeof chrome === "undefined" ? undefined : chrome,
): PrivateComposerLauncher {
  const api = asSidePanelLauncherApi(chromeApi);

  return {
    isAvailable: () => api !== null,
    open() {
      if (api === null) {
        return Promise.reject(new Error("Side panel API is unavailable"));
      }

      return new Promise<void>((resolve, reject) => {
        try {
          api.windows!.getCurrent((currentWindow) => {
            if (typeof currentWindow?.id !== "number") {
              reject(new Error("Current extension window is unavailable"));
              return;
            }

            void api.sidePanel!.open({ windowId: currentWindow.id }).then(resolve, reject);
          });
        } catch (error) {
          reject(error);
        }
      });
    },
  };
}

function requiredElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element as T;
}

function failureMessage(result: Exclude<CustomTermsMutationResult | CustomTermsReadResult, { ok: true }>): string {
  return ERROR_MESSAGES[result.error];
}

function isCustomTermGroup(value: string): value is CustomTermGroup {
  return value in GROUP_LABELS;
}

function isCategoryPolicyAction(value: string): value is CategoryPolicyAction {
  return value === "replace" || value === "confirm" || value === "block";
}

function isDetectionProfile(value: string): value is DetectionProfile {
  return value === "conservative" || value === "balanced";
}

function isReplacementStyle(value: string): value is ReplacementStyle {
  return value === "token" || value === "masked" || value === "surrogate";
}

function isAttachmentAction(value: string): value is AttachmentAction {
  return value === "allow" || value === "warn" || value === "confirm" || value === "block";
}

function isSemanticReviewMode(value: string): value is SemanticReviewMode {
  return value === "off" || value === "local_statistical" || value === "local_neural";
}

function isSiteId(value: string): value is SiteId {
  return value in SITE_LABELS;
}

function isProfessionalPresetId(value: string): value is ProfessionalPresetId {
  for (const id of PROFESSIONAL_PRESET_IDS) {
    if (id === value) {
      return true;
    }
  }
  return false;
}

function presetPackUrl(id: ProfessionalPresetId): string {
  if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
    return chrome.runtime.getURL(`assets/presets/${id}.json`);
  }
  return `assets/presets/${id}.json`;
}

function settingsFromStoreResult(result: CustomTermsSettings): CustomTermsSettings {
  return {
    terms: result.terms,
    mode: result.mode,
    allowlistedTerms: result.allowlistedTerms,
    siteAllowlist: result.siteAllowlist,
    categoryPolicies: result.categoryPolicies,
    siteCategoryPolicies: result.siteCategoryPolicies,
    settingsVersion: result.settingsVersion,
    auditEnabled: result.auditEnabled,
    detectionProfile: result.detectionProfile,
    replacementStyle: result.replacementStyle,
    replyTokenViewerEnabled: result.replyTokenViewerEnabled,
    attachmentAction: result.attachmentAction,
    semanticReview: result.semanticReview,
  };
}

type AllowlistExpiry = "one_hour" | "one_day" | "seven_days" | "never";

function isAllowlistExpiry(value: string): value is AllowlistExpiry {
  return value === "one_hour" || value === "one_day" || value === "seven_days" || value === "never";
}

function isConfigurationImportMode(value: string): value is ConfigurationImportMode {
  return value === "replace" || value === "merge";
}

function expiryTimestamp(expiry: AllowlistExpiry, now = Date.now()): string | undefined {
  const duration = {
    one_hour: 60 * 60 * 1000,
    one_day: 24 * 60 * 60 * 1000,
    seven_days: 7 * 24 * 60 * 60 * 1000,
    never: 0,
  }[expiry];

  return duration === 0 ? undefined : new Date(now + duration).toISOString();
}

function successMessage(terms: readonly CustomTerm[], previousCount: number): string {
  const addedCount = terms.length - previousCount;

  return `已添加 ${addedCount} 个词条。`;
}

export function createPopupController(
  document: Document,
  store: CustomTermsStore,
  confirmClear: () => boolean = () => document.defaultView?.confirm("确认清空全部自定义敏感词吗？") ?? false,
  auditLog: AuditLogStore = createChromeAuditLogStore(),
  confirmImport: () => boolean = () => document.defaultView?.confirm("导入会替换当前自定义词、白名单和策略，是否继续？") ?? false,
  confirmSiteAllowlist: () => boolean = () => document.defaultView?.confirm("指定网站白名单可能按原文发送敏感值。确认仅对所选网站放行吗？") ?? false,
  sessionClearSignal: SessionClearSignal = createChromeSessionClearSignal(),
  confirmSensitiveExport: () => boolean = () => document.defaultView?.confirm("导出的白名单可能包含敏感原文。确认生成包含白名单的配置吗？") ?? false,
  privateComposerLauncher: PrivateComposerLauncher = createChromePrivateComposerLauncher(),
  pageGuardStatusReader: PageGuardStatusReader = createChromePageGuardStatusReader(),
): PopupController {
  const form = requiredElement<HTMLFormElement>(document, "custom-term-form");
  const input = requiredElement<HTMLTextAreaElement>(document, "custom-term-input");
  const groupInput = requiredElement<HTMLSelectElement>(document, "custom-term-group");
  const searchInput = requiredElement<HTMLInputElement>(document, "custom-term-search");
  const filterInput = requiredElement<HTMLSelectElement>(document, "custom-term-filter-group");
  const strictModeInput = requiredElement<HTMLInputElement>(document, "strict-redaction-mode");
  const status = requiredElement<HTMLElement>(document, "custom-term-status");
  const list = requiredElement<HTMLUListElement>(document, "custom-term-list");
  const clearButton = requiredElement<HTMLButtonElement>(document, "clear-custom-terms");
  const customTermsTab = requiredElement<HTMLButtonElement>(document, "custom-terms-tab");
  const allowlistTab = requiredElement<HTMLButtonElement>(document, "allowlist-tab");
  const policyTab = requiredElement<HTMLButtonElement>(document, "policy-tab");
  const auditTab = requiredElement<HTMLButtonElement>(document, "audit-tab");
  const configTransferTab = requiredElement<HTMLButtonElement>(document, "config-transfer-tab");
  const protectionTab = requiredElement<HTMLButtonElement>(document, "protection-tab");
  const customTermsPanel = requiredElement<HTMLElement>(document, "custom-terms-panel");
  const allowlistPanel = requiredElement<HTMLElement>(document, "allowlist-panel");
  const policyPanel = requiredElement<HTMLElement>(document, "policy-panel");
  const auditPanel = requiredElement<HTMLElement>(document, "audit-panel");
  const configTransferPanel = requiredElement<HTMLElement>(document, "config-transfer-panel");
  const protectionPanel = requiredElement<HTMLElement>(document, "protection-panel");
  const moreSettings = requiredElement<HTMLDetailsElement>(document, "more-settings");
  const pageGuardStatus = requiredElement<HTMLElement>(document, "page-guard-status");
  const allowlistForm = requiredElement<HTMLFormElement>(document, "allowlist-form");
  const allowlistInput = requiredElement<HTMLTextAreaElement>(document, "allowlist-input");
  const allowlistScopeInput = requiredElement<HTMLSelectElement>(document, "allowlist-scope");
  const allowlistSiteInput = requiredElement<HTMLSelectElement>(document, "allowlist-site");
  const allowlistSiteControl = requiredElement<HTMLElement>(document, "allowlist-site-control");
  const allowlistExpiryInput = requiredElement<HTMLSelectElement>(document, "allowlist-expiry");
  const allowlistExpiryControl = requiredElement<HTMLElement>(document, "allowlist-expiry-control");
  const allowlistSearchInput = requiredElement<HTMLInputElement>(document, "allowlist-search");
  const allowlistStatus = requiredElement<HTMLElement>(document, "allowlist-status");
  const allowlistList = requiredElement<HTMLUListElement>(document, "allowlist-list");
  const clearAllowlistButton = requiredElement<HTMLButtonElement>(document, "clear-allowlist");
  const policyStatus = requiredElement<HTMLElement>(document, "policy-status");
  const policyList = requiredElement<HTMLUListElement>(document, "policy-list");
  const policyScopeInput = requiredElement<HTMLSelectElement>(document, "policy-scope");
  const policySiteInput = requiredElement<HTMLSelectElement>(document, "policy-site");
  const policySiteControl = requiredElement<HTMLElement>(document, "policy-site-control");
  const presetPackInput = requiredElement<HTMLSelectElement>(document, "preset-pack");
  const applyPresetButton = requiredElement<HTMLButtonElement>(document, "apply-preset");
  const confirmPresetButton = requiredElement<HTMLButtonElement>(document, "confirm-preset");
  const auditEnabledInput = requiredElement<HTMLInputElement>(document, "audit-enabled");
  const auditStatus = requiredElement<HTMLElement>(document, "audit-status");
  const auditList = requiredElement<HTMLUListElement>(document, "audit-list");
  const auditExport = requiredElement<HTMLTextAreaElement>(document, "audit-export");
  const exportAuditButton = requiredElement<HTMLButtonElement>(document, "export-audit-log");
  const clearAuditButton = requiredElement<HTMLButtonElement>(document, "clear-audit-log");
  const configurationTransfer = requiredElement<HTMLTextAreaElement>(document, "configuration-transfer");
  const exportConfigurationButton = requiredElement<HTMLButtonElement>(document, "export-configuration");
  const importConfigurationButton = requiredElement<HTMLButtonElement>(document, "import-configuration");
  const importModeInput = requiredElement<HTMLSelectElement>(document, "import-mode");
  const exportIncludeAllowlistInput = requiredElement<HTMLInputElement>(document, "export-include-allowlist");
  const configurationTransferStatus = requiredElement<HTMLElement>(document, "config-transfer-status");
  const detectionProfileInput = requiredElement<HTMLSelectElement>(document, "detection-profile");
  const replacementStyleInput = requiredElement<HTMLSelectElement>(document, "replacement-style");
  const replyTokenViewerInput = requiredElement<HTMLInputElement>(document, "reply-token-viewer-enabled");
  const attachmentActionInput = requiredElement<HTMLSelectElement>(document, "attachment-action");
  const clearSessionMapButton = requiredElement<HTMLButtonElement>(document, "clear-session-map");
  const semanticReviewInput = requiredElement<HTMLSelectElement>(document, "semantic-review");
  const semanticReviewStatus = requiredElement<HTMLElement>(document, "semantic-review-status");
  const protectionStatus = requiredElement<HTMLElement>(document, "protection-status");
  const privateComposerButton = requiredElement<HTMLButtonElement>(document, "open-private-composer");
  const privateComposerStatus = requiredElement<HTMLElement>(document, "private-composer-status");
  let initialized = false;
  let disposed = false;
  let subscriptionRevision = 0;

  /**
   * Ask the offscreen host whether the model actually loaded, and append the answer.
   *
   * "Enabled" and "working" are different states, and the gap between them is invisible without
   * this: if WASM is refused by the extension-page CSP or the artifact is missing, the offscreen
    * document records `ready: false`, and the hint cache stays empty. In `local_neural` mode the
    * send-time gate then asks the user to cancel or explicitly send the raw draft once; the UI must
    * not describe that as an invisible rules-only downgrade.
   *
   * Best-effort by design. The service worker may be asleep and the offscreen document may not exist
   * yet on a cold popup, in which case there is simply no suffix; the settings copy above still
   * describes what is configured. Never throws into the render path.
   */
  const reportNeuralRuntimeState = async (): Promise<void> => {
    const base = semanticReviewStatus.textContent ?? "";
    // Read from storage.session rather than messaging the offscreen host. tests/build.test.ts
    // asserts the built popup contains no `sendMessage`, paired with the same assertion on
    // scanner.js: these are local-only surfaces that do not talk to pages or the worker. Publishing
    // status through storage keeps that property and also works before the offscreen document
    // exists.
    const status = await readNeuralRuntimeStatus();
    if (disposed || status === null) {
      return;
    }
    if (status.error !== null) {
      semanticReviewStatus.textContent = `${base} 模型加载失败（${status.error}），发送时将要求取消或确认一次原文发送。`;
      return;
    }
    semanticReviewStatus.textContent = status.ready
      ? `${base} 模型已就绪，加载耗时 ${status.loadMilliseconds ?? "?"} ms。`
      : `${base} 模型尚未加载，首次检测会稍慢。`;
  };
  let unsubscribe: (() => void) | null = null;
  let auditSubscriptionRevision = 0;
  let auditUnsubscribe: (() => void) | null = null;
  let settings: CustomTermsSettings = EMPTY_SETTINGS;
  let searchQuery = "";
  let groupFilter: "all" | CustomTermGroup = "all";
  let allowlistSearchQuery = "";
  let auditEvents: readonly AuditEvent[] = [];
  let configurationAvailable = false;
  let pendingPresetId: ProfessionalPresetId | null = null;

  const setStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    status.textContent = message;
    status.dataset.state = state;
  };

  const setAllowlistStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    allowlistStatus.textContent = message;
    allowlistStatus.dataset.state = state;
  };

  const setPolicyStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    policyStatus.textContent = message;
    policyStatus.dataset.state = state;
  };

  const setAuditStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    auditStatus.textContent = message;
    auditStatus.dataset.state = state;
  };

  const setConfigurationTransferStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    configurationTransferStatus.textContent = message;
    configurationTransferStatus.dataset.state = state;
  };

  const setProtectionStatus = (message: string, state: "neutral" | "success" | "error" = "neutral"): void => {
    protectionStatus.textContent = message;
    protectionStatus.dataset.state = state;
  };

  const renderPrivateComposerLauncher = (): void => {
    const available = privateComposerLauncher.isAvailable();
    privateComposerButton.disabled = !available;
    privateComposerStatus.textContent = available ? "" : "当前浏览器不支持私密编辑器。";
    privateComposerStatus.dataset.state = available ? "neutral" : "error";
  };

  const renderPageGuardStatus = async (): Promise<void> => {
    const state = await pageGuardStatusReader();
    if (disposed) {
      return;
    }

    const presentation = pageGuardPresentation(state);
    pageGuardStatus.textContent = presentation.text;
    pageGuardStatus.dataset.state = state;
    pageGuardStatus.title = presentation.title;
  };

  const openPrivateComposer = async (): Promise<void> => {
    try {
      await privateComposerLauncher.open();
      privateComposerStatus.textContent = "已打开私密编辑器。";
      privateComposerStatus.dataset.state = "success";
    } catch {
      privateComposerStatus.textContent = "无法打开私密编辑器。";
      privateComposerStatus.dataset.state = "error";
    }
  };

  const visibleTerms = (): readonly CustomTerm[] => {
    const normalizedQuery = searchQuery.toLocaleLowerCase();

    return settings.terms.filter((term) => {
      const matchesGroup = groupFilter === "all" || term.group === groupFilter;
      const matchesQuery = normalizedQuery.length === 0 || term.value.toLocaleLowerCase().includes(normalizedQuery);

      return matchesGroup && matchesQuery;
    });
  };

  const renderTerms = (): void => {
    const terms = visibleTerms();
    list.replaceChildren();
    clearButton.disabled = settings.terms.length === 0;
    strictModeInput.checked = settings.mode === "block";

    if (settings.terms.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "custom-term-empty";
      emptyState.textContent = "尚未添加自定义敏感词。";
      list.append(emptyState);
      return;
    }

    if (terms.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "custom-term-filter-empty";
      emptyState.textContent = "没有符合当前筛选条件的词条。";
      list.append(emptyState);
      return;
    }

    for (const term of terms) {
      const row = document.createElement("li");
      const copy = document.createElement("span");
      const group = document.createElement("span");
      const value = document.createElement("span");
      const removeButton = document.createElement("button");

      row.className = "custom-term-row";
      copy.className = "custom-term-copy";
      group.className = "custom-term-group";
      value.className = "custom-term-value";
      group.textContent = GROUP_LABELS[term.group];
      value.textContent = term.value;
      removeButton.type = "button";
      removeButton.textContent = "删除";
      removeButton.addEventListener("click", () => {
        void removeTerm(term.value);
      });
      copy.append(group, value);
      row.append(copy, removeButton);
      list.append(row);
    }
  };

  const allowlistEntries = (): readonly { value: string; scope: "global" | "site"; siteId?: SiteId; expiresAt?: string }[] => [
    ...(settings.allowlistedTerms ?? []).map((value) => ({ value, scope: "global" as const })),
    ...(settings.siteAllowlist ?? []).map((entry) => ({
      value: entry.value,
      scope: "site" as const,
      siteId: entry.siteId,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
    })),
  ];

  const renderAllowlist = (): void => {
    const entries = allowlistEntries();
    const normalizedQuery = allowlistSearchQuery.toLocaleLowerCase();
    const visibleEntries = entries.filter((entry) => entry.value.toLocaleLowerCase().includes(normalizedQuery));
    allowlistList.replaceChildren();
    clearAllowlistButton.disabled = entries.length === 0;

    if (entries.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "allowlist-empty";
      emptyState.textContent = "尚未添加白名单值。";
      allowlistList.append(emptyState);
      return;
    }

    if (visibleEntries.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "allowlist-filter-empty";
      emptyState.textContent = "没有符合当前搜索的白名单值。";
      allowlistList.append(emptyState);
      return;
    }

    for (const entry of visibleEntries) {
      const row = document.createElement("li");
      const value = document.createElement("span");
      const removeButton = document.createElement("button");

      row.className = "allowlist-row";
      value.className = "allowlist-value";
      value.textContent = entry.value;
      const scope = document.createElement("span");
      scope.className = "allowlist-scope";
      scope.textContent = entry.scope === "global"
        ? "全局"
        : `${SITE_LABELS[entry.siteId as SiteId]}${entry.expiresAt === undefined ? " · 永久" : " · 有效期内"}`;
      removeButton.type = "button";
      removeButton.textContent = "删除";
      removeButton.addEventListener("click", () => {
        void removeAllowlisted(entry.value, entry.scope === "global"
          ? { scope: "global" }
          : { scope: "site", siteId: entry.siteId as SiteId });
      });
      row.append(scope, value, removeButton);
      allowlistList.append(row);
    }
  };

  const renderPolicies = (): void => {
    const selectedSiteId = policySiteInput.value;
    const siteScoped = policyScopeInput.value === "site" && isSiteId(selectedSiteId);
    const configuredPolicies = new Map(
      (siteScoped
        ? mergeCategoryPolicies(
            settings.categoryPolicies ?? [],
            settings.siteCategoryPolicies ?? [],
            selectedSiteId,
          )
        : (settings.categoryPolicies ?? [])
      ).map((policy) => [policy.kind, policy.action]),
    );
    policyList.replaceChildren();

    for (const kind of DETECTION_KINDS) {
      const row = document.createElement("li");
      const label = document.createElement("label");
      const select = document.createElement("select");
      const policy = configuredPolicies.get(kind);

      row.className = "policy-row";
      label.className = "policy-label";
      label.textContent = DETECTION_KIND_LABELS[kind];
      select.dataset.policyKind = kind;
      select.setAttribute("aria-label", `${DETECTION_KIND_LABELS[kind]}策略`);

      for (const action of ["default", "replace", "confirm", "block"] as const) {
        const option = document.createElement("option");
        option.value = action;
        option.textContent = action === "default"
          ? `${POLICY_OPTION_LABELS[action]}：${DEFAULT_CONFIRM_KINDS.has(kind) ? "确认" : "匿名化"}`
          : POLICY_OPTION_LABELS[action];
        select.append(option);
      }

      select.value = policy ?? "default";
      select.addEventListener("change", () => {
        void updateCategoryPolicy(kind, select.value);
      });
      row.append(label, select);
      policyList.append(row);
    }
  };

  const renderAudit = (): void => {
    auditEnabledInput.checked = settings.auditEnabled === true;
    auditList.replaceChildren();
    clearAuditButton.disabled = auditEvents.length === 0;

    if (auditEvents.length === 0) {
      const emptyState = document.createElement("li");
      emptyState.className = "audit-empty";
      emptyState.textContent = "尚无本地审计记录。";
      auditList.append(emptyState);
      return;
    }

    for (const event of auditEvents) {
      const row = document.createElement("li");
      const summary = document.createElement("span");
      const findings = document.createElement("span");

      row.className = "audit-row";
      summary.className = "audit-row-main";
      findings.className = "audit-row-detail";
      summary.textContent = `${SITE_LABELS[event.siteId]} · ${AUDIT_OPERATION_LABELS[event.operation]} · ${AUDIT_OUTCOME_LABELS[event.outcome]}`;
      findings.textContent = event.findings
        .map((finding) => `${DETECTION_KIND_LABELS[finding.kind]} ${finding.count} 项`)
        .join("，");
      row.append(summary, findings);
      auditList.append(row);
    }
  };

  const renderProtection = (): void => {
    const detectionProfile = settings.detectionProfile ?? DEFAULT_ADVANCED_SETTINGS.detectionProfile;
    const replacementStyle = settings.replacementStyle ?? DEFAULT_ADVANCED_SETTINGS.replacementStyle;
    const attachmentAction = settings.attachmentAction ?? DEFAULT_ADVANCED_SETTINGS.attachmentAction;
    const semanticReview = settings.semanticReview ?? DEFAULT_ADVANCED_SETTINGS.semanticReview;

    detectionProfileInput.value = detectionProfile;
    replacementStyleInput.value = replacementStyle;
    attachmentActionInput.value = attachmentAction;
    replyTokenViewerInput.disabled = replacementStyle !== "token";
    replyTokenViewerInput.checked = replacementStyle === "token" && settings.replyTokenViewerEnabled === true;
    semanticReviewInput.value = semanticReview;
    semanticReviewInput.disabled = detectionProfile !== "balanced";
    if (detectionProfile !== "balanced") {
      semanticReviewInput.value = "off";
      // Says what is lost, not just that the control is unavailable. The previous copy mentioned
      // only the statistical model, which had been wrong since the neural model shipped, and it
      // left the reader with no idea that a 12 MB model in the package was sitting idle.
      semanticReviewStatus.textContent =
        "语义审查只在平衡档运行，所以当前不识别没有提示词的人名与地址。改成平衡档可启用本地模型。";
    } else if (semanticReview === "local_neural") {
      // Says "打字时" because that is the prewarm phase. The R9 send-time gate stops the native
      // event and reviews the exact final draft before it re-enters the detector.
      semanticReviewStatus.textContent = "本地神经模型已启用；在打字时于本地运行，语义候选会在发送前要求确认。";
      // Whether it actually loaded is a different question from whether it is enabled. A CSP or
      // WASM failure leaves the cache empty; the send-time gate surfaces that missed review, and
      // this status line makes the same boundary visible before the user submits.
      void reportNeuralRuntimeState();
    } else {
      semanticReviewStatus.textContent = semanticReview === "local_statistical"
        ? "本地统计模型已启用；语义候选会在发送前要求确认。"
        : "语义审查已关闭；当前不识别没有提示词的人名与地址，也不连接远程服务。";
    }
    protectionStatus.textContent = replacementStyle === "token" && settings.replyTokenViewerEnabled === true
      ? "回复令牌查看已启用，仅在当前页面内存中按需显示。"
      : "当前设置会在发送前本地处理文本。";
  };

  const renderAuditResult = (result: AuditLogReadResult): void => {
    if (!result.ok) {
      auditEvents = [];
      renderAudit();
      setAuditStatus(
        result.error === "invalid_storage" ? "本地审计记录格式异常。" : "无法读取本地审计记录。",
        "error",
      );
      return;
    }

    auditEvents = result.events.map((event) => ({
      occurredAt: event.occurredAt,
      siteId: event.siteId,
      operation: event.operation,
      outcome: event.outcome,
      findings: event.findings.map((finding) => ({ kind: finding.kind, count: finding.count })),
    }));
    renderAudit();
  };

  const renderFailure = (result: Exclude<CustomTermsReadResult, { ok: true }>): void => {
    list.replaceChildren();
    allowlistList.replaceChildren();
    policyList.replaceChildren();
    auditEnabledInput.disabled = true;
    detectionProfileInput.disabled = true;
    replacementStyleInput.disabled = true;
    replyTokenViewerInput.disabled = true;
    attachmentActionInput.disabled = true;
    configurationAvailable = false;
    exportConfigurationButton.disabled = true;
    clearButton.disabled = result.error !== "invalid_storage";
    clearAllowlistButton.disabled = result.error !== "invalid_storage";
    setStatus(failureMessage(result), "error");
    setAllowlistStatus(failureMessage(result), "error");
    setPolicyStatus(failureMessage(result), "error");
  };

  const replaceSettings = (nextSettings: CustomTermsSettings): void => {
    settings = {
      terms: [...nextSettings.terms],
      mode: nextSettings.mode,
      allowlistedTerms: [...(nextSettings.allowlistedTerms ?? [])],
      siteAllowlist: [...(nextSettings.siteAllowlist ?? [])].map((entry) => ({ ...entry })),
      categoryPolicies: [...(nextSettings.categoryPolicies ?? [])].map((policy) => ({ ...policy })),
      siteCategoryPolicies: [...(nextSettings.siteCategoryPolicies ?? [])].map((policy) => ({ ...policy })),
      ...(nextSettings.settingsVersion !== undefined ? { settingsVersion: nextSettings.settingsVersion } : {}),
      ...(nextSettings.auditEnabled ? { auditEnabled: true } : {}),
      ...(nextSettings.detectionProfile !== undefined ? { detectionProfile: nextSettings.detectionProfile } : {}),
      ...(nextSettings.replacementStyle !== undefined ? { replacementStyle: nextSettings.replacementStyle } : {}),
      ...(nextSettings.replyTokenViewerEnabled !== undefined
        ? { replyTokenViewerEnabled: nextSettings.replyTokenViewerEnabled }
        : {}),
      ...(nextSettings.attachmentAction !== undefined ? { attachmentAction: nextSettings.attachmentAction } : {}),
      ...(nextSettings.semanticReview !== undefined ? { semanticReview: nextSettings.semanticReview } : {}),
    };
    auditEnabledInput.disabled = false;
    detectionProfileInput.disabled = false;
    replacementStyleInput.disabled = false;
    attachmentActionInput.disabled = false;
    configurationAvailable = true;
    exportConfigurationButton.disabled = false;
    renderTerms();
    renderAllowlist();
    renderPolicies();
    renderAudit();
    renderProtection();
  };

  const applySettings = (nextSettings: CustomTermsSettings, message = "", state: "neutral" | "success" | "error" = "neutral"): void => {
    replaceSettings(nextSettings);
    setStatus(message, state);
  };

  const renderReadResult = (result: CustomTermsReadResult): void => {
    if (!result.ok) {
      renderFailure(result);
      return;
    }

    applySettings(settingsFromStoreResult(result));
  };

  const handleMutation = (
    result: CustomTermsMutationResult,
    message: (terms: readonly CustomTerm[], previousCount: number) => string,
    previousCount: number,
    resetInput = false,
  ): boolean => {
    if (!result.ok) {
      setStatus(failureMessage(result), "error");
      return false;
    }

    applySettings(
      settingsFromStoreResult(result),
      message(result.terms, previousCount),
      "success",
    );
    if (resetInput) {
      input.value = "";
    }
    return true;
  };

  const addTerms = async (): Promise<void> => {
    if (!isCustomTermGroup(groupInput.value)) {
      setStatus(ERROR_MESSAGES.invalid_storage, "error");
      return;
    }

    try {
      const previousCount = settings.terms.length;
      const result = await store.addBatch(input.value, groupInput.value);
      handleMutation(result, successMessage, previousCount, true);
    } catch {
      setStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const allowlistSuccessMessage = (result: CustomTermsMutationResult, previousCount: number): string => {
    if (!result.ok) {
      return "";
    }
    const nextCount = (result.allowlistedTerms ?? []).length + (result.siteAllowlist ?? []).length;
    return `已添加 ${nextCount - previousCount} 个白名单值。`;
  };

  const handleAllowlistMutation = (
    result: CustomTermsMutationResult,
    message: (result: CustomTermsMutationResult, previousCount: number) => string,
    previousCount: number,
    resetInput = false,
  ): boolean => {
    if (!result.ok) {
      setAllowlistStatus(failureMessage(result), "error");
      return false;
    }

    replaceSettings(settingsFromStoreResult(result));
    setAllowlistStatus(message(result, previousCount), "success");
    if (resetInput) {
      allowlistInput.value = "";
    }
    return true;
  };

  const addAllowlisted = async (): Promise<void> => {
    try {
      const isSiteScoped = allowlistScopeInput.value === "site";
      if (isSiteScoped && !confirmSiteAllowlist()) {
        setAllowlistStatus("已取消指定网站白名单。", "neutral");
        return;
      }
      const selectedExpiry = isAllowlistExpiry(allowlistExpiryInput.value)
        ? allowlistExpiryInput.value
        : "one_day";
      const expiresAt = expiryTimestamp(selectedExpiry);
      const target: AllowlistTarget = isSiteScoped
        ? {
            scope: "site",
            siteId: allowlistSiteInput.value as SiteId,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }
        : { scope: "global" };
      const previousCount = allowlistEntries().length;
      const result = await store.addAllowlistedBatch(allowlistInput.value, target);
      handleAllowlistMutation(result, allowlistSuccessMessage, previousCount, true);
    } catch {
      setAllowlistStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const removeTerm = async (value: string): Promise<void> => {
    try {
      handleMutation(await store.remove(value), () => "已删除词条。", settings.terms.length);
    } catch {
      setStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const removeAllowlisted = async (value: string, target: AllowlistTarget = { scope: "global" }): Promise<void> => {
    try {
      handleAllowlistMutation(
        await store.removeAllowlisted(value, target),
        () => "已删除白名单值。",
        allowlistEntries().length,
      );
    } catch {
      setAllowlistStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const clearTerms = async (): Promise<void> => {
    if (!confirmClear()) {
      return;
    }

    try {
      handleMutation(await store.clear(), () => "已清空全部词条。", settings.terms.length);
    } catch {
      setStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const clearAllowlisted = async (): Promise<void> => {
    if (!confirmClear()) {
      return;
    }

    try {
      handleAllowlistMutation(
        await store.clearAllowlisted(),
        () => "已清空白名单。",
        allowlistEntries().length,
      );
    } catch {
      setAllowlistStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const updateMode = async (): Promise<void> => {
    const nextMode: RedactionMode = strictModeInput.checked ? "block" : "replace";

    try {
      const result = await store.setMode(nextMode);
      if (!result.ok) {
        strictModeInput.checked = settings.mode === "block";
        setStatus(failureMessage(result), "error");
        return;
      }

      applySettings(settingsFromStoreResult(result), "已更新发送策略。", "success");
    } catch {
      strictModeInput.checked = settings.mode === "block";
      setStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const updateCategoryPolicy = async (kind: DetectionKind, rawAction: string): Promise<void> => {
    const action = rawAction === "default" ? null : isCategoryPolicyAction(rawAction) ? rawAction : undefined;
    if (action === undefined) {
      renderPolicies();
      setPolicyStatus(ERROR_MESSAGES.invalid_storage, "error");
      return;
    }

    try {
      const selectedSiteId = policySiteInput.value;
      if (policyScopeInput.value === "site") {
        if (!isSiteId(selectedSiteId)) {
          renderPolicies();
          setPolicyStatus(ERROR_MESSAGES.invalid_storage, "error");
          return;
        }
        const overlay = (settings.siteCategoryPolicies ?? []).filter(
          (entry) => !(entry.siteId === selectedSiteId && entry.kind === kind),
        );
        const result = await store.replace({
          ...settings,
          siteCategoryPolicies: action === null ? overlay : [...overlay, { siteId: selectedSiteId, kind, action }],
          settingsVersion: 2,
        });
        if (!result.ok) {
          renderPolicies();
          setPolicyStatus(failureMessage(result), "error");
          return;
        }
        replaceSettings(settingsFromStoreResult(result));
        setPolicyStatus("已更新类别策略。", "success");
        return;
      }

      const result = await store.setCategoryPolicy(kind, action);
      if (!result.ok) {
        renderPolicies();
        setPolicyStatus(failureMessage(result), "error");
        return;
      }

      replaceSettings(settingsFromStoreResult(result));
      setPolicyStatus("已更新类别策略。", "success");
    } catch {
      renderPolicies();
      setPolicyStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const updateAuditEnabled = async (): Promise<void> => {
    try {
      const result = await store.setAuditEnabled(auditEnabledInput.checked);
      if (!result.ok) {
        auditEnabledInput.checked = settings.auditEnabled === true;
        setAuditStatus(failureMessage(result), "error");
        return;
      }

      replaceSettings(settingsFromStoreResult(result));
      setAuditStatus(result.auditEnabled ? "已启用本地审计。" : "已停用本地审计。", "success");
    } catch {
      auditEnabledInput.checked = settings.auditEnabled === true;
      setAuditStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const updateAdvancedSettings = async (
    patch: {
      detectionProfile?: DetectionProfile;
      replacementStyle?: ReplacementStyle;
      replyTokenViewerEnabled?: boolean;
      attachmentAction?: AttachmentAction;
      semanticReview?: SemanticReviewMode;
    },
  ): Promise<void> => {
    try {
      const result = await store.setAdvancedSettings(patch);
      if (!result.ok) {
        renderProtection();
        setProtectionStatus("保护设置无效，未保存。", "error");
        return;
      }

      replaceSettings(settingsFromStoreResult(result));
      setProtectionStatus("保护设置已保存到本地。", "success");
    } catch {
      renderProtection();
      setProtectionStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const clearAudit = async (): Promise<void> => {
    if (!confirmClear()) {
      return;
    }

    try {
      const result = await auditLog.clear();
      if (!result.ok) {
        setAuditStatus(result.error === "invalid_storage" ? "本地审计记录格式异常。" : "无法清空本地审计记录。", "error");
        return;
      }

      auditEvents = [];
      renderAudit();
      setAuditStatus("已清空本地审计记录。", "success");
    } catch {
      setAuditStatus("无法清空本地审计记录。", "error");
    }
  };

  const clearSessionMap = async (): Promise<void> => {
    const cleared = await sessionClearSignal.requestClear();
    setProtectionStatus(
      cleared
        ? "已请求清除所有已打开页面的会话映射。"
        : "无法请求清除会话映射，请检查扩展本地存储。",
      cleared ? "success" : "error",
    );
  };

  const exportConfiguration = (): void => {
    if (!configurationAvailable) {
      setConfigurationTransferStatus("当前本地配置不可导出，请先修复或导入有效配置。", "error");
      return;
    }

    const hasAllowlist = (settings.allowlistedTerms?.length ?? 0) + (settings.siteAllowlist?.length ?? 0) > 0;
    if (exportIncludeAllowlistInput.checked && hasAllowlist && !confirmSensitiveExport()) {
      setConfigurationTransferStatus("已取消导出白名单值。", "neutral");
      return;
    }

    const result = serializeConfigurationTransfer(settings, {
      includeAllowlist: exportIncludeAllowlistInput.checked,
    });
    if (!result.ok) {
      setConfigurationTransferStatus("当前本地配置格式异常，未导出。", "error");
      return;
    }

    configurationTransfer.value = result.text;
    setConfigurationTransferStatus(
      exportIncludeAllowlistInput.checked ? "已生成包含白名单的本地配置。" : "已生成不含白名单的本地配置。",
      "success",
    );
  };

  const importConfiguration = async (): Promise<void> => {
    const importMode = isConfigurationImportMode(importModeInput.value) ? importModeInput.value : "replace";
    const parsed = applyConfigurationTransfer(configurationTransfer.value, settings, { importMode });
    if (!parsed.ok) {
      const message = parsed.error === "invalid_json"
        ? "配置不是有效 JSON，未导入。"
        : parsed.error === "unsupported_schema"
          ? "配置版本不受支持，未导入。"
          : "配置结构异常，未导入。";
      setConfigurationTransferStatus(message, "error");
      return;
    }

    if (importMode === "replace" && !confirmImport()) {
      setConfigurationTransferStatus("已取消导入。", "neutral");
      return;
    }

    try {
      const result = await store.replace(parsed.settings);
      if (!result.ok) {
        setConfigurationTransferStatus(failureMessage(result), "error");
        return;
      }

      replaceSettings(settingsFromStoreResult(result));
      setConfigurationTransferStatus("已导入本地配置。", "success");
    } catch {
      setConfigurationTransferStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const exportAudit = async (): Promise<void> => {
    try {
      const payload = await exportAuditLog(auditLog);
      const text = JSON.stringify(payload);
      auditExport.value = text;
      auditExport.hidden = false;
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "audit-log.json";
      link.rel = "noopener";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setAuditStatus("已导出本地审计记录。", "success");
    } catch {
      setAuditStatus("无法导出本地审计记录。", "error");
    }
  };

  const applyPreset = (): void => {
    if (!isProfessionalPresetId(presetPackInput.value)) {
      pendingPresetId = null;
      confirmPresetButton.hidden = true;
      setPolicyStatus("请选择专业预设。", "error");
      return;
    }
    pendingPresetId = presetPackInput.value;
    confirmPresetButton.hidden = false;
    setPolicyStatus("确认后将只更新类别策略。", "neutral");
  };

  const confirmPreset = async (): Promise<void> => {
    if (pendingPresetId === null) {
      return;
    }
    try {
      const response = await fetch(presetPackUrl(pendingPresetId));
      if (!response.ok) {
        setPolicyStatus("预设无效，未应用。", "error");
        return;
      }
      const parsed = parseProfessionalPresetPack(await response.json());
      if (!parsed.ok) {
        setPolicyStatus("预设无效，未应用。", "error");
        return;
      }
      const result = await store.replace(applyProfessionalPreset(settings, parsed.pack));
      if (!result.ok) {
        setPolicyStatus(failureMessage(result), "error");
        return;
      }
      replaceSettings(settingsFromStoreResult(result));
      pendingPresetId = null;
      confirmPresetButton.hidden = true;
      setPolicyStatus("已应用专业预设。", "success");
    } catch {
      setPolicyStatus(ERROR_MESSAGES.storage_write_failed, "error");
    }
  };

  const bindEvents = (): void => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void addTerms();
    });
    clearButton.addEventListener("click", () => {
      void clearTerms();
    });
    strictModeInput.addEventListener("change", () => {
      void updateMode();
    });
    searchInput.addEventListener("input", () => {
      searchQuery = searchInput.value;
      renderTerms();
    });
    filterInput.addEventListener("change", () => {
      groupFilter = isCustomTermGroup(filterInput.value) ? filterInput.value : "all";
      renderTerms();
    });
    allowlistForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void addAllowlisted();
    });
    clearAllowlistButton.addEventListener("click", () => {
      void clearAllowlisted();
    });
    allowlistSearchInput.addEventListener("input", () => {
      allowlistSearchQuery = allowlistSearchInput.value;
      renderAllowlist();
    });
    const updateAllowlistScope = (): void => {
      const isSiteScoped = allowlistScopeInput.value === "site";
      allowlistSiteControl.hidden = !isSiteScoped;
      allowlistExpiryControl.hidden = !isSiteScoped;
    };
    allowlistScopeInput.addEventListener("change", updateAllowlistScope);
    updateAllowlistScope();
    const updatePolicyScope = (): void => {
      policySiteControl.hidden = policyScopeInput.value !== "site";
      renderPolicies();
    };
    policyScopeInput.addEventListener("change", updatePolicyScope);
    policySiteInput.addEventListener("change", () => {
      renderPolicies();
    });
    updatePolicyScope();
    applyPresetButton.addEventListener("click", applyPreset);
    confirmPresetButton.addEventListener("click", () => {
      void confirmPreset();
    });
    exportAuditButton.addEventListener("click", () => {
      void exportAudit();
    });
    auditEnabledInput.addEventListener("change", () => {
      void updateAuditEnabled();
    });
    detectionProfileInput.addEventListener("change", () => {
      if (isDetectionProfile(detectionProfileInput.value)) {
        void updateAdvancedSettings({
          detectionProfile: detectionProfileInput.value,
          ...(detectionProfileInput.value === "conservative" ? { semanticReview: "off" as const } : {}),
        });
      } else {
        renderProtection();
      }
    });
    replacementStyleInput.addEventListener("change", () => {
      if (isReplacementStyle(replacementStyleInput.value)) {
        void updateAdvancedSettings({ replacementStyle: replacementStyleInput.value });
      } else {
        renderProtection();
      }
    });
    replyTokenViewerInput.addEventListener("change", () => {
      void updateAdvancedSettings({ replyTokenViewerEnabled: replyTokenViewerInput.checked });
    });
    attachmentActionInput.addEventListener("change", () => {
      if (isAttachmentAction(attachmentActionInput.value)) {
        void updateAdvancedSettings({ attachmentAction: attachmentActionInput.value });
      } else {
        renderProtection();
      }
    });
    semanticReviewInput.addEventListener("change", () => {
      if (isSemanticReviewMode(semanticReviewInput.value) && detectionProfileInput.value === "balanced") {
        void updateAdvancedSettings({ semanticReview: semanticReviewInput.value });
      } else {
        renderProtection();
      }
    });
    clearSessionMapButton.addEventListener("click", () => {
      void clearSessionMap();
    });
    clearAuditButton.addEventListener("click", () => {
      void clearAudit();
    });
    exportConfigurationButton.addEventListener("click", exportConfiguration);
    importConfigurationButton.addEventListener("click", () => {
      void importConfiguration();
    });
    privateComposerButton.addEventListener("click", () => {
      void openPrivateComposer();
    });
    const showCustomTerms = (): void => {
      customTermsTab.setAttribute("aria-selected", "true");
      allowlistTab.setAttribute("aria-selected", "false");
      policyTab.setAttribute("aria-selected", "false");
      auditTab.setAttribute("aria-selected", "false");
      configTransferTab.setAttribute("aria-selected", "false");
      protectionTab.setAttribute("aria-selected", "false");
      customTermsPanel.hidden = false;
      allowlistPanel.hidden = true;
      policyPanel.hidden = true;
      auditPanel.hidden = true;
      configTransferPanel.hidden = true;
      protectionPanel.hidden = true;
    };
    customTermsTab.addEventListener("click", () => {
      showCustomTerms();
      moreSettings.open = false;
    });
    moreSettings.addEventListener("toggle", () => {
      if (!moreSettings.open) {
        showCustomTerms();
      }
    });
    allowlistTab.addEventListener("click", () => {
      customTermsTab.setAttribute("aria-selected", "false");
      allowlistTab.setAttribute("aria-selected", "true");
      policyTab.setAttribute("aria-selected", "false");
      auditTab.setAttribute("aria-selected", "false");
      configTransferTab.setAttribute("aria-selected", "false");
      protectionTab.setAttribute("aria-selected", "false");
      customTermsPanel.hidden = true;
      allowlistPanel.hidden = false;
      policyPanel.hidden = true;
      auditPanel.hidden = true;
      configTransferPanel.hidden = true;
      protectionPanel.hidden = true;
    });
    policyTab.addEventListener("click", () => {
      customTermsTab.setAttribute("aria-selected", "false");
      allowlistTab.setAttribute("aria-selected", "false");
      policyTab.setAttribute("aria-selected", "true");
      auditTab.setAttribute("aria-selected", "false");
      configTransferTab.setAttribute("aria-selected", "false");
      protectionTab.setAttribute("aria-selected", "false");
      customTermsPanel.hidden = true;
      allowlistPanel.hidden = true;
      policyPanel.hidden = false;
      auditPanel.hidden = true;
      configTransferPanel.hidden = true;
      protectionPanel.hidden = true;
    });
    auditTab.addEventListener("click", () => {
      customTermsTab.setAttribute("aria-selected", "false");
      allowlistTab.setAttribute("aria-selected", "false");
      policyTab.setAttribute("aria-selected", "false");
      auditTab.setAttribute("aria-selected", "true");
      configTransferTab.setAttribute("aria-selected", "false");
      protectionTab.setAttribute("aria-selected", "false");
      customTermsPanel.hidden = true;
      allowlistPanel.hidden = true;
      policyPanel.hidden = true;
      auditPanel.hidden = false;
      configTransferPanel.hidden = true;
      protectionPanel.hidden = true;
    });
    configTransferTab.addEventListener("click", () => {
      customTermsTab.setAttribute("aria-selected", "false");
      allowlistTab.setAttribute("aria-selected", "false");
      policyTab.setAttribute("aria-selected", "false");
      auditTab.setAttribute("aria-selected", "false");
      configTransferTab.setAttribute("aria-selected", "true");
      protectionTab.setAttribute("aria-selected", "false");
      customTermsPanel.hidden = true;
      allowlistPanel.hidden = true;
      policyPanel.hidden = true;
      auditPanel.hidden = true;
      configTransferPanel.hidden = false;
      protectionPanel.hidden = true;
    });
    protectionTab.addEventListener("click", () => {
      customTermsTab.setAttribute("aria-selected", "false");
      allowlistTab.setAttribute("aria-selected", "false");
      policyTab.setAttribute("aria-selected", "false");
      auditTab.setAttribute("aria-selected", "false");
      configTransferTab.setAttribute("aria-selected", "false");
      protectionTab.setAttribute("aria-selected", "true");
      customTermsPanel.hidden = true;
      allowlistPanel.hidden = true;
      policyPanel.hidden = true;
      auditPanel.hidden = true;
      configTransferPanel.hidden = true;
      protectionPanel.hidden = false;
    });
  };

  return {
    async initialize() {
      if (initialized) {
        return;
      }

      initialized = true;
      bindEvents();
      renderPrivateComposerLauncher();
      await renderPageGuardStatus();
      unsubscribe = store.subscribe((result) => {
        if (disposed) {
          return;
        }

        subscriptionRevision += 1;
        renderReadResult(result);
      });
      auditUnsubscribe = auditLog.subscribe((result) => {
        if (disposed) {
          return;
        }

        auditSubscriptionRevision += 1;
        renderAuditResult(result);
      });
      const initialRevision = subscriptionRevision;
      const initialAuditRevision = auditSubscriptionRevision;

      try {
        const result = await store.read();
        if (!disposed && subscriptionRevision === initialRevision) {
          renderReadResult(result);
        }
      } catch {
        if (!disposed && subscriptionRevision === initialRevision) {
          renderFailure({ ok: false, error: "storage_read_failed" });
        }
      }

      try {
        const result = await auditLog.read();
        if (!disposed && auditSubscriptionRevision === initialAuditRevision) {
          renderAuditResult(result);
        }
      } catch {
        if (!disposed && auditSubscriptionRevision === initialAuditRevision) {
          renderAuditResult({ ok: false, error: "storage_read_failed" });
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      auditUnsubscribe?.();
      auditUnsubscribe = null;
    },
  };
}

export async function bootstrapPopup(document: Document = window.document): Promise<PopupController> {
  const controller = createPopupController(document, createChromeCustomTermsStore());
  await controller.initialize();
  return controller;
}

function startPopupWhenReady(): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const start = (): void => {
    if (document.getElementById("custom-term-form")) {
      void bootstrapPopup();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
    return;
  }

  start();
}

startPopupWhenReady();
