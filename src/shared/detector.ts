import type {
  CategoryPolicyEntry,
  DetectionKind,
  DetectionProfile,
  DraftAnalysis,
  ReplacementStyle,
  RedactionDecision,
  RedactionFinding,
  RedactionResult,
  SendAction,
  ScopedAllowlistValue,
} from "./types.js";
import { createSessionTokenMap, type SessionTokenMap } from "./session-token-map.js";
import {
  isCourtCaseNumber,
  isDigitalInvoiceNumber,
  isIpv4Address,
  isIpv6Address,
  isIso3779Vin,
  isMedicalRecordNumber,
  isValidUnifiedSocialCreditCode,
  isValidChinaResidentId,
  passesLuhnCheck,
} from "./validators.js";
import { getCuratedSecretRules } from "./secret-rules.js";
import {
  createNoopSemanticReviewProvider,
  type SemanticHint,
  type SemanticReviewProvider,
} from "./semantic-review.js";
import { getCodeRanges, overlapsTextRange } from "./code-ranges.js";
import {
  findHighSignalSemanticCandidates,
  looksLikeNonPersonValue,
  parseChineseNameAt,
} from "./semantic-candidates.js";
import {
  ORGANIZATION_MARKER_PATTERN,
  PERSON_ROLE_NOUNS,
  COMMON_ORGANIZATION_OR_PLACE_NAMES,
} from "./semantic-lexicon.js";
import { createDetectionText, sourceRangeFor, type DetectionText } from "./text-normalization.js";

type Candidate = {
  kind: DetectionKind;
  decision: RedactionDecision;
  start: number;
  end: number;
  raw: string;
  normalized: string;
  label?: string;
  policy?: CategoryPolicyEntry["action"];
  warning?: "credential_too_long";
  source?: "structured" | "context" | "semantic";
};

export type RedactionOptions = {
  detectionProfile?: DetectionProfile;
  replacementStyle?: ReplacementStyle;
  semanticReviewProvider?: SemanticReviewProvider;
};

export type DetectionRange = {
  kind: DetectionKind;
  start: number;
  end: number;
};

const KIND_PRIORITY: Record<DetectionKind, number> = {
  api_key: 0,
  access_token: 1,
  private_key: 2,
  connection_string: 3,
  china_id: 4,
  unified_social_credit_code: 5,
  labeled_identifier: 6,
  bank_account: 7.2,
  mac_address: 6.6,
  bank_card: 7,
  // Both sit above the semantic kinds: a checksum-free but shape-anchored identifier is
  // still stronger evidence than a person or address guess, and a plate must win over
  // labeled_identifier so `车牌号：京A12345` reports the specific kind.
  passport: 7.5,
  license_plate: 5.5,
  person_name: 8,
  address: 9,
  account: 10,
  credential: 11,
  private_date: 8.5,
  private_url: 2.5,
  phone: 12,
  email: 13,
  local_path: 14,
  ipv4: 15,
  ipv6: 15.5,
  custom_term: 16,
};

const API_KEY_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const ACCESS_TOKEN_PATTERNS = [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g];

const MAX_LABELED_VALUE_LENGTH = 120;
// 与语义锚点共用同一份角色名词，避免两条路径的词表漂移——此前
// PERSON_LABELS 与 PERSON_PREFIX_PATTERN 各自维护，公文角色词两边都缺。
const PERSON_LABELS = [...PERSON_ROLE_NOUNS, "姓名"].join("|");
const ADDRESS_LABELS = "家庭住址|户籍地址|联系地址|收货地址|办公地址|开户地址|住址|地址";
const ACCOUNT_LABELS = "个人微信id|个人微信ID|微信 ID|微信号|微信ID|QQ号码|QQ号|VPN账号|数据库账号|SSH登录账号|OA登录账号|登录账号|用户账号|用户名|user_id|user id|userid|user_name|username|login|account|微信|QQ|账号";
const ID_LABELS = "紧急联系人身份证|对接人身份证|身份证号|身份证";
const CARD_LABELS = "副卡卡号|信用卡号|银行卡号|卡号";
// 护照与车牌从 IDENTIFIER_LABELS 里独立出来，好让提示与会话令牌显示具体类型而不是
// 笼统的“编号”。医保卡号一并补上：此前只收了社保卡号。
const PASSPORT_LABELS = "护照号码|护照编号|护照号|因私护照|因公护照|护照";
const PLATE_LABELS = "车辆牌照|车牌号码|车牌号|车牌";
  const IDENTIFIER_LABELS = "增值税数电发票号|数电发票号码|数电发票号|增值税发票号码|增值税发票号|发票号码|发票号|法院案号|病历号|住院号|病案号|合同编号|合同号|数据库实例端口|数据库端口|社保卡号|医保卡号|医保号|公积金账号|客户合同编号|涉密归档编号|OA系统工号|人事档案编号|薪资档案编号|车架号VIN|车架号|车辆发动机号|医疗档案编号|内部项目编号|项目编号|开户行|MAC地址|信用卡有效期|工号";
const PHONE_LABELS = "手机号|手机号码|手机|备用号码|联系电话|紧急联系电话|电话号码|电话";
const EMAIL_LABELS = "电子邮箱|邮箱|邮件地址|邮件|email|mail";
const NETWORK_LABELS = "服务器内网 IP|服务器内网IP|服务器外网 IP|服务器外网IP|内网公网IP|内网 IP|内网IP|外网公网IP|外网公网 IP|公网IP|公网 IP|IP地址|IP 地址|IP";
const CREDENTIAL_LABELS = "VPN动态密钥|Redis连接密码|数据库密码|SSH登录密码|OA登录密码|SSH私钥指纹|合同加密密码|信用卡CVV|项目访问token|项目密钥|动态密钥|访问令牌|登录密码|密码|密钥|令牌|token|password|passwd|pwd|passcode|secret|secret key|client secret|client_secret|api_key|api-key|apikey|authorization|auth token|access token|refresh token|session token|bearer|private key|private_key|ssh key|credential|credentials|CVV|私钥";
const ALL_FIELD_LABELS = [
  CREDENTIAL_LABELS,
  PERSON_LABELS,
  ADDRESS_LABELS,
  ACCOUNT_LABELS,
  PASSPORT_LABELS,
  PLATE_LABELS,
  ID_LABELS,
  CARD_LABELS,
  IDENTIFIER_LABELS,
  PHONE_LABELS,
  EMAIL_LABELS,
  NETWORK_LABELS,
].join("|");
const MAX_CREDENTIAL_VALUE_LENGTH = 4096;

function normalizeDashVariants(input: string): string {
  return createDetectionText(input).text;
}

// 标签集合都是模块常量，但 labelAlternation 会在每次候选扫描中被反复调用，
// 且要对数百个标签做排序与转义。缓存结果，避免长草稿下的重复开销。
const labelAlternationCache = new Map<string, string>();

function labelAlternation(labels: string): string {
  const cached = labelAlternationCache.get(labels);
  if (cached !== undefined) {
    return cached;
  }

  const alternation = labels
    .split("|")
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replace(/\s+/g, "\\s*"))
    .join("|");
  labelAlternationCache.set(labels, alternation);
  return alternation;
}

const PRIVATE_KEY_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]+?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
];

const CONNECTION_STRING_PATTERNS = [
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi,
];

