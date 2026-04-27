import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  Player,
  SearchConfig,
} from '../types';
import { pvsSearchBestMove } from './pvs_search';
import {
  serializeGameState,
  type SerializedGameState,
} from './state_serialization';

type WorkerTask = {
  id: number;
  payload: {
    state: SerializedGameState;
    player: Player;
    weights: EvaluationWeights;
    config: SearchConfig;
  };
  resolve: (decision: AIMoveDecision) => void;
  reject: (error: unknown) => void;
};

type WorkerResponse = {
  id: number;
  decision?: AIMoveDecision;
  error?: unknown;
};

class PvsWorkerClient {
  private worker: Worker | null = null;
  private queue: WorkerTask[] = [];
  private inflight: WorkerTask | null = null;
  private seq = 0;
  private disposed = false;

  constructor() {
    if (typeof Worker === 'undefined') return;
    const w = new Worker(new URL('../workers/pvs_worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = e => this.handleMessage(e.data as WorkerResponse);
    w.onerror = err => this.handleError(err);
    this.worker = w;
  }

  isAvailable(): boolean {
    return !this.disposed && this.worker !== null;
  }

  run(
    state: GameState,
    player: Player,
    weights: EvaluationWeights,
    config: SearchConfig,
  ): Promise<AIMoveDecision> {
    if (!this.isAvailable()) {
      return Promise.reject(new Error('Worker not available'));
    }
    return new Promise((resolve, reject) => {
      const payload = {
        state: serializeGameState(state),
        player,
        weights,
        config: { ...config, useMultithreading: false },
      };
      const task: WorkerTask = { id: -1, payload, resolve, reject };
      this.queue.push(task);
      this.runNext();
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = null;
    this.queue.length = 0;
    this.inflight = null;
  }

  private runNext() {
    if (this.disposed || !this.worker || this.inflight || this.queue.length === 0) {
      return;
    }
    const task = this.queue.shift();
    if (!task) return;
    const id = ++this.seq;
    this.inflight = { ...task, id };
    const transfer = task.payload.state.board.buffer;
    this.worker.postMessage({ id, ...task.payload }, [transfer]);
  }

  private handleMessage(data: WorkerResponse) {
    const task = this.inflight;
    if (!task || data?.id !== task.id) return;
    this.inflight = null;
    if (data.error) task.reject(data.error);
    else task.resolve(data.decision as AIMoveDecision);
    this.runNext();
  }

  private handleError(err: ErrorEvent) {
    const error = err.error ?? err.message;
    this.failAll(error);
  }

  private failAll(error: unknown) {
    if (this.inflight) {
      this.inflight.reject(error);
      this.inflight = null;
    }
    for (const task of this.queue) {
      task.reject(error);
    }
    this.queue.length = 0;
    this.dispose();
  }
}

let sharedClient: PvsWorkerClient | null = null;

function getSharedClient(): PvsWorkerClient | null {
  if (!sharedClient) {
    sharedClient = new PvsWorkerClient();
  }
  if (!sharedClient.isAvailable()) {
    sharedClient = null;
  }
  return sharedClient;
}

export async function pvsSearchBestMoveAsync(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
  config: SearchConfig,
): Promise<AIMoveDecision> {
  if (!config.useMultithreading || typeof Worker === 'undefined') {
    return pvsSearchBestMove(state, player, weights, config);
  }
  const client = getSharedClient();
  if (!client) {
    return pvsSearchBestMove(state, player, weights, config);
  }
  try {
    const decision = await client.run(state, player, weights, config);
    decision.debugInfo = {
      ...(decision.debugInfo ?? {}),
      multithreading: 'enabled',
    };
    return decision;
  } catch (err) {
    sharedClient?.dispose();
    sharedClient = null;
    const fallback = pvsSearchBestMove(state, player, weights, config);
    fallback.debugInfo = {
      ...(fallback.debugInfo ?? {}),
      multithreading: 'requested_but_unsupported',
      workerError: err instanceof Error ? err.message : String(err),
    };
    return fallback;
  }
}
