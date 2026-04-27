import type {
  EvaluationWeights,
  GameState,
  Player,
  SearchConfig,
  AIMoveDecision,
} from '../types';
import { createInitialState } from './game_state';
import { pvsSearchBestMove } from './pvs_search';
import { DEFAULT_EVALUATION_WEIGHTS } from './evaluation';
import { applyMoveWithWinner } from './rules';
import { evaluateState } from './evaluation';
import {
  serializeGameState,
  type SerializedGameState,
} from './state_serialization';

export interface GAConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
  gamesPerIndividual: number;
  maxMovesPerGame: number;
  pvsConfig: SearchConfig;
  usePrevBestAsOpponent?: boolean; // 每代引入上一代冠军作为额外对手
  maxOpponentPoolSize?: number;    // 对手池最大数量（含基线），默认 2
  updateBaselineEachGen?: boolean; // 是否把当代冠军写回 baseline 作为新的参照
}

export interface GAResult {
  best: EvaluationWeights;
  history: { generation: number; bestFitness: number; avgFitness: number }[];
}

const DEFAULT_BASELINE: EvaluationWeights = { ...DEFAULT_EVALUATION_WEIGHTS };

// ===== Worker 池（并行 PVS）=====
type WorkerTask = {
  id: number;
  payload: {
    state: SerializedGameState;
    player: Player;
    weights: EvaluationWeights;
    config: SearchConfig;
  };
  resolve: (r: AIMoveDecision) => void;
  reject: (e: unknown) => void;
};

type WorkerResponse = {
  id: number;
  decision?: AIMoveDecision;
  error?: unknown;
};

class WorkerPool {
  private workers: Worker[] = [];
  private queue: WorkerTask[] = [];
  private inflight = new Map<number, WorkerTask>();
  private seq = 0;
  private rr = 0;
  private debugDispatchCounts: number[] | null = null;
  private disposed = false;

  constructor(size: number) {
    if (typeof Worker === 'undefined') return;
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('../workers/pvs_worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = e => this.handleMessage(e.data, w);
      w.onerror = err => {
        console.error('[worker] error', err);
      };
      this.workers.push(w);
    }
    this.debugDispatchCounts = new Array(this.workers.length).fill(0);
  }

  private handleMessage(data: WorkerResponse, _worker: Worker) {
    const { id, decision, error } = data ?? {};
    const task = this.inflight.get(id);
    if (!task) return;
    this.inflight.delete(id);
    if (error) task.reject(error);
    else task.resolve(decision);
    this.runNext();
  }

  private runNext() {
    if (this.disposed) return;
    if (this.queue.length === 0) return;
    if (this.workers.length === 0) return;
    while (this.queue.length > 0 && this.inflight.size < this.workers.length) {
      const task = this.queue.shift();
      if (!task) return;
      const id = ++this.seq;
      this.inflight.set(id, { ...task, id });
      const idx = this.rr % this.workers.length;
      this.rr += 1;
      if (this.debugDispatchCounts) this.debugDispatchCounts[idx] += 1;
      const worker = this.workers[idx];
      const transfer = task.payload.state.board.buffer;
      worker.postMessage({ id, ...task.payload }, [transfer]);
    }
  }

  run(
    state: GameState,
    player: Player,
    weights: EvaluationWeights,
    config: SearchConfig,
  ) {
    return new Promise<AIMoveDecision>((resolve, reject) => {
      if (this.disposed || this.workers.length === 0) {
        reject(new Error('WorkerPool not available'));
        return;
      }
      const task: WorkerTask = {
        id: -1,
        payload: {
          state: serializeGameState(state),
          player,
          weights,
          config: { ...config, useMultithreading: false },
        },
        resolve,
        reject,
      };
      this.queue.push(task);
      this.runNext();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.inflight.values()) {
      task.reject(new Error('WorkerPool disposed'));
    }
    this.inflight.clear();
    this.queue.length = 0;
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
  }
}

/**
 * 简易 GA + 自对弈优化器：
 * - 个体与基准权重各下 gamesPerIndividual 盘，黑白互换，取平均胜率作为 fitness
 * - 保留精英，轮盘赌选父代，交叉+突变生成下一代
 */
export class SelfPlayOptimizer {
  private gaConfig: GAConfig;
  private baseline: EvaluationWeights;
  private opponentPool: EvaluationWeights[];
  private onProgress?: (msg: string) => void;
  private onSimIncrement?: () => void;
  private pool: WorkerPool | null = null;

