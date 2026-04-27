import { createEmptyBoard } from '../src/core/game_state';
import { pvsSearchBestMove, getLastAspirationWindows } from '../src/core/pvs_search';
import type { EvaluationWeights, GameState } from '../src/types';

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const state: GameState = {
  board: createEmptyBoard(),
  currentPlayer: 'BLACK',
  moveNumber: 0,
  lastMove: undefined,
  winner: undefined,
  zobristHash: 0n,
};

const decision = pvsSearchBestMove(state, 'BLACK', weights, {
  maxDepth: 2,
  timeLimitMs: 300,
  useMultithreading: false,
});

if (!Number.isFinite(decision.score)) {
  throw new Error(`search score not finite: ${decision.score}`);
}

const windows = getLastAspirationWindows();
if (windows.length === 0) {
  throw new Error('no aspiration windows recorded');
}

const first = windows.find(w => w.depth === 1 && w.retry === 0);
if (!first || first.alpha !== -Infinity || first.beta !== Infinity) {
  throw new Error('first iteration did not use full window');
}

for (const w of windows) {
  if (Number.isNaN(w.alpha) || Number.isNaN(w.beta)) {
    throw new Error(`invalid window NaN at depth=${w.depth} retry=${w.retry}`);
  }
  if (!(w.alpha < w.beta)) {
    throw new Error(
      `invalid window alpha>=beta at depth=${w.depth} retry=${w.retry}`,
    );
  }
}

console.log('pvs_aspiration_selftest: OK');
