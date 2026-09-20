export type SiteId =
  | "doubao"
  | "deepseek"
  | "yuanbao"
  | "chatgpt"
  | "claude"
  | "gemini"
  | "kimi"
  | "qwen"
  | "wenxin";

export type DetectionKind =
  | "api_key"
  | "access_token"
  | "private_key"
  | "connection_string"
  | "phone"
  | "email"
  | "china_id"
  | "bank_card"
  | "unified_social_credit_code"
  | "passport"
  | "license_plate"
  | "ipv4"
  | "ipv6"
  | "local_path"
  | "custom_term"
  | "person_name"
  | "address"
  | "account"
  | "labeled_identifier"
  | "credential"
  | "private_date"
  | "private_url"
  | "mac_address"
  | "bank_account";

export type RedactionDecision = "block" | "replace";
export type SensitiveActionDecision = "redact" | "raw_once" | "session" | "cancel";
export type CategoryPolicyAction = "replace" | "confirm" | "block";
export type CategoryPolicyEntry = { kind: DetectionKind; action: CategoryPolicyAction };
export type DetectionProfile = "conservative" | "balanced";
export type ReplacementStyle = "token" | "masked" | "surrogate";
export type AttachmentAction = "allow" | "warn" | "confirm" | "block";
/*
 * `local_statistical` runs the rule and lexicon candidates plus the small in-source scoring
 * model. `local_neural` additionally warms the distilled student in an offscreen document while
 * the user types. On send, the controller stops the native event, reviews the exact final draft,
 * then re-enters the detector; an unavailable review requires an explicit one-time raw send or
 * cancellation. Both stay on the device.
 */
export type SemanticReviewMode = "off" | "local_statistical" | "local_neural";
export type AllowlistScope = "global" | "site" | "session";
export type ScopedAllowlistValue = {
  value: string;
  scope: AllowlistScope;
  expiresAt?: string;
};

export type RedactionFinding = {
  kind: DetectionKind;
  decision: RedactionDecision;
  count: number;
  labels?: readonly string[];
  policy?: CategoryPolicyAction;
  inferred?: boolean;
  warning?: "credential_too_long";
};

export type DraftAnalysis = {
  findings: RedactionFinding[];
  redactedText: string;
};

export type SendAction = "native" | "replace" | "confirm" | "block";

export type RedactionResult =
  | {
      status: "blocked";
      outboundText: null;
      findings: RedactionFinding[];
    }
  | {
      status: "ready";
      outboundText: string;
      findings: RedactionFinding[];
    };

export type PingMessage = {
  type: "PING";
};

export type PageSiteStatusResponse =
  | { site: null }
  | {
      site: SiteId;
      bindingKey: string;
    };

export type SiteStatusResponse =
  | { site: null }
  | {
      site: SiteId;
      tabId: number;
      bindingKey: string;
    };

export type FillDraftMessage = {
  type: "FILL_DRAFT";
  outboundText: string;
  site: SiteId;
  tabId: number;
  bindingKey: string;
};

export type RuntimeMessage = PingMessage | FillDraftMessage;

export type FillError =
  | "unsupported_site"
  | "site_changed"
  | "binding_changed"
  | "editor_not_found"
  | "write_failed"
  | "content_script_unavailable"
  | "invalid_message";

export type FillResponse =
  | { ok: true }
  | {
      ok: false;
      error: FillError;
    };

export type RuntimeResponse = FillResponse | PageSiteStatusResponse;
