export type DetectionText = {
  source: string;
  text: string;
  sourceStarts: readonly number[];
  sourceEnds: readonly number[];
};

const DASH_COMPATIBILITY = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/gu;
const INVISIBLE_FORMAT_CHARACTERS = /(?:\p{Cf}|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])/u;
const UNICODE_SPACE_CHARACTERS = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu;
const SEPARATOR_COMPATIBILITY = /[\u00B7\u30FB\u2027\u2219\u22C5\uFF65]/gu;

export function createDetectionText(source: string): DetectionText {
  let text = "";
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let pendingStart: number | null = null;

  for (let start = 0; start < source.length;) {
    const codePoint = source.codePointAt(start);
    if (codePoint === undefined) {
      break;
    }

    const rawCharacter = String.fromCodePoint(codePoint);
    const end = start + rawCharacter.length;
    if (INVISIBLE_FORMAT_CHARACTERS.test(rawCharacter)) {
      if (sourceEnds.length > 0) {
        sourceEnds[sourceEnds.length - 1] = end;
      } else {
        pendingStart ??= start;
      }
      start = end;
      continue;
    }

    const normalizedCharacter = rawCharacter
      .normalize("NFKC")
      .replace(DASH_COMPATIBILITY, "-")
      // Phone numbers and Chinese identifiers are often dictated with a middle-dot
      // separator. Normalizing it to a space lets the existing structured validators
      // preserve source offsets while treating it like the equally common `138 0013` form.
      .replace(SEPARATOR_COMPATIBILITY, " ")
      .replace(UNICODE_SPACE_CHARACTERS, " ");
    for (let index = 0; index < normalizedCharacter.length; index += 1) {
      text += normalizedCharacter[index];
      sourceStarts.push(pendingStart ?? start);
      sourceEnds.push(end);
      pendingStart = null;
    }
    start = end;
  }

  return { source, text, sourceStarts, sourceEnds };
}

export function sourceRangeFor(
  view: DetectionText,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start < 0 || end <= start || end > view.sourceStarts.length) {
    return null;
  }

  const sourceStart = view.sourceStarts[start];
  const sourceEnd = view.sourceEnds[end - 1];
  return sourceStart === undefined || sourceEnd === undefined || sourceEnd <= sourceStart
    ? null
    : { start: sourceStart, end: sourceEnd };
}
