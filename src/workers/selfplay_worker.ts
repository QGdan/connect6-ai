/// <reference lib="webworker" />
import type { SelfPlayOptions, GameRecord } from '../core/self_play';
import { SelfPlay } from '../core/self_play';
import { TrainingDataset } from '../core/training_dataset';
import type { TrainingSampleStats } from '../core/training_dataset';
import {
  buildValueSampleFromJson,
  buildValueSampleFromState,
} from '../core/training_sample_io';
import type {
  ValueTrainingConfig,
  ValueTrainingSample,
} from '../core/value_trainer';
import { trainValueModel } from '../core/value_trainer';
import type { ValueModelSnapshot } from '../core/value_model_snapshot';

type GenerateRequest = {
  id: number;
  type: 'generate';
  options: SelfPlayOptions;
  maxSamples: number;
  reportEvery?: number;
};

type ParseRequest = {
  id: number;
  type: 'parse';
  text: string;
  maxSamples: number;
  seed?: number;
  reportEvery?: number;
};

type TrainRequest = {
  id: number;
  type: 'train';
  samples: ValueTrainingSample[];
  config: ValueTrainingConfig;
  reportEvery?: number;
};

type EvaluateRequest = {
  id: number;
  type: 'evaluate';
  games: number;
  timeMs: number;
  mode: 'fast' | 'normal' | 'deep';
  randomOpeningPlies?: number;
  seed?: number;
  modelA?: SelfPlayOptions['modelSnapshot'];
  modelB?: SelfPlayOptions['modelSnapshot'];
  reportEvery?: number;
};

type CancelRequest = {
  id: number;
  type: 'cancel';
};

type WorkerRequest =
  | GenerateRequest
  | ParseRequest
  | TrainRequest
  | EvaluateRequest
  | CancelRequest;

type ProgressMessage = {
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
};

type GameRecordSummary = Omit<GameRecord, 'samples'>;

type ResultMessage = {
  id: number;
  kind: 'result';
  stats: TrainingSampleStats;
  samples: ReturnType<TrainingDataset['getSamples']>;
  records?: GameRecordSummary[];
};

type TrainMessage = {
  id: number;
  kind: 'train';
  snapshot: ValueModelSnapshot;
  losses: number[];
};

type EvaluationStats = {
  games: number;
  winsA: number;
  winsB: number;
  draws: number;
  winRateA: number;
  avgMoves: number;
  elapsedMs: number;
};

type EvalMessage = {
  id: number;
  kind: 'eval';
  stats: EvaluationStats;
  records?: GameRecordSummary[];
};

type ErrorMessage = {
  id: number;
  kind: 'error';
  error: string;
};

const ctx = self as DedicatedWorkerGlobalScope;
let activeId = 0;
let cancelled = false;

function resultFor(player: string, winner?: string): number {
  if (!winner || winner === 'DRAW') return 0.5;
  return winner === player ? 1 : 0;
}

function postProgress(msg: ProgressMessage): void {
  ctx.postMessage(msg);
}

