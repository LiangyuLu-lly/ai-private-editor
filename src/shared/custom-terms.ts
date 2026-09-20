import type { SiteCategoryPolicy } from "./policy-overlay.js";
import type {
  CategoryPolicyAction,
  CategoryPolicyEntry,
  DetectionKind,
  SiteId,
  AttachmentAction,
  DetectionProfile,
  ReplacementStyle,
  SemanticReviewMode,
} from "./types.js";

export const CUSTOM_TERMS_STORAGE_KEY = "customTerms";
export const MAX_CUSTOM_TERMS = 100;
export const MAX_CUSTOM_TERM_LENGTH = 120;

export type CustomTermGroup = "personal" | "work" | "project" | "other";
export type CustomTerm = { value: string; group: CustomTermGroup };
export type RedactionMode = "replace" | "block";
export type SiteAllowlistEntry = { value: string; siteId: SiteId; expiresAt?: string };
export type AllowlistTarget =
  | { scope: "global" }
  | { scope: "site"; siteId: SiteId; expiresAt?: string };
export type CustomTermsSettings = {
  terms: readonly CustomTerm[];
  mode: RedactionMode;
  allowlistedTerms?: readonly string[];
  siteAllowlist?: readonly SiteAllowlistEntry[];
  categoryPolicies?: readonly CategoryPolicyEntry[];
  siteCategoryPolicies?: readonly SiteCategoryPolicy[];
  settingsVersion?: 1 | 2;
  auditEnabled?: boolean;
  detectionProfile?: DetectionProfile;
  replacementStyle?: ReplacementStyle;
  replyTokenViewerEnabled?: boolean;
  attachmentAction?: AttachmentAction;
  semanticReview?: SemanticReviewMode;
};

export type CustomTermsSnapshot =
  | { state: "loading" }
  | {
      state: "ready";
      terms: readonly CustomTerm[];
      mode: RedactionMode;
      allowlistedTerms?: readonly string[];
      siteAllowlist?: readonly SiteAllowlistEntry[];
      categoryPolicies?: readonly CategoryPolicyEntry[];
      siteCategoryPolicies?: readonly SiteCategoryPolicy[];
      settingsVersion?: 1 | 2;
      auditEnabled?: boolean;
      detectionProfile?: DetectionProfile;
      replacementStyle?: ReplacementStyle;
      replyTokenViewerEnabled?: boolean;
      attachmentAction?: AttachmentAction;
      semanticReview?: SemanticReviewMode;
    }
  | { state: "failed" };

export type CustomTermsReadResult =
  | {
      ok: true;
      terms: readonly CustomTerm[];
      mode: RedactionMode;
      allowlistedTerms?: readonly string[];
      siteAllowlist?: readonly SiteAllowlistEntry[];
      categoryPolicies?: readonly CategoryPolicyEntry[];
      siteCategoryPolicies?: readonly SiteCategoryPolicy[];
      settingsVersion?: 1 | 2;
      auditEnabled?: boolean;
      detectionProfile?: DetectionProfile;
      replacementStyle?: ReplacementStyle;
      replyTokenViewerEnabled?: boolean;
      attachmentAction?: AttachmentAction;
      semanticReview?: SemanticReviewMode;
    }
  | { ok: false; error: "invalid_storage" | "storage_read_failed" };

type CustomTermsError =
  | "invalid_storage"
  | "storage_read_failed"
  | "storage_write_failed"
  | "empty_term"
  | "term_too_long"
  | "duplicate_term"
  | "term_limit";

export type AdvancedSettings = Pick<
  CustomTermsSettings,
  "detectionProfile" | "replacementStyle" | "replyTokenViewerEnabled" | "attachmentAction" | "semanticReview"
>;

export type CustomTermsMutationResult =
  | {
      ok: true;
      terms: readonly CustomTerm[];
      mode: RedactionMode;
      allowlistedTerms?: readonly string[];
      siteAllowlist?: readonly SiteAllowlistEntry[];
      categoryPolicies?: readonly CategoryPolicyEntry[];
      siteCategoryPolicies?: readonly SiteCategoryPolicy[];
      settingsVersion?: 1 | 2;
      auditEnabled?: boolean;
      detectionProfile?: DetectionProfile;
      replacementStyle?: ReplacementStyle;
      replyTokenViewerEnabled?: boolean;
      attachmentAction?: AttachmentAction;
      semanticReview?: SemanticReviewMode;
    }
  | { ok: false; error: CustomTermsError; line?: number };

export type CustomTermsStorage = {
  readValue(): Promise<unknown>;
  writeValue(settings: CustomTermsSettings): Promise<void>;
  subscribe(listener: (nextValue: unknown) => void): () => void;
};

export type CustomTermsStore = {
  read(): Promise<CustomTermsReadResult>;
  replace(settings: CustomTermsSettings): Promise<CustomTermsMutationResult>;
  add(rawTerm: string, group?: CustomTermGroup): Promise<CustomTermsMutationResult>;
  addBatch(rawBatch: string, group: CustomTermGroup): Promise<CustomTermsMutationResult>;
  addAllowlistedBatch(rawBatch: string, target?: AllowlistTarget): Promise<CustomTermsMutationResult>;
  setMode(mode: RedactionMode): Promise<CustomTermsMutationResult>;
  setCategoryPolicy(
    kind: DetectionKind,
    action: CategoryPolicyAction | null,
  ): Promise<CustomTermsMutationResult>;
  setAuditEnabled(enabled: boolean): Promise<CustomTermsMutationResult>;
  setAdvancedSettings(settings: Partial<AdvancedSettings>): Promise<CustomTermsMutationResult>;
  remove(value: string): Promise<CustomTermsMutationResult>;
  removeAllowlisted(value: string, target?: AllowlistTarget): Promise<CustomTermsMutationResult>;
  clear(): Promise<CustomTermsMutationResult>;
  clearAllowlisted(target?: AllowlistTarget): Promise<CustomTermsMutationResult>;
  subscribe(listener: (result: CustomTermsReadResult) => void): () => void;
};

