import type { AIMoveDecision, GameState, Player } from '../types';
import type { IResNetEvaluator } from './resnet_ai';
import {
  MCTSConnect6AI,
  mergeMCTSRootStats,
  selectMoveFromStats,
  type MCTSConfig,
  type MCTSRootStats,
} from './mcts_ai_engine';
import {
  serializeGameState,
  type SerializedGameState,
} from './state_serialization';

type WorkerRequest = {
  type: 'search';
  id: number;
  state: SerializedGameState;
  player: Player;
  simulations: number;
};

type WorkerResponse = {
  id: number;
  stats?: MCTSRootStats;
  error?: unknown;
};

type PendingTask = {
  resolve: (stats: MCTSRootStats) => void;
  reject: (error: unknown) => void;
};

export type MCTSParallelConfig = MCTSConfig & {
  useWorkers?: boolean;
  workerCount?: number;
};

const sanitizeConfig = (config: MCTSConfig): MCTSConfig => ({
  simulationCount: config.simulationCount,
  simulationSteps: config.simulationSteps,
  expandNodes: config.expandNodes,
  minWinRateThreshold: config.minWinRateThreshold,
  valueRange: config.valueRange,
  valuePerspective: config.valuePerspective,
  maxTableEntries: config.maxTableEntries,
  dirichletAlpha: config.dirichletAlpha,
  dirichletEps: config.dirichletEps,
  reuseDecay: config.reuseDecay,
  reuseTtl: config.reuseTtl,
});

const splitSimulations = (total: number, workers: number): number[] => {
  const count = Math.max(1, workers);
  const raw = Number.isFinite(total) ? Math.floor(total) : 0;
  const sims = Math.max(0, raw);
  if (sims <= 0) return new Array(count).fill(0);
  const active = Math.min(count, sims);
  const base = Math.floor(sims / active);
  let rem = sims % active;
  const out = new Array(count).fill(0);
  for (let i = 0; i < active; i += 1) {
    out[i] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
  }
  return out;
};

class MCTSWorkerPool {
  private workers: Worker[] = [];
  private pending = new Map<number, PendingTask>();
  private seq = 0;
  private disposed = false;

  constructor(config: MCTSConfig, workerCount: number) {
    if (typeof Worker === 'undefined' || workerCount <= 0) return;
    const safeConfig = sanitizeConfig(config);
    for (let i = 0; i < workerCount; i += 1) {
      const w = new Worker(new URL('../workers/mcts_worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = e => this.handleMessage(e.data as WorkerResponse);
      w.onerror = err => this.handleError(err);
      w.postMessage({ type: 'init', config: safeConfig });
      this.workers.push(w);
    }
  }

  isAvailable(): boolean {
    return !this.disposed && this.workers.length > 0;
  }

  size(): number {
    return this.workers.length;
  }

  async runBatch(
    state: GameState,
    player: Player,
    totalSimulations: number,
  ): Promise<MCTSRootStats> {
    if (!this.isAvailable()) {
      throw new Error('MCTS worker pool not available');
    }
    const sims = splitSimulations(totalSimulations, this.workers.length);
    const tasks: Promise<MCTSRootStats>[] = [];
    for (let i = 0; i < sims.length; i += 1) {
      if (sims[i] <= 0) continue;
      const payload = {
        state: serializeGameState(state),
        player,
        simulations: sims[i],
      };
      tasks.push(this.runOnWorker(this.workers[i], payload));
    }
    if (tasks.length === 0) {
      return { rootVisits: 0, deltaVisits: 0, children: [] };
    }
    const results = await Promise.all(tasks);
    return mergeMCTSRootStats(results);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.pending.values()) {
      task.reject(new Error('MCTS worker pool disposed'));
    }
    this.pending.clear();
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }

  private runOnWorker(
    worker: Worker,
    payload: Omit<WorkerRequest, 'id' | 'type'>,
  ): Promise<MCTSRootStats> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('MCTS worker pool disposed'));
        return;
      }
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      const transfer = payload.state.board.buffer;
      worker.postMessage(
        { type: 'search', id, ...payload } as WorkerRequest,
        [transfer],
      );
    });
  }

  private handleMessage(data: WorkerResponse) {
    const task = this.pending.get(data.id);
    if (!task) return;
    this.pending.delete(data.id);
    if (data.error) {
      task.reject(data.error);
    } else if (!data.stats) {
      task.reject(new Error('MCTS worker returned no stats'));
    } else {
      task.resolve(data.stats as MCTSRootStats);
    }
  }

  private handleError(err: ErrorEvent) {
    const error = err.error ?? err.message;
    this.failAll(error);
  }

  private failAll(error: unknown) {
    for (const task of this.pending.values()) {
      task.reject(error);
    }
    this.pending.clear();
    this.dispose();
  }
}

export class MCTSParallelRunner {
  private readonly config: MCTSParallelConfig;
  private readonly local: MCTSConnect6AI;
  private pool: MCTSWorkerPool | null;

  constructor(evaluator: IResNetEvaluator, config: MCTSParallelConfig) {
    this.config = config;
    this.local = new MCTSConnect6AI(evaluator, config);
    const useWorkers = config.useWorkers !== false;
    const workerCount = Math.max(0, config.workerCount ?? 2);
    this.pool = useWorkers ? new MCTSWorkerPool(config, workerCount) : null;
    if (this.pool && !this.pool.isAvailable()) {
      this.pool = null;
    }
  }

  async decideMove(state: GameState, player: Player): Promise<AIMoveDecision> {
    if (!this.pool || !this.pool.isAvailable()) {
      return this.local.decideMove(state, player);
    }
    const threshold = this.config.minWinRateThreshold ?? 0;
    const simulations = this.config.simulationCount;
    try {
      const stats = await this.pool.runBatch(state, player, simulations);
      const selection = selectMoveFromStats(stats, threshold);
      if (!selection) {
        return this.local.decideMove(state, player);
      }
      const visits = stats.deltaVisits > 0 ? stats.deltaVisits : stats.rootVisits;
      return {
        move: selection.move,
        score: selection.score,
        debugInfo: {
          engine: 'mcts_parallel',
          visits,
          totalVisits: stats.rootVisits,
          selection: selection.selection,
          winRate: selection.winRate,
          threshold,
          workerCount: this.pool.size(),
          reuseDecay: this.config.reuseDecay,
          reuseTtl: this.config.reuseTtl,
        },
      };
    } catch (err) {
      this.pool.dispose();
      this.pool = null;
      const fallback = await this.local.decideMove(state, player);
      fallback.debugInfo = {
        ...(fallback.debugInfo ?? {}),
        workerError: err instanceof Error ? err.message : String(err),
      };
      return fallback;
    }
  }

  dispose(): void {
    this.pool?.dispose();
    this.pool = null;
  }
}
