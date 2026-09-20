import type { DetectionKind, RedactionFinding, SiteId } from "./types.js";

export const AUDIT_LOG_STORAGE_KEY = "localAuditLog";
export const MAX_AUDIT_EVENTS = 100;

export type AuditOperation = "send" | "paste";
export type AuditOutcome = "anonymized" | "raw_confirmed" | "cancelled" | "blocked";
export type AuditFinding = { kind: DetectionKind; count: number };
export type AuditEvent = {
  occurredAt: string;
  siteId: SiteId;
  operation: AuditOperation;
  outcome: AuditOutcome;
  findings: readonly AuditFinding[];
};
export type AuditEventInput = {
  siteId: SiteId;
  operation: AuditOperation;
  outcome: AuditOutcome;
  findings: readonly Pick<RedactionFinding, "kind" | "count">[];
};

export type AuditLogReadResult =
  | { ok: true; events: readonly AuditEvent[] }
  | { ok: false; error: "invalid_storage" | "storage_read_failed" };
export type AuditLogMutationResult = { ok: true } | { ok: false; error: "invalid_storage" | "storage_write_failed" };

export type AuditLogStorage = {
  readValue(): Promise<unknown>;
  writeValue(events: readonly AuditEvent[]): Promise<void>;
  subscribe(listener: (nextValue: unknown) => void): () => void;
};

export type AuditLogStore = {
  read(): Promise<AuditLogReadResult>;
  append(event: AuditEventInput): Promise<AuditLogMutationResult>;
  clear(): Promise<AuditLogMutationResult>;
  subscribe(listener: (result: AuditLogReadResult) => void): () => void;
};

export const AUDIT_LOG_EXPORT_SCHEMA_VERSION = 1 as const;

export type AuditLogExportEvent = {
  readonly site: SiteId;
  readonly operation: AuditOperation;
  readonly outcome: AuditOutcome;
  readonly kinds: readonly AuditFinding[];
};

export type AuditLogExport = {
  readonly schemaVersion: typeof AUDIT_LOG_EXPORT_SCHEMA_VERSION;
  readonly events: readonly AuditLogExportEvent[];
  readonly contentHash: string;
};

const SITE_IDS: readonly SiteId[] = [
  "doubao",
  "deepseek",
  "yuanbao",
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "qwen",
  "wenxin",
];
const DETECTION_KINDS: readonly DetectionKind[] = [
  "api_key",
  "access_token",
  "private_key",
  "connection_string",
  "phone",
  "email",
  "china_id",
  "bank_card",
  "unified_social_credit_code",
  "passport",
  "license_plate",
  "ipv4",
  "ipv6",
  "local_path",
  "custom_term",
  "person_name",
  "address",
  "account",
  "labeled_identifier",
  "credential",
  "private_date",
  "private_url",
  "mac_address",
  "bank_account",
];
const AUDIT_OPERATIONS: readonly AuditOperation[] = ["send", "paste"];
const AUDIT_OUTCOMES: readonly AuditOutcome[] = ["anonymized", "raw_confirmed", "cancelled", "blocked"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const valueKeys = Object.keys(value);
  return valueKeys.length === keys.length && keys.every((key) => key in value);
}

function isSiteId(value: unknown): value is SiteId {
  return typeof value === "string" && SITE_IDS.includes(value as SiteId);
}

function isDetectionKind(value: unknown): value is DetectionKind {
  return typeof value === "string" && DETECTION_KINDS.includes(value as DetectionKind);
}

function isAuditOperation(value: unknown): value is AuditOperation {
  return typeof value === "string" && AUDIT_OPERATIONS.includes(value as AuditOperation);
}

function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === "string" && AUDIT_OUTCOMES.includes(value as AuditOutcome);
}

function sanitizeFindings(value: unknown, strict: boolean): AuditFinding[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > DETECTION_KINDS.length) {
    return null;
  }

  const counts = new Map<DetectionKind, number>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      (strict && !hasExactKeys(item, ["kind", "count"])) ||
      !isDetectionKind(item.kind) ||
      typeof item.count !== "number" ||
      !Number.isSafeInteger(item.count) ||
      item.count < 1
    ) {
      return null;
    }

    counts.set(item.kind, (counts.get(item.kind) ?? 0) + item.count);
  }

  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

