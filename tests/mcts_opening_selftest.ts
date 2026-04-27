import { createInitialState } from '../src/core/game_state';
import { DummyResNetEvaluator } from '../src/core/resnet_ai';
import { MCTSConnect6AI } from '../src/core/mcts_ai_engine';
import type { MCTSConfig } from '../src/core/mcts_ai_engine';

const config: MCTSConfig = {
  simulationCount: 20,
  simulationSteps: 1,
  expandNodes: 8,
  minWinRateThreshold: 0.0,
};

const ai = new MCTSConnect6AI(new DummyResNetEvaluator(), config);
const state = createInitialState();

const decision = await ai.decideMove(state, state.currentPlayer);
if (decision.move.positions.length !== 1) {
  throw new Error(
    `opening move should place 1 stone, got ${decision.move.positions.length}`,
  );
}

console.log('mcts_opening_selftest: OK');