export type CustomTermsCache = {
  start(): void;
  getSnapshot(): CustomTermsSnapshot;
  subscribe(listener: (snapshot: CustomTermsSnapshot) => void): () => void;
  dispose(): void;
};

const TERM_GROUPS: readonly CustomTermGroup[] = ["personal", "work", "project", "other"];
const REDACTION_MODES: readonly RedactionMode[] = ["replace", "block"];
const SITE_IDS: readonly SiteId[] = [
  "doubao",
  "deepseek",
  "yuanbao",
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "qwen",
  "wenxin",
];
const DETECTION_KINDS: readonly DetectionKind[] = [
  "api_key",
  "access_token",
  "private_key",
  "connection_string",
  "phone",
  "email",
  "china_id",
  "bank_card",
  "unified_social_credit_code",
  "passport",
  "license_plate",
  "ipv4",
  "ipv6",
  "local_path",
  "custom_term",
  "person_name",
  "address",
  "account",
  "labeled_identifier",
  "credential",
  "private_date",
  "private_url",
  "mac_address",
  "bank_account",
];
const CATEGORY_POLICY_ACTIONS: readonly CategoryPolicyAction[] = ["replace", "confirm", "block"];
const DETECTION_PROFILES: readonly DetectionProfile[] = ["conservative", "balanced"];
const REPLACEMENT_STYLES: readonly ReplacementStyle[] = ["token", "masked", "surrogate"];
const ATTACHMENT_ACTIONS: readonly AttachmentAction[] = ["allow", "warn", "confirm", "block"];
const SEMANTIC_REVIEW_MODES: readonly SemanticReviewMode[] = ["off", "local_statistical", "local_neural"];
function emptySettings(): CustomTermsSettings {
  return { terms: [], mode: "replace", allowlistedTerms: [] };
}

function advancedSettingsFrom(value: Pick<CustomTermsSettings, keyof AdvancedSettings>): AdvancedSettings {
  return {
    ...(value.detectionProfile !== undefined ? { detectionProfile: value.detectionProfile } : {}),
    ...(value.replacementStyle !== undefined ? { replacementStyle: value.replacementStyle } : {}),
    ...(value.replyTokenViewerEnabled !== undefined ? { replyTokenViewerEnabled: value.replyTokenViewerEnabled } : {}),
    ...(value.attachmentAction !== undefined ? { attachmentAction: value.attachmentAction } : {}),
    ...(value.semanticReview !== undefined ? { semanticReview: value.semanticReview } : {}),
  };
}

function advancedSettingsFromResult(value: CustomTermsReadResult | CustomTermsMutationResult): AdvancedSettings {
  return value.ok ? advancedSettingsFrom(value) : {};
}

function normalizeAdvancedSettings(advanced: AdvancedSettings): AdvancedSettings {
  const normalized = advancedSettingsFrom(advanced);
  if (normalized.replacementStyle !== undefined && normalized.replacementStyle !== "token") {
    normalized.replyTokenViewerEnabled = false;
  }
  return normalized;
}

/*
 * 默认档从 conservative + 语义审查关闭改为 balanced + local_neural。
 *
 * 这是一次有意的默认值反转，理由是测量而不是偏好。旧默认下用户装完不改设置时，
 * `appendSemanticCandidates` 在 conservative 档整条早返回、`semanticReview` 又是 off，
 * 所以随包分发的 12 MB 本地模型**完全不生效**；而要打开它需要先把检测档位改成平衡、
 * 语义审查下拉框才解除禁用、再选一次——两层嵌套开关，界面上还没有任何地方提示这个
 * 模型的存在。
 *
 * 以下代价是当时唯一对所有系统盲测的 hidden-redteam 集上的历史 R8 证据（1800 条，balanced 档，
 * 规则 → 规则+模型，历史出货产物 r8b），不是当前 R9 的跑分：
 *
 *   完全漏出率  81.20% → 2.80%
 *   PERSON 召回  0.188 → 0.961
 *   干净文档提示率 2.75% → 8.75%
 *
 * 也就是说旧默认会让 81% 的含实体消息原样发给模型服务方。R7 那一轮干净文档提示率是
 * 27.00%，"默认关闭"当时是站得住的；R8 把负例值池从 14 个扩到 314 个之后是 8.75%，
 * 就不再站得住了。逐集数字与全部代价见 ml/docs/r8-model-card.md。
 *
 * 三件让这次反转是安全的事：
 *  1. 模型产出的候选 policy 一律是 `confirm`，永远不会静默替换——最坏情况是多一次确认，
 *     不可能改错内容。
 *  2. 当时模型加载失败时 offscreen 记 `ready: false`、缓存保持空、provider 返回空，
 *     整条会退化成纯规则。R9 已替换该失败策略：发送控制器会停止原事件并要求用户取消，
 *     或明确选择一次原文发送。
 *  3. 只影响**没有存过设置**的用户。读取侧是逐字段 `settings.x ?? DEFAULT.x`，
 *     显式存过 conservative 的用户不受影响。
 *
 * 安装时 `welcome.html` 会把这套默认和它的代价讲清楚，并提供一键调低。默认值改了但
 * 用户不知道，才是不能接受的那一种。
 */
