import type {
  CategoryPolicyAction,
  CategoryPolicyEntry,
  DetectionKind,
  SiteId,
} from "./types.js";

export type SiteCategoryPolicy = {
  readonly siteId: SiteId;
  readonly kind: DetectionKind;
  readonly action: CategoryPolicyAction;
};

export function mergeCategoryPolicies(
  global: readonly CategoryPolicyEntry[],
  overlay: readonly SiteCategoryPolicy[],
  siteId: SiteId,
): readonly CategoryPolicyEntry[] {
  const merged = new Map<DetectionKind, CategoryPolicyAction>();
  for (const entry of global) {
    merged.set(entry.kind, entry.action);
  }
  for (const entry of overlay) {
    if (entry.siteId === siteId) {
      merged.set(entry.kind, entry.action);
    }
  }
  return [...merged].map(([kind, action]) => ({ kind, action }));
}
