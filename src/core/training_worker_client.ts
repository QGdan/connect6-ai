import type { SelfPlayOptions } from './self_play';
import type { TrainingSampleStats } from './training_dataset';
import type { ValueModelSnapshot } from './value_model_snapshot';
import type {
  ValueTrainingConfig,
  ValueTrainingSample,
} from './value_trainer';

type ProgressUpdate = {
  phase: 'generate' | 'parse' | 'train' | 'evaluate';
  games?: number;
  lines?: number;
  samples: number;
  seen: number;
  elapsedMs: number;
  epoch?: number;
  totalEpochs?: number;
  loss?: number;
  step?: number;
  totalSteps?: number;
};

type WorkerResult = {
  stats: TrainingSampleStats;
  samples: ValueTrainingSample[];
  records?: GameRecordSummary[];
};

type TrainResult = {
  snapshot: ValueModelSnapshot;
  losses: number[];
};

export type EvaluationStats = {
  games: number;
  winsA: number;
  winsB: number;
  draws: number;
  winRateA: number;
  avgMoves: number;
  elapsedMs: number;
};

type PendingRequest<T = unknown> = {
  resolve: (result: T | PromiseLike<T>) => void;
  reject: (error: Error) => void;
  onProgress?: (update: ProgressUpdate) => void;
};

export type GameRecordSummary = {
  winner: 'BLACK' | 'WHITE' | 'DRAW' | undefined;
  moves: Array<{
    player: 'BLACK' | 'WHITE';
    positions: Array<{ x: number; y: number }>;
  }>;
  stats: {
    elapsedMs: number;
  };
};

type WorkerMessage =
  | {
      id: number;
      kind: 'progress';
      phase: 'generate' | 'parse' | 'train' | 'evaluate';
      games?: number;
      lines?: number;
      samples: number;
      seen: number;
      elapsedMs: number;
      epoch?: number;
      totalEpochs?: number;
      loss?: number;
      step?: number;
      totalSteps?: number;
    }
  | {
      id: number;
      kind: 'result';
      stats: TrainingSampleStats;
      samples: ValueTrainingSample[];
      records?: GameRecordSummary[];
    }
  | {
      id: number;
      kind: 'train';
      snapshot: ValueModelSnapshot;
      losses: number[];
    }
  | {
      id: number;
      kind: 'eval';
      stats: EvaluationStats;
      records?: GameRecordSummary[];
    }
  | { id: number; kind: 'error'; error: string };

export class TrainingWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, PendingRequest>();

  constructor() {
    if (typeof Worker === 'undefined') return;
    this.worker = new Worker(
      new URL('../workers/selfplay_worker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = event => this.handleMessage(event.data as WorkerMessage);
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.pending.clear();
  }

  async generateSamples(
    options: SelfPlayOptions,
    maxSamples: number,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<WorkerResult> {
    return this.runTask(
      {
        type: 'generate',
        options,
        maxSamples,
        reportEvery: 10,
      },
      onProgress,
    );
  }

  async parseJsonl(
    text: string,
    maxSamples: number,
    seed?: number,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<WorkerResult> {
    return this.runTask(
      {
        type: 'parse',
        text,
        maxSamples,
        seed,
        reportEvery: 2000,
      },
      onProgress,
    );
  }

  async evaluateModels(
    params: {
      games: number;
      timeMs: number;
      mode: 'fast' | 'normal' | 'deep';
      randomOpeningPlies?: number;
      seed?: number;
      modelA?: SelfPlayOptions['modelSnapshot'];
      modelB?: SelfPlayOptions['modelSnapshot'];
    },
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<{ stats: EvaluationStats; records?: GameRecordSummary[] }> {
    return this.runTask<{ stats: EvaluationStats; records?: GameRecordSummary[] }>(
      {
        type: 'evaluate',
        ...params,
      },
      onProgress,
    );
  }

  async trainModel(
    samples: ValueTrainingSample[],
    config: ValueTrainingConfig,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<TrainResult> {
    return this.runTask<TrainResult>(
      {
        type: 'train',
        samples,
        config,
        reportEvery: 1,
      },
      onProgress,
    );
  }

  cancelActive(requestId: number): void {
    if (!this.worker) return;
    this.worker.postMessage({ id: requestId, type: 'cancel' });
  }

  private runTask<T>(
    payload: Record<string, unknown>,
    onProgress?: (update: ProgressUpdate) => void,
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Training worker not available'));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as PendingRequest['resolve'], reject, onProgress });
      this.worker?.postMessage({ id, ...payload });
    });
  }

  private handleMessage(msg: WorkerMessage): void {
    const task = this.pending.get(msg.id);
    if (!task) return;
    if (msg.kind === 'progress') {
      task.onProgress?.({
        phase: msg.phase,
        games: msg.games,
        lines: msg.lines,
        samples: msg.samples,
        seen: msg.seen,
        elapsedMs: msg.elapsedMs,
        epoch: msg.epoch,
        totalEpochs: msg.totalEpochs,
        loss: msg.loss,
        step: msg.step,
        totalSteps: msg.totalSteps,
      });
      return;
    }
    this.pending.delete(msg.id);
    if (msg.kind === 'error') {
      task.reject(new Error(msg.error));
      return;
    }
    if (msg.kind === 'result') {
      task.resolve({ stats: msg.stats, samples: msg.samples, records: msg.records });
      return;
    }
    if (msg.kind === 'train') {
      task.resolve({ snapshot: msg.snapshot, losses: msg.losses });
      return;
    }
    task.resolve({ stats: msg.stats, records: msg.records });
  }
}