export const DEFAULT_ADVANCED_SETTINGS: Required<AdvancedSettings> = {
  detectionProfile: "balanced",
  replacementStyle: "token",
  replyTokenViewerEnabled: false,
  attachmentAction: "warn",
  semanticReview: "local_neural",
};

/**
 * 首次运行页给出的"更少提示"配置，也就是旧的默认值。
 *
 * 单独导出而不是让欢迎页硬编码字符串，这样"调低"这个动作的含义只有一个来源。
 */
export const FEWER_PROMPTS_SETTINGS: Required<AdvancedSettings> = {
  ...DEFAULT_ADVANCED_SETTINGS,
  detectionProfile: "conservative",
  semanticReview: "off",
};

function resolveAdvancedSettings(value: Pick<CustomTermsSettings, keyof AdvancedSettings>): Required<AdvancedSettings> {
  return normalizeAdvancedSettings({
    ...DEFAULT_ADVANCED_SETTINGS,
    ...advancedSettingsFrom(value),
  }) as Required<AdvancedSettings>;
}

function missingAdvancedSettings(value: CustomTermsReadResult): Partial<AdvancedSettings> {
  if (!value.ok) {
    return {};
  }

  const defaults = resolveAdvancedSettings(value);
  const missing: Partial<AdvancedSettings> = {};
  if (value.detectionProfile === undefined) {
    missing.detectionProfile = defaults.detectionProfile;
  }
  if (value.replacementStyle === undefined) {
    missing.replacementStyle = defaults.replacementStyle;
  }
  if (value.replyTokenViewerEnabled === undefined) {
    missing.replyTokenViewerEnabled = defaults.replyTokenViewerEnabled;
  }
  if (value.attachmentAction === undefined) {
    missing.attachmentAction = defaults.attachmentAction;
  }
  if (value.semanticReview === undefined) {
    missing.semanticReview = defaults.semanticReview;
  }
  return missing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => key in value);
}

function isGroup(value: unknown): value is CustomTermGroup {
  return typeof value === "string" && TERM_GROUPS.includes(value as CustomTermGroup);
}

function isMode(value: unknown): value is RedactionMode {
  return typeof value === "string" && REDACTION_MODES.includes(value as RedactionMode);
}

function isDetectionProfile(value: unknown): value is DetectionProfile {
  return typeof value === "string" && DETECTION_PROFILES.includes(value as DetectionProfile);
}

function isReplacementStyle(value: unknown): value is ReplacementStyle {
  return typeof value === "string" && REPLACEMENT_STYLES.includes(value as ReplacementStyle);
}

function isAttachmentAction(value: unknown): value is AttachmentAction {
  return typeof value === "string" && ATTACHMENT_ACTIONS.includes(value as AttachmentAction);
}

function isSemanticReviewMode(value: unknown): value is SemanticReviewMode {
  return typeof value === "string" && SEMANTIC_REVIEW_MODES.includes(value as SemanticReviewMode);
}

function isAdvancedSettingsPatch(value: Partial<AdvancedSettings>): boolean {
  const allowed = new Set([
    "detectionProfile",
    "replacementStyle",
    "replyTokenViewerEnabled",
    "attachmentAction",
    "semanticReview",
  ]);

  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return false;
  }

  return (value.detectionProfile === undefined || isDetectionProfile(value.detectionProfile)) &&
    (value.replacementStyle === undefined || isReplacementStyle(value.replacementStyle)) &&
    (value.replyTokenViewerEnabled === undefined || typeof value.replyTokenViewerEnabled === "boolean") &&
    (value.attachmentAction === undefined || isAttachmentAction(value.attachmentAction)) &&
    (value.semanticReview === undefined || isSemanticReviewMode(value.semanticReview));
}

function isSiteId(value: unknown): value is SiteId {
  return typeof value === "string" && SITE_IDS.includes(value as SiteId);
}

function isDetectionKind(value: unknown): value is DetectionKind {
  return typeof value === "string" && DETECTION_KINDS.includes(value as DetectionKind);
}

function isCategoryPolicyAction(value: unknown): value is CategoryPolicyAction {
  return typeof value === "string" && CATEGORY_POLICY_ACTIONS.includes(value as CategoryPolicyAction);
}

function hasSupportedSettingsKeys(value: Record<string, unknown>): boolean {
  return "terms" in value && "mode" in value;
}

function parseTerms(value: unknown, legacy: boolean): CustomTerm[] | null {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_TERMS) {
    return null;
  }

  const terms: CustomTerm[] = [];
  for (const item of value) {
    if (legacy) {
      if (typeof item !== "string") {
        return null;
      }
      const term = item.trim();
      if (term.length === 0 || term.length > MAX_CUSTOM_TERM_LENGTH) {
        return null;
      }
      terms.push({ value: term, group: "other" });
      continue;
    }

    if (!isRecord(item) || !hasExactKeys(item, ["value", "group"]) || typeof item.value !== "string" || !isGroup(item.group)) {
      return null;
    }
    const term = item.value.trim();
    if (term.length === 0 || term.length > MAX_CUSTOM_TERM_LENGTH) {
      return null;
    }
    terms.push({ value: term, group: item.group });
  }

  return new Set(terms.map((term) => term.value)).size === terms.length ? terms : null;
}

