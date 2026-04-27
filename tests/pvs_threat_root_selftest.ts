import { computeZobristHash } from '../src/core/zobrist.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
import type { Cell, GameState, Position } from '../src/types.ts';

function makeEmptyBoard(): Cell[][] {
  return Array.from({ length: 19 }, () => Array<Cell>(19).fill(0));
}

function makeState(
  stones: Array<{ pos: Position; player: 1 | 2 }>,
  currentPlayer: 'BLACK' | 'WHITE',
  moveNumber: number,
): GameState {
  const board = makeEmptyBoard();
  for (const { pos, player } of stones) {
    board[pos.y][pos.x] = player;
  }
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

function posEq(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

const weights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

// WIN_IN_1: must take a winning point (1 stone).
{
  const state = makeState(
    [
      { pos: { x: 3, y: 0 }, player: 1 },
      { pos: { x: 4, y: 0 }, player: 1 },
      { pos: { x: 5, y: 0 }, player: 1 },
      { pos: { x: 6, y: 0 }, player: 1 },
      { pos: { x: 7, y: 0 }, player: 1 },
    ],
    'BLACK',
    0,
  );
  const decision = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 1,
    timeLimitMs: 50,
    useMultithreading: false,
  });
  expect(decision.move.positions.length === 1, 'WIN1 should use one stone');
  const p = decision.move.positions[0];
  expect(
    posEq(p, { x: 2, y: 0 }) || posEq(p, { x: 8, y: 0 }),
    'WIN1 move should hit winning point',
  );
}

// WIN_IN_2: must take the win pair (2 stones).
{
  const state = makeState(
    [
      { pos: { x: 0, y: 1 }, player: 1 },
      { pos: { x: 1, y: 1 }, player: 1 },
      { pos: { x: 2, y: 1 }, player: 1 },
      { pos: { x: 5, y: 1 }, player: 1 },
    ],
    'BLACK',
    1,
  );
  const decision = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 1,
    timeLimitMs: 50,
    useMultithreading: false,
  });
  expect(decision.move.positions.length === 2, 'WIN2 should use two stones');
  const hit = decision.move.positions.some(p => posEq(p, { x: 3, y: 1 })) &&
    decision.move.positions.some(p => posEq(p, { x: 4, y: 1 }));
  expect(hit, 'WIN2 should place the winning pair');
}

// Defend WIN_IN_2: do not waste both stones on the same pair.
{
  const state = makeState(
    [
      { pos: { x: 0, y: 2 }, player: 2 },
      { pos: { x: 1, y: 2 }, player: 2 },
      { pos: { x: 2, y: 2 }, player: 2 },
      { pos: { x: 5, y: 2 }, player: 2 },
    ],
    'BLACK',
    1,
  );
  const decision = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 1,
    timeLimitMs: 50,
    useMultithreading: false,
  });
  expect(decision.move.positions.length === 2, 'DEF WIN2 should use two stones');
  const pairPoints = [
    { x: 3, y: 2 },
    { x: 4, y: 2 },
  ];
  const hits = decision.move.positions.filter(p =>
    pairPoints.some(q => posEq(p, q)),
  ).length;
  expect(hits === 1, 'DEF WIN2 should not spend both stones on the pair');
}

console.log('pvs_threat_root_selftest: OK');