function parseAuditEvents(value: unknown): AuditLogReadResult {
  if (value === undefined) {
    return { ok: true, events: [] };
  }

  if (!Array.isArray(value) || value.length > MAX_AUDIT_EVENTS) {
    return { ok: false, error: "invalid_storage" };
  }

  const events: AuditEvent[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["occurredAt", "siteId", "operation", "outcome", "findings"]) ||
      typeof item.occurredAt !== "string" ||
      item.occurredAt.length === 0 ||
      item.occurredAt.length > 64 ||
      !isSiteId(item.siteId) ||
      !isAuditOperation(item.operation) ||
      !isAuditOutcome(item.outcome)
    ) {
      return { ok: false, error: "invalid_storage" };
    }

    const findings = sanitizeFindings(item.findings, true);
    if (findings === null) {
      return { ok: false, error: "invalid_storage" };
    }

    events.push({
      occurredAt: item.occurredAt,
      siteId: item.siteId,
      operation: item.operation,
      outcome: item.outcome,
      findings,
    });
  }

  return { ok: true, events };
}

function toWriteFailure(): AuditLogMutationResult {
  return { ok: false, error: "storage_write_failed" };
}

export function createAuditLogStore(
  storage: AuditLogStorage,
  now: () => string = () => new Date().toISOString(),
): AuditLogStore {
  const read = async (): Promise<AuditLogReadResult> => {
    try {
      return parseAuditEvents(await storage.readValue());
    } catch {
      return { ok: false, error: "storage_read_failed" };
    }
  };
  let mutationTail = Promise.resolve();

  const enqueueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    read,
    append(input) {
      const findings = sanitizeFindings(input.findings, false);
      if (findings === null || !isSiteId(input.siteId) || !isAuditOperation(input.operation) || !isAuditOutcome(input.outcome)) {
        return Promise.resolve({ ok: false, error: "invalid_storage" });
      }

      return enqueueMutation(async () => {
        const current = await read();
        if (!current.ok) {
          return current.error === "invalid_storage" ? { ok: false, error: "invalid_storage" } : toWriteFailure();
        }

        const event: AuditEvent = {
          occurredAt: now(),
          siteId: input.siteId,
          operation: input.operation,
          outcome: input.outcome,
          findings,
        };
        try {
          await storage.writeValue([...current.events.slice(-(MAX_AUDIT_EVENTS - 1)), event]);
          return { ok: true };
        } catch {
          return toWriteFailure();
        }
      });
    },
    clear() {
      return enqueueMutation(async () => {
        try {
          await storage.writeValue([]);
          return { ok: true };
        } catch {
          return toWriteFailure();
        }
      });
    },
    subscribe(listener) {
      return storage.subscribe((nextValue) => listener(parseAuditEvents(nextValue)));
    },
  };
}

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.get === "function" &&
    typeof chrome.storage.local.set === "function" &&
    typeof chrome.storage.onChanged?.addListener === "function" &&
    typeof chrome.storage.onChanged.removeListener === "function"
  );
}

function toCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(toCanonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${toCanonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function exportAuditLog(store: AuditLogStore): Promise<AuditLogExport> {
  const read = await store.read();
  if (!read.ok) {
    throw new Error(read.error);
  }

  const events = read.events.slice(-MAX_AUDIT_EVENTS).map((event) => ({
    site: event.siteId,
    operation: event.operation,
    outcome: event.outcome,
    kinds: event.findings.map((finding) => ({ kind: finding.kind, count: finding.count })),
  }));
  const payload = { schemaVersion: AUDIT_LOG_EXPORT_SCHEMA_VERSION, events };
  return { ...payload, contentHash: await sha256Hex(toCanonicalJson(payload)) };
}

export function createChromeAuditLogStore(): AuditLogStore {
  if (!hasChromeStorage()) {
    const unavailableRead = async (): Promise<AuditLogReadResult> => ({ ok: false, error: "storage_read_failed" });
    const unavailableMutation = async (): Promise<AuditLogMutationResult> => toWriteFailure();

    return {
      read: unavailableRead,
      append: unavailableMutation,
      clear: unavailableMutation,
      subscribe: () => () => undefined,
    };
  }

  return createAuditLogStore({
    async readValue() {
      const values = await chrome.storage.local.get(AUDIT_LOG_STORAGE_KEY);
      return values[AUDIT_LOG_STORAGE_KEY];
    },
    async writeValue(events) {
      await chrome.storage.local.set({
        [AUDIT_LOG_STORAGE_KEY]: events.map((event) => ({
          occurredAt: event.occurredAt,
          siteId: event.siteId,
          operation: event.operation,
          outcome: event.outcome,
          findings: event.findings.map((finding) => ({ kind: finding.kind, count: finding.count })),
        })),
      });
    },
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
        if (areaName === "local" && AUDIT_LOG_STORAGE_KEY in changes) {
          listener(changes[AUDIT_LOG_STORAGE_KEY]?.newValue);
        }
      };

      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  });
}
