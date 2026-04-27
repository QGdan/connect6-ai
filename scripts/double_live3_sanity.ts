import type { GameState, Move, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { Connect6AI } from '../src/core/connect6_ai.ts';
import { posIdx } from '../src/core/pos_key.ts';
import { formatBoardCoordTuple } from '../src/core/board_coords.ts';
import { getAllLines } from '../src/core/road_encoding.ts';

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

type OpenThreeThreat = { id: number; ends: [Position, Position] };

function collectOpenThreeThreats(
  state: GameState,
  playerVal: number,
): OpenThreeThreat[] {
  const threats: OpenThreeThreat[] = [];
  for (const line of getAllLines()) {
    const vals = line.cells.map(p => state.board[p.y][p.x]);
    let i = 0;
    while (i < vals.length) {
      if (vals[i] !== playerVal) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < vals.length && vals[i] === playerVal) i += 1;
      const end = i - 1;
      const runLen = end - start + 1;
      if (runLen === 3) {
        const leftPos =
          start - 1 >= 0 ? line.cells[start - 1] : line.before;
        const rightPos =
          end + 1 < vals.length ? line.cells[end + 1] : line.after;
        if (!leftPos || !rightPos) continue;
        if (state.board[leftPos.y][leftPos.x] !== 0) continue;
        if (state.board[rightPos.y][rightPos.x] !== 0) continue;
        threats.push({
          id: line.id * 32 + start,
          ends: [leftPos, rightPos],
        });
      }
    }
  }
  return threats;
}

function coverThreats(threats: OpenThreeThreat[], points: Position[]): Set<number> {
  const covered = new Set<number>();
  for (const p of points) {
    for (const t of threats) {
      if (
        (t.ends[0].x === p.x && t.ends[0].y === p.y) ||
        (t.ends[1].x === p.x && t.ends[1].y === p.y)
      ) {
        covered.add(t.id);
      }
    }
  }
  return covered;
}

async function testDoubleLive3Attack(ai: Connect6AI): Promise<void> {
  const black: Position[] = [
    { x: 9, y: 9 },
    { x: 8, y: 9 },
    { x: 10, y: 9 },
    { x: 9, y: 8 },
    { x: 9, y: 10 },
  ];
  const state = makeState(black, [], 'BLACK', 2);
  const threats = collectOpenThreeThreats(state, 1);
  assert(threats.length >= 2, 'Expected double live3 for current player');

  const move = await ai.get_best_move(state, 80);
  console.log('double-live3 attack:', formatMove(move));
  assert(move.positions.length === 2, 'Expected 2 stones for attack');
  const covered = coverThreats(threats, move.positions);
  assert(covered.size >= 2, 'Attack should extend two open threes');
}

async function testDoubleLive3Defense(ai: Connect6AI): Promise<void> {
  const white: Position[] = [
    { x: 9, y: 9 },
    { x: 8, y: 9 },
    { x: 10, y: 9 },
    { x: 9, y: 8 },
    { x: 9, y: 10 },
  ];
  const black: Position[] = [
    { x: 0, y: 0 },
    { x: 18, y: 18 },
  ];
  const state = makeState(black, white, 'BLACK', 2);
  const threats = collectOpenThreeThreats(state, 2);
  assert(threats.length >= 2, 'Expected double live3 for opponent');

  const move = await ai.get_best_move(state, 80);
  console.log('double-live3 defense:', formatMove(move));
  assert(move.positions.length === 2, 'Expected 2 stones for defense');
  const covered = coverThreats(threats, move.positions);
  assert(covered.size >= 2, 'Defense should cover two live3 lines');
}

async function main() {
  const ai = new Connect6AI('fast');
  await testDoubleLive3Attack(ai);
  await testDoubleLive3Defense(ai);
  console.log('double_live3_sanity: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
