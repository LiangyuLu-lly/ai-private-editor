/*
 * Turn a draft into semantic hints with the local student model.
 *
 * Extracted so the offscreen document and the offline evaluation harness share one
 * implementation. If they diverged, the numbers used to justify shipping the model would
 * describe code the extension does not run.
 *
 * The model receives the raw draft. Its tokenizer performs the training-time cleanup of
 * zero-width and control characters while retaining source offsets, so compatibility rewrites
 * such as NFKC do not change the context distribution the checkpoint was trained on.
 */

import type { SemanticHint } from "../semantic-review.js";
import { parseChineseNameAt } from "../semantic-candidates.js";
import { predictEntities, type InferenceRunner } from "./session.js";
import type { BertVocabulary } from "./tokenizer.js";

export type NeuralReviewSettings = {
  vocabulary: BertVocabulary;
  labels: readonly string[];
  threshold: number;
  maxLength?: number;
  stride?: number;
};

/**
 * The model's confidence is not carried into the hint score.
 *
 * `semantic-review.ts` records the reason: the consuming detector must not gate on a score, so
 * a fixed high value keeps the hint reportable while leaving the accept/reject decision to the
 * threshold that was selected on validation. Letting a per-span probability leak into a
 * downstream gate would turn a model miss into a leak.
 */
const HINT_SCORE = 0.9;

const MODEL_LABEL_TO_HINT_KIND: Readonly<Record<string, SemanticHint["kind"]>> = {
  PERSON: "person_name",
  ADDRESS: "address",
  ACCOUNT_ALIAS: "account",
  CN_PHONE: "phone",
  EMAIL: "email",
  CN_ID: "china_id",
  BANK_CARD: "bank_card",
  LICENSE_PLATE: "license_plate",
  PASSPORT: "passport",
  PRIVATE_DATE: "private_date",
  SOCIAL_ACCOUNT: "account",
  BANK_ACCOUNT: "bank_account",
  CREDENTIAL: "credential",
  API_KEY: "api_key",
  ACCESS_TOKEN: "access_token",
  EMPLOYEE_ID: "labeled_identifier",
  HEALTH_RECORD: "labeled_identifier",
  VEHICLE_VIN: "labeled_identifier",
  IP_ADDRESS: "ipv4",
  MAC_ADDRESS: "mac_address",
};

/*
 * Organisation and landmark names the model still reads as people.
 *
 * This is a verbatim port of `COMMON_NON_PERSON_NAMES` in `ml/src/chinese_pii_training/hybrid.py`,
 * the research pipeline's semantic post-filter. Every teacher-side pollution number in the R3-R6
 * model cards was measured with that filter applied; the extension had no equivalent, which is part
 * of why the shipped student's clean-document numbers looked so much worse than its teacher's.
 *
 * Only this one piece of that filter is ported, and the reason is measurement rather than taste.
 * `ml/reports/generated/r7/measure_config_matrix.py` scored six variants of it across six evaluation
 * sets and 19,500 documents:
 *
 *   - exact match on the original seven names: removes 192 false positives, deletes **0** spans that
 *     match gold, and moves no leak metric on any set.
 *   - the same filter plus hybrid.py's context regex (公司|集团|…|历史|作品|诗人|公开课|展览):
 *     removes far more pollution but deletes 66-221 real names — `陈志远`, `林晓东`, `王雪` sitting
 *     within ten characters of 公司 — and raises `charLeak`.
 *
 * A miss is a safety failure and a false positive costs one confirmation click, so only the variant
 * with zero measured recall cost ships. The larger variants are recorded in docs/r7-model-card.md as
 * measured and declined, not as future work that was forgotten.
 *
 * `黄鹤楼` and `天安门` are the same class as `王府井` / `中关村` (landmark-shaped, not a plausible
 * personal name). They were added from the R9 mixed-validation diagnostic, not mined from the six
 * eval sets. Person-shaped public figures are deliberately absent: an exact-match drop of `李白`
 * would leak.
 *
 * Exact match, deliberately, not substring and not a regex over organisation markers. The
 * extension's own `isPersonNegative` takes the regex route and it costs real names: `云` is an
 * organisation marker, so the rule that suppresses `马云` also deletes `云丽`, `馨云` and `筑云`.
 * Twelve gold-matching names on OpenPII alone.
 *
 * Simplified forms only, matching hybrid.py. The model is trained on simplified Chinese and the
 * normalized view does not convert between scripts, so adding traditional variants here would be
 * adding untested surface.
 */
