import { VALUE_FEATURE_NAMES } from './value_features';

export type ValueModelSnapshot = {
  enabled: boolean;
  featureNames: string[];
  weights: number[];
  bias: number;
  trainedAt: string | null;
  samples: number;
  epochs: number;
  config?: {
    lr?: number;
    l2?: number;
    seed?: number;
    maxSamples?: number;
  };
};

export function createValueModelSnapshot(params: {
  weights: number[];
  bias: number;
  samples: number;
  epochs: number;
  config?: ValueModelSnapshot['config'];
  trainedAt?: string | null;
  enabled?: boolean;
}): ValueModelSnapshot {
  return {
    enabled: params.enabled ?? true,
    featureNames: [...VALUE_FEATURE_NAMES],
    weights: params.weights,
    bias: params.bias,
    trainedAt:
      typeof params.trainedAt === 'string'
        ? params.trainedAt
        : new Date().toISOString(),
    samples: params.samples,
    epochs: params.epochs,
    config: params.config,
  };
}

export function isValueModelCompatible(
  snapshot: ValueModelSnapshot,
): boolean {
  if (!snapshot) return false;
  if (snapshot.weights.length !== VALUE_FEATURE_NAMES.length) return false;
  if (snapshot.featureNames.length !== VALUE_FEATURE_NAMES.length) return false;
  for (let i = 0; i < VALUE_FEATURE_NAMES.length; i += 1) {
    if (snapshot.featureNames[i] !== VALUE_FEATURE_NAMES[i]) return false;
  }
  return true;
}
