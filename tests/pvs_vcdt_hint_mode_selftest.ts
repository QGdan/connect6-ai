import { computeZobristHash } from '../src/core/zobrist.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
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
  vcdt_bonus: 6_000,
};

// A calm attacking position that should route through vcdt-root hint selection.
{
  const state = makeState(
    [
      { x: 7, y: 9 },
      { x: 8, y: 9 },
      { x: 9, y: 9 },
      { x: 8, y: 8 },
    ],
    [{ x: 2, y: 2 }, { x: 14, y: 14 }],
    'BLACK',
    2,
  );

  const decision = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 1,
    timeLimitMs: 200,
    useMultithreading: false,
  });

  expect(Number.isFinite(decision.score), 'score must be finite');
  expect(decision.move.positions.length === 2, 'should place two stones');
  expect(decision.debugInfo?.mode === 'vcdt_root', 'selected hint should keep vcdt_root mode');
  expect(
    String(decision.debugInfo?.reason ?? '').endsWith('_hint_selected'),
    'vcdt_root compatibility reason should carry _hint_selected suffix',
  );
}

console.log('pvs_vcdt_hint_mode_selftest: OK');
