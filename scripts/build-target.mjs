import { isAbsolute, relative, resolve, sep } from "node:path";

const PROTECTED_RELEASE_CANDIDATE = "r14-release-candidate-20260911-isolated";

/**
 * Resolve the build output without allowing an alternate target to erase project assets.
 *
 * The default remains the historical root `dist` directory. An explicit target is only for
 * isolated browser evidence and must be a child directory of `.harness-tmp`; the known protected
 * release-candidate directory is rejected even though it is under that parent.
 */
export function resolveBuildDirectory(root, requested = process.env.PRIVATE_COMPOSER_BUILD_DIR) {
  const defaultDirectory = resolve(root, "dist");
  if (requested === undefined || requested.trim().length === 0) {
    return defaultDirectory;
  }

  const harnessRoot = resolve(root, ".harness-tmp");
  const target = resolve(root, requested);
  const relationship = relative(harnessRoot, target);
  const isHarnessChild = relationship.length > 0 &&
    relationship !== ".." &&
    !relationship.startsWith(`..${sep}`) &&
    !isAbsolute(relationship);
  if (!isHarnessChild) {
    throw new Error(
      "PRIVATE_COMPOSER_BUILD_DIR must point to a fresh directory under .harness-tmp.",
    );
  }

  const protectedDirectory = resolve(harnessRoot, PROTECTED_RELEASE_CANDIDATE);
  const normalizedTarget = target.toLowerCase();
  const normalizedProtected = protectedDirectory.toLowerCase();
  if (normalizedTarget === normalizedProtected || normalizedTarget.startsWith(`${normalizedProtected}${sep}`)) {
    throw new Error("PRIVATE_COMPOSER_BUILD_DIR points to the protected release-candidate directory.");
  }

  return target;
}