// 只识别带有分享路径或口令参数的已知协作/网盘链接。普通公开首页和文档链接不应触发，
// 否则会把用户的正常引用变成确认噪声。
const PRIVATE_URL_PATTERNS = [
  /https?:\/\/(?:drive\.google\.com|docs\.google\.com|pan\.baidu\.com|aliyundrive\.com|www\.aliyundrive\.com|cloud\.189\.cn|weiyun\.com|1drv\.ms|onedrive\.live\.com|larksuite\.com|feishu\.cn|notion\.so|dropbox\.com)\/(?:s|share|shared|d|l|file|folder)\/[A-Za-z0-9_-]{8,}(?:[?&](?:pwd|passcode|token|share_token)=[A-Za-z0-9_-]{6,})?[^\s"'<>，,。.!！？!?]*/giu,
  /https?:\/\/(?:drive\.google\.com|docs\.google\.com|pan\.baidu\.com|aliyundrive\.com|www\.aliyundrive\.com|cloud\.189\.cn|weiyun\.com|1drv\.ms|onedrive\.live\.com|larksuite\.com|feishu\.cn|notion\.so|dropbox\.com)\/[^\s"'<>，,。.!！？!?]*[?&](?:pwd|passcode|token|share_token)=[A-Za-z0-9_-]{6,}[^\s"'<>，,。.!！？!?]*/giu,
];

const PRIVATE_DATE_LABELS = "出生日期|出生年月日|出生日期时间|生日日期|生日|出生时间";
const BANK_ACCOUNT_LABELS = "银行账户|银行账号|对公账户|对公账号|收款账户|收款账号|结算账户|结算账号|开户账号|银行卡账户";

function isValidPrivateDate(value: string): boolean {
  const normalized = value.trim().replace(/[年月日./-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(normalized);
  if (full === null) {
    const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(value.trim());
    if (compact === null) {
      return false;
    }
    return isValidPrivateDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  }
  const year = Number(full[1]);
  const month = Number(full[2]);
  const day = Number(full[3]);
  if (year < 1900 || year > new Date().getFullYear() || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidMacAddress(value: string): boolean {
  const hex = value.replace(/[:.\-]/gu, "").toUpperCase();
  return /^[0-9A-F]{12}$/u.test(hex) && !/^0{12}$/u.test(hex) && !/^F{12}$/u.test(hex);
}

function isValidBankAccountValue(value: string): boolean {
  const compact = normalizeDashVariants(value).replace(/[\s-]/gu, "");
  return /^[0-9A-Za-z]{6,36}$/u.test(compact) && /\d/u.test(compact);
}

function normalizeValue(kind: DetectionKind, raw: string): string {
  switch (kind) {
    case "phone":
    case "bank_card":
      return normalizeDashVariants(raw).replace(/[\s-]/g, "");
    case "email":
      return normalizeDashVariants(raw).toLowerCase();
    case "china_id":
      // Deliberately does NOT strip dashes: labeled values like `ID-DEMO-001` must keep
      // their punctuation or two different values collapse onto one session token.
      return raw.toUpperCase();
    case "passport":
    case "license_plate":
      // 只去掉真实写法里会出现的分隔符：`京A·12345` 与 `京A 12345` 应与 `京a12345`
      // 共用一个会话令牌。ASCII 连字符**不去**——真实车牌不用它，而 getRedactionValues
      // 会把归一化后的值展示给用户，去掉了就会显示成用户没输入过的样子。
      return normalizeDashVariants(raw).replace(/[\s·・]/gu, "").toUpperCase();
    case "api_key":
    case "access_token":
    case "unified_social_credit_code":
    case "account":
    case "labeled_identifier":
    case "credential":
    case "private_url":
      return kind === "account" ? normalizeDashVariants(raw).replace(/^@/u, "") : normalizeDashVariants(raw);
    case "mac_address":
      return raw.replace(/[:.\-]/gu, "").toUpperCase();
    case "bank_account":
      return normalizeDashVariants(raw);
    case "private_date":
      return raw.trim().replace(/[年月日./-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
    case "person_name":
    case "address":
      return normalizeDashVariants(raw).replace(/[\s·・]/gu, "");
    default:
      return raw;
  }
}

function appendRegexCandidates(
  candidates: Candidate[],
  view: DetectionText,
  pattern: RegExp,
  kind: DetectionKind,
  decision: RedactionDecision,
  isAccepted: (raw: string) => boolean = () => true,
  source?: Candidate["source"],
): void {
  const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(view.text)) !== null) {
    const normalizedRaw = match[0];
    const range = sourceRangeFor(view, match.index, match.index + normalizedRaw.length);

    if (range !== null && isAccepted(normalizedRaw)) {
      candidates.push({
        kind,
        decision,
        start: range.start,
        end: range.end,
        raw: view.source.slice(range.start, range.end),
        normalized: normalizeValue(kind, normalizedRaw),
        ...(source === undefined ? {} : { source }),
      });
    }

    if (normalizedRaw.length === 0) {
      matcher.lastIndex += 1;
    }
  }
}

function hasNearbyLabel(input: string, start: number, end: number, pattern: RegExp, radius = 24): boolean {
  const contextStart = Math.max(0, start - radius);
  const contextEnd = Math.min(input.length, end + radius);
  return pattern.test(input.slice(contextStart, contextEnd));
}

function isPlausibleChinaId(value: string): boolean {
  const compact = value.replace(/[\s-]/gu, "");
  const matched = /^(\d{6})(\d{4})(\d{2})(\d{2})\d{3}[\dXx]$/u.exec(compact);
  if (matched === null) {
    return false;
  }
  const year = Number(matched[2]);
  const month = Number(matched[3]);
  const day = Number(matched[4]);
  if (year < 1900 || year > new Date().getFullYear() || month < 1 || month > 12 || day < 1) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function appendObfuscatedEmailCandidates(candidates: Candidate[], view: DetectionText): void {
  const patterns = [
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+_at_[A-Za-z0-9-]+(?:_dot_[A-Za-z0-9-]+)+/giu,
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+\s*\[\s*at\s*\]\s*[A-Za-z0-9-]+(?:\s*\[\s*dot\s*\]\s*[A-Za-z0-9-]+)+/giu,
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+\s*[（(]\s*at\s*[）)]\s*[A-Za-z0-9-]+(?:\s*[（(]\s*dot\s*[）)]\s*[A-Za-z0-9-]+)+/giu,
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+\s+at\s+[A-Za-z0-9-]+(?:\s+dot\s+[A-Za-z0-9-]+)+/giu,
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+\s*艾特\s*[A-Za-z0-9-]+(?:\s*点\s*[A-Za-z0-9-]+)+/gu,
  ];
  for (const pattern of patterns) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(view.text)) !== null) {
      const raw = match[0];
      const leading = /^[\s=:：]+/u.exec(raw)?.[0].length ?? 0;
      const valueStart = match.index + leading;
      const valueRaw = raw.slice(leading);
      if (
        valueRaw.length === 0 ||
        isExplicitTechnicalStructuredValue(view.text, valueStart, valueStart + valueRaw.length)
      ) {
        continue;
      }
      const normalized = normalizeObfuscatedEmail(valueRaw);
      const [local, domain] = normalized.split("@", 2);
      if (
        !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{3,}$/u.test(local ?? "") ||
        !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(domain ?? "")
      ) {
        continue;
      }
      const range = sourceRangeFor(view, valueStart, valueStart + valueRaw.length);
      if (range === null) {
        continue;
      }
      candidates.push({
        kind: "email",
        decision: "replace",
        start: range.start,
        end: range.end,
        raw: view.source.slice(range.start, range.end),
        normalized: normalizeValue("email", normalized),
        policy: "confirm",
        source: "structured",
      });
    }
  }
}

function appendContextualStructuredCandidates(candidates: Candidate[], view: DetectionText): void {
  const input = view.text;
  const bankCardMatcher = /(?<!\d)(?:\d[ -]?){12,18}\d(?![\dXx])/g;
  let match: RegExpExecArray | null;
  while ((match = bankCardMatcher.exec(input)) !== null) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/gu, "");
    if (
      (digits.length !== 16 && digits.length !== 19) ||
      /[Xx]$/u.test(raw) ||
      isIdentityNumberContext(input, match.index, match.index + raw.length) ||
      !hasNearbyLabel(input, match.index, match.index + raw.length, /银行卡|信用卡|卡号|转账|打钱|收款|付款|充值|扣款|支付/gu, 18)
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, match.index + raw.length);
    if (range === null) {
      continue;
    }
    if (candidates.some((candidate) => (candidate.kind === "bank_card" || candidate.kind === "china_id") && candidate.start < range.end && range.start < candidate.end)) {
      continue;
    }
    candidates.push({
      kind: "bank_card",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("bank_card", raw),
      policy: "confirm",
      source: "context",
    });
  }

  const chinaIdMatcher = /(?<![0-9A-Za-z])(?:\d{15}|\d{17}[\dXx]|\d{6}[ -]\d{8}[ -]\d{3}[\dXx])(?![0-9A-Za-z])/g;
  while ((match = chinaIdMatcher.exec(input)) !== null) {
    const raw = match[0];
    if (
      !isPlausibleChinaId(raw) ||
      !hasNearbyLabel(input, match.index, match.index + raw.length, /身份证|证件号|证件串|身份信息|实名|实名认证|报名信息|报名/gu, 22)
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, match.index + raw.length);
    if (range === null) {
      continue;
    }
    if (candidates.some((candidate) => candidate.kind === "china_id" && candidate.start < range.end && range.start < candidate.end)) {
      continue;
    }
    candidates.push({
      kind: "china_id",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("china_id", raw),
      policy: "confirm",
      source: "context",
    });
  }

  // 银联号在真实聊天里经常是裸的 16 位数字，且测试/脱敏样本可能故意不带有效 Luhn
  // 校验位。62 开头是必要但不足的形态证据，因此只产生 confirm 候选，并明确排除订单号、
  // 流水号、验证码等常见业务数字语境。
  const unionPayMatcher = /(?<!\d)62\d{14}(?!\d)/g;
  while ((match = unionPayMatcher.exec(input)) !== null) {
    if (
      /(?:订单|工单|流水|交易|版本|金额|验证码|邮编|端口|编号)/u.test(input.slice(Math.max(0, match.index - 18), Math.min(input.length, match.index + match[0].length + 18))) ||
      isIdentityNumberContext(input, match.index, match.index + match[0].length)
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, match.index + match[0].length);
    if (range === null || candidates.some((candidate) => candidate.kind === "bank_card" && candidate.start < range.end && range.start < candidate.end)) {
      continue;
    }
    candidates.push({
      kind: "bank_card",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("bank_card", match[0]),
      policy: "confirm",
      source: "context",
    });
  }

  // Voice transcription often spells an identity number with Chinese digits, while the
  // neighbouring phone remains Arabic digits. Normalize the spoken sequence before validating;
  // a checksum-valid value or a date-plausible value with an explicit recording/transcription
  // cue is strong enough for a confirm candidate, even when no literal "身份证" label survived.
  const dictatedIdentityMatcher = /(?<![0-9A-Za-z])[0-9零〇○一二三四五六七八九幺xX](?:[ \t-]*[0-9零〇○一二三四五六七八九幺xX]){14,22}(?![0-9A-Za-z])/gu;
  while ((match = dictatedIdentityMatcher.exec(input)) !== null) {
    const raw = match[0];
    if (!/[零〇○一二三四五六七八九幺]/u.test(raw)) {
      continue;
    }
    const normalized = normalizeChineseNumber(raw, true);
    const context = semanticContext(input, match.index, match.index + raw.length);
    if (
      normalized === null ||
      !/^\d{17}[\dX]$/u.test(normalized) ||
      (!isValidChinaResidentId(normalized) && !(
        /录音|语音|转写|转文字|证件|身份证|实名|身份/iu.test(context) &&
        isPlausibleChinaId(normalized)
      )) ||
      isExplicitTechnicalStructuredValue(input, match.index, match.index + raw.length)
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, match.index + raw.length);
    if (
      range === null ||
      candidates.some(
        (candidate) => candidate.kind === "china_id" && candidate.start < range.end && range.start < candidate.end,
      )
    ) {
      continue;
    }
    candidates.push({
      kind: "china_id",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized,
      policy: "confirm",
      source: "structured",
    });
  }
}

function isIdentityNumberContext(input: string, start: number, end: number): boolean {
  const prefix = input.slice(Math.max(0, start - 40), start);
  const lastFieldBoundary = Math.max(
    prefix.lastIndexOf("，"),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf("；"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("?"),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\r"),
  );
  const currentField = prefix.slice(lastFieldBoundary + 1);
  const identityMatches = [...currentField.matchAll(/身份证|证件(?:号码|号|串)?|身份信息|实名|实名认证/gu)];
  const cardMatches = [...currentField.matchAll(/银行卡|信用卡|卡号/gu)];
  const identityIndex = identityMatches.at(-1)?.index ?? -1;
  const cardIndex = cardMatches.at(-1)?.index ?? -1;
  return identityIndex >= 0 && identityIndex > cardIndex;
}

function isExplicitlyNonBankCardContext(input: string, start: number, end: number): boolean {
  const context = input.slice(Math.max(0, start - 32), Math.min(input.length, end + 32));
  return /校验码|校驗碼|测试编号|測試編號|模拟编号|模擬編號|非(?:银行卡|銀行卡)|不(?:是|为|為)(?:银行卡|銀行卡)|不是(?:银行卡|銀行卡)/u.test(context);
}

function appendBareBankCardCandidates(candidates: Candidate[], view: DetectionText): void {
  const matcher = /(?<!\d)(?:\d[ -]?){12,18}\d(?![\dXx])/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(view.text)) !== null) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/gu, "");
    if (
      !passesLuhnCheck(raw) ||
      isExplicitlyNonBankCardContext(view.text, match.index, match.index + raw.length) ||
      isIdentityNumberContext(view.text, match.index, match.index + raw.length) ||
      (digits.length === 18 && isValidChinaResidentId(digits))
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, match.index + raw.length);
    if (range === null) {
      continue;
    }
    candidates.push({
      kind: "bank_card",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("bank_card", raw),
    });
  }
}

function findClosingQuote(input: string, start: number, quote: string): number {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
      continue;
    }

    if (input[index] === quote) {
      return index;
    }
  }

  return -1;
}

// 这条正则包含全部字段标签，编译代价高，而它在每个凭证候选的值边界判定中都会用到。
// 复用同一实例并在每次使用前显式重置 lastIndex。
let fieldBoundaryMatcher: RegExp | undefined;

