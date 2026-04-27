/// <reference lib="webworker" />
import type { Player } from '../types';
import {
  MCTSConnect6AI,
  type MCTSConfig,
  type MCTSRootStats,
} from '../core/mcts_ai_engine';
import { createDefaultEvaluator } from '../core/resnet_ai';
import {
  deserializeGameState,
  type SerializedGameState,
} from '../core/state_serialization';

type InitMessage = {
  type: 'init';
  config: MCTSConfig;
};

type SearchMessage = {
  type: 'search';
  id: number;
  state: SerializedGameState;
  player: Player;
  simulations?: number;
};

type WorkerMessage = InitMessage | SearchMessage;

type WorkerResponse = {
  id: number;
  stats?: MCTSRootStats;
  error?: unknown;
};

let engine: MCTSConnect6AI | null = null;
let baseConfig: MCTSConfig | null = null;

const ctx = self as DedicatedWorkerGlobalScope;

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

ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    baseConfig = sanitizeConfig(msg.config);
    engine = new MCTSConnect6AI(createDefaultEvaluator(), baseConfig);
    return;
  }

  const response: WorkerResponse = { id: msg.id };
  try {
    if (!engine || !baseConfig) {
      throw new Error('MCTS worker not initialized');
    }
    const state = deserializeGameState(msg.state);
    const sims = Math.max(
      0,
      Number.isFinite(msg.simulations) ? msg.simulations! : baseConfig.simulationCount,
    );
    response.stats = await engine.runBatch(state, msg.player, sims);
  } catch (err) {
    response.error = err instanceof Error ? err.message : String(err);
  }

  ctx.postMessage(response);
};
