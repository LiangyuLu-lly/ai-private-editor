const CHINA_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHINA_ID_CHECK_DIGITS = "10X98765432";
const USCC_CHARACTERS = "0123456789ABCDEFGHJKLMNPQRTUWXY";
const USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

export function isValidChinaResidentId(value: string): boolean {
  const normalized = value.trim().toUpperCase();

  if (!/^\d{17}[\dX]$/.test(normalized)) {
    return false;
  }

  const year = Number.parseInt(normalized.slice(6, 10), 10);
  const month = Number.parseInt(normalized.slice(10, 12), 10);
  const day = Number.parseInt(normalized.slice(12, 14), 10);
  const birthDate = new Date(Date.UTC(year, month - 1, day));

  if (
    birthDate.getUTCFullYear() !== year ||
    birthDate.getUTCMonth() !== month - 1 ||
    birthDate.getUTCDate() !== day
  ) {
    return false;
  }

  const checksum = normalized
    .slice(0, 17)
    .split("")
    .reduce((sum, digit, index) => sum + Number.parseInt(digit, 10) * CHINA_ID_WEIGHTS[index], 0);

  return normalized[17] === CHINA_ID_CHECK_DIGITS[checksum % 11];
}

export function passesLuhnCheck(value: string): boolean {
  const digits = value.replace(/[ -]/g, "");

  if (!/^\d{13,19}$/.test(digits)) {
    return false;
  }

  let total = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number.parseInt(digits[index], 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    total += digit;
    shouldDouble = !shouldDouble;
  }

  return total % 10 === 0;
}

export function isValidUnifiedSocialCreditCode(value: string): boolean {
  const normalized = value.trim().toUpperCase();

  if (!/^[0-9A-Z]{18}$/.test(normalized)) {
    return false;
  }

  let weightedSum = 0;
  for (let index = 0; index < USCC_WEIGHTS.length; index += 1) {
    const characterValue = USCC_CHARACTERS.indexOf(normalized[index]);
    if (characterValue === -1) {
      return false;
    }
    weightedSum += characterValue * USCC_WEIGHTS[index];
  }

  return normalized[17] === USCC_CHARACTERS[(31 - (weightedSum % 31)) % 31];
}

export function isIpv4Address(value: string): boolean {
  const octets = value.split(".");

  // 有意保留前导零（如 010.001.001.001）：拒绝它们会让混淆写法漏检，
  // 而漏检是安全事故，误报只是效用损失。
  if (
    octets.length !== 4 ||
    !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number.parseInt(octet, 10) <= 255)
  ) {
    return false;
  }

  // 回环与通配地址不携带任何可识别信息，替换它们只会干扰技术讨论。
  // 私有地址段（10/172.16-31/192.168）不在此列——内网地址本身就是敏感资产。
  const numbers = octets.map((octet) => Number.parseInt(octet, 10));
  if (numbers[0] === 127) {
    return false;
  }

  return !numbers.every((number) => number === 0) && !numbers.every((number) => number === 255);
}

export function isDigitalInvoiceNumber(value: string): boolean {
  return /^\d{20}$/u.test(value.trim());
}

export function isCourtCaseNumber(value: string): boolean {
  return /^[（(]\d{4}[）)][\u4e00-\u9fff0-9]{1,12}(?:民|刑|行|执|赔|知)[初终再申]?[字]?\d{1,8}号$/u.test(
    value.trim(),
  );
}

export function isMedicalRecordNumber(value: string): boolean {
  return /^\d{6,18}$/u.test(value.trim());
}

const VIN_TRANSLITERATION: Readonly<Record<string, number>> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export function isIso3779Vin(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/u.test(normalized) || !/[A-HJ-NPR-Z]/u.test(normalized) || !/\d/u.test(normalized)) {
    return false;
  }

  let total = 0;
  for (let index = 0; index < VIN_WEIGHTS.length; index += 1) {
    const mapped = VIN_TRANSLITERATION[normalized[index] ?? ""];
    const weight = VIN_WEIGHTS[index];
    if (mapped === undefined) {
      return false;
    }
    total += mapped * weight;
  }

  const remainder = total % 11;
  const check = remainder === 10 ? "X" : String(remainder);
  return normalized[8] === check;
}

const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/u;

function splitIpv6Side(side: string): string[] | null {
  if (side === "") {
    return [];
  }
  const groups = side.split(":");
  return groups.every((group) => IPV6_GROUP.test(group)) ? groups : null;
}

export function isIpv6Address(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes(".") || !trimmed.includes(":")) {
    return false;
  }

  const pieces = trimmed.split("::");
  if (pieces.length > 2) {
    return false;
  }

  const compressed = pieces.length === 2;
  const head = splitIpv6Side(pieces[0] ?? "");
  const tail = compressed ? splitIpv6Side(pieces[1] ?? "") : [];
  if (head === null || tail === null) {
    return false;
  }

  const groupCount = head.length + tail.length;
  if (compressed ? groupCount >= 8 : groupCount !== 8) {
    return false;
  }

  const fill = compressed ? 8 - groupCount : 0;
  const groups = compressed ? [...head, ...Array.from({ length: fill }, () => "0"), ...tail] : head;
  const parts = groups.map((group) => Number.parseInt(group, 16));
  if (parts.length !== 8 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  // 与 IPv4 相同：回环、未指定、链路本地不携带可识别对端信息，替换只会干扰排障讨论。
  if (parts.every((part) => part === 0)) {
    return false;
  }
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return false;
  }
  return ((parts[0] ?? 0) & 0xffc0) !== 0xfe80;
}