function findNextFieldBoundary(input: string, start: number): number {
  fieldBoundaryMatcher ??= new RegExp(
    `(?:[,，]\\s*|\\s+)(?:${labelAlternation(ALL_FIELD_LABELS)})\\s*(?:[:：=]|(?:是|为|叫)\\s*[:：]?)`,
    "giu",
  );
  fieldBoundaryMatcher.lastIndex = start;
  return fieldBoundaryMatcher.exec(input)?.index ?? -1;
}

function findCredentialValueEnd(input: string, start: number): number {
  const nextField = findNextFieldBoundary(input, start);
  const limit = nextField === -1 ? input.length : nextField;

  for (let index = start; index < limit; index += 1) {
    const character = input[index];
    if (character === "\n" || character === "\r" || character === "。" || character === "！" || character === "？" || character === ";" || character === "；") {
      return index;
    }

    if (character === "." && (index + 1 === input.length || /\s/u.test(input[index + 1] ?? ""))) {
      return index;
    }
  }

  return limit;
}

function trimBounds(input: string, start: number, end: number): { start: number; end: number } {
  let trimmedStart = start;
  let trimmedEnd = end;

  while (trimmedStart < trimmedEnd && /\s/u.test(input[trimmedStart] ?? "")) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(input[trimmedEnd - 1] ?? "")) {
    trimmedEnd -= 1;
  }

  return { start: trimmedStart, end: trimmedEnd };
}

function fingerprintRange(input: string, start: number, end: number): string {
  let hash = 0x811c9dc5;
  for (let index = start; index < end; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${end - start}-${(hash >>> 0).toString(36)}`;
}

function appendCredentialCandidates(candidates: Candidate[], view: DetectionText): void {
  const input = view.text;
  const separator = `(?:[:：=]|(?:是|为|叫)\\s*[:：]?)`;
  const matcher = new RegExp(
    `(?<![A-Za-z0-9_])["']?(${labelAlternation(CREDENTIAL_LABELS)})["']?\\s*${separator}\\s*`,
    "giu",
  );
  const protectedRanges: [number, number][] = [];
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) !== null) {
    if (protectedRanges.some(([start, end]) => match!.index >= start && match!.index < end)) {
      continue;
    }

    const label = match[1].trim();
    const valueStart = matcher.lastIndex;
    if (valueStart >= input.length) {
      continue;
    }

    const quote = input[valueStart];
    let candidateStart = valueStart;
    let candidateEnd: number;

    if (quote === '"' || quote === "'" || quote === "`") {
      const closingQuote = findClosingQuote(input, valueStart + 1, quote);
      candidateStart = valueStart + 1;
      candidateEnd = closingQuote === -1 ? findCredentialValueEnd(input, candidateStart) : closingQuote;
      protectedRanges.push([match.index, closingQuote === -1 ? candidateEnd : closingQuote + 1]);
    } else {
      candidateEnd = findCredentialValueEnd(input, valueStart);
    }

    const bounds = trimBounds(input, candidateStart, candidateEnd);
    if (bounds.end <= bounds.start) {
      continue;
    }

    const valueLength = bounds.end - bounds.start;
    const warning = valueLength > MAX_CREDENTIAL_VALUE_LENGTH
      ? "credential_too_long" as const
      : undefined;
    const normalizedRaw = warning === undefined ? input.slice(bounds.start, bounds.end) : null;
    if (normalizedRaw !== null && normalizedRaw.startsWith("[[")) {
      continue;
    }
    const range = sourceRangeFor(view, bounds.start, bounds.end);
    if (range === null) {
      continue;
    }

    candidates.push({
      kind: "credential",
      decision: "block",
      start: range.start,
      end: range.end,
      raw: warning === undefined ? view.source.slice(range.start, range.end) : "<已省略的长凭证>",
      normalized: warning === undefined
        ? normalizeValue("credential", normalizedRaw as string)
        : `credential_too_long:${fingerprintRange(input, bounds.start, bounds.end)}`,
      label,
      ...(warning === undefined ? {} : { warning }),
      source: "context",
    });
  }

  const bearerMatcher = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/giu;
  while ((match = bearerMatcher.exec(input)) !== null) {
    const normalizedRaw = match[1];
    const start = match.index + match[0].length - normalizedRaw.length;
    const range = sourceRangeFor(view, start, start + normalizedRaw.length);
    if (range === null) {
      continue;
    }
    candidates.push({
      kind: "credential",
      decision: "block",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("credential", normalizedRaw),
      label: "Bearer",
      source: "context",
    });
  }
}

// 表单里常见的占位与指针值。它们不是 PII，打码只会制造噪声并让用户关掉工具。
// 归一化后比较：去掉空格、统一小写。
const LABELED_PLACEHOLDER_VALUES = new Set([
  "待定", "未定", "暂无", "暫無", "无", "無", "略", "不详", "不詳", "保密", "同上", "如上", "见上", "見上",
  "待补充", "待補充", "待确认", "待確認", "待填", "待填写", "待填寫", "见附件", "見附件", "见下", "見下",
  "详见合同", "詳見合同", "详见附件", "詳見附件", "见正文", "見正文", "另行通知", "面议", "面議",
  "n/a", "na", "tbd", "none", "null", "-", "--", "/", "无。", "無。",
]);

const LABELED_POINTER_PATTERN = /^(?:详见|詳見|参见|參見|见|見|另见|另見|同|如)[^\s]{0,8}$/u;

function isPlaceholderLabeledValue(value: string): boolean {
  const normalized = value.replace(/\s+/gu, "").toLowerCase();
  return (
    normalized.length === 0 ||
    LABELED_PLACEHOLDER_VALUES.has(normalized) ||
    LABELED_POINTER_PATTERN.test(normalized)
  );
}

// 机构名出现在人名字段里是误打码；出现在地址字段里可能是合法地址的一部分
// （"地址：华为技术有限公司总部"），所以这道守卫只对 person_name 生效。
function isOrganizationLabeledPerson(value: string): boolean {
  const compact = value.replace(/[\s·・]/gu, "");
  return (
    ORGANIZATION_MARKER_PATTERN.test(compact) || COMMON_ORGANIZATION_OR_PLACE_NAMES.has(compact)
  );
}

function isRejectedLabeledValue(kind: DetectionKind, value: string): boolean {
  if (isPlaceholderLabeledValue(value)) {
    return true;
  }
  if (kind !== "person_name") {
    return false;
  }
  return isOrganizationLabeledPerson(value) || looksLikeNonPersonValue(value);
}

// 只有空格分隔的标签字段（"微信 yx_12345"、"收件人 沈砚"）在中文聊天和粘贴的
// 表单里很常见，但空格是比冒号弱得多的证据：放开它而不校验值，"账号 已经注销"
// 这类正常句子就会被打码。所以弱分隔符要求值本身自证形态。
const ACCOUNT_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;

const WHITESPACE_SEPARATOR_KINDS = new Set<DetectionKind>([
  "account",
  "person_name",
  "bank_account",
  "labeled_identifier",
]);

const CLAUSE_END_CHARACTER = /^[，,。；;：:！？!、）)】\]\n\r]/u;

const LABELED_ACCOUNT_VALUE_PATTERNS: readonly RegExp[] = [
  /^@?[A-Za-z][A-Za-z0-9._-]{2,63}/u,
  /^@?[\p{Script=Han}]{1,8}[_@.-][A-Za-z0-9][A-Za-z0-9._-]{1,63}/u,
  /^@?\d{5,10}/u,
];

function boundLabeledAccountValue(value: string): string {
  for (const pattern of LABELED_ACCOUNT_VALUE_PATTERNS) {
    const match = pattern.exec(value);
    if (match !== null) {
      return match[0];
    }
  }
  return value;
}

/**
 * 空格分隔的人名值必须落在小句末尾。
 *
 * 这道限制是必需的。空格分隔的表单字段长这样：`收件人 沈砚，电话 138…`，值后面
 * 紧跟标点。而 `对接人 方案已确认`、`负责人 何时确认`、`申请人 于近期提交` 是散文，
 * 值后面跟的是动词——放开就会把 方案 / 何时 / 于近期 当人名打码。
 *
 * 代价是 conservative 档漏掉 `负责人 张三已经确认` 这类散文里的人名。这是有意的：
 * balanced 档的语义锚点路径本来就覆盖它，conservative 档就该保守。
 */
function isClauseFinal(input: string, end: number): boolean {
  let cursor = end;
  // 只跳过行内空白。换行本身就是小句结束，跳过它会把下一行的内容当成后续语境，
  // 让 "负责人 岑湛珩\n联系电话 …" 这种表单被误判为散文。
  while (cursor < input.length && /[ \t\u00a0·・]/u.test(input[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor >= input.length || CLAUSE_END_CHARACTER.test(input.slice(cursor));
}

/**
 * 空格分隔时，从 `valueStart` 处确定实际应打码的长度；返回 0 表示不接受。
 *
 * account 取第一个 token 并要求账号形态；person_name 交给姓名解析器定边界，
 * 并额外要求小句末尾。
 */
function whitespaceSeparatedValueLength(
  kind: DetectionKind,
  input: string,
  valueStart: number,
  candidate: string,
): number {
  if (kind === "account") {
    const token = candidate.split(/\s+/u)[0] ?? "";
    return ACCOUNT_HANDLE_PATTERN.test(token) && /[A-Za-z0-9]/u.test(token) ? token.length : 0;
  }
  if (kind === "bank_account") {
    const token = candidate.split(/\s+/u)[0] ?? "";
    return isValidBankAccountValue(token) ? token.length : 0;
  }
  if (kind === "person_name") {
    const parsed = parseChineseNameAt(input, valueStart);
    return parsed === null || !isClauseFinal(input, parsed.end) ? 0 : parsed.end - parsed.start;
  }
  if (kind === "labeled_identifier") {
    const token = candidate.split(/\s+/u)[0] ?? "";
    if (
      isDigitalInvoiceNumber(token) ||
      isMedicalRecordNumber(token) ||
      isIso3779Vin(token) ||
      isCourtCaseNumber(token)
    ) {
      return token.length;
    }
    return /^[A-Za-z][A-Za-z0-9._-]{2,47}$/u.test(token) && /\d/u.test(token) ? token.length : 0;
  }
  return 0;
}

function appendLabeledCandidates(
  candidates: Candidate[],
  view: DetectionText,
  labels: string,
  kind: DetectionKind,
  decision: RedactionDecision,
  isAccepted: (value: string) => boolean = () => true,
): void {
  const input = view.text;
  const allowsWhitespaceSeparator = WHITESPACE_SEPARATOR_KINDS.has(kind);
  const separator = allowsWhitespaceSeparator
    ? "(?:[:：=]|(?:是|为|叫)\\s*[:：]?|(?=\\s))"
    : "(?:[:：=]|(?:是|为|叫)\\s*[:：]?)";
  const matcher = new RegExp(
    `(${labelAlternation(labels)})\\s*${separator}\\s*([^，,；;。！？!\\n\\r]+)`,
    "giu",
  );
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input)) !== null) {
    const label = match[1].trim();
    const capturedValue = match[2];
    const normalizedRaw = capturedValue.trim();
    const leadingWhitespaceLength = capturedValue.length - capturedValue.trimStart().length;

    if (!normalizedRaw || normalizedRaw.length > MAX_LABELED_VALUE_LENGTH || normalizedRaw.startsWith("[[")) {
      continue;
    }

    const boundedAccountValue = kind === "account" ? boundLabeledAccountValue(normalizedRaw) : normalizedRaw;
    const acceptedValue = boundedAccountValue || normalizedRaw;

    if (isRejectedLabeledValue(kind, acceptedValue)) {
      continue;
    }

    if (!isAccepted(acceptedValue)) {
      continue;
    }

    const start = match.index + match[0].length - capturedValue.length + leadingWhitespaceLength;

    // 分隔符是纯空格时收紧：证据弱，值必须自证形态，且由解析器决定边界。
    const separatorText = match[0].slice(label.length, match[0].length - capturedValue.length);
    let value = acceptedValue;
    if (allowsWhitespaceSeparator && !/[:：=]|是|为|叫/u.test(separatorText)) {
      const length = whitespaceSeparatedValueLength(kind, input, start, acceptedValue);
      if (length === 0) {
        continue;
      }
      value = acceptedValue.slice(0, length);
    } else if (kind === "person_name") {
      // 冒号路径故意宽松，好让生僻姓、外文名和"演示联系人甲"这类占位人名也能打码。
      // 但"到下一个标点为止"会把整个小句吞掉：`候选人：沈砚的沟通记录在附件里`
      // 此前会整条打码。若值开头能解析出一个人名且它短于整段，就只取这个人名。
      const parsed = parseChineseNameAt(input, start);
      if (parsed !== null && parsed.end - parsed.start < acceptedValue.length) {
        value = acceptedValue.slice(0, parsed.end - parsed.start);
      }
    }

    const range = sourceRangeFor(view, start, start + value.length);
    if (range === null) {
      continue;
    }
    candidates.push({
      kind,
      decision,
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue(kind, value),
      label,
    });
  }
}

