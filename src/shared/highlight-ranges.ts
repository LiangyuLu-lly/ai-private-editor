import type { DetectionKind } from "./types.js";

export type HighlightRange = {
  readonly kind: DetectionKind;
  readonly start: number;
  readonly end: number;
};

export type HighlightRangeOptions = {
  readonly kindPrecedence?: Readonly<Record<DetectionKind, number>>;
};

export type HighlightOverlayFactory = {
  readonly create: (ranges: readonly HighlightRange[]) => HTMLElement;
};

const KIND_PRECEDENCE: Record<DetectionKind, number> = {
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

function isUsableRange(range: HighlightRange, length: number): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end <= length &&
    range.end > range.start
  );
}

function mergeHighlightRanges(
  ranges: readonly HighlightRange[],
  table: Readonly<Record<DetectionKind, number>>,
): readonly HighlightRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const seen = new Set<number>();
  const points: number[] = [];
  for (const range of ranges) {
    if (!seen.has(range.start)) {
      seen.add(range.start);
      points.push(range.start);
    }
    if (!seen.has(range.end)) {
      seen.add(range.end);
      points.push(range.end);
    }
  }
  points.sort((left, right) => left - right);

  const merged: HighlightRange[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === undefined || end === undefined || start >= end) {
      continue;
    }
    let winner: DetectionKind | undefined;
    let winnerRank = Number.POSITIVE_INFINITY;
    for (const range of ranges) {
      if (range.start > start || range.end < end) {
        continue;
      }
      const rank = table[range.kind];
      if (winner === undefined || rank < winnerRank || (rank === winnerRank && range.kind < winner)) {
        winner = range.kind;
        winnerRank = rank;
      }
    }
    if (winner === undefined) {
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.kind === winner && previous.end === start) {
      merged[merged.length - 1] = { kind: winner, start: previous.start, end };
    } else {
      merged.push({ kind: winner, start, end });
    }
  }
  return merged;
}

export function buildHighlightRanges(
  htmlOrText: string,
  ranges: readonly HighlightRange[],
  options: HighlightRangeOptions = {},
): readonly HighlightRange[] {
  const table = options.kindPrecedence ?? KIND_PRECEDENCE;
  const usable: HighlightRange[] = [];
  for (const range of ranges) {
    if (!isUsableRange(range, htmlOrText.length)) {
      continue;
    }
    usable.push({ kind: range.kind, start: range.start, end: range.end });
  }
  return mergeHighlightRanges(usable, table);
}

/**
 * Overlay marks sit above the composer with pointer-events: none; they never wrap text nodes.
 */
export function createHighlightOverlayFactory(doc: Document): HighlightOverlayFactory {
  return {
    create(ranges: readonly HighlightRange[]): HTMLElement {
      const root = doc.createElement("div");
      root.style.pointerEvents = "none";
      root.style.position = "absolute";
      root.style.inset = "0";
      for (const range of ranges) {
        const mark = doc.createElement("span");
        mark.dataset.kind = range.kind;
        mark.style.pointerEvents = "none";
        mark.style.position = "absolute";
        mark.style.left = `${range.start}ch`;
        mark.style.width = `${range.end - range.start}ch`;
        mark.style.top = "0";
        mark.style.height = "1em";
        root.appendChild(mark);
      }
      return root;
    },
  };
}
