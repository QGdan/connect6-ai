import type { Move } from '../src/types';
import { createInitialState } from '../src/core/game_state';
import { applyMoveWithWinner } from '../src/core/rules';
import { computeZobristHash } from '../src/core/zobrist';

const moves: Move[] = [
  { player: 'BLACK', positions: [{ x: 9, y: 9 }] },
  { player: 'WHITE', positions: [{ x: 9, y: 8 }, { x: 10, y: 9 }] },
  { player: 'BLACK', positions: [{ x: 8, y: 9 }, { x: 10, y: 10 }] },
  { player: 'WHITE', positions: [{ x: 8, y: 8 }, { x: 10, y: 8 }] },
];

let state = createInitialState();

const initialHash = computeZobristHash(state.board, state.currentPlayer);
if (initialHash !== state.zobristHash) {
  throw new Error('Initial zobrist hash mismatch');
}

for (let i = 0; i < moves.length; i++) {
  state = applyMoveWithWinner(state, moves[i]);
  const recomputed = computeZobristHash(state.board, state.currentPlayer);
  if (recomputed !== state.zobristHash) {
    throw new Error(`Zobrist hash mismatch after move ${i + 1}`);
  }
}

console.log('zobrist check ok');
