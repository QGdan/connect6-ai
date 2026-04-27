import { createMulberry32 } from './rng';
import type { ValueTrainingSample } from './value_trainer';

export type TrainingSampleStats = {
  seen: number;
  samples: number;
  unique: number;
  duplicateCount: number;
  duplicateRate: number;
  wins: number;
  draws: number;
  losses: number;
  avgResult: number;
};

function bucketResult(result: number): 'win' | 'draw' | 'loss' {
  if (result > 0.5) return 'win';
  if (result < 0.5) return 'loss';
  return 'draw';
}

function emptyStats(): TrainingSampleStats {
  return {
    seen: 0,
    samples: 0,
    unique: 0,
    duplicateCount: 0,
    duplicateRate: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    avgResult: 0,
  };
}

export class TrainingDataset {
  private readonly maxSamples: number;
  private readonly rng: () => number;
  private readonly samples: ValueTrainingSample[] = [];
  private readonly sampleCounts = new Map<number, number>();
  private seen = 0;
  private wins = 0;
  private draws = 0;
  private losses = 0;
  private sumResult = 0;

  constructor(maxSamples = 80_000, seed = Date.now()) {
    this.maxSamples = Number.isFinite(maxSamples)
      ? Math.max(1, Math.floor(maxSamples))
      : 80_000;
    this.rng = createMulberry32(seed);
  }

  addSample(sample: ValueTrainingSample): void {
    const clamped = Math.max(0, Math.min(1, sample.result));
    const normalized: ValueTrainingSample = {
      features: sample.features,
      result: clamped,
    };
    this.seen += 1;

    if (this.samples.length < this.maxSamples) {
      this.samples.push(normalized);
      this.applyStats(normalized, 1);
      return;
    }

    const pick = Math.floor(this.rng() * this.seen);
    if (pick < this.maxSamples) {
      const prev = this.samples[pick];
      this.applyStats(prev, -1);
      this.samples[pick] = normalized;
      this.applyStats(normalized, 1);
    }
  }

  addSamples(list: ValueTrainingSample[]): void {
    for (const sample of list) {
      this.addSample(sample);
    }
  }

  getSamples(): ValueTrainingSample[] {
    return [...this.samples];
  }

  getStats(): TrainingSampleStats {
    if (this.samples.length === 0) return { ...emptyStats(), seen: this.seen };
    const unique = this.sampleCounts.size;
    const duplicateCount = Math.max(0, this.samples.length - unique);
    return {
      seen: this.seen,
      samples: this.samples.length,
      unique,
      duplicateCount,
      duplicateRate:
        this.samples.length > 0 ? duplicateCount / this.samples.length : 0,
      wins: this.wins,
      draws: this.draws,
      losses: this.losses,
      avgResult: this.sumResult / this.samples.length,
    };
  }

  private applyStats(sample: ValueTrainingSample, dir: 1 | -1): void {
    const bucket = bucketResult(sample.result);
    if (bucket === 'win') this.wins += dir;
    if (bucket === 'draw') this.draws += dir;
    if (bucket === 'loss') this.losses += dir;
    this.sumResult += sample.result * dir;
    this.updateSampleCount(sample, dir);
  }

  private updateSampleCount(sample: ValueTrainingSample, dir: 1 | -1): void {
    const hash = this.hashSample(sample);
    const prev = this.sampleCounts.get(hash) ?? 0;
    const next = prev + dir;
    if (next <= 0) {
      this.sampleCounts.delete(hash);
      return;
    }
    this.sampleCounts.set(hash, next);
  }

  private hashSample(sample: ValueTrainingSample): number {
    let hash = 2166136261;
    for (let i = 0; i < sample.features.length; i += 1) {
      const scaled = Math.round(sample.features[i] * 1000);
      hash ^= scaled;
      hash = Math.imul(hash, 16777619);
    }
    const resultScaled = Math.round(sample.result * 1000);
    hash ^= resultScaled;
    return hash >>> 0;
  }
}