function appendPrivateDateCandidates(candidates: Candidate[], view: DetectionText): void {
  const matcher = new RegExp(
    `(${labelAlternation(PRIVATE_DATE_LABELS)})\\s*(?:[:：=]|(?:是|为|叫)\\s*[:：]?)\\s*([0-9]{4}(?:年|[-/.])[0-9]{1,2}(?:月|[-/.])[0-9]{1,2}(?:日)?|[0-9]{8})`,
    "giu",
  );
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(view.text)) !== null) {
    const value = match[2];
    if (!isValidPrivateDate(value)) {
      continue;
    }
    const start = match.index + match[0].length - value.length;
    const range = sourceRangeFor(view, start, start + value.length);
    if (range === null) {
      continue;
    }
    candidates.push({
      kind: "private_date",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("private_date", value),
      label: match[1].trim(),
      source: "structured",
    });
  }
}

function appendCustomCandidates(
  candidates: Candidate[],
  view: DetectionText,
  customTerms: readonly string[],
): void {
  // 自定义词必须与内置规则一样在归一化视图上匹配。否则「青岚<零宽空格>项目」
  // 这类混淆能绕过自定义词，而同样被混淆的手机号却会被拦下——自定义词往往是
  // 用户最敏感的业务字面量，不能是防护最弱的一环。
  const normalizedTerms = [
    ...new Set(
      customTerms
        .map((term) => createDetectionText(term).text.trim())
        .filter((term) => term.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);

  for (const term of normalizedTerms) {
    let cursor = view.text.indexOf(term);

    while (cursor !== -1) {
      const range = sourceRangeFor(view, cursor, cursor + term.length);
      if (range !== null) {
        candidates.push({
          kind: "custom_term",
          decision: "replace",
          start: range.start,
          end: range.end,
          raw: view.source.slice(range.start, range.end),
          normalized: term,
        });
      }
      cursor = view.text.indexOf(term, cursor + term.length);
    }
  }
}

/*
 * 规则与词表产出的语义候选在两档里都启用。
 *
 * 此前 conservative 档在这里整条早返回，于是**默认配置**（DEFAULT_ADVANCED_SETTINGS
 * 就是 conservative）完全检不出自由形式的人名和地址，只有带标签的字段能被打码。
 *
 * 量化过两种放开方式（ml/reports/generated/ts-baseline/conservative-{anchor-only,all}.txt）。
 * 只收锚词候选（evidence ≥ 0.82）那一档**在每个集上都更差，连精确率也更差**：
 * blind-probe 精确率 0.9578 vs 全收的 0.9661，sift 0.8661 vs 0.8782。原因是被排除的
 * person_role(0.76) 与 address_structure(0.78) 恰恰是最精确的那批——blind-probe 776/776、
 * semantic-v2 3653/3653 全为精确跨度。所以这里不设证据门槛。
 *
 * 全收之后 conservative 档相对自身基线的变化（ts-baseline/current.txt）：
 *   hidden-redteam（对规则引擎仍是真盲测）F1 0.7237→0.8266、精确率 0.9864→0.9891、
 *                                        charLeak 0.5556→0.4511、完全漏出 1.0000→0.8120
 *   blind-probe    F1 0.6049→0.7387、精确率 0.9784→0.9661、charLeak 0.6065→0.5251
 *   sift-gold      F1 0.5783→0.6502、精确率 0.8704→0.8810、charLeak 0.3879→0.3570
 *   semantic-v2    F1 0.1968→0.7459、精确率 1.0000→1.0000、charLeak 0.5710→0.3441
 *   openpii        F1 0.0822→0.1443、精确率 0.1643→0.2188、charLeak 0.9429→0.9216
 * 负例代价：org-negatives(1000 真实机构名) 0.0000→0.0000、blind-probe(1065) 0.0000→0.0000、
 * semantic-v2 0.0000→0.0000、hidden-redteam 0.0275 不变；只有 sift 污染 0.0266→0.0286，
 * 新增的 2 行（1014 条无实体行里）是 `联系王老板` 与 `家在 宁波鄞州四明中路`——一个是
 * 真实人物指称、一个是真实路名，都是 gold 未标，不是误报。
 *
 * 除此之外只有 blind-probe 精确率 0.9784→0.9661 低于基线；其余每个集每项指标都改善。
 *
 * 这些候选一律带 policy:"confirm"，走的是问用户而不是静默替换——误判成本是一次点击，
 * 漏判成本是泄漏。
 *
 * 两档的区别因此移到 appendSemanticCandidates：conservative 只用内置规则与词表，
 * balanced 还接外部/模型 provider（并对超长草稿分窗扫描）。神经模型接进来之后，
 * 这个区别会重新变得实质。
 */

function appendContextCandidates(candidates: Candidate[], view: DetectionText): void {
  const input = view.text;
  for (const candidate of findHighSignalSemanticCandidates(input, getCodeRanges(input))) {
    const range = sourceRangeFor(view, candidate.start, candidate.end);
    if (range === null) {
      continue;
    }
    const normalizedRaw = input.slice(candidate.start, candidate.end);
    candidates.push({
      kind: candidate.kind,
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue(candidate.kind, normalizedRaw),
      policy: "confirm",
      source: "context",
    });
  }
  appendContextualAccountCandidates(candidates, view);
}

function isValidSemanticHint(
  input: string,
  hint: unknown,
): hint is SemanticHint {
  if (typeof hint !== "object" || hint === null) {
    return false;
  }

  const candidate = hint as Record<string, unknown>;
  return (
    (
      candidate.kind === "person_name" ||
      candidate.kind === "address" ||
      candidate.kind === "account" ||
      candidate.kind === "phone" ||
      candidate.kind === "email" ||
      candidate.kind === "china_id" ||
      candidate.kind === "bank_card" ||
      candidate.kind === "license_plate" ||
      candidate.kind === "passport" ||
      candidate.kind === "private_date" ||
      candidate.kind === "bank_account" ||
      candidate.kind === "credential" ||
      candidate.kind === "api_key" ||
      candidate.kind === "access_token" ||
      candidate.kind === "labeled_identifier" ||
      candidate.kind === "ipv4" ||
      candidate.kind === "mac_address"
    ) &&
    typeof candidate.start === "number" &&
    typeof candidate.end === "number" &&
    Number.isInteger(candidate.start) &&
    Number.isInteger(candidate.end) &&
    candidate.start >= 0 &&
    candidate.end > candidate.start &&
    candidate.end <= input.length &&
    typeof candidate.score === "number" &&
    Number.isFinite(candidate.score) &&
    candidate.requiresConfirmation === true
  );
}

const PHONE_CONTEXT_PATTERN = /手机|电话|拨打|拨|致电|联系(?:方式|电话)?|来电|回电|号码/iu;
const EMAIL_CONTEXT_PATTERN = /邮箱|邮件|mail|e-?mail|电子信箱|联系(?:方式|邮箱)?/iu;
const ID_CONTEXT_PATTERN = /身份证|居民身份证|证件(?:号码|号)?|身份信息|实名(?:认证)?|认证信息/iu;
const CARD_CONTEXT_PATTERN = /银行卡|信用卡|卡号|收款|转账|付款|支付|打款|汇款|转入|扣款|充值|bank\s*card|card\s*(?:no|number)?/iu;
const PRIVATE_DATE_CONTEXT_PATTERN = /出生|生日|入职(?:日期|时间)?|结婚(?:日期|时间)?|纪念日|个人日期|date\s*of\s*birth|\bdob\b/iu;
const BANK_ACCOUNT_CONTEXT_PATTERN = /银行账户|银行账号|对公账户|对公账号|收款账户|收款账号|结算账户|结算账号|开户账号|银行卡账户|收款信息|打款账户/iu;
const CREDENTIAL_CONTEXT_PATTERN = /凭据|口令|密码|密钥|登录信息|鉴权信息|secret|credential|pass(?:word|code)?|private\s*key/iu;
const API_KEY_CONTEXT_PATTERN = /api\s*(?:key|密钥)|应用密钥|云服务密钥|client[_ -]?secret|api[_ -]?key|apikey/iu;
const ACCESS_TOKEN_CONTEXT_PATTERN = /access\s*token|访问令牌|令牌|token|bearer|authorization|请求头|鉴权/iu;
const LABELED_IDENTIFIER_CONTEXT_PATTERN = /(?:OA|员工|工号|人事|薪资|医疗|病历|医保|车架|VIN|发动机|社保|公积金|合同|归档)/iu;
const NETWORK_CONTEXT_PATTERN = /服务器|主机|内网|公网|网卡|以太网|物理地址|IP(?:地址)?|MAC(?:地址)?/iu;
const LICENSE_PLATE_PATTERN = /^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][A-Z0-9]{5,6}$/u;
const CHINA_PASSPORT_PATTERN = /^(?:E[A-L]?\d{7,8}|G\d{8}|[DSP]E?\d{7,8})$/u;
const TRAVEL_DOCUMENT_PATTERN = /^[A-Z]{1,2}\d{7,8}$/u;
const TRAVEL_DOCUMENT_CONTEXT_PATTERN = /护照|旅行证|旅行證|通行证|通行證|证件|證件|访客卡|訪客卡|门禁|門禁/iu;
const EXPLICIT_TECHNICAL_STRUCTURED_CONTEXT_PATTERN = /(?:代码(?:示例|片段)|变量(?:占位|名)|占位(?:符|字符串)?|构建夹具|测试(?:数据|样例|夹具)|固定(?:占位|样例)|配置(?:样例|模板)|服务任务标识|系统标识|字段名|内部代号|\bfixture\b|\bcache[-_ ]?(?:warmup|key)\b|\btenant[-_ ]?(?:seed|id)\b|\bstage[-_ ]?(?:qa|prod)\b|\bsearch[-_ ]?index\b|\btopic[-_ ]?consumer\b)/iu;
const NEGATED_TECHNICAL_STRUCTURED_CONTEXT_PATTERN = new RegExp(
  `(?:并不是|不是|并非|不属于)\\s*${EXPLICIT_TECHNICAL_STRUCTURED_CONTEXT_PATTERN.source}`,
  "giu",
);
const CHINESE_PHONE_DIGITS: Readonly<Record<string, string>> = {
  "零": "0",
  "〇": "0",
  "○": "0",
  "一": "1",
  "二": "2",
  "三": "3",
  "四": "4",
  "五": "5",
  "六": "6",
  "七": "7",
  "八": "8",
  "九": "9",
  "幺": "1",
};

function semanticContext(input: string, start: number, end: number): string {
  return `${normalizeDashVariants(input.slice(Math.max(0, start - 32), start))} ${normalizeDashVariants(input.slice(end, Math.min(input.length, end + 32)))}`;
}

function isExplicitTechnicalStructuredValue(input: string, start: number, end: number): boolean {
  const clauseBoundary = /[，,；;。！？!?\r\n]/u;
  const before = normalizeDashVariants(input.slice(Math.max(0, start - 32), start)).split(clauseBoundary).at(-1) ?? "";
  const after = normalizeDashVariants(input.slice(end, Math.min(input.length, end + 32))).split(clauseBoundary)[0] ?? "";
  const context = `${before} ${after}`.replace(NEGATED_TECHNICAL_STRUCTURED_CONTEXT_PATTERN, "");
  return EXPLICIT_TECHNICAL_STRUCTURED_CONTEXT_PATTERN.test(context);
}

function compactSemanticNumber(raw: string): string {
  return normalizeDashVariants(raw).replace(/[\s\-·・]/gu, "");
}

function normalizeChineseNumber(raw: string, allowIdentityCheckDigit = false): string | null {
  const compact = compactSemanticNumber(raw).replace(/[()（）]/gu, "");
  let normalized = "";
  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index] as string;
    if (/\d/u.test(character)) {
      normalized += character;
      continue;
    }
    if (allowIdentityCheckDigit && index === compact.length - 1 && /^[Xx]$/u.test(character)) {
      normalized += "X";
      continue;
    }
    const digit = CHINESE_PHONE_DIGITS[character];
    if (digit === undefined) {
      return null;
    }
    normalized += digit;
  }
  return normalized;
}

