/*
 * BIE span decoding for the browser, ported from ml/src/chinese_pii_training/tagging.py and
 * the windowing logic in predict_token_classifier.py.
 *
 * The model emits per-token tag scores; turning those into character spans involves three
 * steps that all have to match the Python side exactly, because the offline numbers in the
 * model cards were measured through this decoder:
 *
 *   1. Constrained Viterbi over the BIE transition rules, so `I-` can only follow `B-`/`I-`
 *      of the same label and a span always closes properly. Greedy argmax produces invalid
 *      tag sequences on roughly the boundary cases that matter.
 *   2. A confidence threshold applied to the chosen tag, computed as softmax over the
 *      original logits at the chosen index — not over the constrained path.
 *   3. Window stitching for text longer than one model window.
 *
 * Ported behaviour that is easy to get wrong is called out inline.
 */

export type DecodedEntity = { start: number; end: number; label: string };

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

type ParsedTag = { prefix: "O" | "B" | "I" | "E"; label: string | null };

function parseTag(tag: string): ParsedTag {
  if (tag === "O") {
    return { prefix: "O", label: null };
  }
  const separator = tag.indexOf("-");
  const prefix = tag.slice(0, separator);
  const label = tag.slice(separator + 1);
  if (separator < 0 || label.length === 0 || (prefix !== "B" && prefix !== "I" && prefix !== "E")) {
    throw new Error(`Invalid sequence tag: ${tag}`);
  }
  return { prefix, label };
}

/**
 * Python's `str.isspace()`, which is wider than JavaScript's `\s`.
 *
 * It matters because a span is allowed to continue across whitespace between tokens. Using
 * `\s` would refuse to bridge U+001C..U+001F and U+0085, closing a span early and leaving
 * the tail of a name or address unmasked.
 */
