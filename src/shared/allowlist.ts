import type { CustomTermsSnapshot, SiteAllowlistEntry } from "./custom-terms.js";
import type { ScopedAllowlistValue, SiteId } from "./types.js";

function isUnexpired(entry: { expiresAt?: string }, now: Date): boolean {
  if (entry.expiresAt === undefined) {
    return true;
  }

  const expiresAt = Date.parse(entry.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function laterExpiresAt(left?: string, right?: string): string | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function siteAllowlistKey(entry: SiteAllowlistEntry): string {
  return `${entry.siteId}\0${entry.value}`;
}

function cloneSiteEntry(entry: SiteAllowlistEntry, expiresAt?: string): SiteAllowlistEntry {
  return {
    value: entry.value,
    siteId: entry.siteId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function mergeAllowlists(
  current: {
    readonly allowlistedTerms?: readonly string[];
    readonly siteAllowlist?: readonly SiteAllowlistEntry[];
  },
  incoming: {
    readonly allowlistedTerms?: readonly string[];
    readonly siteAllowlist?: readonly SiteAllowlistEntry[];
  },
): {
  readonly allowlistedTerms: readonly string[];
  readonly siteAllowlist: readonly SiteAllowlistEntry[];
} {
  const allowlistedTerms = [...new Set([...(current.allowlistedTerms ?? []), ...(incoming.allowlistedTerms ?? [])])];
  const byScope = new Map<string, SiteAllowlistEntry>();
  for (const entry of [...(current.siteAllowlist ?? []), ...(incoming.siteAllowlist ?? [])]) {
    const key = siteAllowlistKey(entry);
    const existing = byScope.get(key);
    byScope.set(
      key,
      cloneSiteEntry(entry, existing === undefined ? entry.expiresAt : laterExpiresAt(existing.expiresAt, entry.expiresAt)),
    );
  }
  return {
    allowlistedTerms,
    siteAllowlist: [...byScope.values()],
  };
}

export function resolveScopedAllowlistedTerms(
  snapshot: Extract<CustomTermsSnapshot, { state: "ready" }>,
  siteId: SiteId,
  sessionAllowlistedTerms: ReadonlySet<string>,
  now: Date = new Date(),
): ScopedAllowlistValue[] {
  return [
    ...(snapshot.allowlistedTerms ?? []).map((value) => ({ value, scope: "global" as const })),
    ...(snapshot.siteAllowlist ?? [])
      .filter((entry) => entry.siteId === siteId && isUnexpired(entry, now))
      .map((entry) => ({
        value: entry.value,
        scope: "site" as const,
        ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      })),
    ...[...sessionAllowlistedTerms].map((value) => ({ value, scope: "session" as const })),
  ];
}