function appendDictatedPhoneCandidates(candidates: Candidate[], view: DetectionText): void {
  const matcher = /[0-9零〇○一二三四五六七八九幺](?:[ \t-]*[0-9零〇○一二三四五六七八九幺])*/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(view.text)) !== null) {
    const raw = match[0];
    if (!/[零〇○一二三四五六七八九幺]/u.test(raw)) {
      continue;
    }
    const end = match.index + raw.length;
    const context = semanticContext(view.text, match.index, end);
    const digits = normalizeChineseNumber(raw);
    if (
      digits === null || !/^1[3-9]\d{9}$/u.test(digits) ||
      !/手机|电话|拨打|回拨|致电|来电|回电/u.test(context) ||
      isExplicitTechnicalStructuredValue(view.text, match.index, end) ||
      /[A-Za-z0-9_]/u.test(view.text[match.index - 1] ?? "") ||
      /[A-Za-z0-9_]/u.test(view.text[end] ?? "")
    ) {
      continue;
    }
    const range = sourceRangeFor(view, match.index, end);
    if (range !== null) {
      candidates.push({
        kind: "phone", decision: "replace", source: "structured",
        start: range.start, end: range.end,
        raw: view.source.slice(range.start, range.end), normalized: digits,
      });
    }
  }
}

function normalizeObfuscatedEmail(raw: string): string {
  return normalizeDashVariants(raw)
    .trim()
    .replace(/\s*(?:@|艾特)\s*/gu, "@")
    .replace(/(?:_at_|\s*\[\s*at\s*\]\s*|\s*[（(]\s*at\s*[）)]|\s+\bat\b\s+)/giu, "@")
    .replace(/\s*(?:\.|点)\s*/gu, ".")
    .replace(/(?:_dot_|\s*\[\s*dot\s*\]\s*|\s*[（(]\s*dot\s*[）)]|\s+\bdot\b\s+)/giu, ".")
    .replace(/\s+/gu, "");
}

function isUsableStructuredSemanticHint(
  input: string,
  kind: Extract<SemanticHint["kind"],
    | "phone"
    | "email"
    | "china_id"
    | "bank_card"
    | "license_plate"
    | "passport"
    | "private_date"
    | "bank_account"
    | "credential"
    | "api_key"
    | "access_token"
    | "labeled_identifier"
    | "ipv4"
    | "mac_address"
  >,
  start: number,
  end: number,
): boolean {
  const raw = input.slice(start, end).trim();
  const context = semanticContext(input, start, end);
  if (isExplicitTechnicalStructuredValue(input, start, end)) {
    return false;
  }

  switch (kind) {
    case "phone": {
      const digits = normalizeChineseNumber(raw);
      return digits !== null && /^1[3-9]\d{9}$/u.test(digits);
    }
    case "email": {
      const normalized = normalizeObfuscatedEmail(raw);
      const [local, domain] = normalized.split("@", 2);
      return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{3,}$/u.test(local ?? "") &&
        /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(domain ?? "");
    }
    case "china_id": {
      const compact = normalizeChineseNumber(raw, true);
      return compact !== null && (
        isValidChinaResidentId(compact) ||
        (ID_CONTEXT_PATTERN.test(context) && isPlausibleChinaId(compact))
      );
    }
    case "bank_card": {
      const compact = normalizeChineseNumber(raw);
      if (compact === null || !/^\d{13,19}$/u.test(compact) || isIdentityNumberContext(input, start, end)) {
        return false;
      }
      return passesLuhnCheck(compact) ||
        (!isExplicitlyNonBankCardContext(input, start, end) &&
          CARD_CONTEXT_PATTERN.test(context) &&
          /^62\d{14,17}$/u.test(compact));
    }
    case "license_plate":
      return LICENSE_PLATE_PATTERN.test(compactSemanticNumber(raw).toUpperCase());
    case "passport": {
      const compact = compactSemanticNumber(raw).toUpperCase();
      return CHINA_PASSPORT_PATTERN.test(compact) ||
        (TRAVEL_DOCUMENT_CONTEXT_PATTERN.test(context) && TRAVEL_DOCUMENT_PATTERN.test(compact));
    }
    case "private_date":
      return isValidPrivateDate(raw) && PRIVATE_DATE_CONTEXT_PATTERN.test(context);
    case "bank_account":
      return isValidBankAccountValue(raw) && BANK_ACCOUNT_CONTEXT_PATTERN.test(context);
    case "credential": {
      const normalized = normalizeDashVariants(raw).trim();
      return normalized.length >= 6 &&
        normalized.length <= MAX_CREDENTIAL_VALUE_LENGTH &&
        /[A-Za-z0-9\u4e00-\u9fff]/u.test(normalized) &&
        CREDENTIAL_CONTEXT_PATTERN.test(context);
    }
    case "api_key": {
      const normalized = normalizeDashVariants(raw).trim();
      return normalized.length >= 8 &&
        normalized.length <= 512 &&
        /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,}$/u.test(normalized) &&
        (API_KEY_CONTEXT_PATTERN.test(context) || /^(?:sk-|sk_live_|key_live_|AIza|AKIA|gh[pousr]_)/iu.test(normalized));
    }
    case "access_token": {
      const normalized = normalizeDashVariants(raw).trim();
      return normalized.length >= 8 &&
        normalized.length <= 4096 &&
        /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,}$/u.test(normalized) &&
        ACCESS_TOKEN_CONTEXT_PATTERN.test(context);
    }
    case "labeled_identifier": {
      const normalized = normalizeDashVariants(raw).trim();
      return normalized.length >= 2 &&
        normalized.length <= MAX_LABELED_VALUE_LENGTH &&
        LABELED_IDENTIFIER_CONTEXT_PATTERN.test(context);
    }
    case "ipv4":
      return isIpv4Address(raw.replace(/\s+/gu, "")) && NETWORK_CONTEXT_PATTERN.test(context);
    case "mac_address":
      return isValidMacAddress(raw.replace(/\s+/gu, "")) && NETWORK_CONTEXT_PATTERN.test(context);
  }
}

function hasExplicitPersonalAccountAssignment(input: string, start: number, end: number): boolean {
  return /(?:联系人|对接人|收件人|负责人|本人|私聊|聊天|联系(?:人|方式)?)[\s\S]{0,24}(?:账号|帐号|聊天号|别名|ID)\s*(?:记为|为|是|[:：=])/u.test(
    input.slice(Math.max(0, start - 32), Math.min(input.length, end + 32)),
  );
}

const ACCOUNT_NEGATION_CONTEXT_PATTERN = /(?:不是|并非|不要|不应|不能|无需|勿|不代表|不属于|不含|非)[\s\S]{0,18}(?:账号|帐号|聊天号|联系人|姓名|昵称|通讯入口|通讯账号|私人账号|个人账号|私聊对象|聊天对象|服务任务标识|组件代号)/iu;
const ACCOUNT_TECHNICAL_CONTEXT_PATTERN = /(?:代码(?:示例|片段)?|变量(?:占位|名)?|占位(?:符|字符串)?|日志(?:里|中|中的)?|调试|测试(?:数据|样例)?|实验批次|服务任务标识|系统标识|字段名|内部代号|内部样本|样本编号|模型卡|pipeline|rollout|audit|编号|模拟租户|测试租户|租户标识|fixture|trace(?:[-_ ]?span)?|cache(?:[-_ ]?(?:warmup|key))?|tenant(?:[-_ ]?(?:seed|id))?|stage(?:[-_ ]?(?:qa|prod))?|gateway|search[-_ ]?index|topic[-_ ]?consumer)/iu;

function hasTechnicalNegativeAccountContext(context: string): boolean {
  return ACCOUNT_NEGATION_CONTEXT_PATTERN.test(context) || ACCOUNT_TECHNICAL_CONTEXT_PATTERN.test(context);
}

