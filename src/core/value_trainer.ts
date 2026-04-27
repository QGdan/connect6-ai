import { VALUE_FEATURE_NAMES } from './value_features';
import {
  createValueModelSnapshot,
  type ValueModelSnapshot,
} from './value_model_snapshot';

export type ValueTrainingSample = {
  features: number[];
  result: number;
};

export type ValueTrainingConfig = {
  epochs: number;
  lr: number;
  l2: number;
  seed: number;
};

export type ValueTrainingProgress = {
  epoch: number;
  epochs: number;
  loss: number;
  step: number;
  totalSteps: number;
};

export type ValueTrainingHooks = {
  onEpoch?: (progress: ValueTrainingProgress) => void;
  shouldCancel?: () => boolean;
  reportEvery?: number;
};

export type ValueTrainingResult = {
  snapshot: ValueModelSnapshot;
  losses: number[];
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

export function trainValueModel(
  samples: ValueTrainingSample[],
  config: ValueTrainingConfig,
  hooks?: ValueTrainingHooks,
): ValueTrainingResult {
  const epochs = Math.max(1, Math.floor(config.epochs));
  const lr = Number.isFinite(config.lr) ? config.lr : 0.02;
  const l2 = Number.isFinite(config.l2) ? config.l2 : 0.001;
  const seed = Number.isFinite(config.seed) ? config.seed : 42;
  const rng = mulberry32(seed);
  const reportEvery = hooks?.reportEvery ?? 1;
  const shouldCancel = hooks?.shouldCancel;

  const featureCount = VALUE_FEATURE_NAMES.length;
  const weights = new Array<number>(featureCount).fill(0);
  let bias = 0;

  const filtered = samples.filter(
    sample =>
      sample.features.length === featureCount &&
      Number.isFinite(sample.result),
  );

  const losses: number[] = [];
  const totalSteps = filtered.length * epochs;
  let step = 0;
  let cancelled = false;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    if (shouldCancel?.()) {
      cancelled = true;
      break;
    }
    const order = [...filtered.keys()];
    shuffleInPlace(order, rng);
    let totalLoss = 0;
    let processed = 0;
    for (const idx of order) {
      if (shouldCancel?.()) {
        cancelled = true;
        break;
      }
      const { features, result } = filtered[idx];
      let sum = bias;
      for (let i = 0; i < featureCount; i += 1) {
        sum += features[i] * weights[i];
      }
      const pred = sigmoid(sum);
      const y = Math.max(0, Math.min(1, result));
      const error = pred - y;
      totalLoss += -(
        y * Math.log(pred + 1e-6) +
        (1 - y) * Math.log(1 - pred + 1e-6)
      );
      for (let i = 0; i < featureCount; i += 1) {
        weights[i] -= lr * (error * features[i] + l2 * weights[i]);
      }
      bias -= lr * error;
      processed += 1;
      step += 1;
    }
    const avgLoss = totalLoss / Math.max(1, processed);
    losses.push(avgLoss);
    if (
      hooks?.onEpoch &&
      (reportEvery <= 1 ||
        (epoch + 1) % reportEvery === 0 ||
        epoch === epochs - 1 ||
        cancelled)
    ) {
      hooks.onEpoch({
        epoch: Math.min(epoch + 1, epochs),
        epochs,
        loss: avgLoss,
        step,
        totalSteps,
      });
    }
    if (cancelled) break;
  }

  return {
    snapshot: createValueModelSnapshot({
      weights,
      bias,
      samples: filtered.length,
      epochs,
      config: { lr, l2, seed },
    }),
    losses,
  };
}
