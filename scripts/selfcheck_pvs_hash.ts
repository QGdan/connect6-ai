import { createInitialState, applyMove } from '../src/core/game_state.ts';
import { getStonesToPlace } from '../src/core/rules.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { pvsSearchBestMove, getLastAspirationWindows } from '../src/core/pvs_search.ts';
import type { EvaluationWeights, GameState, Move, Position } from '../src/types.ts';

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

function pickRandomEmpties(state: GameState, count: number): Position[] {
  const empties: Position[] = [];
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] === 0) empties.push({ x, y });
    }
  }
  if (empties.length < count) throw new Error('not enough empties');
  for (let i = empties.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [empties[i], empties[j]] = [empties[j], empties[i]];
  }
  return empties.slice(0, count);
}

function expect(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function verifyHashConsistency(): void {
  let state = createInitialState();
  const initial = computeZobristHash(state.board, state.currentPlayer);
  expect(initial === state.zobristHash, 'initial hash mismatch');

  for (let step = 0; step < 6; step++) {
    const need = getStonesToPlace(state.moveNumber, state.currentPlayer);
    const positions = pickRandomEmpties(state, need);
    const move: Move = { player: state.currentPlayer, positions };
    state = applyMove(state, move);
    const recomputed = computeZobristHash(state.board, state.currentPlayer);
    expect(recomputed === state.zobristHash, `hash mismatch at step ${step}`);
  }
}

function verifyAspirationAndScore(): void {
  const state = createInitialState();
  const decision = pvsSearchBestMove(state, state.currentPlayer, weights, {
    maxDepth: 2,
    timeLimitMs: 200,
    useMultithreading: false,
  });
  expect(Number.isFinite(decision.score), 'search score not finite');
  const windows = getLastAspirationWindows();
  for (const w of windows) {
    expect(!Number.isNaN(w.alpha) && !Number.isNaN(w.beta), 'window NaN');
    expect(w.alpha < w.beta, 'alpha must be < beta');
  }
}

verifyHashConsistency();
verifyAspirationAndScore();
console.log('selfcheck_pvs_hash: OK');
