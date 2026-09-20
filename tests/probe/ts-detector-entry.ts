// Entry point for scoring the shipped TypeScript detector against the blind
// probe set. Exposes only what the harness needs.
//
// The extension is what users actually run, so its numbers matter more than any
// research checkpoint's. It also normalizes Unicode before detection, which the
// Python hybrid does not — so this is the only way to measure the product's real
// behaviour on obfuscated input.
import { getDetectionRanges } from "../../src/shared/detector.js";
import { findHighSignalSemanticCandidates } from "../../src/shared/semantic-candidates.js";
import { createLocalStatisticalSemanticProvider } from "../../src/shared/semantic-review.js";

type Ranges = ReturnType<typeof getDetectionRanges>;

function detect(text: string, profile: "conservative" | "balanced"): Ranges {
  return getDetectionRanges(text, [], [], [], {
    detectionProfile: profile,
    ...(profile === "balanced"
      ? { semanticReviewProvider: createLocalStatisticalSemanticProvider() }
      : {}),
  });
}

// Raw semantic candidates with their seed provenance. Boundary bugs are impossible to
// attribute without knowing whether a span came from an anchor or a structural seed —
// the two paths have different left-edge logic, so the fix differs.
function candidates(text: string): ReturnType<typeof findHighSignalSemanticCandidates> {
  return findHighSignalSemanticCandidates(text, []);
}

Object.assign(globalThis, { __tsDetector: { detect, candidates } });