const NON_PERSON_ORGANISATION_NAMES: ReadonlySet<string> = new Set([
  "华为",
  "腾讯",
  "小米",
  "阿里",
  "百度",
  "王府井",
  "中关村",
  "黄鹤楼",
  "天安门",
]);

/**
 * Is this span an organisation the model mislabelled as a person?
 *
 * Exported for the golden-fixture test that pins it against the Python predicate.
 */
export function isNonPersonOrganisation(value: string): boolean {
  return NON_PERSON_ORGANISATION_NAMES.has(value);
}

export function repairPersonEntityToUniqueName(text: string, start: number, end: number): { start: number; end: number } | null {
  const names: { start: number; end: number }[] = [];
  const searchStart = Math.max(0, start - 4);
  const searchEnd = Math.min(text.length, end + 4);
  for (let cursor = searchStart; cursor < searchEnd; cursor += 1) {
    const parsed = parseChineseNameAt(text, cursor);
    if (
      parsed !== null &&
      (parsed.start < end && start < parsed.end || parsed.start >= end && parsed.start - end <= 2)
    ) {
      names.push(parsed);
      cursor = parsed.end - 1;
    }
  }
  const unique = new Map(names.map((name) => [`${name.start}:${name.end}`, name]));
  const candidates = [...unique.values()];
  const exact = candidates.find((name) => name.start === start && name.end === end);
  if (exact !== undefined) {
    return exact;
  }
  const leftExpansion = candidates.filter(
    (name) => name.start < start && start - name.start <= 2 && Math.abs(name.end - end) <= 3,
  );
  if (leftExpansion.length === 1) {
    return leftExpansion[0] ?? null;
  }
  const anchoredStart = candidates.filter(
    (name) => name.start === start && name.end <= end && end - name.end <= 2,
  );
  if (anchoredStart.length === 1) {
    return anchoredStart[0] ?? null;
  }
  const contained = candidates.filter((name) => name.start >= start && name.end <= end);
  if (contained.length === 1) {
    return contained[0] ?? null;
  }

  // A model span can end on a copula immediately before the actual name (for example, "方是纪予蕴").
  // Only repair this right-shift when the boundary word and the unique adjacent name make the
  // intended structure explicit; arbitrary adjacent Chinese text remains untouched.
  const rightExpansion = candidates.filter(
    (name) => name.start >= end && name.start - end <= 2 && /[是为叫]$/u.test(text.slice(start, end)),
  );
  return rightExpansion.length === 1 ? rightExpansion[0] ?? null : null;
}

const ACCOUNT_TOKEN_PATTERNS: readonly RegExp[] = [
  /@?[A-Za-z][A-Za-z0-9._-]{2,63}/u,
  /@?[\p{Script=Han}]{1,8}[_@.-][A-Za-z0-9][A-Za-z0-9._-]{1,63}/u,
  /@?\d{5,10}/u,
];

/**
 * Model account spans are more likely than person spans to run through a closing quote or the
 * prose after a value. Keep the first account-shaped token and map that sub-range to source text;
 * the detector still decides whether the token has enough surrounding evidence.
 */
