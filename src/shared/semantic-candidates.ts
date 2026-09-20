import { CHINESE_SURNAMES } from "./chinese-entities.js";
import { overlapsTextRange, type TextRange } from "./code-ranges.js";
import {
  ADDRESS_ADMIN_PATTERN,
  ADDRESS_INDOOR_PLACE_PATTERN,
  ADDRESS_ANCHOR_PATTERN,
  ADDRESS_NUMBER_PATTERN,
  ADDRESS_PLACE_PATTERN,
  ADDRESS_ROAD_PATTERN,
  ADDRESS_TAIL_PATTERN,
  BARE_CITY_NAMES,
  BARE_DISTRICT_NAMES,
  BARE_PROVINCE_NAMES,
  COMMON_NON_NAME_WORDS,
  COMMON_ORGANIZATION_OR_PLACE_NAMES,
  MINORITY_NAME_PREFIXES,
  EXTENDED_COMPOUND_SURNAMES,
  NON_NAME_TAIL_PATTERN,
  NON_PLACE_NAME_INITIALS,
  ORGANIZATION_MARKER_PATTERN,
  PERSON_ACTION_PATTERN,
  PERSON_PREFIX_PATTERN,
  PERSON_ROLE_SUFFIX_PATTERN,
  PERSON_TITLE_SUFFIX_PATTERN,
  TRADITIONAL_SURNAMES,
} from "./semantic-lexicon.js";

export type SemanticCandidate = {
  kind: "person_name" | "address";
  start: number;
  end: number;
  reason: "person_anchor" | "person_role" | "person_structured" | "address_anchor" | "address_structure";
  evidence: number;
};

