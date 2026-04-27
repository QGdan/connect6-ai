import { createEmptyBoard } from '../src/core/game_state';
import { computeZobristHash } from '../src/core/zobrist';
import { buildSmartBlockForOpponentLive4 } from '../src/core/smart_defense';
import { analyzeCached } from '../src/core/threat_service';
import type { GameState, Player, Position } from '../src/types';

function makeState(
  placements: Array<{ player: Player; positions: Position[] }>,
  currentPlayer: Player,
  moveNumber: number,
): GameState {
  const board = createEmptyBoard();
  for (const group of placements) {
    const v = group.player === 'BLACK' ? 1 : 2;
    for (const p of group.positions) {
      board[p.y][p.x] = v;
    }
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

function pos(x: number, y: number): Position {
  return { x, y };
}

const state = makeState(
  [
    {
      player: 'WHITE',
      positions: [pos(5, 9), pos(6, 9), pos(7, 9), pos(8, 9)],
    },
  ],
  'BLACK',
  0,
);

const report = analyzeCached(state, 'WHITE');
const move = buildSmartBlockForOpponentLive4(state, 'BLACK', report);

if (move.positions.length !== 1) {
  throw new Error(`Expected 1 stone, got ${move.positions.length}`);
}

console.log('smart defense need=1 ok');