function parseAllowlistedTerms(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_TERMS) {
    return null;
  }

  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }

    const term = item.trim();
    if (term.length === 0 || term.length > MAX_CUSTOM_TERM_LENGTH) {
      return null;
    }
    terms.push(term);
  }

  return new Set(terms).size === terms.length ? terms : null;
}

function parseSiteAllowlist(value: unknown): SiteAllowlistEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_TERMS) {
    return null;
  }

  const entries: SiteAllowlistEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !(hasExactKeys(item, ["value", "siteId"]) || hasExactKeys(item, ["value", "siteId", "expiresAt"])) ||
      typeof item.value !== "string" ||
      !isSiteId(item.siteId) ||
      ("expiresAt" in item && (typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))))
    ) {
      return null;
    }

    const term = item.value.trim();
    if (term.length === 0 || term.length > MAX_CUSTOM_TERM_LENGTH) {
      return null;
    }
    entries.push({
      value: term,
      siteId: item.siteId,
      ...("expiresAt" in item ? { expiresAt: item.expiresAt as string } : {}),
    });
  }

  return new Set(entries.map((entry) => `${entry.siteId}\u0000${entry.value}`)).size === entries.length
    ? entries
    : null;
}

function parseCategoryPolicies(value: unknown): CategoryPolicyEntry[] | null {
  if (!Array.isArray(value) || value.length > DETECTION_KINDS.length) {
    return null;
  }

  const policies: CategoryPolicyEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["kind", "action"]) ||
      !isDetectionKind(item.kind) ||
      !isCategoryPolicyAction(item.action)
    ) {
      return null;
    }

    policies.push({ kind: item.kind, action: item.action });
  }

  return new Set(policies.map((policy) => policy.kind)).size === policies.length ? policies : null;
}

function parseSettingsVersion(value: unknown): 1 | 2 | undefined {
  return value === 1 || value === 2 ? value : undefined;
}

function parseSiteCategoryPolicies(value: unknown): SiteCategoryPolicy[] | null {
  const maxEntries = SITE_IDS.length * DETECTION_KINDS.length;
  if (!Array.isArray(value) || value.length > maxEntries) {
    return null;
  }

  const policies: SiteCategoryPolicy[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["siteId", "kind", "action"]) ||
      !isSiteId(item.siteId) ||
      !isDetectionKind(item.kind) ||
      !isCategoryPolicyAction(item.action)
    ) {
      return null;
    }

    policies.push({ siteId: item.siteId, kind: item.kind, action: item.action });
  }

  return policies;
}

function parseStoredTerms(value: unknown): CustomTermsReadResult {
  if (value === undefined) {
    return { ok: true, ...emptySettings() };
  }

  if (Array.isArray(value)) {
    const terms = parseTerms(value, true);
    return terms === null
      ? { ok: false, error: "invalid_storage" }
      : { ok: true, terms, mode: "replace", allowlistedTerms: [] };
  }

  if (
    !isRecord(value) ||
    !hasSupportedSettingsKeys(value) ||
    !isMode(value.mode)
  ) {
    return { ok: false, error: "invalid_storage" };
  }

  const terms = parseTerms(value.terms, false);
  const allowlistedTerms = "allowlistedTerms" in value ? parseAllowlistedTerms(value.allowlistedTerms) : [];
  const siteAllowlist = "siteAllowlist" in value ? parseSiteAllowlist(value.siteAllowlist) : [];
  const categoryPolicies = "categoryPolicies" in value ? parseCategoryPolicies(value.categoryPolicies) : [];
  const siteCategoryPolicies = "siteCategoryPolicies" in value
    ? parseSiteCategoryPolicies(value.siteCategoryPolicies)
    : [];
  const settingsVersion = "settingsVersion" in value ? parseSettingsVersion(value.settingsVersion) : undefined;
  const auditEnabled = "auditEnabled" in value ? value.auditEnabled : false;
  const hasDetectionProfile = "detectionProfile" in value;
  const hasReplacementStyle = "replacementStyle" in value;
  const hasReplyTokenViewer = "replyTokenViewerEnabled" in value;
  const hasAttachmentAction = "attachmentAction" in value;
  const hasSemanticReview = "semanticReview" in value;
  const detectionProfile = hasDetectionProfile ? value.detectionProfile : undefined;
  const replacementStyle = hasReplacementStyle ? value.replacementStyle : undefined;
  const replyTokenViewerEnabled = hasReplyTokenViewer ? value.replyTokenViewerEnabled : undefined;
  const attachmentAction = hasAttachmentAction ? value.attachmentAction : undefined;
  const semanticReview = hasSemanticReview
    ? value.semanticReview === "local_provider" ? "off" : value.semanticReview
    : undefined;
  return terms === null || allowlistedTerms === null || siteAllowlist === null || categoryPolicies === null ||
    siteCategoryPolicies === null || typeof auditEnabled !== "boolean" ||
    (hasDetectionProfile && !isDetectionProfile(detectionProfile)) || (hasReplacementStyle && !isReplacementStyle(replacementStyle)) ||
    (hasReplyTokenViewer && typeof replyTokenViewerEnabled !== "boolean") || (hasAttachmentAction && !isAttachmentAction(attachmentAction)) ||
    (hasSemanticReview && !isSemanticReviewMode(semanticReview))
    ? { ok: false, error: "invalid_storage" }
    : (() => {
        const advanced = normalizeAdvancedSettings({
          ...(hasDetectionProfile ? { detectionProfile: detectionProfile as DetectionProfile } : {}),
          ...(hasReplacementStyle ? { replacementStyle: replacementStyle as ReplacementStyle } : {}),
          ...(hasReplyTokenViewer ? { replyTokenViewerEnabled: replyTokenViewerEnabled as boolean } : {}),
          ...(hasAttachmentAction ? { attachmentAction: attachmentAction as AttachmentAction } : {}),
          ...(hasSemanticReview ? { semanticReview: semanticReview as SemanticReviewMode } : {}),
        });
        return {
          ok: true,
          terms,
          mode: value.mode,
          allowlistedTerms,
          ...(siteAllowlist.length > 0 ? { siteAllowlist } : {}),
          ...(categoryPolicies.length > 0 ? { categoryPolicies } : {}),
          ...(siteCategoryPolicies.length > 0 ? { siteCategoryPolicies } : {}),
          ...(settingsVersion !== undefined ? { settingsVersion } : {}),
          ...(auditEnabled ? { auditEnabled } : {}),
          ...advanced,
        };
      })();
}

