import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, BOARD_SIZE } from '../src/core/game_state.js';

test('creates an empty board with the correct dimensions', () => {
  const state = createInitialState();
  assert.equal(state.board.length, BOARD_SIZE);
  for (const row of state.board) {
    assert.equal(row.length, BOARD_SIZE);
    assert.ok(row.every(cell => cell === 0));
  }
});

test('starts with the black player to move at move 0', () => {
  const state = createInitialState();
  assert.equal(state.currentPlayer, 'BLACK');
  assert.equal(state.moveNumber, 0);
  assert.equal(state.winner, undefined);
});
