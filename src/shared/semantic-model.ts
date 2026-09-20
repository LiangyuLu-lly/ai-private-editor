import {
  SEMANTIC_MODEL_CORPUS,
  type SemanticModelKind,
} from "./semantic-model-corpus.js";

type SemanticModel = {
  score(kind: SemanticModelKind, context: string): number;
};

type ModelCounts = {
  positive: Map<string, number>;
  negative: Map<string, number>;
  positiveSamples: number;
  negativeSamples: number;
  vocabulary: ReadonlySet<string>;
  positiveDenominator: number;
  negativeDenominator: number;
};

function features(input: string): string[] {
  const compact = input.replace(/\s+/gu, "");
  const result = new Set<string>();

  for (let index = 0; index < compact.length; index += 1) {
    result.add(compact[index] ?? "");
    if (index + 1 < compact.length) {
      result.add(compact.slice(index, index + 2));
    }
  }

  return [...result];
}

function buildModel(): SemanticModel {
  const counts = new Map<SemanticModelKind, ModelCounts>();

  for (const kind of ["person_name", "address"] as const) {
    counts.set(kind, {
      positive: new Map(),
      negative: new Map(),
      positiveSamples: 0,
      negativeSamples: 0,
      vocabulary: new Set(),
      positiveDenominator: 1,
      negativeDenominator: 1,
    });
  }

  for (const sample of SEMANTIC_MODEL_CORPUS) {
    const current = counts.get(sample.kind);
    if (current === undefined) {
      continue;
    }

    const target = sample.positive ? current.positive : current.negative;
    if (sample.positive) {
      current.positiveSamples += 1;
    } else {
      current.negativeSamples += 1;
    }
    for (const feature of features(sample.context)) {
      target.set(feature, (target.get(feature) ?? 0) + 1);
    }
  }

  for (const current of counts.values()) {
    const vocabulary = new Set([...current.positive.keys(), ...current.negative.keys()]);
    current.vocabulary = vocabulary;
    current.positiveDenominator = current.positiveSamples + vocabulary.size;
    current.negativeDenominator = current.negativeSamples + vocabulary.size;
  }

  return {
    score(kind, context): number {
      const current = counts.get(kind);
      if (current === undefined) {
        return 0;
      }

      let positiveEvidence = 0;
      let logOdds = Math.log((current.positiveSamples + 1) / (current.negativeSamples + 1));

      for (const feature of features(context)) {
        if (!current.vocabulary.has(feature)) {
          continue;
        }
        if ((current.positive.get(feature) ?? 0) > (current.negative.get(feature) ?? 0)) {
          positiveEvidence += 1;
        }
        logOdds += Math.log(
          ((current.positive.get(feature) ?? 0) + 1) / current.positiveDenominator,
        ) - Math.log(
          ((current.negative.get(feature) ?? 0) + 1) / current.negativeDenominator,
        );
      }

      if (positiveEvidence === 0) {
        return 0;
      }
      return 1 / (1 + Math.exp(-Math.max(-12, Math.min(12, logOdds))));
    },
  };
}

export const LOCAL_STATISTICAL_SEMANTIC_MODEL = buildModel();
