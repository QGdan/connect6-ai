/// <reference lib="webworker" />
import { pvsSearchBestMove } from '../core/pvs_search';
import {
  deserializeGameState,
  type SerializedGameState,
} from '../core/state_serialization';
import type {
  GameState,
  Player,
  EvaluationWeights,
  SearchConfig,
  AIMoveDecision,
} from '../types';

interface TaskPayload {
  id: number;
  state: GameState | SerializedGameState;
  player: Player;
  weights: EvaluationWeights;
  config: SearchConfig;
}

const ctx = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<TaskPayload>) => {
  const { id, state, player, weights, config } = event.data;
  try {
    const restored = deserializeGameState(state);
    const decision: AIMoveDecision = pvsSearchBestMove(
      restored,
      player,
      weights,
      config,
    );
    ctx.postMessage({ id, decision });
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
};
