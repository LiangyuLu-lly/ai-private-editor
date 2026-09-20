import { getCodeRanges, type TextRange } from "./code-ranges.js";
import { findHighSignalSemanticCandidates } from "./semantic-candidates.js";
import { LOCAL_STATISTICAL_SEMANTIC_MODEL } from "./semantic-model.js";
import { createDetectionText, sourceRangeFor, type DetectionText } from "./text-normalization.js";

export type SemanticHintKind =
  | "person_name"
  | "address"
  | "account"
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
  | "mac_address";

export type SemanticHint = {
  kind: SemanticHintKind;
  start: number;
  end: number;
  score: number;
  requiresConfirmation: true;
};

export type SemanticReviewProvider = {
  review(input: string): readonly SemanticHint[];
};

export function createNoopSemanticReviewProvider(): SemanticReviewProvider {
  return {
    review: () => [],
  };
}

// This is a window size, not a cutoff. Longer drafts are scanned in overlapping windows.
export const MAX_SEMANTIC_REVIEW_CHARACTERS = 120_000;
const REVIEW_WINDOW_OVERLAP = 160;
const CONTEXT_RADIUS = 16;

function contextAround(input: string, start: number, end: number): string {
  return `${input.slice(Math.max(0, start - CONTEXT_RADIUS), start)} ${input.slice(end, Math.min(input.length, end + CONTEXT_RADIUS))}`;
}

function rangesInWindow(ranges: readonly TextRange[], start: number, end: number): TextRange[] {
  return ranges.flatMap(([rangeStart, rangeEnd]) => {
    if (rangeStart >= end || rangeEnd <= start) {
      return [];
    }
    return [[Math.max(0, rangeStart - start), Math.min(end - start, rangeEnd - start)] as TextRange];
  });
}

function findCandidatesInWindows(input: string, protectedRanges: readonly TextRange[]) {
  if (input.length <= MAX_SEMANTIC_REVIEW_CHARACTERS) {
    return findHighSignalSemanticCandidates(input, protectedRanges);
  }

  const candidates = [] as ReturnType<typeof findHighSignalSemanticCandidates>;
  for (let coreStart = 0; coreStart < input.length; coreStart += MAX_SEMANTIC_REVIEW_CHARACTERS) {
    const coreEnd = Math.min(input.length, coreStart + MAX_SEMANTIC_REVIEW_CHARACTERS);
    const windowStart = Math.max(0, coreStart - REVIEW_WINDOW_OVERLAP);
    const windowEnd = Math.min(input.length, coreEnd + REVIEW_WINDOW_OVERLAP);
    const window = input.slice(windowStart, windowEnd);
    const protectedWindowRanges = rangesInWindow(protectedRanges, windowStart, windowEnd);

    for (const candidate of findHighSignalSemanticCandidates(window, protectedWindowRanges)) {
      const start = candidate.start + windowStart;
      if (start < coreStart || start >= coreEnd) {
        continue;
      }
      candidates.push({ ...candidate, start, end: candidate.end + windowStart });
    }
  }
  return candidates;
}

function createHint(view: DetectionText, candidate: ReturnType<typeof findHighSignalSemanticCandidates>[number]): SemanticHint | null {
  const range = sourceRangeFor(view, candidate.start, candidate.end);
  if (range === null) {
    return null;
  }
  const modelScore = LOCAL_STATISTICAL_SEMANTIC_MODEL.score(
    candidate.kind,
    contextAround(view.text, candidate.start, candidate.end),
  );
  // 有意为之：统计模型只能抬高评分，永远不能否决规则与词表产出的候选。
  // 该模型仅由数十条合成语料训练，让它决定"是否上报"会直接转化为漏检，
  // 而漏检是安全事故、误报只是效用损失。因此 score 只作为附加信号，
  // 消费侧（detector）不用它做任何门控判断，取 max 而非加权融合。
  return {
    kind: candidate.kind,
    start: range.start,
    end: range.end,
    score: Math.max(candidate.evidence, modelScore),
    requiresConfirmation: true,
  };
}

export function createLocalStatisticalSemanticProvider(): SemanticReviewProvider {
  return {
    review(input): readonly SemanticHint[] {
      const view = createDetectionText(input);
      const protectedRanges = getCodeRanges(view.text);
      const hints = findCandidatesInWindows(view.text, protectedRanges)
        .map((candidate) => createHint(view, candidate))
        .filter((hint): hint is SemanticHint => hint !== null);
      const unique = new Map<string, SemanticHint>();
      for (const hint of hints) {
        const key = `${hint.kind}:${hint.start}:${hint.end}`;
        const previous = unique.get(key);
        if (previous === undefined || hint.score > previous.score) {
          unique.set(key, hint);
        }
      }

      return [...unique.values()].sort((left, right) => left.start - right.start || right.end - left.end);
    },
  };
}
