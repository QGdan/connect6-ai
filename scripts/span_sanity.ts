import type { GameState, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { analyzeThreats } from '../src/core/threat_analyzer.ts';
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

function testDeadPocketSpan(): void {
  const black: Position[] = [
    { x: 6, y: 9 },
    { x: 7, y: 9 },
    { x: 8, y: 9 },
    { x: 9, y: 9 },
  ];
  const white: Position[] = [
    { x: 5, y: 9 },
    { x: 11, y: 9 },
  ];
  const state = makeState(black, white, 'BLACK', 2);
  const report = analyzeThreats(state, 'BLACK');

  const forbiddenTypes = ['LIVE4', 'CHARGE4', 'LIVE3'] as const;
  const bad = forbiddenTypes
    .flatMap(type => report.byType[type])
    .filter(hit => hit.dir.x === 1 && hit.dir.y === 0);
  assert(bad.length === 0, 'Expected no live/charge threats in dead pocket span');
}

function main() {
  testDeadPocketSpan();
  console.log('span_sanity: OK');
}

main();
