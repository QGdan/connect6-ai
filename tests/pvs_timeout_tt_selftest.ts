import { computeZobristHash } from '../src/core/zobrist.ts';
import { getLastSearchStats, pvsSearchBestMove } from '../src/core/pvs_search.ts';
import type { Cell, GameState, Position } from '../src/types.ts';

function makeEmptyBoard(): Cell[][] {
  return Array.from({ length: 19 }, () => Array<Cell>(19).fill(0));
}

function makeState(
  black: Position[],
  white: Position[],
  currentPlayer: 'BLACK' | 'WHITE',
  moveNumber: number,
): GameState {
  const board = makeEmptyBoard();
  for (const p of black) board[p.y][p.x] = 1;
  for (const p of white) board[p.y][p.x] = 2;
  return {
    board,
    currentPlayer,
    moveNumber,
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, currentPlayer),
  };
}

function expect(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

const weights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_123, // unique signature for isolated TT run
};

{
  const state = makeState(
    [{ x: 3, y: 11 }],
    [
      { x: 4, y: 11 },
      { x: 5, y: 11 },
      { x: 6, y: 11 },
      { x: 7, y: 11 },
      { x: 8, y: 11 },
      { x: 10, y: 9 },
      { x: 11, y: 9 },
      { x: 12, y: 9 },
    ],
    'BLACK',
    2,
  );

  const rushed = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 10,
    timeLimitMs: 1,
    useMultithreading: false,
  });

  expect(Number.isFinite(rushed.score), 'timeout path score must be finite');
  expect(rushed.debugInfo?.mode === 'threat_root', 'short-time case should still use threat_root');
  expect(getLastSearchStats().ttSize === 0, 'aborted short-time search should not write TT entries');

  const normal = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 3,
    timeLimitMs: 200,
    useMultithreading: false,
  });
  expect(Number.isFinite(normal.score), 'follow-up search score must stay finite');
}

console.log('pvs_timeout_tt_selftest: OK');