function isUsableAccountSemanticHint(
  input: string,
  start: number,
  end: number,
  allowStructuredMixedHandle = false,
): boolean {
  const raw = input.slice(start, end).trim();
  const normalizedRaw = normalizeDashVariants(raw);
  const compact = normalizedRaw.replace(/[\s._-]/gu, "").toLowerCase();
  if (/^1[3-9]\d{9}$/u.test(compact) || /^62\d{14,17}$/u.test(compact) || /^(?:e|g)\d{8}$/iu.test(compact)) {
    return false;
  }
  const context = normalizeDashVariants(input.slice(Math.max(0, start - 32), Math.min(input.length, end + 32)));
  const explicitPersonalAssignment = hasExplicitPersonalAccountAssignment(input, start, end);
  const hasInterpersonalAccountCue = /转发给|发给|收件(?:人|地址)?|在线号|线上入口|入口|沟通渠道|联系渠道|交接(?:给|时|用)?|私下(?:沟通|联系)?|会话|回执|回單|回单|指向/iu.test(context);
  const hasAccountCue = /微信|微\s*信|qq|账号|帐号|昵称|用户名|用户\s*id|user(?:name|_?id)?|login|别名|alias|handle|搜|搜索|私聊|添加|加|加我|先加|加好友|用|通过|留言|群成员|成员昵称|备用|常用|联系方式|站内|应用里|应用内|app里|app内/iu.test(context) || hasInterpersonalAccountCue;
  const hasStrongAccountCue = /微信|微\s*信|qq|账号|帐号|昵称|用户名|用户\s*id|user(?:name|_?id)?|login|别名|alias|handle|抖音(?:号)?|快手(?:号)?|小红书|微博|telegram|tg|discord|搜|搜索|指向|会话入口|沟通渠道|联系渠道|加(?:我|好友)?|用|通过|私聊|群成员|成员昵称|联系方式|站内|应用里|应用内|app里|app内/iu.test(context) || hasInterpersonalAccountCue;
  const hasPersonalCue = /我的|本人|私聊|加我|找我|个人(?:微信|账号|ID)/iu.test(context);
  const hasNonAccountCue = /订单|工单|流水|交易|版本|金额|验证码|端口|邮编|项目密钥|访问令牌|token|password|密码|密钥|凭证/iu.test(context);
  const isRejectedProse = /^(?:已(?:经)?(?:注销|停用|冻结|失效|删除)|无法登录|不要(?:写|填)|稍后(?:再发|发送)|待(?:定|补充|确认)|无|没有|未知|不详|暂无|见附件|详见合同)$/u.test(normalizedRaw.replace(/\s+/gu, ""));
  const hasCjk = /[\u3400-\u9fff]/u.test(normalizedRaw);
  if (ACCOUNT_NEGATION_CONTEXT_PATTERN.test(context) && !explicitPersonalAssignment) {
    return false;
  }
  const hasFieldlessOfficeSearchCue = /(?:没有|无|缺少)字段名[\s\S]{0,12}(?:先?搜|搜索|找|添加)/iu.test(context);
  if (hasTechnicalNegativeAccountContext(context) && !hasPersonalCue && !explicitPersonalAssignment && !hasFieldlessOfficeSearchCue) {
    return false;
  }
  if ((hasNonAccountCue && !hasStrongAccountCue && !explicitPersonalAssignment) || isRejectedProse) {
    return false;
  }
  if (compact.length < 4 && !(hasCjk && compact.length >= 2 && hasStrongAccountCue)) {
    return false;
  }
  if (/^\d+$/u.test(compact)) {
    return hasAccountCue && /^\d{5,10}$/u.test(compact);
  }
  const isKnownAlias = /^(?:wxid_|u-|id-|work_)/iu.test(normalizedRaw);
  const hasImmediateAliasVerb = /(?:加|搜|找|用)\s*$/u.test(input.slice(Math.max(0, start - 12), start));
  if (
    isCommonEnglishAccountWord(normalizedRaw) &&
    !explicitPersonalAssignment &&
    !hasImmediateAliasVerb
  ) {
    return false;
  }
  const isLatinHandle = /^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$/u.test(normalizedRaw) && /[A-Za-z]/u.test(normalizedRaw);
  const isChineseOrMixedHandle = /^[\u3400-\u9fffA-Za-z0-9][\u3400-\u9fffA-Za-z0-9._@-]{1,31}$/u.test(normalizedRaw) && hasCjk;
  const hasStructuredMixedHandle =
    /[A-Za-z0-9]/u.test(normalizedRaw) &&
    /[_@.-]/u.test(normalizedRaw) &&
    /\d/u.test(normalizedRaw) &&
    (hasCjk || /[A-Za-z]/u.test(normalizedRaw));
  if (
    !hasAccountCue &&
    !hasStrongAccountCue &&
    !explicitPersonalAssignment &&
    !(isKnownAlias && hasImmediateAliasVerb) &&
    !(allowStructuredMixedHandle && hasStructuredMixedHandle)
  ) {
    return false;
  }
  if (isChineseOrMixedHandle) {
    return hasStrongAccountCue || (allowStructuredMixedHandle && hasStructuredMixedHandle);
  }
  return isLatinHandle || explicitPersonalAssignment || (allowStructuredMixedHandle && hasStructuredMixedHandle);
}

const ACCOUNT_ALIAS_CONTEXT_PATTERN = /(?<![A-Za-z0-9._-])[A-Za-z][A-Za-z0-9._-]{3,63}(?![A-Za-z0-9._-])/gu;
const ACCOUNT_CONTEXT_EXCLUSIONS = /(?:api|access|refresh|bearer|secret|token|password|passwd|key|version|commit|branch|build|port|order|pipeline|rollout|audit|fixture|model[-_ ]?card|sample|订单|版本|工单|流水|交易|验证码|端口|项目|编号|样本|内部代号|系统标识)/iu;
const COMMON_ENGLISH_ACCOUNT_WORDS = new Set([
  "account",
  "address",
  "admin",
  "alias",
  "branch",
  "channel",
  "client",
  "contact",
  "demo",
  "destination",
  "email",
  "english",
  "example",
  "follow",
  "handle",
  "handoff",
  "login",
  "message",
  "name",
  "owner",
  "password",
  "phone",
  "project",
  "ready",
  "reply",
  "sample",
  "server",
  "service",
  "source",
  "status",
  "target",
  "text",
  "token",
  "user",
  "username",
  "version",
]);

function isCommonEnglishAccountWord(value: string): boolean {
  const normalized = normalizeDashVariants(value).toLowerCase();
  return /^[a-z]{3,32}$/u.test(normalized) && COMMON_ENGLISH_ACCOUNT_WORDS.has(normalized);
}

const CONTEXTUAL_ACCOUNT_VALUE = "@?(?:[\\p{Script=Han}]{1,8}(?:[_@.-][A-Za-z0-9][A-Za-z0-9._-]{1,63}|[0-9]{1,10})|[A-Za-z][A-Za-z0-9._-]{2,63}|[0-9]{5,10})";
const CONTEXTUAL_ACCOUNT_MATCHERS: readonly RegExp[] = [
  new RegExp(`(?:账号|帐号|在线号|联系号|聊天号|别名|昵称|handle|alias|user(?:name|_?id)?)\\s*(?:仍?是|为|叫|改成|改为|换成|记为|[:：=])\\s*(${CONTEXTUAL_ACCOUNT_VALUE})`, "giu"),
  new RegExp(`(?:先?搜|搜索|加|添加|找|指向|用|通过|发给|转给|交给)\\s*(${CONTEXTUAL_ACCOUNT_VALUE})`, "giu"),
  new RegExp(`(?:会话入口|线上入口|沟通渠道|联系渠道)\\s*(?:改成|换成|是|为|[:：=])\\s*(${CONTEXTUAL_ACCOUNT_VALUE})`, "giu"),
  new RegExp(`(?:对接窗口|聊天窗口|工作窗口|联系窗口|账号入口|沟通入口)\\s*(?:改成|换成|切到|转到)\\s*(${CONTEXTUAL_ACCOUNT_VALUE})`, "giu"),
  new RegExp(`(?:完整账号|另有账号|还有账号|另一个账号|备用账号)\\s*(?:仍是|是|为|叫|[:：=])?\\s*(${CONTEXTUAL_ACCOUNT_VALUE})`, "giu"),
  new RegExp(`(?:出现|出现了|看到|记下|显示)\\s*(${CONTEXTUAL_ACCOUNT_VALUE})(?=\\s*(?:[，,。；;]|它|表示|就是))`, "giu"),
];

function appendExplicitContextualAccountCandidates(candidates: Candidate[], view: DetectionText): void {
  const input = view.text;
  const codeRanges = getCodeRanges(input);
  for (const pattern of CONTEXTUAL_ACCOUNT_MATCHERS) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(input)) !== null) {
      const value = match[1] ?? "";
      const valueOffset = match[0].lastIndexOf(value);
      if (valueOffset < 0) {
        continue;
      }
      const start = match.index + valueOffset;
      const end = start + value.length;
      if (overlapsTextRange(start, end, codeRanges)) {
        continue;
      }
      if (!isUsableAccountSemanticHint(input, start, end, true)) {
        continue;
      }
      const range = sourceRangeFor(view, start, end);
      if (
        range === null ||
        candidates.some((candidate) => candidate.kind === "account" && candidate.start < range.end && range.start < candidate.end)
      ) {
        continue;
      }
      candidates.push({
        kind: "account",
        decision: "replace",
        start: range.start,
        end: range.end,
        raw: view.source.slice(range.start, range.end),
        normalized: normalizeValue("account", value),
        policy: "confirm",
        source: "context",
      });
    }
  }
}

function appendContextualAccountCandidates(candidates: Candidate[], view: DetectionText): void {
  const input = view.text;
  const codeRanges = getCodeRanges(input);
  appendExplicitContextualAccountCandidates(candidates, view);
  const matcher = new RegExp(ACCOUNT_ALIAS_CONTEXT_PATTERN.source, ACCOUNT_ALIAS_CONTEXT_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(input)) !== null) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const mentionStart = input[start - 1] === "@" ? start - 1 : start;
    const nearby = input.slice(Math.max(0, start - 40), Math.min(input.length, end + 40));
    if (
      overlapsTextRange(start, end, codeRanges) ||
      (ACCOUNT_CONTEXT_EXCLUSIONS.test(nearby) && !hasExplicitPersonalAccountAssignment(input, start, end)) ||
      !isUsableAccountSemanticHint(input, start, end)
    ) {
      continue;
    }
    const range = sourceRangeFor(view, mentionStart, end);
    if (
      range === null ||
      candidates.some(
        (candidate) => candidate.kind === "account" && candidate.start < range.end && range.start < candidate.end,
      )
    ) {
      continue;
    }
    candidates.push({
      kind: "account",
      decision: "replace",
      start: range.start,
      end: range.end,
      raw: view.source.slice(range.start, range.end),
      normalized: normalizeValue("account", raw),
      policy: "confirm",
      source: "context",
    });
  }
}