const MAX_ADDRESS_LENGTH = 128;
const NAME_SEPARATORS = /[\s·・]/u;
const HAN_CHARACTER = /^[\u3400-\u9fff]$/u;
const ADDRESS_CHARACTER = /^[\u3400-\u9fffA-Za-z0-9\s·・#－-]$/u;
// `的` 是领属助词，中文地址内部不会出现它。把它当停止符，`灵隐路 168 号的民宿 5月20日
// 入住 房东 张姐 13901234567` 就不会被整段吞进一个 [[ADDRESS_x]] 令牌。
const ADDRESS_STOP = /[，,。；;！？!的\n\r]/u;
const SENTENCE_PUNCTUATION = /[，,。；;！？!]/u;
const PERSON_BOUNDARY_LOOKAHEAD = 32;
const PERSON_PREFIX_LOOKBEHIND = 64;
const ADDRESS_TAIL_LOOKAHEAD = 8;

const surnames = [...new Set([...CHINESE_SURNAMES, ...TRADITIONAL_SURNAMES, ...EXTENDED_COMPOUND_SURNAMES])]
  .sort((left, right) => right.length - left.length);
const surnamesByFirst = new Map<string, string[]>();
for (const surname of surnames) {
  const first = surname[0];
  if (first === undefined) {
    continue;
  }
  const values = surnamesByFirst.get(first) ?? [];
  values.push(surname);
  surnamesByFirst.set(first, values);
}

function isNameSeparator(character: string | undefined): boolean {
  return character !== undefined && NAME_SEPARATORS.test(character);
}

function skipNameSeparators(input: string, start: number): number {
  let cursor = start;
  while (isNameSeparator(input[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isHan(character: string | undefined): boolean {
  return character !== undefined && HAN_CHARACTER.test(character);
}

function isPersonStartBoundary(input: string, start: number): boolean {
  const previous = input[start - 1];
  return previous === undefined || !isHan(previous) || SENTENCE_PUNCTUATION.test(previous);
}

function isPersonBoundary(input: string, start: number): boolean {
  const cursor = skipNameSeparators(input, start);
  if (cursor >= input.length) {
    return true;
  }
  // Both consumers are anchored at the beginning. Restricting the lookahead keeps a long
  // repeated draft from copying the entire suffix for every possible surname.
  const remainder = input.slice(cursor, cursor + PERSON_BOUNDARY_LOOKAHEAD);
  return /^(?:[，,。；;/:：.!！？?~～…]|\p{Extended_Pictographic})/u.test(remainder)
    ? true
    : PERSON_ACTION_PATTERN.test(remainder);
}

function isStructuredSensitiveValueAt(input: string, start: number): boolean {
  const remainder = input.slice(start).trimStart();
  return /^(?:1[3-9](?:[ -]?\d){9}|\d{17}[\dXx]|\d{6}[ -]\d{8}[ -]\d{4}|(?:\d[ -]?){12,18}\d|[A-Z]\d{8}|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![A-Za-z0-9])/u.test(remainder);
}

function isDirectStructuredSensitiveValueAt(input: string, start: number): boolean {
  return /^(?:1[3-9](?:[ -]?\d){9}|\d{17}[\dXx]|\d{6}[ -]\d{8}[ -]\d{4}|(?:\d[ -]?){12,18}\d|[A-Z]\d{8}|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?![A-Za-z0-9])/u.test(input.slice(start));
}

function matchingSurname(input: string, start: number): string | null {
  const values = surnamesByFirst.get(input[start] ?? "");
  return values?.find((surname) => input.startsWith(surname, start)) ?? null;
}

function parseStandardNameAt(input: string, start: number): { start: number; end: number } | null {
  const surname = matchingSurname(input, start);
  if (surname === null) {
    return null;
  }

  let cursor = start + surname.length;
  let end = cursor;
  let givenCharacters = 0;
  while (givenCharacters < 2) {
    cursor = skipNameSeparators(input, cursor);
    if (PERSON_ACTION_PATTERN.test(input.slice(cursor))) {
      break;
    }
    if (!isHan(input[cursor])) {
      if (givenCharacters === 0) {
        return null;
      }
      // Structured values may be adjacent to the name (`郭静136...`) or separated by
      // whitespace. Requiring skipped whitespace here dropped the common adjacent form.
      if (isDirectStructuredSensitiveValueAt(input, cursor)) {
        break;
      }
      if (!isPersonBoundary(input, cursor)) {
        return null;
      }
      break;
    }
    cursor += 1;
    end = cursor;
    givenCharacters += 1;
  }

  if (givenCharacters === 0 || (!isPersonBoundary(input, end) && !isStructuredSensitiveValueAt(input, end))) {
    return null;
  }
  return { start, end };
}

function parseMinorityNameAt(input: string, start: number): { start: number; end: number } | null {
  const prefix = MINORITY_NAME_PREFIXES.find((value) => input.startsWith(value, start));
  if (prefix === undefined) {
    return null;
  }

  let cursor = start + prefix.length;
  let end = cursor;
  let givenCharacters = 0;
  while (givenCharacters < 4) {
    cursor = skipNameSeparators(input, cursor);
    if (PERSON_ACTION_PATTERN.test(input.slice(cursor))) {
      break;
    }
    if (!isHan(input[cursor])) {
      break;
    }
    cursor += 1;
    end = cursor;
    givenCharacters += 1;
  }

  return givenCharacters >= 2 && isPersonBoundary(input, end) ? { start, end } : null;
}

function parseNameAt(input: string, start: number): { start: number; end: number } | null {
  return parseMinorityNameAt(input, start) ?? parseStandardNameAt(input, start);
}

/**
 * 从 `start` 处解析一个中文人名，返回它的结束位置；解析不出来返回 null。
 *
 * 给"弱分隔符"的标签字段用。`收件人：沈砚` 这类带冒号的强证据仍走宽松路径，
 * 不要求姓氏在表内（否则生僻姓和外文名会漏）；而 `收件人 沈砚` 只有空格，证据
 * 弱，就必须过这道形态检查，否则 `收件人 已经签收` 会被打码。
 *
 * 用解析器而不是"取到下一个空格为止"，是为了拿到正确的边界：
 * `负责人 张三已经确认` 应当只圈出 `张三`，而不是整段。
 */
export function parseChineseNameAt(input: string, start: number): { start: number; end: number } | null {
  const parsed = parseNameAt(input, start);
  return parsed !== null && !isPersonNegative(input, parsed.start, parsed.end) ? parsed : null;
}

/**
 * 值是否以一个常见非人名词开头。
 *
 * 只判等号不够：`付款` 会被拦下，`付款单` 却漏过去，而中文名极少以"付款/方案/时间"
 * 这类双字常用词开头。代价是 `白天宇` 这类真名会被误拒，属于已知取舍。
 */
function startsWithNonNameWord(value: string): boolean {
  for (const word of COMMON_NON_NAME_WORDS) {
    if (value.length > word.length && value.startsWith(word)) {
      return true;
    }
  }
  return false;
}

/**
 * 值是否明显不是人名。给标签字段的宽松路径用。
 *
 * 那条路径故意不要求姓氏在表内，好让生僻姓、外文名、"演示联系人甲"这类占位人名也能
 * 打码；代价是 `负责人：付款单` 也会被打码。这道守卫只做否认，不做认定，所以不会
 * 牵连上面那些需要放过的值。
 */
export function looksLikeNonPersonValue(value: string): boolean {
  const compact = value.replace(/[\s·・]/gu, "");
  return (
    COMMON_NON_NAME_WORDS.has(compact) ||
    startsWithNonNameWord(compact) ||
    NON_NAME_TAIL_PATTERN.test(compact)
  );
}

/**
 * 这个跨度明显不是人名吗？
 *
 * 只在本模块内用于门控（`parseChineseNameAt` 与 `addPersonCandidate`），所以它只作用于
 * 规则生成器自己产出的候选；神经模型的候选走 provider 边界，不经过这里。
 *
 * 导出是给 `scripts/measure-negative-predicate-gap.mjs` 用的，**不是**为了接到神经路径上。
 * 那条路已经量化过并否掉了，理由是净亏而不是"收益小"：
 *
 * - 收益：六个集共 1194 篇被模型污染的干净文档，这套词表能清掉 **83 篇**（7.0%），
 *   绝大部分是 clean-room 上的 `王府井`×46 与 `华为`×34。
 * - 代价：openpii-holdout 上会否掉 **12 个与 gold 完全吻合的真实人名**——`馨云`、`云勇`、
 *   `云丽`、`筑云`。
 *
 * 关键在于收益与代价出自同一个机制：`云` 落在 `ORGANIZATION_MARKER_PATTERN` 里，所以拦住
 * `马云` 的那一条正则同时删掉 `云丽`。漏检是安全事故，误报只是多一次确认，方向反了。
 *
 * 而真正的污染主体 `王安石` / `张衡` / `李白` / `杜甫` / `药明康德` / `隆基` / `王维` 一个都不
 * 在表内，也不该塞进来——首字为姓的普通词与公众人物名都是开放集合，而这几张表同时被
 * `looksLikeNonPersonValue` 用于标签字段守卫，加词会连带改变 `收件人：张三` 的行为。
 * 修复属于训练数据（R5 卡就提了公众人物负例，至今未做）。
 */
export function isPersonNegative(input: string, start: number, end: number): boolean {
  const value = input.slice(start, end).replace(/[\s·・]/gu, "");
  const nearby = input.slice(Math.max(0, start - 10), Math.min(input.length, end + 18));
  return COMMON_ORGANIZATION_OR_PLACE_NAMES.has(value) ||
    COMMON_NON_NAME_WORDS.has(value) ||
    startsWithNonNameWord(value) ||
    NON_NAME_TAIL_PATTERN.test(value) ||
    PERSON_TITLE_SUFFIX_PATTERN.test(value) ||
    ORGANIZATION_MARKER_PATTERN.test(value) ||
    /(?:唐代|詩人|诗人|歷史(?:展|人物|故事)|历史(?:展|人物|故事)|地標|地标|景點|景点)/u.test(nearby);
}

function addPersonCandidate(
  candidates: SemanticCandidate[],
  input: string,
  start: number,
  end: number,
  reason: SemanticCandidate["reason"],
  protectedRanges: readonly TextRange[],
): void {
  if (overlapsTextRange(start, end, protectedRanges) || isPersonNegative(input, start, end)) {
    return;
  }
  candidates.push({
    kind: "person_name",
    start,
    end,
    reason,
    evidence: reason === "person_structured" ? 0.84 : reason === "person_anchor" ? 0.82 : 0.76,
  });
}

const STRUCTURED_PERSON_NEIGHBOR = /(?:1[3-9](?:[ -]?\d){9}|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\d{6}[ -]?\d{8}[ -]?\d{3}[\dXx]|(?:62\d{14}|(?:\d[ -]?){12,18}\d)|(?:E[A-L]?\d{7,8}|G\d{8}|[DSP]E?\d{7,8}))/u;
const PERSON_NEIGHBOR_CONNECTOR = /^(?:\s|[，,/:：.!！？?~～…]|\p{Extended_Pictographic}|(?:的)?(?:contact\s*info|聯繫方式|联系方式|電話號碼|电话号码|電話|电话|號|号|手機號|手机号|手機|手机|郵箱|邮箱|email|phone|at|護照|护照|證件|证件|身份證|身份证|銀行卡|银行卡|卡號|卡号|号码|号码是|微信同號|微信同号|說他号码是|说他号码是)|说|說|是|叫)*$/iu;
const PERSON_CHAT_PREFIXES = [
  "微信加", "微信搜", "微信搜索", "加个微信吧", "加個微信吧", "加好友", "转账到", "轉帳到", "转到", "轉到",
  "发给", "發給", "邮件发给", "郵件發給", "户名", "戶名", "报名信息", "報名信息",
  "这个人叫", "這個人叫", "名字", "名为", "名為", "姓名", "收件人", "联系人", "聯絡人", "联系", "聯繫",
  "那个", "問了", "问了", "cc一下", "帮", "帮我打给", "帮我转到", "是", "就是", "叫",
] as const;

const PERSON_PREFIX_CONNECTOR = /^(?:\s|[，,。；;/:：.!！？?~～…]|\p{Extended_Pictographic})*$/u;
const PERSON_CHAT_PREFIX_PATTERN = new RegExp(
  `(?:${[...PERSON_CHAT_PREFIXES]
    .sort((left, right) => right.length - left.length)
    .map((prefix) => prefix.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("|")})${PERSON_PREFIX_CONNECTOR.source.replace(/^\^|\$$/gu, "")}$`,
  "u",
);

function hasPersonChatPrefix(input: string, start: number): boolean {
  return PERSON_CHAT_PREFIX_PATTERN.test(input.slice(Math.max(0, start - PERSON_PREFIX_LOOKBEHIND), start));
}

function hasStructuredPersonNeighbor(input: string, end: number): boolean {
  const tail = input.slice(end, Math.min(input.length, end + 40));
  const match = STRUCTURED_PERSON_NEIGHBOR.exec(tail);
  return match !== null && PERSON_NEIGHBOR_CONNECTOR.test(tail.slice(0, match.index));
}

function hasStructuredPersonPredecessor(input: string, start: number): boolean {
  const head = input.slice(Math.max(0, start - 48), start);
  return /(?:1[3-9](?:[ -]?\d){9}|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\d{6}[ -]\d{8}[ -]\d{4}|(?:62\d{14}|(?:\d[ -]?){12,18}\d)|(?:E[A-L]?\d{7,8}|G\d{8}|[DSP]E?\d{7,8}))[\s，,/:：.!！？?~～…\p{Extended_Pictographic}]*(?:是|是的|就是|名字|名为|名為|姓名|户名|戶名|联系人|聯絡人|的)?$/iu.test(head);
}

function findPersonCandidates(input: string, protectedRanges: readonly TextRange[]): SemanticCandidate[] {
  const candidates: SemanticCandidate[] = [];
  const anchorMatcher = new RegExp(PERSON_PREFIX_PATTERN.source, PERSON_PREFIX_PATTERN.flags);
  let anchor: RegExpExecArray | null;
  while ((anchor = anchorMatcher.exec(input)) !== null) {
    const start = skipNameSeparators(input, anchor.index + anchor[0].length);
    const parsed = parseNameAt(input, start);
    if (parsed !== null) {
      addPersonCandidate(candidates, input, parsed.start, parsed.end, "person_anchor", protectedRanges);
    }
  }

  for (let start = 0; start < input.length; start += 1) {
    if (
      overlapsTextRange(start, start + 1, protectedRanges) ||
      !isPersonStartBoundary(input, start) ||
      !surnamesByFirst.has(input[start] ?? "")
    ) {
      continue;
    }
    const parsed = parseNameAt(input, start);
    if (parsed !== null && PERSON_ROLE_SUFFIX_PATTERN.test(input.slice(skipNameSeparators(input, parsed.end)))) {
      addPersonCandidate(candidates, input, parsed.start, parsed.end, "person_role", protectedRanges);
    }
  }

  for (let start = 0; start < input.length; start += 1) {
    if (
      overlapsTextRange(start, start + 1, protectedRanges) ||
      !surnamesByFirst.has(input[start] ?? "") ||
      (!isPersonStartBoundary(input, start) && !hasPersonChatPrefix(input, start))
    ) {
      continue;
    }
    const parsed = parseNameAt(input, start);
    if (
      parsed !== null &&
      (hasStructuredPersonNeighbor(input, parsed.end) || hasStructuredPersonPredecessor(input, parsed.start)) &&
      (hasPersonChatPrefix(input, parsed.start) || isPersonStartBoundary(input, parsed.start))
    ) {
      addPersonCandidate(candidates, input, parsed.start, parsed.end, "person_structured", protectedRanges);
    }
  }

  return candidates;
}

function trimAddressTail(value: string): string {
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    if (ADDRESS_TAIL_PATTERN.test(value.slice(index))) {
      end = index;
      break;
    }
  }
  return value.slice(0, end).trimEnd();
}

/*
 * 地址右边界：成分链。
 *
 * 地址是"行政区划 → 道路 → 门牌 → 楼栋/单元"连成的一串结构成分，成分之间只允许
 * 分隔符或短专名片段（`望京 SOHO` 的 `望京`、`珠江新城` 的 `新城`）。一旦出现散文，
 * 地址就结束了。链尾之后的内容一律丢弃。
 *
 * 这取代了继续给 ADDRESS_TAIL_PATTERN 列黑名单的做法。实测每个集的尾巴都不一样
 * （`楼下取`、`拍照`、`看房`、`房号 207`、`总价 1680 万`、`的民宿 5月20日入住 房东
 * 张姐 13901234567`），是开放集合，穷举不完；"必须由结构成分连成"是闭合判据。
 *
 * 最严重的是最后一种：地址跨度把电话和人名一起吞进 [[ADDRESS_x]] 令牌，既错标类型
 * 又让用户看到一整句被替换。
 */
type AddressTokenKind = "separator" | "digits" | "latin" | "han";

const ADDRESS_TOKEN_SEPARATOR = /\s|[·・#－-]/u;
// 门牌单位字。它们只在数字或拉丁编号之后才算单位——`17 号` 的 `号` 是单位，
// `楼下取` 的 `楼` 不是。所以拆分只在前一个词是数字/拉丁时才做。
const ADDRESS_UNIT_CHARACTERS = /^[號号弄院棟栋幢座樓楼層层室組组排期單单元]+/u;
// 专名 + 后缀 才算一个命名成分。要求后缀前至少两个汉字，与 ADDRESS_ADMIN_PATTERN 同一形状：
// `天河区` 是成分，`楼下取` 里位于开头的 `楼` 不是。
//
// 刻意不收裸的单位字（`室`/`座`/`樓`/`棟`）：它们在真实地址里一律跟在数字或字母编号
// 之后（`1801 室`、`A 座`），走单位字那条路径。收进来会让 `2202 三居室` 的 `三居室`
// 也算成分，把跨度拖长。
const ADDRESS_NAMED_COMPONENT =
  /[\u4e00-\u9fff]{2,}(?:省|自治區|自治区|市|區|区|縣|县|旗|鎮|镇|鄉|乡|大道|路|街|道|巷|弄|胡同|園|园|苑|村|大廈|大厦|大樓|大楼|廣場|广场|公寓|公館|公馆|別墅|别墅|酒店|飯店|饭店|賓館|宾馆|大院|號院|号院)/gu;
// 命名成分后面允许跟的专名尾巴长度：`广州天河区珠江新城` 的 `珠江新城`。
const ADDRESS_PROPER_NAME_TAIL = 4;
// 楼栋编号的拉丁串上限。`SOHO` 正好 4 个字符，`LinkedIn` 8 个不是楼栋号。
const MAX_ADDRESS_LATIN_TOKEN = 4;
// 结尾处可以被回退掉的裸数字长度。房号和单元号都是 3-4 位。
const MAX_TRAILING_SHORT_NUMBER = 2;
// 量词与时间词的首字。链尾停在 1-2 位裸数字、后面紧跟这些字时，那个数字属于后面的
// 短语而不是房号：`88 号 8 点`、`28 号 5月20日`。
//
// 量词是闭合语法类，与 NON_PLACE_NAME_INITIALS 的代词集同一性质。刻意不收 `号`、
// `层`、`栋`、`座`、`室`、`楼`——它们本身就是门牌单位。
const ADDRESS_MEASURE_WORD_INITIALS = new Set([
  "點", "点", "時", "时", "分", "秒", "月", "日", "年", "週", "周",
  "折", "人", "位", "元", "塊", "块", "歲", "岁", "度", "次", "份", "件",
  "台", "輛", "辆", "場", "场", "成", "張", "张", "名", "個", "个", "萬", "万",
]);

function tokenKindOf(character: string): AddressTokenKind {
  if (ADDRESS_TOKEN_SEPARATOR.test(character)) {
    return "separator";
  }
  if (/\d/u.test(character)) {
    return "digits";
  }
  return /[A-Za-z]/u.test(character) ? "latin" : "han";
}

function tokenizeAddress(value: string): { start: number; end: number; kind: AddressTokenKind }[] {
  const tokens: { start: number; end: number; kind: AddressTokenKind }[] = [];
  let index = 0;
  while (index < value.length) {
    const kind = tokenKindOf(value[index] ?? "");
    let end = index + 1;
    while (end < value.length && tokenKindOf(value[end] ?? "") === kind) {
      end += 1;
    }
    tokens.push({ start: index, end, kind });
    index = end;
  }
  return tokens;
}

/**
 * 把跨度裁剪到成分链本身，返回链在 value 内的起止偏移。
 *
 * 头部裁剪是同一判据的对称用法，用来治锚点路径。`ADDRESS_ANCHOR_PATTERN` 里有裸的
 * `到`，`货到了 收件人 周晓宇 18811223344 杭州西湖区文三路 100 号` 里它命中 `货到`，
 * 起点落在 `了` 上，于是一条 [[ADDRESS_x]] 令牌把人名和电话一起吞掉。裁到第一个
 * 结构成分就得到 `杭州西湖区文三路 100 号`。
 *
 * 对结构种子是空操作：种子起点本来就是从后缀回退出来的成分起点。
 */
function findAddressComponentChain(value: string): { start: number; end: number } {
  let chainStart = -1;
  let chainEnd = 0;
  let previousIsComponent = false;
  let previousKind: AddressTokenKind | null = null;

  const markStart = (offset: number): void => {
    if (chainStart === -1) {
      chainStart = offset;
    }
  };

  // 上一个分隔符里是否有空白。`5-1801` 是一个复合房号，`1701 130` 是房号后面跟了
  // 电话号码的开头——两者都是"数字 分隔符 数字"，只有分隔符能区分。
  let gapHasWhitespace = false;
  // 最后一次推进链尾的是哪种词、推进前链尾在哪。用来回退结尾处的短数字。
  //
  // 判据是"短数字后面跟着量词或时间词"，不是"短数字一律回退"——实测后者会连带丢掉
  // openpii 里合法的短门牌号，openpii F1 从 0.1406 掉到 0.1356、charLeak 反而变差。
  let lastExtend: { isShortNumber: boolean; previousEnd: number; end: number } | null = null;

  for (const token of tokenizeAddress(value)) {
    const text = value.slice(token.start, token.end);
    if (token.kind === "separator") {
      gapHasWhitespace = /\s/u.test(text);
      continue;
    }
    const spaceBefore = gapHasWhitespace;
    gapHasWhitespace = false;

    if (token.kind === "latin") {
      // `SOHO`、`T1`、`A 座` 都是楼栋编号：必须紧接在成分之后，且必须短。
      // 少了 previousIsComponent，`学院路 17 号 订单号 ORD-4257` 里的 `ORD` 会隔着
      // `订单号` 把跨度续上；少了长度上限，简历里紧跟地址的 `LinkedIn` 会被吃进来。
      if (chainStart !== -1 && previousIsComponent && text.length <= MAX_ADDRESS_LATIN_TOKEN) {
        lastExtend = { isShortNumber: false, previousEnd: chainEnd, end: token.end };
        chainEnd = token.end;
      } else {
        previousIsComponent = false;
      }
      previousKind = "latin";
      continue;
    }

    if (token.kind === "digits") {
      // 裸数字只有紧接成分时才算门牌/房号。隔着散文的数字（`总价 1680`、`房号 207`）不算。
      //
      // 两串裸数字用空白隔开时停在第一串：`… B 座 1701 130` 里 `130` 是后面电话号码
      // 的开头，不是房号。用连字号连起来的是复合房号（`88 号 5-1801`），要保留。
      if (chainStart !== -1 && previousIsComponent && !(previousKind === "digits" && spaceBefore)) {
        lastExtend = {
          isShortNumber: text.length <= MAX_TRAILING_SHORT_NUMBER,
          previousEnd: chainEnd,
          end: token.end,
        };
        chainEnd = token.end;
      } else {
        previousIsComponent = false;
      }
      previousKind = "digits";
      continue;
    }

    let offset = 0;
    if (chainStart !== -1 && (previousKind === "digits" || previousKind === "latin")) {
      const unit = ADDRESS_UNIT_CHARACTERS.exec(text);
      if (unit !== null) {
        offset = unit[0].length;
        lastExtend = { isShortNumber: false, previousEnd: chainEnd, end: token.start + offset };
        chainEnd = token.start + offset;
        previousIsComponent = true;
      }
    }

    const rest = text.slice(offset);
    const named = [...rest.matchAll(ADDRESS_NAMED_COMPONENT)];
    if (named.length > 0) {
      const first = named[0];
      const last = named[named.length - 1];
      const namedEnd = (last?.index ?? 0) + (last?.[0].length ?? 0);
      const tail = Math.min(rest.length - namedEnd, ADDRESS_PROPER_NAME_TAIL);
      // 只有命名成分能开一条链。这样 `了 收货人 周晓宇 18811223344` 全部被裁掉，
      // 而 `朝阳门外大街 88 号` 的起点仍是 0（整个汉字词都在命名成分里）。
      //
      // 首字是代词或位移动词的不算地名：`您小区` 满足"两汉字 + 区"的形状，但真正的
      // 地址是它后面的 `朝阳门外大街 88 号`；`去超市` 同理，压根不是地址。
      const firstIndex = first?.index ?? 0;
      if (!NON_PLACE_NAME_INITIALS.has(rest[firstIndex] ?? "")) {
        markStart(token.start + offset + firstIndex);
      }
      if (chainStart !== -1) {
        lastExtend = {
          isShortNumber: false,
          previousEnd: chainEnd,
          end: token.start + offset + namedEnd + tail,
        };
        chainEnd = token.start + offset + namedEnd + tail;
      }
      previousIsComponent = chainStart !== -1;
    } else if (offset === 0) {
      // 散文或专名片段：不推进链尾，但后面的拉丁编号仍可续上（`号望京 SOHO`）。
      previousIsComponent = false;
    }
    previousKind = "han";
  }

  if (chainStart === -1) {
    return { start: 0, end: 0 };
  }
  // 链尾停在 1-2 位裸数字、且后面紧跟量词或时间词时回退一步：那个数字属于后面的
  // 短语，不是房号。`朝阳门外大街 88 号 8 点` 的 `8` 是钟点，`洱海路 28 号 5月20日`
  // 的 `5` 是月份。
  if (lastExtend !== null && lastExtend.isShortNumber) {
    let after = lastExtend.end;
    while (after < value.length && /\s/u.test(value[after] ?? "")) {
      after += 1;
    }
    if (ADDRESS_MEASURE_WORD_INITIALS.has(value[after] ?? "")) {
      chainEnd = lastExtend.previousEnd;
    }
  }
  const trimmed = value.slice(chainStart, chainEnd).trimEnd();
  return { start: chainStart, end: chainStart + trimmed.length };
}

// 门牌号里的阿拉伯数字。无锚点扫描要求它，中文数词不算。
const ADDRESS_ARABIC_NUMBER = /\d/u;
// 具名道路：后缀前至少两个汉字。`学院路` 是具名道路，`顺路`、`一路` 不是。
const ADDRESS_NAMED_ROAD_PATTERN = /[\u4e00-\u9fff]{2,}(?:大道|路|街|巷|弄|胡同|道)/u;

function isAddressCandidate(value: string, requireArabicNumber = false): boolean {
  const hasAdmin = ADDRESS_ADMIN_PATTERN.test(value);
  const hasBareDistrict = BARE_DISTRICT_NAMES.some((district) => value.includes(district));
  const hasRoad = ADDRESS_ROAD_PATTERN.test(value);
  const hasPlace = ADDRESS_PLACE_PATTERN.test(value);
  const hasNumber = ADDRESS_NUMBER_PATTERN.test(value);

  // 室内场所加楼层号不是可投递地址。没有街道信息时拒绝，
  // 否则"到市场部会议室3楼开会"这类日常句子会被当成地址。
  if (ADDRESS_INDOOR_PLACE_PATTERN.test(value) && !hasRoad) {
    return false;
  }

  // 无锚点时证据更弱，所以门牌号必须是阿拉伯数字。中文数词太松：
  // `山的路上遇到一个采药的老乡` 里 `一` 当成号码、`老乡` 的 `乡` 当成行政区划，
  // 整句就成了地址；`宁波鄞州四明中路` 里的 `四` 同理。真实地址一律用阿拉伯数字。
  if (requireArabicNumber && !ADDRESS_ARABIC_NUMBER.test(value)) {
    return false;
  }

  // 具名道路 + 阿拉伯门牌号本身就是可投递地址，不需要行政区划或场所词。
  // `海淀学院路 17 号`、`丽水路 1582`、`朝阳门外大街 88 号` 都是这一形状。
  //
  // 此前这一条被拒，理由是精确率风险。改判的原因是边界纪律现在强得多（成分链、
  // 头部裁剪、`的` 停止符、代词否决），而且实测发现旧行为里这类地址是**偶然**通过的：
  // 松散跨度把 prose 里的 `室`/`公寓`/`中心` 吞进来才凑出 hasPlace。
  // 代价在 4 个负例集上单独度量，见 ml/reports/generated/ts-baseline/。
  if (ADDRESS_NAMED_ROAD_PATTERN.test(value) && ADDRESS_ARABIC_NUMBER.test(value)) {
    return true;
  }

  return (hasRoad && hasNumber && (hasAdmin || hasPlace)) || ((hasAdmin || hasBareDistrict) && hasPlace && hasNumber);
}

/**
 * 无锚词地址的种子位置。
 *
 * 此前地址只在 ADDRESS_ANCHOR_PATTERN 之后扫描，所以 `武汉市洪山区霁虹街95号` 这种
 * 前面没有"寄到/送往"的写法完全检不出——四个评测集上"无锚词地址"一律 0.000，共 1298 条。
 *
 * 结构约束本身很强（isAddressCandidate 要求 具名道路+门牌号，或 路+号+（行政区划|场所），
 * 或 行政区划+场所+号），所以不靠锚词也能守住精确率。两类种子对应实测到的两种形状：
 *   1. 行政区划：`辽宁省…`、`上海市…`、`岳麓区…`——占 blind-probe 与 semantic-v2 的绝大多数。
 *   2. 道路+号：`海淀学院路17号`、`朝阳建国路88号`——sift 里 99/150 是这种，没有区划后缀。
 *
 * 起点用"从后缀往前回退，跨过已知地名"确定。回退是必需的：中文没有词边界，
 * `寄到武汉市` 里 `武` 前面就是汉字，任何前瞻断言都会把整条丢掉。
 */
const ADDRESS_DIVISION_SUFFIX = /[省市区县旗]/gu;
const ADDRESS_ROAD_SUFFIX = /(?:大道|路|街|巷|胡同|弄)/gu;
// 多字区划后缀。回退是从后缀的**起点**往前数的，所以 `新区` 这类必须单列：
// 对 `上海浦东新区世纪大道 100 号`，从 `区` 回退 2 字只能拿到 `东新区`，
// 从 `新区` 回退 2 字才拿到 `浦东新区`，再左延伸到 `上海`。
const ADDRESS_LONG_DIVISION_SUFFIX =
  /(?:新區|新区|開發區|开发区|高新區|高新区|經濟區|经济区|工業區|工业区|保稅區|保税区|自治州|自治縣|自治县)/gu;
// 回退窗口上限。`中关村南大街` 的专名有 5 个字，`文一西路` 有 4 个。放宽到 6 是安全的：
// 超过 2 字的窗口只在跨过已知地名并落在词开头时才被采纳。
const MAX_ADDRESS_SEED_BACKOFF = 6;
// 三字及以上的省级名称。回退按"最短优先"会在这些名字上少吃一个字，所以显式列出。
const LONG_DIVISION_NAMES = [
  "黑龙江省", "内蒙古自治区", "新疆维吾尔自治区", "宁夏回族自治区", "广西壮族自治区",
  "西藏自治区", "香港特别行政区", "澳门特别行政区",
] as const;

/**
 * 无锚词地址的候选起点。
 *
 * 做法是**从行政区划或道路后缀往前回退**，而不是让正则贪婪地向左吃。
 * 中文没有词边界，`改为上海市` 里 `上` 前面就是汉字，`[\u4e00-\u9fff]{2,4}市` 会把
 * `改为上海市` 整个匹配进来——实测在 semantic-v2 上让精确率掉了 18 个点，因为
 * `改为`、`填写`、`地址为`、`点在`、`后去` 这些散文头全被吃进跨度。
 *
 * 默认取最短回退（2 字），把 `上海市`、`北京市`、`辽宁省`、`蜀山区` 这类两字地名
 * 切得完全正确；更长的窗口只在"真的跨过了已知地名、并且落在词开头"时才被采纳，
 * 这样 `杭州余杭文一西路` 能拿到完整路名，而 `改为上海市` 仍然退回 `上海市`。
 * 三字以上省名由 LONG_DIVISION_NAMES 显式兜住。
 */
function addressSeedStarts(input: string): number[] {
  const starts = new Set<number>();

  for (const name of LONG_DIVISION_NAMES) {
    let index = input.indexOf(name);
    while (index !== -1) {
      starts.add(index);
      index = input.indexOf(name, index + 1);
    }
  }

  for (const pattern of [ADDRESS_LONG_DIVISION_SUFFIX, ADDRESS_DIVISION_SUFFIX, ADDRESS_ROAD_SUFFIX]) {
    const matcher = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(input)) !== null) {
      let fallback: number | null = null;
      let chosen: number | null = null;
      for (let back = 2; back <= MAX_ADDRESS_SEED_BACKOFF; back += 1) {
        const start = match.index - back;
        if (start < 0) {
          break;
        }
        // 逐字检查而不是 [...slice].every：延迟护栏用例会在长文本上反复走这里，
        // 每次回退都分配一个数组的代价可观。
        if (!isHan(input[start] ?? "")) {
          break;
        }
        const extended = extendLeftOverKnownPlace(input, start);
        if (fallback === null) {
          fallback = extended;
        }
        if (extended < start && isCleanLeftBoundary(input, extended)) {
          chosen = extended;
          break;
        }
      }
      const seed = chosen ?? fallback;
      if (seed !== null) {
        starts.add(seed);
      }
    }
  }

  return [...starts].sort((left, right) => left - right);
}

/*
 * 起点左移，跨过紧贴在前的裸省名 / 城市名 / 区名。
 *
 * `浙江杭州西湖文三路 200 号` 从道路后缀回退只能拿到 `文三路`，要连跨三级才回到 gold：
 * 先跨 `西湖`，再跨 `杭州`，再跨 `浙江`。所以这里循环延伸，直到没有已知地名可跨。
 *
 * 按末字建索引。整表约 400 条，每个种子每一级都全表扫一遍会拖垮延迟护栏；
 * 用末字先筛，候选降到个位数。长名在前，保证 `内蒙古` 优先于 `蒙古`。
 */
const KNOWN_BARE_PLACE_NAMES_BY_LAST_CHARACTER = ((): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  const all = [...BARE_DISTRICT_NAMES, ...BARE_CITY_NAMES, ...BARE_PROVINCE_NAMES].sort(
    (left, right) => right.length - left.length,
  );
  for (const place of all) {
    const last = place[place.length - 1] ?? "";
    const bucket = index.get(last);
    if (bucket === undefined) {
      index.set(last, [place]);
    } else {
      bucket.push(place);
    }
  }
  return index;
})();

function extendLeftOverKnownPlace(input: string, start: number): number {
  let cursor = start;
  // 最多三级（区 → 市 → 省）。不设上限会在 `北京北京北京` 这种病态输入上一直走。
  for (let round = 0; round < 3; round += 1) {
    let moved = false;
    for (const place of KNOWN_BARE_PLACE_NAMES_BY_LAST_CHARACTER.get(input[cursor - 1] ?? "") ?? []) {
      if (cursor >= place.length && input.startsWith(place, cursor - place.length)) {
        cursor -= place.length;
        moved = true;
        break;
      }
    }
    if (!moved) {
      break;
    }
  }
  return cursor;
}

/** 跨度左边界是否落在词的开头：文本起点，或前一个字符不是汉字。 */
function isCleanLeftBoundary(input: string, start: number): boolean {
  return start === 0 || !isHan(input[start - 1] ?? "");
}

function findAddressCandidates(input: string, protectedRanges: readonly TextRange[]): SemanticCandidate[] {
  const candidates: SemanticCandidate[] = [];
  const anchorMatcher = new RegExp(ADDRESS_ANCHOR_PATTERN.source, ADDRESS_ANCHOR_PATTERN.flags);
  const seeds: { start: number; reason: SemanticCandidate["reason"] }[] = [];
  let anchor: RegExpExecArray | null;
  while ((anchor = anchorMatcher.exec(input)) !== null) {
    let start = anchor.index + anchor[0].length;
    while (/\s/u.test(input[start] ?? "")) {
      start += 1;
    }
    seeds.push({ start, reason: "address_anchor" });
  }
  for (const start of addressSeedStarts(input)) {
    seeds.push({ start, reason: "address_structure" });
  }

  for (const seed of seeds) {
    const start = seed.start;
    if (start >= input.length || overlapsTextRange(start, start + 1, protectedRanges)) {
      continue;
    }

    let cursor = start;
    while (cursor < input.length && cursor - start < MAX_ADDRESS_LENGTH) {
      const character = input[cursor];
      if (
        character === undefined ||
        ADDRESS_STOP.test(character) ||
        ADDRESS_TAIL_PATTERN.test(input.slice(cursor, cursor + ADDRESS_TAIL_LOOKAHEAD)) ||
        !ADDRESS_CHARACTER.test(character)
      ) {
        break;
      }
      cursor += 1;
    }
    const scanned = trimAddressTail(input.slice(start, cursor));
    const chain = findAddressComponentChain(scanned);
    const value = scanned.slice(chain.start, chain.end);
    const valueStart = start + chain.start;
    const end = valueStart + value.length;
    if (
      end > valueStart &&
      !overlapsTextRange(valueStart, end, protectedRanges) &&
      isAddressCandidate(value, seed.reason === "address_structure")
    ) {
      candidates.push({
        kind: "address",
        start: valueStart,
        end,
        reason: seed.reason,
        // 结构种子少一条锚词证据，所以证据分低一档。命中同一段文本时锚点候选会胜出。
        evidence: seed.reason === "address_anchor" ? 0.85 : 0.78,
      });
    }
  }
  return candidates;
}

export function findHighSignalSemanticCandidates(
  input: string,
  protectedRanges: readonly TextRange[] = [],
): SemanticCandidate[] {
  const candidates = [
    ...findPersonCandidates(input, protectedRanges),
    ...findAddressCandidates(input, protectedRanges),
  ];
  const unique = new Map<string, SemanticCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.kind}:${candidate.start}:${candidate.end}`, candidate);
  }
  // 同一条地址会被多个种子命中：`广东省深圳市南山区科苑路15号` 的 `省`/`市`/`区`/`路`
  // 各出一个种子，得到四个互相嵌套的候选。它们描述的是同一个实体，只保留最宽的那个，
  // 否则用户会为同一段文本被问四次。
  //
  // 按 (start 升, end 降) 排序后单趟扫描即可：排在前面的候选起点不晚于当前候选，
  // 所以 end 被前面的最大 end 盖住就一定是被包含的。两两比较是 O(k²)，在
  // "一万个人名" 的护栏用例上会把 1500ms 的预算直接烧掉。
  const ordered = [...unique.values()].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const kept: SemanticCandidate[] = [];
  const coverEnd = new Map<SemanticCandidate["kind"], number>();
  for (const candidate of ordered) {
    const covered = coverEnd.get(candidate.kind) ?? -1;
    if (candidate.end <= covered) {
      continue;
    }
    coverEnd.set(candidate.kind, candidate.end);
    kept.push(candidate);
  }
  return kept;
}
