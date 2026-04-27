export type RunStatus =
  | 'idle'
  | 'generating'
  | 'training'
  | 'evaluating'
  | 'error';

export type JobStatus = 'idle' | 'running' | 'done' | 'error' | 'paused';

export interface TimeseriesPoint {
  t: number;
  step: number;
  totalLoss: number;
  valueLoss: number;
  policyLoss: number;
  l2Loss: number;
  lr: number;
  gradNorm: number;
  weightNorm: number;
  updateRatio: number;
  cpu: number;
  gpu: number;
  throughput: number;
}

export interface DatasetJob {
  status: JobStatus;
  gamesTarget: number;
  gamesDone: number;
  timePerMoveMs: number;
  randomPlies: number;
  seed: number;
  maxSamples: number;
  symmetry: boolean;
  stats: {
    winLoseDraw: { win: number; loss: number; draw: number };
    lengthHist: Array<{ bucket: string; count: number }>;
    openingsTop: Array<{ id: string; count: number }>;
    uniquePositions: number;
    duplicateRate: number;
    policyEntropy: number;
    top1Rate: number;
    topKRate: number;
    illegalCount: number;
    parseFailed: number;
    nanSamples: number;
  };
}

export interface TrainJob {
  status: JobStatus;
  epochs: number;
  lr: number;
  l2: number;
  seed: number;
  step: number;
  totalSteps: number;
  metricsTimeseries: TimeseriesPoint[];
}

export interface EvalJob {
  status: JobStatus;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  ci95: number;
  bySide: { first: number; second: number };
  byOpening: Array<{ id: string; winRate: number; games: number }>;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  epoch: number;
  samples: number;
  loss: number;
  winRate: number;
  elo: number;
  notes: string;
  isApplied: boolean;
}

export interface GameSample {
  id: string;
  source: 'selfplay' | 'eval';
  moves: Array<{
    ply: number;
    stones: Array<{ x: number; y: number; color: 'BLACK' | 'WHITE' }>;
  }>;
  result: 'BLACK' | 'WHITE' | 'DRAW';
  meta: { openingId: string; seed: number };
  policyHeatmaps?: number[][][];
}

export interface RunKpis {
  samples: { total: number; delta: number; unique: number };
  latestLoss: { total: number; value: number; policy: number; l2: number };
  evalWinRate: { value: number; ci95: number; delta: number };
  elo: { value: number; sigma: number; delta: number };
  throughput: { value: number; unit: string };
  system: { cpu: number; gpu: number; ram: number; vram: number };
}

export interface Run {
  id: string;
  name: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  rules: { boardSize: number; firstMoveStones: number; nextMoveStones: number };
  datasetJob: DatasetJob;
  trainJob: TrainJob;
  evalJob: EvalJob;
  kpis: RunKpis;
  checkpoints: Checkpoint[];
  samples: GameSample[];
}

export interface RunLogEntry {
  id: string;
  at: string;
  stage: 'generate' | 'train' | 'eval' | 'system';
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface RunAlert {
  id: string;
  at: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}
