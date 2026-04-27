import type { GameState, Move, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { Connect6AI } from '../src/core/connect6_ai.ts';
import { analyzeBothSidesCached } from '../src/core/threat_service.ts';
import { applyMoveWithWinner } from '../src/core/rules.ts';
import { posIdx } from '../src/core/pos_key.ts';
import { formatBoardCoordTuple } from '../src/core/board_coords.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function formatMove(move: Move): string {
  return move.positions.map(p => `(${formatBoardCoordTuple(p)})`).join(' ');
}

function makeState(
  black: Position[],
  white: Position[],
  currentPlayer: Player,
  moveNumber: number,
): GameState {
  const board = createEmptyBoard();
  const seen = new Set<number>();
  for (const p of black) {
    const key = posIdx(p.x, p.y);
    assert(!seen.has(key), 'Duplicate position in black stones');
    seen.add(key);
    board[p.y][p.x] = 1;
  }
  for (const p of white) {
    const key = posIdx(p.x, p.y);
    assert(!seen.has(key), 'Duplicate position in white stones');
    seen.add(key);
    board[p.y][p.x] = 2;
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

function moveMatchesPair(move: Move, pair: [Position, Position]): boolean {
  const moveSet = new Set(move.positions.map(p => posIdx(p.x, p.y)));
  return (
    moveSet.size === 2 &&
    moveSet.has(posIdx(pair[0].x, pair[0].y)) &&
    moveSet.has(posIdx(pair[1].x, pair[1].y))
  );
}

async function testWinIn1(ai: Connect6AI): Promise<void> {
  const black = [
    { x: 3, y: 9 },
    { x: 4, y: 9 },
    { x: 5, y: 9 },
    { x: 6, y: 9 },
    { x: 7, y: 9 },
  ];
  const state = makeState(black, [], 'BLACK', 2);
  const { my } = analyzeBothSidesCached(state, state.currentPlayer);
  assert(my.winIn1.length >= 2, 'Expected winIn1 points for current player');
  const move = await ai.get_best_move(state, 60);
  console.log('winIn1 move:', formatMove(move));
  const winSet = new Set(my.winIn1.map(p => posIdx(p.x, p.y)));
  assert(move.positions.length === 2, 'winIn1 should return 2 stones');
  assert(
    move.positions.every(p => winSet.has(posIdx(p.x, p.y))),
    'winIn1 move must use winning points',
  );
}

async function testWinIn2(ai: Connect6AI): Promise<void> {
  const black = [
    { x: 4, y: 7 },
    { x: 5, y: 7 },
    { x: 6, y: 7 },
    { x: 7, y: 7 },
  ];
  const state = makeState(black, [], 'BLACK', 2);
  const { my } = analyzeBothSidesCached(state, state.currentPlayer);
  assert(my.winIn2.length > 0, 'Expected winIn2 pairs for current player');
  const move = await ai.get_best_move(state, 60);
  console.log('winIn2 move:', formatMove(move));
  assert(move.positions.length === 2, 'winIn2 should return 2 stones');
  const matches = my.winIn2.some(pair => moveMatchesPair(move, pair));
  assert(matches, 'winIn2 move should match a winning pair');
}

async function testDefenseSafeSecond(ai: Connect6AI): Promise<void> {
  const white = [
    { x: 4, y: 11 },
    { x: 5, y: 11 },
    { x: 6, y: 11 },
    { x: 7, y: 11 },
    { x: 8, y: 11 },
  ];
  const black = [{ x: 3, y: 11 }];
  const state = makeState(black, white, 'BLACK', 2);
  const { opp } = analyzeBothSidesCached(state, state.currentPlayer);
  assert(opp.winIn1.length === 1, 'Expected a single opp winIn1 point');
  const blockPoint = opp.winIn1[0];
  const move = await ai.get_best_move(state, 80);
  console.log('defense move:', formatMove(move));
  assert(
    move.positions.some(p => posIdx(p.x, p.y) === posIdx(blockPoint.x, blockPoint.y)),
    'defense must include the block point',
  );
  const nextState = applyMoveWithWinner(state, move);
  const { my: nextMy } = analyzeBothSidesCached(
    nextState,
    nextState.currentPlayer,
  );
  assert(
    nextMy.winIn1.length === 0 && nextMy.byType.CONNECT6.length === 0,
    'defense second stone should not allow immediate win',
  );
}

async function main() {
  const ai = new Connect6AI('fast');
  await testWinIn1(ai);
  await testWinIn2(ai);
  await testDefenseSafeSecond(ai);
  console.log('tactical_sanity: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