async function runGenerate(request: GenerateRequest): Promise<ResultMessage> {
  const start = Date.now();
  const dataset = new TrainingDataset(
    request.maxSamples,
    request.options.seed ?? Date.now(),
  );
  const reportEvery = request.reportEvery ?? 10;
  const selfPlay = new SelfPlay({
    ...request.options,
    recordSamples: true,
  });

  const records: GameRecordSummary[] = [];
  const recordLimit = Math.max(
    2,
    Math.min(6, Math.floor(request.options.games / 10)),
  );

  let games = 0;
  await selfPlay.runStream(async (record: GameRecord, index: number) => {
    if (cancelled) return;
    games = index + 1;
    const samples = record.samples ?? [];
    for (const sample of samples) {
      const res = resultFor(sample.state.currentPlayer, record.winner);
      dataset.addSample(buildValueSampleFromState(sample.state, res));
    }
    if (games % reportEvery === 0) {
      const stats = dataset.getStats();
      postProgress({
        id: request.id,
        kind: 'progress',
        phase: 'generate',
        games,
        samples: stats.samples,
        seen: stats.seen,
        elapsedMs: Date.now() - start,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (records.length < recordLimit) {
      records.push({
        winner: record.winner,
        moves: record.moves,
        stats: record.stats,
      });
    }
  });

  return {
    id: request.id,
    kind: 'result',
    stats: dataset.getStats(),
    samples: dataset.getSamples(),
    records,
  };
}

async function runParse(request: ParseRequest): Promise<ResultMessage> {
  const start = Date.now();
  const dataset = new TrainingDataset(
    request.maxSamples,
    request.seed ?? Date.now(),
  );
  const reportEvery = request.reportEvery ?? 2000;
  const lines = request.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (cancelled) break;
    const line = lines[i].trim();
    if (!line) continue;
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    const sample = buildValueSampleFromJson(payload);
    if (!sample) continue;
    dataset.addSample(sample);
    if ((i + 1) % reportEvery === 0) {
      const stats = dataset.getStats();
      postProgress({
        id: request.id,
        kind: 'progress',
        phase: 'parse',
        lines: i + 1,
        samples: stats.samples,
        seen: stats.seen,
        elapsedMs: Date.now() - start,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return {
    id: request.id,
    kind: 'result',
    stats: dataset.getStats(),
    samples: dataset.getSamples(),
    records: [],
  };
}

async function runTrain(request: TrainRequest): Promise<TrainMessage> {
  const start = Date.now();
  const samples = request.samples ?? [];
  let lastLoss = 0;
  const result = trainValueModel(samples, request.config, {
    reportEvery: request.reportEvery ?? 1,
    shouldCancel: () => cancelled,
    onEpoch: progress => {
      lastLoss = progress.loss;
      postProgress({
        id: request.id,
        kind: 'progress',
        phase: 'train',
        samples: samples.length,
        seen: samples.length,
        elapsedMs: Date.now() - start,
        epoch: progress.epoch,
        totalEpochs: progress.epochs,
        loss: progress.loss,
        step: progress.step,
        totalSteps: progress.totalSteps,
      });
    },
  });

  if (cancelled) {
    throw new Error('训练已取消');
  }

  return {
    id: request.id,
    kind: 'train',
    snapshot: result.snapshot,
    losses: result.losses.length > 0 ? result.losses : [lastLoss],
  };
}

async function runEvaluate(request: EvaluateRequest): Promise<EvalMessage> {
  const start = Date.now();
  const totalGames = Math.max(1, Math.floor(request.games));
  const half = Math.floor(totalGames / 2);
  const reportEvery = request.reportEvery ?? 2;
  const records: GameRecordSummary[] = [];
  const recordLimit = Math.max(2, Math.min(4, Math.floor(totalGames / 10)));
  const stats = {
    games: 0,
    winsA: 0,
    winsB: 0,
    draws: 0,
    moves: 0,
  };

  const modelA = request.modelA ?? null;
  const modelB = request.modelB ?? null;
  const runMatch = async (
    games: number,
    modelBlack: EvaluateRequest['modelA'],
    modelWhite: EvaluateRequest['modelB'],
    aIsBlack: boolean,
  ) => {
    if (games <= 0) return;
    const selfPlay = new SelfPlay({
      games,
      timeMs: request.timeMs,
      mode: request.mode,
      randomOpeningPlies: request.randomOpeningPlies,
      seed: request.seed,
      modelSnapshotBlack: modelBlack ?? null,
      modelSnapshotWhite: modelWhite ?? null,
    });

    await selfPlay.runStream((record, index) => {
      if (cancelled) return;
      stats.games += 1;
      stats.moves += record.moves.length;
      if (!record.winner || record.winner === 'DRAW') {
        stats.draws += 1;
      } else if (record.winner === 'BLACK') {
        if (aIsBlack) stats.winsA += 1;
        else stats.winsB += 1;
      } else {
        if (aIsBlack) stats.winsB += 1;
        else stats.winsA += 1;
      }

      if ((index + 1) % reportEvery === 0) {
        postProgress({
          id: request.id,
          kind: 'progress',
          phase: 'evaluate',
          games: stats.games,
          samples: 0,
          seen: 0,
          elapsedMs: Date.now() - start,
        });
      }

      if (records.length < recordLimit) {
        records.push({
          winner: record.winner,
          moves: record.moves,
          stats: record.stats,
        });
      }
    });
  };

  await runMatch(half, modelA, modelB, true);
  await runMatch(totalGames - half, modelB, modelA, false);

  const winRateA =
    stats.games > 0 ? stats.winsA / stats.games : 0;
  const avgMoves = stats.games > 0 ? stats.moves / stats.games : 0;
  return {
    id: request.id,
    kind: 'eval',
    stats: {
      games: stats.games,
      winsA: stats.winsA,
      winsB: stats.winsB,
      draws: stats.draws,
      winRateA,
      avgMoves,
      elapsedMs: Date.now() - start,
    },
    records,
  };
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    if (msg.id === activeId) cancelled = true;
    return;
  }

  activeId = msg.id;
  cancelled = false;

  const run = async () => {
    try {
      const result =
        msg.type === 'generate'
          ? await runGenerate(msg)
          : msg.type === 'parse'
          ? await runParse(msg)
          : msg.type === 'train'
          ? await runTrain(msg)
          : await runEvaluate(msg);
      if (cancelled) return;
      ctx.postMessage(result);
    } catch (err) {
      const errorMessage: ErrorMessage = {
        id: msg.id,
        kind: 'error',
        error: (err as Error).message ?? String(err),
      };
      ctx.postMessage(errorMessage);
    }
  };
  run();
};
