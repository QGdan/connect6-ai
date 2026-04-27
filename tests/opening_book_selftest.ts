import { createInitialState, BOARD_SIZE } from '../src/core/game_state';
import { Connect6AI } from '../src/core/connect6_ai';

const state = createInitialState();
const ai = new Connect6AI('fast');

const move = await ai.get_best_move(state, 50);
if (move.positions.length !== 1) {
  throw new Error(`opening move should place 1 stone, got ${move.positions.length}`);
}

const c = Math.floor(BOARD_SIZE / 2);
const [pos] = move.positions;
if (pos.x !== c || pos.y !== c) {
  throw new Error(`opening move should be center (${c},${c}), got (${pos.x},${pos.y})`);
}

console.log('opening_book_selftest: OK');