  constructor(
    gaConfig: GAConfig,
    baseline: EvaluationWeights = DEFAULT_BASELINE,
    onProgress?: (msg: string) => void,
    onSimIncrement?: () => void,
  ) {
    this.gaConfig = gaConfig;
    this.baseline = baseline;
    this.opponentPool = [baseline];
    this.onProgress = onProgress;
    this.onSimIncrement = onSimIncrement;
  }

  async optimize(): Promise<GAResult> {
    const useWorkers = this.gaConfig.pvsConfig.useMultithreading === true;
    if (useWorkers && typeof Worker !== 'undefined') {
      const size = Math.min(
        4,
        Math.max(1, (navigator as { hardwareConcurrency?: number }).hardwareConcurrency ?? 2),
      );
      this.pool = new WorkerPool(size);
    } else {
      this.pool = null;
    }

    let champion = this.baseline;
    const history: GAResult['history'] = [];
    try {
      for (let gen = 0; gen < this.gaConfig.generations; gen++) {
        const challengers = this.initPopulation(champion);
        let championScoreNorm = 1;

        challengersLoop: for (let idx = 0; idx < challengers.length; idx++) {
          const challenger = challengers[idx];
          this.onProgress?.(
            `Gen ${gen + 1}: 挑战者${idx + 1} 权重 ${formatWeights(challenger)}`,
          );
          const { championScore, challengerScore } = await this.duel(
            champion,
            challenger,
          );

          championScoreNorm = championScore / 2;
          const challengerScoreNorm = challengerScore / 2;

          const margin = 0.01; // 轻微偏向挑战者，促使探索
          if (challengerScore > championScore + margin) {
            champion = challenger;
            championScoreNorm = challengerScoreNorm;
            this.onProgress?.(
              `Gen ${gen + 1}: 挑战者${idx + 1} 胜出，得分 ${challengerScoreNorm.toFixed(2)} 权重 ${formatWeights(challenger)}`,
            );
          } else if (Math.abs(challengerScore - championScore) <= margin) {
            // 平局时偶尔让挑战者上位，避免停滞
            champion = challenger;
            championScoreNorm = challengerScoreNorm;
            this.onProgress?.(
              `Gen ${gen + 1}: 平局，晋升挑战者${idx + 1} 以增加多样性，得分 ${challengerScoreNorm.toFixed(2)} 权重 ${formatWeights(challenger)}`,
            );
          } else {
            this.onProgress?.(
              `Gen ${gen + 1}: 冠军卫冕，得分 ${championScoreNorm.toFixed(2)} 权重 ${formatWeights(champion)}`,
            );
          }

          // 让出事件循环
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        history.push({
          generation: gen,
          bestFitness: championScoreNorm,
          avgFitness: championScoreNorm,
        });

        if (this.gaConfig.usePrevBestAsOpponent) {
          this.opponentPool.push(champion);
          const poolCap = this.gaConfig.maxOpponentPoolSize ?? 2;
          if (this.opponentPool.length > poolCap) {
            this.opponentPool = this.opponentPool.slice(-poolCap);
          }
        }

        if (this.gaConfig.updateBaselineEachGen) {
          this.baseline = champion;
          this.opponentPool[0] = champion;
        }
      }

      return { best: champion, history };
    } finally {
      this.pool?.dispose();
      this.pool = null;
    }
  }

  private initPopulation(seed: EvaluationWeights): EvaluationWeights[] {
    const pop: EvaluationWeights[] = [];
    for (let i = 0; i < this.gaConfig.populationSize; i++) {
      const ratio = i === 0 ? 0.5 : 0.3; // 给第一个挑战者更大扰动
      pop.push({
        road_3_score: jitter(seed.road_3_score, ratio),
        road_4_score: jitter(seed.road_4_score, ratio),
        live4_score: jitter(seed.live4_score, ratio),
        live5_score: jitter(seed.live5_score, ratio),
        vcdt_bonus: jitter(seed.vcdt_bonus, ratio),
      });
    }
    // 再追加一个从 baseline 极大扰动的“野性”挑战者，避免陷入局部
    pop.push({
      road_3_score: jitter(DEFAULT_BASELINE.road_3_score, 0.8),
      road_4_score: jitter(DEFAULT_BASELINE.road_4_score, 0.8),
      live4_score: jitter(DEFAULT_BASELINE.live4_score, 0.8),
      live5_score: jitter(DEFAULT_BASELINE.live5_score, 0.8),
      vcdt_bonus: jitter(DEFAULT_BASELINE.vcdt_bonus, 0.8),
    });
    return pop;
  }

  /**
   * 冠军 vs 挑战者，两局换色对弈，返回双方得分（2 局合计）。
   */
  private async duel(
    champion: EvaluationWeights,
    challenger: EvaluationWeights,
  ): Promise<{ championScore: number; challengerScore: number }> {
    let championScore = 0;
    let challengerScore = 0;

    // 冠军执黑
    const g1 = await this.selfPlay(champion, challenger);
    championScore += g1;
    challengerScore += 1 - g1;
    this.onSimIncrement?.();

    // 挑战者执黑
    const g2 = await this.selfPlay(challenger, champion);
    challengerScore += g2;
    championScore += 1 - g2;
    this.onSimIncrement?.();

    return { championScore, challengerScore };
  }

  private async selfPlay(
    blackWeights: EvaluationWeights,
    whiteWeights: EvaluationWeights,
  ): Promise<number> {
    let state: GameState = createInitialState();
    let player: Player = state.currentPlayer; // 初始应为 BLACK
    let steps = 0;

    while (!state.winner && steps < this.gaConfig.maxMovesPerGame) {
      const weights = player === 'BLACK' ? blackWeights : whiteWeights;
      const moveDecision = this.pool
        ? await this.pool.run(state, player, weights, this.gaConfig.pvsConfig)
        : pvsSearchBestMove(state, player, weights, this.gaConfig.pvsConfig);
      state = applyMoveWithWinner(state, moveDecision.move);
      player = player === 'BLACK' ? 'WHITE' : 'BLACK';
      steps++;

      // 定期让出事件循环，避免界面假死
      if ((steps & 7) === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (state.winner === 'BLACK') return 1;
    if (state.winner === 'WHITE') return 0;

    // 无胜负：用最终局面评分做软胜率
    const evalScore = evaluateState(state, 'BLACK', blackWeights);
    return normalizeEval(evalScore);
  }
}

function jitter(base: number, ratio: number): number {
  return base * (1 + (Math.random() - 0.5) * 2 * ratio);
}

function normalizeEval(score: number): number {
  // 将评价值压缩到 0..1，并加入轻微噪声打破平局
  const scaled = Math.tanh(score / 8000);
  const noise = (Math.random() - 0.5) * 0.1; // ±0.05
  const v = 0.5 + scaled * 0.5 + noise;
  return Math.max(0, Math.min(1, v));
}

function formatWeights(w: EvaluationWeights): string {
  return `r3=${w.road_3_score.toFixed(1)}, r4=${w.road_4_score.toFixed(
    1,
  )}, l4=${w.live4_score.toFixed(1)}, l5=${w.live5_score.toFixed(
    1,
  )}, vcdt=${w.vcdt_bonus.toFixed(1)}`;
}
