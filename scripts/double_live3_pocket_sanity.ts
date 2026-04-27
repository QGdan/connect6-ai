import type { GameState, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { analyzeBothSidesCached } from '../src/core/threat_service.ts';
import { __test__ } from '../src/core/connect6_ai.ts';
import { posIdx } from '../src/core/pos_key.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
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

function testDeadPocketDoubleLive3(): void {
  const black: Position[] = [
    { x: 5, y: 8 },
    { x: 11, y: 8 },
    { x: 8, y: 5 },
    { x: 8, y: 11 },
  ];
  const white: Position[] = [
    { x: 7, y: 8 },
    { x: 8, y: 8 },
    { x: 9, y: 8 },
    { x: 8, y: 7 },
    { x: 8, y: 9 },
  ];
  const state = makeState(black, white, 'BLACK', 2);
  const { opp: oppReport } = analyzeBothSidesCached(state, 'BLACK');

  const hasDouble = __test__.hasStrictDoubleLive3(state, oppReport);
  assert(!hasDouble, 'Expected no double live3 inside dead pocket');

  const defense = __test__.pickDoubleLive3DefenseMove(
    oppReport,
    state,
    'BLACK',
  );
  assert(defense === null, 'Defense move should not trigger for dead pocket');
}

function main() {
  testDeadPocketDoubleLive3();
  console.log('double_live3_pocket_sanity: OK');
}

main();