const PYTHON_WHITESPACE = /^[\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;

export function constrainedBieLabelIds(
  logits: readonly Float32Array[] | readonly number[][],
  validTokens: readonly boolean[],
  labels: readonly string[],
): number[] {
  if (logits.length !== validTokens.length) {
    throw new Error("logits and validTokens must have equal length");
  }
  if (logits.length === 0) {
    return [];
  }
  const labelCount = labels.length;
  const parsed = labels.map(parseTag);
  const oIndex = labels.indexOf("O");
  if (oIndex < 0 || !parsed.some((tag) => tag.prefix === "E")) {
    throw new Error("constrained BIE decoding requires O plus B/I/E labels");
  }

  const canStart = (index: number): boolean => {
    const prefix = parsed[index]?.prefix;
    return prefix === "O" || prefix === "B";
  };
  const canEnd = (index: number): boolean => {
    const prefix = parsed[index]?.prefix;
    return prefix === "O" || prefix === "B" || prefix === "E";
  };
  const canFollow = (previous: number, current: number): boolean => {
    const before = parsed[previous];
    const now = parsed[current];
    if (before === undefined || now === undefined) {
      return false;
    }
    if (now.prefix === "O" || now.prefix === "B") {
      return before.prefix === "O" || before.prefix === "B" || before.prefix === "E";
    }
    return (before.prefix === "B" || before.prefix === "I") && before.label === now.label;
  };

  // A token that covers no characters (special tokens, padding) is forced to O rather than
  // dropped, so the path stays a single chain across the whole window.
  const rows: number[][] = [];
  for (let index = 0; index < logits.length; index += 1) {
    const row = logits[index] as ArrayLike<number>;
    if (row.length !== labelCount) {
      throw new Error("logits width must match the label count");
    }
    if (validTokens[index]) {
      const values: number[] = [];
      for (let column = 0; column < labelCount; column += 1) {
        const value = row[column] as number;
        if (!Number.isFinite(value)) {
          throw new Error("BIE logits must be finite");
        }
        values.push(value);
      }
      rows.push(values);
    } else {
      const masked = new Array<number>(labelCount).fill(NEGATIVE_INFINITY);
      masked[oIndex] = 0;
      rows.push(masked);
    }
  }

  let scores = new Array<number>(labelCount).fill(NEGATIVE_INFINITY);
  for (let index = 0; index < labelCount; index += 1) {
    if (canStart(index)) {
      scores[index] = (rows[0] as number[])[index] as number;
    }
  }
  const backpointers: number[][] = [new Array<number>(labelCount).fill(-1)];

  for (let step = 1; step < rows.length; step += 1) {
    const row = rows[step] as number[];
    const nextScores = new Array<number>(labelCount).fill(NEGATIVE_INFINITY);
    const pointers = new Array<number>(labelCount).fill(-1);
    for (let current = 0; current < labelCount; current += 1) {
      let best = -1;
      let bestScore = NEGATIVE_INFINITY;
      for (let previous = 0; previous < labelCount; previous += 1) {
        if (!canFollow(previous, current)) {
          continue;
        }
        const score = scores[previous] as number;
        // Strict greater-than mirrors Python's max(), which keeps the first maximum.
        if (best < 0 || score > bestScore) {
          best = previous;
          bestScore = score;
        }
      }
      if (best >= 0 && bestScore !== NEGATIVE_INFINITY) {
        nextScores[current] = bestScore + (row[current] as number);
        pointers[current] = best;
      }
    }
    scores = nextScores;
    backpointers.push(pointers);
  }

  let last = -1;
  let lastScore = NEGATIVE_INFINITY;
  for (let index = 0; index < labelCount; index += 1) {
    if (!canEnd(index)) {
      continue;
    }
    const score = scores[index] as number;
    if (last < 0 || score > lastScore) {
      last = index;
      lastScore = score;
    }
  }
  if (last < 0 || lastScore === NEGATIVE_INFINITY) {
    throw new Error("BIE decoder could not produce a valid path");
  }

  const output = [last];
  for (let step = backpointers.length - 1; step > 0; step -= 1) {
    const previous = (backpointers[step] as number[])[output[output.length - 1] as number] as number;
    if (previous < 0) {
      throw new Error("BIE decoder produced an invalid backpointer");
    }
    output.push(previous);
  }
  return output.reverse();
}

/** Softmax probability of `index` within `row`, computed in the max-shifted form Python uses. */
export function softmaxAt(row: ArrayLike<number>, index: number): number {
  let maximum = NEGATIVE_INFINITY;
  for (let column = 0; column < row.length; column += 1) {
    const value = row[column] as number;
    if (value > maximum) {
      maximum = value;
    }
  }
  let denominator = 0;
  for (let column = 0; column < row.length; column += 1) {
    denominator += Math.exp((row[column] as number) - maximum);
  }
  return Math.exp((row[index] as number) - maximum) / denominator;
}

export function decodeBieEntities(
  text: string,
  offsets: readonly [number, number][],
  labelIds: readonly number[],
  confidences: readonly number[],
  labels: readonly string[],
  threshold: number,
): DecodedEntity[] {
  const entities: DecodedEntity[] = [];
  let activeLabel: string | null = null;
  let activeStart = 0;
  let activeEnd = 0;

  const close = (): void => {
    if (activeLabel !== null && activeEnd > activeStart) {
      entities.push({ start: activeStart, end: activeEnd, label: activeLabel });
    }
    activeLabel = null;
    activeStart = 0;
    activeEnd = 0;
  };

  for (let index = 0; index < offsets.length; index += 1) {
    const [start, end] = offsets[index] as [number, number];
    if (start === end) {
      continue;
    }
    const confidence = confidences[index] as number;
    const tag = confidence >= threshold ? (labels[labelIds[index] as number] as string) : "O";
    const { prefix, label } = parseTag(tag);
    if (prefix === "O") {
      close();
      continue;
    }
    if (prefix === "B") {
      close();
      activeLabel = label;
      activeStart = start;
      activeEnd = end;
      continue;
    }
    // A gap between tokens only continues the span if every character in it is whitespace.
    if (activeLabel !== label || (start !== activeEnd && !PYTHON_WHITESPACE.test(text.slice(activeEnd, start)))) {
      close();
      continue;
    }
    activeEnd = end;
    if (prefix === "E") {
      close();
    }
  }
  close();
  return entities;
}

/**
 * Drop spans that touch a window edge where the text continues.
 *
 * A span clipped by the window boundary has an arbitrary edge; the overlapping next window
 * sees the whole thing and contributes the correct span instead.
 */
export function filterWindowBoundaryEntities(
  entities: readonly DecodedEntity[],
  windowStart: number,
  windowEnd: number,
  textLength: number,
): DecodedEntity[] {
  return entities.filter(
    (entity) =>
      !((windowStart > 0 && entity.start === windowStart) || (windowEnd < textLength && entity.end === windowEnd)),
  );
}

/** Deduplicate across windows, preferring longer spans, resolving overlaps deterministically. */
export function mergeWindowEntities(entities: readonly DecodedEntity[]): DecodedEntity[] {
  const ordered = [...entities].sort((left, right) => {
    const byLength = right.end - right.start - (left.end - left.start);
    if (byLength !== 0) {
      return byLength;
    }
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
  });
  const selected: DecodedEntity[] = [];
  for (const entity of ordered) {
    if (selected.some((existing) => entity.start < existing.end && existing.start < entity.end)) {
      continue;
    }
    selected.push(entity);
  }
  return selected.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      (left.label < right.label ? -1 : left.label > right.label ? 1 : 0),
  );
}