export function repairAccountEntityToToken(text: string, start: number, end: number): { start: number; end: number } | null {
  const searchStart = Math.max(0, start - 8);
  const raw = text.slice(searchStart, end);
  const candidates = ACCOUNT_TOKEN_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(raw);
    const candidate = match === null
      ? []
      : [{ start: searchStart + match.index, end: searchStart + match.index + match[0].length }];
    return candidate.filter((range) => range.start < end && range.end > start);
  });
  const directMixedMatch = /^@?[\p{Script=Han}]{1,8}[0-9]{2,10}/u.exec(text.slice(start, end));
  if (directMixedMatch !== null) {
    candidates.push({ start, end: start + directMixedMatch[0].length });
  }
  const prefix = text.slice(searchStart, start);
  const prefixMatch = /[\p{Script=Han}]{1,8}[_@.-]$/u.exec(prefix);
  if (prefixMatch !== null && /^[A-Za-z0-9]/u.test(text[start] ?? "")) {
    const suffixToken = candidates.find((range) => range.start === start && range.end > start);
    candidates.push({
      start: start - prefixMatch[0].length,
      end: suffixToken?.end ?? end,
    });
  }
  const prefixedToken = candidates.find(
    (range) => range.start < start && range.end > start && /[\p{Script=Han}]{1,8}[_@.-]$/u.test(text.slice(range.start, start)),
  );
  if (prefixedToken !== undefined) {
    return prefixedToken;
  }
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const startOrder = left.start - right.start;
    if (startOrder !== 0) {
      return startOrder;
    }
    return (right.end - right.start) - (left.end - left.start);
  });
  return candidates[0] ?? null;
}

function shouldApplyPersonRepair(
  text: string,
  start: number,
  end: number,
  repaired: { start: number; end: number },
): boolean {
  if (repaired.start === start && repaired.end === end) {
    return true;
  }
  const raw = text.slice(start, end);
  const compact = raw.replace(/[\s·・]/gu, "");
  const isLikelyCompleteName = /^[\p{Script=Han}]+$/u.test(compact) &&
    (compact.length <= 4 || /[\s·・]/u.test(raw));
  if (!isLikelyCompleteName) {
    return true;
  }
  if (repaired.start < start || repaired.end > end) {
    return true;
  }
  return repaired.start >= end && /[是为叫]$/u.test(raw);
}

function isFixedNonPersonSyntaxFragment(text: string, start: number, end: number): boolean {
  const value = text.slice(start, end);
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, Math.min(text.length, end + 32));
  if (value === "别复制") {
    return /接送通知$/u.test(before) && /^[，,]/u.test(after);
  }
  if (value === "方" || value === "方是") {
    return /退款接收$/u.test(before) && (value === "方是" || /^是/u.test(after));
  }
  return value === "搜" && /去$/u.test(before) && /^[A-Za-z][A-Za-z0-9._-]{3,}/u.test(after);
}

export async function reviewWithModel(
  text: string,
  settings: NeuralReviewSettings,
  runner: InferenceRunner,
): Promise<SemanticHint[]> {
  const { entities } = await predictEntities(
    text,
    settings.vocabulary,
    settings.labels,
    settings.threshold,
    runner,
    settings.maxLength,
    settings.stride,
  );

  const hints: SemanticHint[] = [];
  for (const entity of entities) {
    const kind = MODEL_LABEL_TO_HINT_KIND[entity.label] ?? null;
    if (kind === null) {
      continue;
    }
    if (kind === "person_name" && !/\p{Script=Han}/u.test(text.slice(entity.start, entity.end))) {
      continue;
    }
    const rawRange = { start: entity.start, end: entity.end };
    const repairedPersonRange = kind === "person_name"
      ? repairPersonEntityToUniqueName(text, entity.start, entity.end)
      : null;
    const repairedAccountRange = kind === "account"
      ? repairAccountEntityToToken(text, entity.start, entity.end)
      : null;
    const normalizedRange = repairedPersonRange !== null && shouldApplyPersonRepair(
      text,
      entity.start,
      entity.end,
      repairedPersonRange,
    )
      ? repairedPersonRange
      : repairedAccountRange ?? rawRange;
    if (kind === "person_name" && isFixedNonPersonSyntaxFragment(
      text,
      normalizedRange.start,
      normalizedRange.end,
    )) {
      continue;
    }
    const range = normalizedRange;
    // Compared against the *source* slice, not the normalized one, because that is the text the
    // offline measurement filtered on and the two must not drift. For these listed names the two are
    // identical anyway; taking the source slice keeps it that way if the name set ever grows.
    if (kind === "person_name" && isNonPersonOrganisation(text.slice(range.start, range.end))) {
      continue;
    }
    hints.push({ kind, start: range.start, end: range.end, score: HINT_SCORE, requiresConfirmation: true });
  }
  return hints;
}
