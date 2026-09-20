import type { DetectionKind } from "./types.js";

const TOKEN_PREFIX: Record<DetectionKind, string> = {
  api_key: "API_KEY",
  access_token: "ACCESS_TOKEN",
  private_key: "PRIVATE_KEY",
  connection_string: "CONNECTION_STRING",
  phone: "PHONE",
  email: "EMAIL",
  china_id: "CHINA_ID",
  bank_card: "BANK_CARD",
  unified_social_credit_code: "USCC",
  passport: "PASSPORT",
  license_plate: "LICENSE_PLATE",
  ipv4: "IPV4",
  ipv6: "IPV6",
  local_path: "LOCAL_PATH",
  custom_term: "CUSTOM",
  person_name: "PERSON",
  address: "ADDRESS",
  account: "ACCOUNT",
  labeled_identifier: "IDENTIFIER",
  credential: "CREDENTIAL",
  private_date: "PRIVATE_DATE",
  private_url: "PRIVATE_URL",
  mac_address: "MAC_ADDRESS",
  bank_account: "BANK_ACCOUNT",
};

export type SessionTokenMap = {
  getOrCreate(kind: DetectionKind, normalizedValue: string, rawValue?: string): string;
  getRawValue(token: string): string | null;
  hasToken(token: string): boolean;
  clear(): void;
};

// 单个页面文档内可追踪的不同敏感值上限。正常会话远低于此，触及上限通常意味着
// 异常输入或脚本化滥用。达到上限时必须抛错而不是静默停止分配令牌：
// 后者会让后续敏感值以原文送出，而抛错会被发送链路的 fail-safe 捕获并阻断发送。
export const MAX_SESSION_TOKEN_VALUES = 10_000;

export function createSessionTokenMap(): SessionTokenMap {
  const tokensByValue = new Map<string, string>();
  const rawValuesByToken = new Map<string, string>();
  const countByKind = new Map<DetectionKind, number>();

  return {
    getOrCreate(kind, normalizedValue, rawValue = normalizedValue) {
      const key = `${kind}\u0000${normalizedValue}`;
      const existing = tokensByValue.get(key);
      if (existing !== undefined) {
        return existing;
      }

      if (tokensByValue.size >= MAX_SESSION_TOKEN_VALUES) {
        throw new Error("Session token map capacity exceeded; refusing to emit unmapped sensitive values.");
      }

      const sequence = (countByKind.get(kind) ?? 0) + 1;
      const token = `[[${TOKEN_PREFIX[kind]}_${String(sequence).padStart(3, "0")}]]`;
      countByKind.set(kind, sequence);
      tokensByValue.set(key, token);
      rawValuesByToken.set(token, rawValue);
      return token;
    },
    getRawValue(token) {
      return rawValuesByToken.get(token) ?? null;
    },
    hasToken(token) {
      return rawValuesByToken.has(token);
    },
    clear() {
      tokensByValue.clear();
      rawValuesByToken.clear();
      countByKind.clear();
    },
  };
}