export function parseCustomTermsSettings(value: unknown): CustomTermsReadResult {
  if (value === undefined || Array.isArray(value)) {
    return { ok: false, error: "invalid_storage" };
  }

  return parseStoredTerms(value);
}

function toWriteFailure(): CustomTermsMutationResult {
  return { ok: false, error: "storage_write_failed" };
}

type PolicyOverlayFields = {
  readonly siteCategoryPolicies?: readonly SiteCategoryPolicy[];
  readonly settingsVersion?: 1 | 2;
};

function overlayFieldsFrom(value: PolicyOverlayFields): PolicyOverlayFields {
  return {
    ...(value.siteCategoryPolicies !== undefined && value.siteCategoryPolicies.length > 0
      ? { siteCategoryPolicies: value.siteCategoryPolicies }
      : {}),
    ...(value.settingsVersion !== undefined ? { settingsVersion: value.settingsVersion } : {}),
  };
}

function toSettings(
  terms: readonly CustomTerm[],
  mode: RedactionMode,
  allowlistedTerms: readonly string[],
  siteAllowlist: readonly SiteAllowlistEntry[],
  categoryPolicies: readonly CategoryPolicyEntry[],
  auditEnabled: boolean,
  advanced: AdvancedSettings = {},
  overlay: PolicyOverlayFields = {},
): CustomTermsSettings {
  const normalizedAdvanced = normalizeAdvancedSettings(advanced);
  const siteCategoryPolicies = overlay.siteCategoryPolicies ?? [];
  return {
    terms: [...terms],
    mode,
    allowlistedTerms: [...allowlistedTerms],
    ...(siteAllowlist.length > 0 ? { siteAllowlist: siteAllowlist.map((entry) => ({ ...entry })) } : {}),
    ...(categoryPolicies.length > 0 ? { categoryPolicies: categoryPolicies.map((policy) => ({ ...policy })) } : {}),
    ...(siteCategoryPolicies.length > 0
      ? { siteCategoryPolicies: siteCategoryPolicies.map((policy) => ({ ...policy })) }
      : {}),
    ...(overlay.settingsVersion !== undefined ? { settingsVersion: overlay.settingsVersion } : {}),
    ...(auditEnabled ? { auditEnabled } : {}),
    ...normalizedAdvanced,
  };
}

function toSuccess(
  terms: readonly CustomTerm[],
  mode: RedactionMode,
  allowlistedTerms: readonly string[],
  siteAllowlist: readonly SiteAllowlistEntry[],
  categoryPolicies: readonly CategoryPolicyEntry[],
  auditEnabled: boolean,
  advanced: AdvancedSettings = {},
  overlay: PolicyOverlayFields = {},
): CustomTermsMutationResult {
  const normalizedAdvanced = normalizeAdvancedSettings(advanced);
  const siteCategoryPolicies = overlay.siteCategoryPolicies ?? [];
  return {
    ok: true,
    terms: [...terms],
    mode,
    allowlistedTerms: [...allowlistedTerms],
    ...(siteAllowlist.length > 0 ? { siteAllowlist: siteAllowlist.map((entry) => ({ ...entry })) } : {}),
    ...(categoryPolicies.length > 0 ? { categoryPolicies: categoryPolicies.map((policy) => ({ ...policy })) } : {}),
    ...(siteCategoryPolicies.length > 0
      ? { siteCategoryPolicies: siteCategoryPolicies.map((policy) => ({ ...policy })) }
      : {}),
    ...(overlay.settingsVersion !== undefined ? { settingsVersion: overlay.settingsVersion } : {}),
    ...(auditEnabled ? { auditEnabled } : {}),
    ...normalizedAdvanced,
  };
}