function appendSemanticCandidates(
  candidates: Candidate[],
  input: string,
  profile: DetectionProfile,
  provider: SemanticReviewProvider,
): void {
  if (profile !== "balanced") {
    return;
  }

  const codeRanges = getCodeRanges(input);
  for (const hint of provider.review(input)) {
    if (!isValidSemanticHint(input, hint) || overlapsTextRange(hint.start, hint.end, codeRanges)) {
      continue;
    }

    let effectiveKind = hint.kind;
    if (hint.kind === "account" && !isUsableAccountSemanticHint(input, hint.start, hint.end, true)) {
      continue;
    }
    if (hint.kind === "phone" && !isUsableStructuredSemanticHint(input, hint.kind, hint.start, hint.end)) {
      if (!isUsableAccountSemanticHint(input, hint.start, hint.end, true)) {
        continue;
      }
      effectiveKind = "account";
    } else if (
      hint.kind === "email" ||
      hint.kind === "china_id" ||
      hint.kind === "bank_card" ||
      hint.kind === "license_plate" ||
      hint.kind === "passport" ||
      hint.kind === "private_date" ||
      hint.kind === "bank_account" ||
      hint.kind === "credential" ||
      hint.kind === "api_key" ||
      hint.kind === "access_token" ||
      hint.kind === "labeled_identifier" ||
      hint.kind === "ipv4" ||
      hint.kind === "mac_address"
    ) {
      if (!isUsableStructuredSemanticHint(input, hint.kind, hint.start, hint.end)) {
        continue;
      }
    }
    const original = input.slice(hint.start, hint.end);
    const raw = original.trim();
    const leadingWhitespaceLength = original.length - original.trimStart().length;
    if (raw.length === 0) {
      continue;
    }

    const candidate: Candidate = {
      kind: effectiveKind,
      decision: "replace",
      start: hint.start + leadingWhitespaceLength,
      end: hint.start + leadingWhitespaceLength + raw.length,
      raw,
      normalized: normalizeValue(effectiveKind, raw),
      policy: "confirm",
      source: "semantic",
    };
    if (hint.kind === "china_id") {
      const normalizedId = normalizeChineseNumber(raw, true);
      if (normalizedId !== null && isValidChinaResidentId(normalizedId)) {
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const existing = candidates[index];
          if (
            existing?.kind === "phone" &&
            existing.source === "structured" &&
            candidate.start <= existing.start &&
            existing.end <= candidate.end
          ) {
            candidates.splice(index, 1);
          }
        }
      }
    }
    const overlapsHighConfidenceCandidate = candidates.some(
      (existing) => existing.source !== "context" && existing.source !== "semantic" && overlaps(existing, candidate),
    );
    if (!overlapsHighConfidenceCandidate) {
      // A model-confirmed structured value can contain Latin fragments that the weaker account
      // context pass reports independently (for example, `demo_user at example dot invalid`).
      // Once the whole span passes the stricter email/card/ID gate, keep the whole typed value
      // and drop only those overlapping account guesses. Explicit rules and user terms remain.
      if (effectiveKind !== "person_name" && effectiveKind !== "address" && effectiveKind !== "account") {
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const existing = candidates[index];
          if (existing?.source === "context" && existing.kind === "account" && overlaps(existing, candidate)) {
            candidates.splice(index, 1);
          }
        }
      }
      candidates.push(candidate);
    }
  }
}

function overlaps(left: Candidate, right: Candidate): boolean {
  return left.start < right.end && right.start < left.end;
}

function candidateActionRank(candidate: Pick<Candidate, "decision" | "policy">): number {
  if (candidate.policy === "block" || (candidate.decision === "block" && candidate.policy === undefined)) {
    return 3;
  }
  if (candidate.policy === "confirm") {
    return 2;
  }
  return 1;
}

function isInferredCandidate(candidate: Candidate): boolean {
  return candidate.source === "semantic" ||
    ((candidate.kind === "person_name" || candidate.kind === "address" || candidate.kind === "account") &&
      candidate.source === "context");
}

function selectCandidates(candidates: Candidate[]): Candidate[] {
  const ordered = [...candidates].sort((left, right) => {
    // block 最先：拦下比替换更强的安全动作，不能被别的候选顶掉。
    const blockOrder = Number(candidateActionRank(right) === 3) - Number(candidateActionRank(left) === 3);
    if (blockOrder !== 0) {
      return blockOrder;
    }

    // 显式证据压过推断。同一段文本上，自定义词条和带标签字段一定比"靠上下文猜出来的"
    // 更可信，而且能给出更好的处理：直接替换、并把标签记进 finding。
    //
    // 少了这一条，推断候选会仅仅因为 policy 是 "confirm"（rank 2 > replace 的 1）就把
    // 显式候选挤掉——用户配的 `张三` 会得到 [[PERSON_001]] 而不是 [[CUSTOM_001]]，
    // `家庭住址：…` 会丢掉标签并退化成需要确认。conservative 档此前不产语义候选，
    // 这个错误的优先级一直被掩盖着。
    const inferredOrder = Number(isInferredCandidate(left)) - Number(isInferredCandidate(right));
    if (inferredOrder !== 0) {
      return inferredOrder;
    }

    const actionOrder = candidateActionRank(right) - candidateActionRank(left);

    if (actionOrder !== 0) {
      return actionOrder;
    }

    const decisionOrder = Number(right.decision === "block") - Number(left.decision === "block");

    if (decisionOrder !== 0) {
      return decisionOrder;
    }

    // Explicit deterministic matches (which have no provenance marker) still outrank
    // inferred context. The context-over-semantic preference applies only when both are
    // inferred candidates for the same overlapping value class.
    const sourceRank = (candidate: Pick<Candidate, "source">): number => candidate.source === "structured"
      ? 3
      : candidate.source === undefined
        ? 2
        : candidate.source === "context"
          ? 1
          : 0;
    const sourceOrder = sourceRank(right) - sourceRank(left);
    if (sourceOrder !== 0) {
      return sourceOrder;
    }

    if (left.start !== right.start) {
      return left.start - right.start;
    }

    const lengthOrder = right.end - right.start - (left.end - left.start);

    if (lengthOrder !== 0) {
      return lengthOrder;
    }

    return KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
  });
  const selected: Candidate[] = [];

  for (const candidate of ordered) {
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((selected[middle]?.start ?? 0) < candidate.start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const previous = selected[low - 1];
    const next = selected[low];
    if (!((previous !== undefined && overlaps(previous, candidate)) || (next !== undefined && overlaps(next, candidate)))) {
      selected.splice(low, 0, candidate);
    }
  }

  return selected;
}

function applyCategoryPolicies(
  candidates: readonly Candidate[],
  categoryPolicies: readonly CategoryPolicyEntry[],
): Candidate[] {
  const policyByKind = new Map(categoryPolicies.map((policy) => [policy.kind, policy.action]));

  return candidates.map((candidate) => {
    const policy = policyByKind.get(candidate.kind);
    if (policy === undefined) {
      return candidate;
    }

    if (candidate.policy === "confirm" && policy === "replace") {
      return candidate;
    }

    return {
      ...candidate,
      decision: policy === "replace" ? "replace" : "block",
      policy,
    };
  });
}

function summarizeCandidates(candidates: readonly Candidate[]): RedactionFinding[] {
  const findings = new Map<DetectionKind, RedactionFinding>();

  for (const candidate of candidates) {
    const existing = findings.get(candidate.kind);

    if (existing) {
      existing.count += 1;
      if (candidate.label !== undefined && !(existing.labels ?? []).includes(candidate.label)) {
        existing.labels = [...(existing.labels ?? []), candidate.label];
      }
      if (candidate.warning !== undefined) {
        existing.warning = candidate.warning;
      }
      if (isInferredCandidate(candidate)) {
        existing.inferred = true;
      }
      if (candidateActionRank(candidate) > candidateActionRank(existing)) {
        existing.decision = candidate.decision;
        if (candidate.policy !== undefined) {
          existing.policy = candidate.policy;
        } else {
          delete existing.policy;
        }
      }
      continue;
    }

    const finding: RedactionFinding = {
      kind: candidate.kind,
      decision: candidate.decision,
      count: 1,
    };
    if (candidate.label !== undefined) {
      finding.labels = [candidate.label];
    }
    if (isInferredCandidate(candidate)) {
      finding.inferred = true;
    }
    if (candidate.policy !== undefined) {
      finding.policy = candidate.policy;
    }
    if (candidate.warning !== undefined) {
      finding.warning = candidate.warning;
    }
    findings.set(candidate.kind, finding);
  }

  return [...findings.values()];
}

function replaceCandidates(
  input: string,
  candidates: readonly Candidate[],
  sessionTokenMap: SessionTokenMap,
  replacementStyle: ReplacementStyle,
): string {
  let cursor = 0;
  let output = "";

  for (const candidate of candidates) {
    output += input.slice(cursor, candidate.start);
    const original = input.slice(candidate.start, candidate.end);
    const token = sessionTokenMap.getOrCreate(
      candidate.kind,
      candidate.normalized,
      candidate.warning === "credential_too_long" ? "原值过长，未在会话映射中保留" : original,
    );
    output += formatReplacement(candidate, token, original, replacementStyle);
    cursor = candidate.end;
  }

  return output + input.slice(cursor);
}

function sequenceFromToken(token: string): string {
  return token.match(/_(\d+)\]\]$/u)?.[1] ?? "001";
}

function maskValue(kind: DetectionKind, raw: string): string {
  const digits = raw.replace(/\D/gu, "");
  switch (kind) {
    case "phone":
      return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : "<手机号>";
    case "email": {
      const at = raw.indexOf("@");
      if (at > 1) {
        return `${raw[0]}***${raw.slice(at)}`;
      }
      return "<邮箱>";
    }
    case "china_id":
    case "bank_card":
      return digits.length >= 8 ? `${digits.slice(0, 4)}********${digits.slice(-4)}` : `<${kind}>`;
    default:
      return `<${kind}>`;
  }
}

function surrogateValue(kind: DetectionKind, token: string): string {
  const sequence = sequenceFromToken(token);
  const labels: Partial<Record<DetectionKind, string>> = {
    phone: "手机号",
    email: "邮箱",
    person_name: "联系人",
    address: "地址",
    china_id: "身份证",
    bank_card: "银行卡",
    account: "账号",
    credential: "凭证",
    private_date: "出生日期",
    private_url: "私密链接",
    mac_address: "MAC地址",
    bank_account: "银行账户",
  };
  const label = labels[kind] ?? "敏感项";
  return `<${label}-${sequence}>`;
}

function formatReplacement(candidate: Candidate, token: string, raw: string, style: ReplacementStyle): string {
  switch (style) {
    case "masked":
      return maskValue(candidate.kind, raw);
    case "surrogate":
      return surrogateValue(candidate.kind, token);
    default:
      return token;
  }
}

