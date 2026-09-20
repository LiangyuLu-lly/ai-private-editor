/*
 * BertTokenizer for the browser, matching the Python fast tokenizer token-for-token.
 *
 * Why this is hand-ported rather than pulled from a library: the predicted spans are
 * character offsets into the user's draft. If tokenization differs from training by a single
 * token, every offset after that point shifts, and the extension masks the wrong characters
 * while leaving the real value in the outbound text. That failure is silent, so the port is
 * pinned by golden fixtures generated from the actual checkpoint
 * (tests/fixtures/neural-tokenizer-fixtures.json, produced by
 * ml/reports/generated/r7/emit_tokenizer_fixtures.py).
 *
 * Configuration recovered from the checkpoint's tokenizer_config.json:
 *   do_lower_case: true, tokenize_chinese_chars: true, strip_accents: null.
 * With strip_accents unset and lowercasing on, HuggingFace strips accents, so `Café`
 * becomes `cafe` while its offset still covers the original four characters.
 *
 * Offsets are emitted in **UTF-16 code units**, the unit JavaScript strings and the rest of
 * the extension use. The Python offsets are codepoint indices; the two differ for astral
 * characters such as emoji, which is why the fixtures carry both columns.
 */

export type TokenizedText = {
  inputIds: number[];
  /** [start, end) in UTF-16 code units of the input string. Empty for special tokens. */
  offsets: [number, number][];
};

export type BertVocabulary = {
  idByToken: Map<string, number>;
  clsId: number;
  sepId: number;
  padId: number;
  unkId: number;
};

const MAX_CHARACTERS_PER_WORD = 100;
const CONTINUATION_PREFIX = "##";

export function createVocabulary(tokens: readonly string[]): BertVocabulary {
  const idByToken = new Map<string, number>();
  tokens.forEach((token, index) => idByToken.set(token, index));
  const required = ["[CLS]", "[SEP]", "[PAD]", "[UNK]"];
  for (const token of required) {
    if (!idByToken.has(token)) {
      throw new Error(`Vocabulary is missing the required special token ${token}`);
    }
  }
  return {
    idByToken,
    clsId: idByToken.get("[CLS]") as number,
    sepId: idByToken.get("[SEP]") as number,
    padId: idByToken.get("[PAD]") as number,
    unkId: idByToken.get("[UNK]") as number,
  };
}

/** CJK ranges exactly as BasicTokenizer._is_chinese_char defines them. */
function isChineseCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  );
}

/** Matches BasicTokenizer._clean_text: drop NUL and control characters, treat the rest as space. */
function isRemovedCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint === 0xfffd) {
    return true;
  }
  // \t \n \r are whitespace, not control, in BasicTokenizer's classification.
  if (character === "\t" || character === "\n" || character === "\r") {
    return false;
  }
  return /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u.test(character);
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r"
    ? true
    : /\p{Zs}/u.test(character);
}

/** Matches BasicTokenizer._is_punctuation: the four ASCII special ranges plus Unicode P. */
function isPunctuation(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    (codePoint >= 33 && codePoint <= 47) ||
    (codePoint >= 58 && codePoint <= 64) ||
    (codePoint >= 91 && codePoint <= 96) ||
    (codePoint >= 123 && codePoint <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(character);
}

type SourceCharacter = { text: string; start: number; end: number };

/**
 * Normalize per source character, keeping the mapping back to UTF-16 offsets.
 *
 * Lowercasing and accent stripping can change a character's length (`ﬁ` stays one unit here
 * because it is not decomposed by NFD, `Ａ` lowercases to `ａ`). Each produced character keeps
 * the offset span of the source character it came from, so a token's offset always covers
 * whole source characters.
 */
function normalizeCharacters(input: string): SourceCharacter[] {
  const result: SourceCharacter[] = [];
  let offset = 0;
  for (const character of input) {
    const width = character.length;
    const from = offset;
    offset += width;
    if (isRemovedCharacter(character)) {
      continue;
    }
    if (isWhitespace(character)) {
      result.push({ text: " ", start: from, end: offset });
      continue;
    }
    const lowered = character.toLowerCase();
    // NFD then drop combining marks: this is what strip_accents does, and it is enabled
    // implicitly because do_lower_case is true and strip_accents is null.
    //
    // A character that is entirely combining marks disappears — U+FE0F VARIATION SELECTOR-16
    // is category Mn and Python drops it. Restoring it here instead would emit a spurious
    // [UNK] and shift every following offset by one token.
    const stripped = lowered.normalize("NFD").replace(/\p{Mn}/gu, "");
    for (const piece of stripped) {
      result.push({ text: piece, start: from, end: offset });
    }
  }
  return result;
}

/** Split into whitespace-delimited words, isolating CJK characters and punctuation. */
function splitIntoWords(characters: readonly SourceCharacter[]): SourceCharacter[][] {
  const words: SourceCharacter[][] = [];
  let current: SourceCharacter[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      words.push(current);
      current = [];
    }
  };

  for (const character of characters) {
    if (character.text === " ") {
      flush();
      continue;
    }
    const codePoint = character.text.codePointAt(0) ?? 0;
    if (isChineseCodePoint(codePoint) || isPunctuation(character.text)) {
      flush();
      words.push([character]);
      continue;
    }
    current.push(character);
  }
  flush();
  return words;
}

function wordPiece(
  word: readonly SourceCharacter[],
  vocabulary: BertVocabulary,
): { id: number; start: number; end: number }[] {
  const text = word.map((character) => character.text).join("");
  const spanStart = word[0]?.start ?? 0;
  const spanEnd = word[word.length - 1]?.end ?? 0;
  if (text.length > MAX_CHARACTERS_PER_WORD) {
    return [{ id: vocabulary.unkId, start: spanStart, end: spanEnd }];
  }

  const pieces: { id: number; start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < word.length) {
    let end = word.length;
    let matched: number | null = null;
    while (end > cursor) {
      const candidate = word.slice(cursor, end).map((character) => character.text).join("");
      const token = cursor === 0 ? candidate : `${CONTINUATION_PREFIX}${candidate}`;
      const id = vocabulary.idByToken.get(token);
      if (id !== undefined) {
        matched = id;
        break;
      }
      end -= 1;
    }
    if (matched === null) {
      // WordPiece is all-or-nothing per word: one unmatched piece makes the whole word UNK.
      return [{ id: vocabulary.unkId, start: spanStart, end: spanEnd }];
    }
    pieces.push({
      id: matched,
      start: word[cursor]?.start ?? spanStart,
      end: word[end - 1]?.end ?? spanEnd,
    });
    cursor = end;
  }
  return pieces;
}

export function tokenize(input: string, vocabulary: BertVocabulary): TokenizedText {
  const inputIds: number[] = [];
  const offsets: [number, number][] = [];
  for (const word of splitIntoWords(normalizeCharacters(input))) {
    for (const piece of wordPiece(word, vocabulary)) {
      inputIds.push(piece.id);
      offsets.push([piece.start, piece.end]);
    }
  }
  return { inputIds, offsets };
}
