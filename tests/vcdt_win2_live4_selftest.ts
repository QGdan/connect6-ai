import { createEmptyBoard } from '../src/core/game_state';
import { detectVCDT } from '../src/core/vcdt';
import type { GameState, Player, Position } from '../src/types';

function makeState(): GameState {
  return {
    board: createEmptyBoard(),
    currentPlayer: 'BLACK',
    moveNumber: 0,
    lastMove: undefined,
    winner: undefined,
    zobristHash: 0n,
  };
}

function place(state: GameState, player: Player, positions: Position[]) {
  const v = player === 'BLACK' ? 1 : 2;
  for (const p of positions) {
    state.board[p.y][p.x] = v;
  }
}

function pairKey(a: Position, b: Position): string {
  if (a.x < b.x || (a.x === b.x && a.y <= b.y)) {
    return `${a.x},${a.y}|${b.x},${b.y}`;
  }
  return `${b.x},${b.y}|${a.x},${a.y}`;
}

// Consecutive four should include LIVE4 and may also produce WIN_IN_2.
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 6, y: 9 },
    { x: 7, y: 9 },
    { x: 8, y: 9 },
    { x: 9, y: 9 },
  ]);
  const threats = detectVCDT(state, 'BLACK');
  if (!threats.some(t => t.kind === 'LIVE4')) {
    throw new Error('LIVE4 not found for consecutive four');
  }
  if (!threats.some(t => t.kind === 'WIN_IN_2')) {
    throw new Error('WIN_IN_2 not found for consecutive four');
  }
}

// Gapped 4+2 should be WIN_IN_2 only (no LIVE4).
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 0, y: 3 },
    { x: 1, y: 3 },
    { x: 3, y: 3 },
    { x: 5, y: 3 },
  ]);
  const threats = detectVCDT(state, 'BLACK');
  if (!threats.some(t => t.kind === 'WIN_IN_2')) {
    throw new Error('WIN_IN_2 not found for gapped four');
  }
  if (threats.some(t => t.kind === 'LIVE4')) {
    throw new Error('LIVE4 should not appear for gapped four');
  }
  const win2 = threats.filter(t => t.kind === 'WIN_IN_2');
  const keys = new Set<string>();
  for (const t of win2) {
    if (t.positions.length !== 2) {
      throw new Error('WIN_IN_2 should have 2 positions');
    }
    keys.add(pairKey(t.positions[0], t.positions[1]));
  }
  if (keys.size !== win2.length) {
    throw new Error('WIN_IN_2 has duplicate pairs');
  }
}

console.log('vcdt_win2_live4_selftest: OK');