function collectCandidates(
  input: string,
  customTerms: readonly string[],
  detectionProfile: DetectionProfile,
  semanticReviewProvider: SemanticReviewProvider,
): Candidate[] {
  const candidates: Candidate[] = [];
  const detectionText = createDetectionText(input);

  for (const pattern of API_KEY_PATTERNS) {
    appendRegexCandidates(candidates, detectionText, pattern, "api_key", "block");
  }

  for (const pattern of ACCESS_TOKEN_PATTERNS) {
    appendRegexCandidates(candidates, detectionText, pattern, "access_token", "block");
  }

  for (const pattern of PRIVATE_KEY_PATTERNS) {
    appendRegexCandidates(candidates, detectionText, pattern, "private_key", "block");
  }

  for (const pattern of CONNECTION_STRING_PATTERNS) {
    appendRegexCandidates(candidates, detectionText, pattern, "connection_string", "block");
  }

  for (const pattern of PRIVATE_URL_PATTERNS) {
    appendRegexCandidates(candidates, detectionText, pattern, "private_url", "block");
  }

  for (const rule of getCuratedSecretRules()) {
    appendRegexCandidates(candidates, detectionText, rule.pattern, "api_key", "block");
  }

  appendCredentialCandidates(candidates, detectionText);
  appendLabeledCandidates(candidates, detectionText, PERSON_LABELS, "person_name", "replace");
  appendLabeledCandidates(candidates, detectionText, ADDRESS_LABELS, "address", "replace");
  appendLabeledCandidates(candidates, detectionText, ACCOUNT_LABELS, "account", "replace");
  appendLabeledCandidates(candidates, detectionText, ID_LABELS, "china_id", "replace");
  appendLabeledCandidates(candidates, detectionText, CARD_LABELS, "bank_card", "replace");
  appendLabeledCandidates(candidates, detectionText, PASSPORT_LABELS, "passport", "replace");
  appendLabeledCandidates(candidates, detectionText, PLATE_LABELS, "license_plate", "replace");
  appendLabeledCandidates(candidates, detectionText, IDENTIFIER_LABELS, "labeled_identifier", "replace");
  appendLabeledCandidates(
    candidates,
    detectionText,
    BANK_ACCOUNT_LABELS,
    "bank_account",
    "replace",
    isValidBankAccountValue,
  );
  appendPrivateDateCandidates(candidates, detectionText);

  // 护照号与车牌此前完全没有裸模式覆盖，`护照` 三个字在整个 src/ 里一次都没出现过，
  // 所以 `护照 E12345678` 和 `他的车是京A12345` 都会原样发出去。
  //
  // 护照模式收紧到真实中国护照前缀（普通 E / E+字母、旧版 G、公务 D/S/P），而不是
  // ml 侧用的 `[A-Z]\d{7,8}`：后者会吞掉订单号和料号。实测这个收紧版保留全部 6 个
  // 真实护照样本、拒绝全部 7 个干扰项，且在 7879 条负例文档上匹配数与宽版一致。
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![A-Za-z0-9])(?:E[A-L]?\d{7,8}|G\d{8}|[DSP]E?\d{7,8})(?![A-Za-z0-9])/g,
    "passport",
    "replace",
  );
  // 车牌常写成 `京A·12345`，中间那个间隔号是官方样式的一部分。模式必须能跨过它，
  // 否则光靠 normalizeValue 去符号也没用——正则先匹配不上就轮不到归一化。
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![A-Z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][·・ ]?[A-Z0-9]{5,6}(?![A-Z0-9])/gu,
    "license_plate",
    "replace",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![0-9A-F])(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}(?![0-9A-F])/giu,
    "mac_address",
    "replace",
    isValidMacAddress,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![0-9A-F])(?:[0-9A-F]{4}\.){2}[0-9A-F]{4}(?![0-9A-F])/giu,
    "mac_address",
    "replace",
    isValidMacAddress,
    "structured",
  );

  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![0-9A-Z])[0-9A-Z]{18}(?![0-9A-Z])/g,
    "unified_social_credit_code",
    "replace",
    isValidUnifiedSocialCreditCode,
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<!\d)\d{17}[\dXx](?![\dXx])/g,
    "china_id",
    "replace",
    isValidChinaResidentId,
  );
  appendBareBankCardCandidates(candidates, detectionText);
  appendDictatedPhoneCandidates(candidates, detectionText);
  appendRegexCandidates(
    candidates,
    detectionText,
    /[（(]\d{4}[）)][\u4e00-\u9fff0-9]{1,12}(?:民|刑|行|执|赔|知)[初终再申]?[字]?\d{1,8}号/gu,
    "labeled_identifier",
    "replace",
    isCourtCaseNumber,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/giu,
    "labeled_identifier",
    "replace",
    isIso3779Vin,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<!\d)(?:\+86[\s-]*|0086[\s-]*)?\(?1[3-9]\d\)?(?:[ -]?\d){8}(?!\d)/g,
    "phone",
    "replace",
    (raw) => {
      const digits = raw.replace(/[()\s+-]/gu, "");
      return /^1[3-9]\d{9}$/u.test(digits) || /^(?:86|0086)1[3-9]\d{9}$/u.test(digits);
    },
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    "email",
    "replace",
    undefined,
    "structured",
  );
  appendObfuscatedEmailCandidates(candidates, detectionText);
  appendRegexCandidates(
    candidates,
    detectionText,
    /[A-Za-z]:\\Users\\[^\\/:*?"<>|,，;；!?！？\r\n]+(?:\\[^\\/:*?"<>|,，;；!?！？\r\n]+)*/g,
    "local_path",
    "replace",
    undefined,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@%+=-]+)*/g,
    "local_path",
    "replace",
    undefined,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    "ipv4",
    "replace",
    isIpv4Address,
    "structured",
  );
  appendRegexCandidates(
    candidates,
    detectionText,
    /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])/g,
    "ipv6",
    "replace",
    isIpv6Address,
    "structured",
  );
  appendContextualStructuredCandidates(candidates, detectionText);
  appendCustomCandidates(candidates, detectionText, customTerms);
  appendContextCandidates(candidates, detectionText);
  appendSemanticCandidates(candidates, input, detectionProfile, semanticReviewProvider);

  return candidates;
}

const HIGH_RISK_ALLOWLIST_KINDS = new Set<DetectionKind>([
  "api_key",
  "access_token",
  "private_key",
  "connection_string",
  "private_url",
  "credential",
]);

type AllowlistValue = string | ScopedAllowlistValue;

function isActiveAllowlistValue(value: AllowlistValue): boolean {
  if (typeof value === "string") {
    return true;
  }

  return value.expiresAt === undefined || Date.parse(value.expiresAt) > Date.now();
}

function allowsCandidate(candidate: Candidate, entry: AllowlistValue): boolean {
  if (!isActiveAllowlistValue(entry)) {
    return false;
  }

  const scope = typeof entry === "string" ? "global" : entry.scope;
  if (
    HIGH_RISK_ALLOWLIST_KINDS.has(candidate.kind) &&
    (scope === "global" || (scope === "site" && (typeof entry === "string" || entry.expiresAt === undefined)))
  ) {
    return false;
  }

  const rawValue = normalizeDashVariants(candidate.raw.trim());
  const normalizedTerm = (typeof entry === "string" ? entry : entry.value).trim();
  return (
    rawValue === normalizeDashVariants(normalizedTerm) ||
    candidate.normalized === normalizeValue(candidate.kind, normalizedTerm)
  );
}

function filterAllowlistedCandidates(
  candidates: readonly Candidate[],
  allowlistedTerms: readonly AllowlistValue[],
): Candidate[] {
  return candidates.filter((candidate) => !allowlistedTerms.some((entry) => allowsCandidate(candidate, entry)));
}

function selectDraftCandidates(
  input: string,
  customTerms: readonly string[],
  allowlistedTerms: readonly AllowlistValue[],
  categoryPolicies: readonly CategoryPolicyEntry[],
  options: RedactionOptions,
): Candidate[] {
  const semanticReviewProvider = options.semanticReviewProvider ?? createNoopSemanticReviewProvider();

  return selectCandidates(
    applyCategoryPolicies(
      filterAllowlistedCandidates(
        collectCandidates(input, customTerms, options.detectionProfile ?? "conservative", semanticReviewProvider),
        allowlistedTerms,
      ),
      categoryPolicies,
    ),
  );
}

export function analyzeDraft(
  input: string,
  customTerms: readonly string[] = [],
  allowlistedTerms: readonly AllowlistValue[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  options: RedactionOptions = {},
): DraftAnalysis {
  const selected = selectDraftCandidates(input, customTerms, allowlistedTerms, categoryPolicies, options);

  return {
    findings: summarizeCandidates(selected),
    redactedText: replaceCandidates(
      input,
      selected,
      createSessionTokenMap(),
      options.replacementStyle ?? "token",
    ),
  };
}

export function materializeDraftRedaction(
  input: string,
  customTerms: readonly string[],
  sessionTokenMap: SessionTokenMap,
  allowlistedTerms: readonly AllowlistValue[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  options: RedactionOptions = {},
): { findings: RedactionFinding[]; outboundText: string } {
  const selected = selectDraftCandidates(input, customTerms, allowlistedTerms, categoryPolicies, options);

  return {
    findings: summarizeCandidates(selected),
    outboundText: replaceCandidates(
      input,
      selected,
      sessionTokenMap,
      options.replacementStyle ?? "token",
    ),
  };
}

export function resolveSendAction(
  findings: readonly RedactionFinding[],
  mode: "replace" | "block",
): SendAction {
  if (findings.length === 0) {
    return "native";
  }

  if (findings.some((finding) => finding.policy === "block")) {
    return "block";
  }

  if (
    mode === "block" ||
    findings.some((finding) => finding.policy === "confirm" || finding.decision === "block")
  ) {
    return "confirm";
  }

  return "replace";
}

export function getRedactionValues(
  input: string,
  customTerms: readonly string[] = [],
  allowlistedTerms: readonly AllowlistValue[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  options: RedactionOptions = {},
): string[] {
  return selectDraftCandidates(input, customTerms, allowlistedTerms, categoryPolicies, options).map(
    (candidate) => candidate.normalized,
  );
}

export function getDetectionRanges(
  input: string,
  customTerms: readonly string[] = [],
  allowlistedTerms: readonly AllowlistValue[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  options: RedactionOptions = {},
): DetectionRange[] {
  return selectDraftCandidates(input, customTerms, allowlistedTerms, categoryPolicies, options).map(
    ({ kind, start, end }) => ({ kind, start, end }),
  );
}

export function redactDraft(
  input: string,
  customTerms: readonly string[] = [],
  sessionTokenMap?: SessionTokenMap,
  allowlistedTerms: readonly AllowlistValue[] = [],
  categoryPolicies: readonly CategoryPolicyEntry[] = [],
  options: RedactionOptions = {},
): RedactionResult {
  const selected = selectDraftCandidates(input, customTerms, allowlistedTerms, categoryPolicies, options);
  const findings = summarizeCandidates(selected);

  if (selected.some((candidate) => candidate.decision === "block")) {
    return { status: "blocked", outboundText: null, findings };
  }

  return {
    status: "ready",
    outboundText: replaceCandidates(
      input,
      selected,
      sessionTokenMap ?? createSessionTokenMap(),
      options.replacementStyle ?? "token",
    ),
    findings,
  };
}