async function writeSettings(
  storage: CustomTermsStorage,
  terms: readonly CustomTerm[],
  mode: RedactionMode,
  allowlistedTerms: readonly string[],
  siteAllowlist: readonly SiteAllowlistEntry[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  auditEnabled = false,
  advanced: AdvancedSettings = {},
  overlay: PolicyOverlayFields = {},
): Promise<CustomTermsMutationResult> {
  try {
    await storage.writeValue(toSettings(terms, mode, allowlistedTerms, siteAllowlist, categoryPolicies, auditEnabled, advanced, overlay));
    return toSuccess(terms, mode, allowlistedTerms, siteAllowlist, categoryPolicies, auditEnabled, advanced, overlay);
  } catch {
    return toWriteFailure();
  }
}

export function createCustomTermsStore(storage: CustomTermsStorage): CustomTermsStore {
  const read = async (): Promise<CustomTermsReadResult> => {
    try {
      return parseStoredTerms(await storage.readValue());
    } catch {
      return { ok: false, error: "storage_read_failed" };
    }
  };
  let mutationTail = Promise.resolve();

  // Serialize read-modify-write operations so a later action cannot restore data cleared by an earlier one.
  const enqueueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    read,
    replace(settings) {
      const parsed = parseCustomTermsSettings(settings);
      if (!parsed.ok) {
        return Promise.resolve({ ok: false, error: "invalid_storage" });
      }

      return enqueueMutation(() => writeSettings(
        storage,
        parsed.terms,
        parsed.mode,
        parsed.allowlistedTerms ?? [],
        parsed.siteAllowlist ?? [],
        parsed.categoryPolicies ?? [],
        parsed.auditEnabled ?? false,
        advancedSettingsFromResult(parsed),
        overlayFieldsFrom(parsed),
      ));
    },
    async add(rawTerm, group = "other") {
      if (!isGroup(group)) {
        return { ok: false, error: "invalid_storage" };
      }
      const value = rawTerm.trim();
      if (value.length === 0) {
        return { ok: false, error: "empty_term" };
      }
      if (value.length > MAX_CUSTOM_TERM_LENGTH) {
        return { ok: false, error: "term_too_long" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }
        if (current.terms.some((term) => term.value === value)) {
          return { ok: false, error: "duplicate_term" };
        }
        if (current.terms.length >= MAX_CUSTOM_TERMS) {
          return { ok: false, error: "term_limit" };
        }

        return writeSettings(
          storage,
          [...current.terms, { value, group }],
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async addBatch(rawBatch, group) {
      if (!isGroup(group)) {
        return { ok: false, error: "invalid_storage" };
      }
      const batch = rawBatch
        .split(/\r\n|\n|\r/)
        .map((rawValue, index) => ({ value: rawValue.trim(), line: index + 1 }))
        .filter((term) => term.value.length > 0);

      if (batch.length === 0) {
        return { ok: false, error: "empty_term" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }

        const values = new Set(current.terms.map((term) => term.value));
        const additions: CustomTerm[] = [];
        for (const term of batch) {
          if (term.value.length > MAX_CUSTOM_TERM_LENGTH) {
            return { ok: false, error: "term_too_long", line: term.line };
          }
          if (values.has(term.value)) {
            return { ok: false, error: "duplicate_term", line: term.line };
          }
          if (current.terms.length + additions.length >= MAX_CUSTOM_TERMS) {
            return { ok: false, error: "term_limit", line: term.line };
          }
          values.add(term.value);
          additions.push({ value: term.value, group });
        }

        return writeSettings(
          storage,
          [...current.terms, ...additions],
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async addAllowlistedBatch(rawBatch, target = { scope: "global" }) {
      if (
        target.scope === "site" &&
        (!isSiteId(target.siteId) ||
          (target.expiresAt !== undefined && !Number.isFinite(Date.parse(target.expiresAt))))
      ) {
        return { ok: false, error: "invalid_storage" };
      }
      const batch = rawBatch
        .split(/\r\n|\n|\r/)
        .map((rawValue, index) => ({ value: rawValue.trim(), line: index + 1 }))
        .filter((term) => term.value.length > 0);

      if (batch.length === 0) {
        return { ok: false, error: "empty_term" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }

        const currentAllowlistedTerms = current.allowlistedTerms ?? [];
        const currentSiteAllowlist = current.siteAllowlist ?? [];
        const targetedValues = target.scope === "global"
          ? currentAllowlistedTerms
          : currentSiteAllowlist.filter((entry) => entry.siteId === target.siteId).map((entry) => entry.value);
        const currentTotal = currentAllowlistedTerms.length + currentSiteAllowlist.length;
        const values = new Set(targetedValues);
        const additions: string[] = [];
        for (const term of batch) {
          if (term.value.length > MAX_CUSTOM_TERM_LENGTH) {
            return { ok: false, error: "term_too_long", line: term.line };
          }
          if (values.has(term.value)) {
            return { ok: false, error: "duplicate_term", line: term.line };
          }
          if (currentTotal + additions.length >= MAX_CUSTOM_TERMS) {
            return { ok: false, error: "term_limit", line: term.line };
          }
          values.add(term.value);
          additions.push(term.value);
        }

        const allowlistedTerms = target.scope === "global"
          ? [...currentAllowlistedTerms, ...additions]
          : currentAllowlistedTerms;
        const siteAllowlist = target.scope === "site"
          ? [
              ...currentSiteAllowlist,
              ...additions.map((value) => ({
                value,
                siteId: target.siteId,
                ...(target.expiresAt === undefined ? {} : { expiresAt: target.expiresAt }),
              })),
            ]
          : currentSiteAllowlist;
        return writeSettings(
          storage,
          current.terms,
          current.mode,
          allowlistedTerms,
          siteAllowlist,
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async setMode(mode) {
      if (!isMode(mode)) {
        return { ok: false, error: "invalid_storage" };
      }
      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }
        return writeSettings(
          storage,
          current.terms,
          mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async setCategoryPolicy(kind, action) {
      if (!isDetectionKind(kind) || (action !== null && !isCategoryPolicyAction(action))) {
        return { ok: false, error: "invalid_storage" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }

        const currentPolicies = current.categoryPolicies ?? [];
        const categoryPolicies = action === null
          ? currentPolicies.filter((policy) => policy.kind !== kind)
          : [...currentPolicies.filter((policy) => policy.kind !== kind), { kind, action }];
        return writeSettings(
          storage,
          current.terms,
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          categoryPolicies,
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async setAuditEnabled(enabled) {
      if (typeof enabled !== "boolean") {
        return { ok: false, error: "invalid_storage" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }

        return writeSettings(
          storage,
          current.terms,
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          enabled,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    async setAdvancedSettings(settings) {
      if (!isRecord(settings) || !isAdvancedSettingsPatch(settings as Partial<AdvancedSettings>)) {
        return { ok: false, error: "invalid_storage" };
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }

        const advanced = {
          ...advancedSettingsFromResult(current),
          ...(settings as Partial<AdvancedSettings>),
        };
        return writeSettings(
          storage,
          current.terms,
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advanced,
          overlayFieldsFrom(current),
        );
      });
    },
    remove(value) {
      const normalizedValue = value.trim();
      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }
        return writeSettings(
          storage,
          current.terms.filter((term) => term.value !== normalizedValue),
          current.mode,
          current.allowlistedTerms ?? [],
          current.siteAllowlist ?? [],
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    removeAllowlisted(value, target = { scope: "global" }) {
      const normalizedValue = value.trim();
      if (target.scope === "site" && !isSiteId(target.siteId)) {
        return Promise.resolve({ ok: false, error: "invalid_storage" as const });
      }
      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current;
        }
        const allowlistedTerms = target.scope === "global"
          ? (current.allowlistedTerms ?? []).filter((term) => term !== normalizedValue)
          : current.allowlistedTerms ?? [];
        const siteAllowlist = target.scope === "site"
          ? (current.siteAllowlist ?? []).filter(
              (entry) => entry.siteId !== target.siteId || entry.value !== normalizedValue,
            )
          : current.siteAllowlist ?? [];
        return writeSettings(
          storage,
          current.terms,
          current.mode,
          allowlistedTerms,
          siteAllowlist,
          current.categoryPolicies ?? [],
          current.auditEnabled ?? false,
          advancedSettingsFromResult(current),
          overlayFieldsFrom(current),
        );
      });
    },
    clear() {
      return enqueueMutation(async () => {
        let mode: RedactionMode = "replace";
        let allowlistedTerms: readonly string[] = [];
        let siteAllowlist: readonly SiteAllowlistEntry[] = [];
        let categoryPolicies: readonly CategoryPolicyEntry[] = [];
        let auditEnabled = false;
        let advanced: AdvancedSettings = {};
        let overlay: PolicyOverlayFields = {};
        try {
          const stored = parseStoredTerms(await storage.readValue());
          if (stored.ok) {
            mode = stored.mode;
            allowlistedTerms = stored.allowlistedTerms ?? [];
            siteAllowlist = stored.siteAllowlist ?? [];
            categoryPolicies = stored.categoryPolicies ?? [];
            auditEnabled = stored.auditEnabled ?? false;
            advanced = advancedSettingsFromResult(stored);
            overlay = overlayFieldsFrom(stored);
          }
        } catch {
          // A recovery clear still restores a valid default configuration when reading fails.
        }
        return writeSettings(storage, [], mode, allowlistedTerms, siteAllowlist, categoryPolicies, auditEnabled, advanced, overlay);
      });
    },
    clearAllowlisted(target) {
      if (target?.scope === "site" && !isSiteId(target.siteId)) {
        return Promise.resolve({ ok: false, error: "invalid_storage" as const });
      }
      return enqueueMutation(async () => {
        let terms: readonly CustomTerm[] = [];
        let mode: RedactionMode = "replace";
        let allowlistedTerms: readonly string[] = [];
        let siteAllowlist: readonly SiteAllowlistEntry[] = [];
        let categoryPolicies: readonly CategoryPolicyEntry[] = [];
        let auditEnabled = false;
        let advanced: AdvancedSettings = {};
        let overlay: PolicyOverlayFields = {};
        try {
          const stored = parseStoredTerms(await storage.readValue());
          if (stored.ok) {
            terms = stored.terms;
            mode = stored.mode;
            allowlistedTerms = stored.allowlistedTerms ?? [];
            siteAllowlist = stored.siteAllowlist ?? [];
            categoryPolicies = stored.categoryPolicies ?? [];
            auditEnabled = stored.auditEnabled ?? false;
            advanced = advancedSettingsFromResult(stored);
            overlay = overlayFieldsFrom(stored);
          }
        } catch {
          // A recovery clear restores valid empty terms and replacement mode when reading fails.
        }
        if (target === undefined) {
          allowlistedTerms = [];
          siteAllowlist = [];
        } else if (target.scope === "global") {
          allowlistedTerms = [];
        } else if (isSiteId(target.siteId)) {
          siteAllowlist = siteAllowlist.filter((entry) => entry.siteId !== target.siteId);
        }
        return writeSettings(storage, terms, mode, allowlistedTerms, siteAllowlist, categoryPolicies, auditEnabled, advanced, overlay);
      });
    },
    subscribe(listener) {
      return storage.subscribe((nextValue) => listener(parseStoredTerms(nextValue)));
    },
  };
}

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.get === "function" &&
    typeof chrome.storage.local.set === "function" &&
    typeof chrome.storage.onChanged?.addListener === "function" &&
    typeof chrome.storage.onChanged.removeListener === "function"
  );
}

export function createChromeCustomTermsStore(): CustomTermsStore {
  if (!hasChromeStorage()) {
    const unavailableRead = async (): Promise<CustomTermsReadResult> => ({ ok: false, error: "storage_read_failed" });
    const unavailableMutation = async (): Promise<CustomTermsMutationResult> => toWriteFailure();

    return {
      read: unavailableRead,
      replace: unavailableMutation,
      add: unavailableMutation,
      addBatch: unavailableMutation,
      addAllowlistedBatch: unavailableMutation,
      setMode: unavailableMutation,
      setCategoryPolicy: unavailableMutation,
      setAuditEnabled: unavailableMutation,
      setAdvancedSettings: unavailableMutation,
      remove: unavailableMutation,
      removeAllowlisted: unavailableMutation,
      clear: unavailableMutation,
      clearAllowlisted: unavailableMutation,
      subscribe: () => () => undefined,
    };
  }

  return createCustomTermsStore({
    async readValue() {
      const values = await chrome.storage.local.get(CUSTOM_TERMS_STORAGE_KEY);
      return values[CUSTOM_TERMS_STORAGE_KEY];
    },
    async writeValue(settings) {
      await chrome.storage.local.set({
        [CUSTOM_TERMS_STORAGE_KEY]: {
          terms: [...settings.terms],
          mode: settings.mode,
          allowlistedTerms: [...(settings.allowlistedTerms ?? [])],
          ...(settings.siteAllowlist && settings.siteAllowlist.length > 0
            ? { siteAllowlist: settings.siteAllowlist.map((entry) => ({ ...entry })) }
            : {}),
          ...(settings.categoryPolicies && settings.categoryPolicies.length > 0
            ? { categoryPolicies: settings.categoryPolicies.map((policy) => ({ ...policy })) }
            : {}),
          ...(settings.siteCategoryPolicies && settings.siteCategoryPolicies.length > 0
            ? { siteCategoryPolicies: settings.siteCategoryPolicies.map((policy) => ({ ...policy })) }
            : {}),
          ...(settings.settingsVersion !== undefined ? { settingsVersion: settings.settingsVersion } : {}),
          ...(settings.auditEnabled ? { auditEnabled: true } : {}),
          ...(settings.detectionProfile !== undefined ? { detectionProfile: settings.detectionProfile } : {}),
          ...(settings.replacementStyle !== undefined ? { replacementStyle: settings.replacementStyle } : {}),
          ...(settings.replyTokenViewerEnabled !== undefined
            ? { replyTokenViewerEnabled: settings.replyTokenViewerEnabled }
            : {}),
          ...(settings.attachmentAction !== undefined ? { attachmentAction: settings.attachmentAction } : {}),
          ...(settings.semanticReview !== undefined ? { semanticReview: settings.semanticReview } : {}),
        },
      });
    },
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
        if (areaName === "local" && CUSTOM_TERMS_STORAGE_KEY in changes) {
          listener(changes[CUSTOM_TERMS_STORAGE_KEY]?.newValue);
        }
      };

      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  });
}

export function createCustomTermsCache(store: CustomTermsStore): CustomTermsCache {
  let snapshot: CustomTermsSnapshot = { state: "loading" };
  let revision = 0;
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<(snapshot: CustomTermsSnapshot) => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must not interfere with cache updates.
      }
    }
  };

  const apply = (result: CustomTermsReadResult): void => {
    revision += 1;
    snapshot = result.ok
      ? (() => {
          const advanced = resolveAdvancedSettings(result);
          return {
            state: "ready",
            terms: result.terms,
            mode: result.mode,
            allowlistedTerms: result.allowlistedTerms,
            siteAllowlist: result.siteAllowlist,
            categoryPolicies: result.categoryPolicies,
            siteCategoryPolicies: result.siteCategoryPolicies,
            settingsVersion: result.settingsVersion,
            auditEnabled: result.auditEnabled,
            detectionProfile: advanced.detectionProfile,
            replacementStyle: advanced.replacementStyle,
            replyTokenViewerEnabled: advanced.replyTokenViewerEnabled,
            attachmentAction: advanced.attachmentAction,
            semanticReview: advanced.semanticReview,
          };
        })()
      : { state: "failed" };
    notify();
  };

  return {
    start() {
      if (unsubscribe !== null) {
        return;
      }

      const startGeneration = ++generation;
      const initialRevision = revision;
      unsubscribe = store.subscribe(apply);
      void store.read().then((result) => {
        if (generation !== startGeneration || revision !== initialRevision || !result.ok) {
          if (generation === startGeneration && revision === initialRevision) {
            apply(result);
          }
          return;
        }

        apply(result);

        // Materialize defaults once so legacy/empty storage cannot silently put the content
        // script back on its conservative fallback after the welcome page is skipped.
        const missing = missingAdvancedSettings(result);
        if (Object.keys(missing).length > 0) {
          void Promise.resolve()
            .then(() => store.setAdvancedSettings(missing))
            .catch(() => undefined);
        }
      });
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}
