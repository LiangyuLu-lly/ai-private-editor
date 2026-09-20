export type TextRange = readonly [start: number, end: number];

const MAX_UNCLOSED_FENCE_LINES = 2;

function lineEnd(input: string, start: number): number {
  const newline = input.indexOf("\n", start);
  return newline === -1 ? input.length : newline + 1;
}

function fenceAtLineStart(input: string, start: number): { marker: "`" | "~"; length: number } | null {
  const line = input.slice(start, lineEnd(input, start));
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/u);
  if (match?.[1] === undefined) {
    return null;
  }
  const marker = match[1][0];
  return marker === "`" || marker === "~" ? { marker, length: match[1].length } : null;
}

function closingFenceAtLineStart(input: string, start: number, marker: "`" | "~", length: number): boolean {
  const line = input.slice(start, lineEnd(input, start));
  return new RegExp(`^[ \\t]{0,3}${marker}{${length},}[ \\t]*$`, "u").test(line.trimEnd());
}

export function getCodeRanges(input: string): TextRange[] {
  const ranges: TextRange[] = [];
  let lineStart = 0;

  while (lineStart < input.length) {
    const opening = fenceAtLineStart(input, lineStart);
    if (opening === null) {
      lineStart = lineEnd(input, lineStart);
      continue;
    }

    let cursor = lineEnd(input, lineStart);
    let closingEnd: number | null = null;
    let protectedUntil = cursor;
    let lines = 0;
    while (cursor < input.length) {
      lines += 1;
      const nextEnd = lineEnd(input, cursor);
      if (closingFenceAtLineStart(input, cursor, opening.marker, opening.length)) {
        closingEnd = nextEnd;
        break;
      }
      if (lines <= MAX_UNCLOSED_FENCE_LINES) {
        protectedUntil = nextEnd;
      }
      cursor = nextEnd;
    }

    if (closingEnd !== null) {
      ranges.push([lineStart, closingEnd]);
      lineStart = closingEnd;
    } else {
      ranges.push([lineStart, protectedUntil]);
      lineStart = protectedUntil;
    }
  }

  const inlineMatcher = /(?<!\\)`([^`\n]+)`/gu;
  let inline: RegExpExecArray | null;
  while ((inline = inlineMatcher.exec(input)) !== null) {
    ranges.push([inline.index, inline.index + inline[0].length]);
  }

  return ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
}

export function overlapsTextRange(start: number, end: number, ranges: readonly TextRange[]): boolean {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && rangeStart < end);
}

export function isIndexInTextRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}
