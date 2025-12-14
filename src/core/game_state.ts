import type { Cell, GameState, Move, Position } from '../types';

export const BOARD_SIZE = 19;

export function createEmptyBoard(): Cell[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array<Cell>(BOARD_SIZE).fill(0),
  );
}

export function createInitialState(): GameState {
  const board = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 0 as 0),
  );

  return {
    board,
    currentPlayer: 'BLACK',
    moveNumber: 0,     // ✅ 开局必须是 0，配合 getStonesToPlace 才是 "黑先 1 子"
    lastMove: undefined,
    winner: undefined,
  };
}

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    board: state.board.map(row => [...row]),
    lastMove: state.lastMove
      ? {
          player: state.lastMove.player,
          positions: state.lastMove.positions.map(p => ({ ...p })),
        }
      : undefined,
  };
}

export function applyMove(state: GameState, move: Move): GameState {
  const next = cloneState(state);
  const value: Cell = move.player === 'BLACK' ? 1 : 2;

  for (const pos of move.positions) {
    next.board[pos.y][pos.x] = value;
  }

  next.lastMove = move;
  next.currentPlayer = move.player === 'BLACK' ? 'WHITE' : 'BLACK';
  next.moveNumber += 1;
  return next;
}

export function isInsideBoard(pos: Position): boolean {
  return (
    pos.x >= 0 && pos.x < BOARD_SIZE && pos.y >= 0 && pos.y < BOARD_SIZE
  );
}
