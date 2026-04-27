import type { Cell, GameState, Player } from '../types';
import { BOARD_SIZE } from './game_state';

export type SerializedGameState = {
  board: Uint8Array;
  currentPlayer: Player;
  moveNumber: number;
  winner?: Player | 'DRAW';
  zobristHash: bigint;
};

export function serializeGameState(state: GameState): SerializedGameState {
  const size = state.board.length;
  const data = new Uint8Array(size * size);
  let idx = 0;
  for (let y = 0; y < size; y++) {
    const row = state.board[y];
    for (let x = 0; x < size; x++) {
      data[idx++] = row[x];
    }
  }
  return {
    board: data,
    currentPlayer: state.currentPlayer,
    moveNumber: state.moveNumber,
    winner: state.winner,
    zobristHash: state.zobristHash,
  };
}

export function deserializeGameState(
  input: GameState | SerializedGameState,
): GameState {
  if (input.board instanceof Uint8Array) {
    const data = input.board;
    const size = BOARD_SIZE;
    const board: Cell[][] = Array.from({ length: size }, () =>
      Array<Cell>(size).fill(0),
    );
    const limit = Math.min(data.length, size * size);
    for (let i = 0; i < limit; i++) {
      const y = Math.floor(i / size);
      const x = i % size;
      board[y][x] = data[i] as Cell;
    }
    return {
      board,
      currentPlayer: input.currentPlayer,
      moveNumber: input.moveNumber,
      winner: input.winner,
      zobristHash: input.zobristHash,
    };
  }
  return input as GameState;
}
