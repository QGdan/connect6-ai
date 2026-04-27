import type { Cell, GameState, Move, Position } from '../types';
import { BOARD_SIZE } from '../types';
import { computeZobristHash, ZOBRIST_TABLE, toggleSideHash } from './zobrist';
import { posIdx } from './pos_key';

export { BOARD_SIZE } from '../types';

export function createEmptyBoard(): Cell[][] {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array<Cell>(BOARD_SIZE).fill(0),
  );
}

export function createInitialState(): GameState {
  const board = createEmptyBoard();

  return {
    board,
    currentPlayer: 'BLACK',
    moveNumber: 0, // 开局必须是 0，匹配 getStonesToPlace 的“黑先 1 子”
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, 'BLACK'),
  };
}

export function cloneState(
  state: GameState,
  positions?: Position[],
): GameState {
  const board =
    positions && positions.length > 0
      ? cloneBoardForPositions(state.board, positions)
      : state.board.map(row => [...row]);

  return {
    ...state,
    board,
    lastMove: state.lastMove
      ? {
          player: state.lastMove.player,
          positions: state.lastMove.positions.map(p => ({ ...p })),
        }
      : undefined,
    zobristHash: state.zobristHash,
  };
}

function cloneBoardForPositions(
  board: Cell[][],
  positions: Position[],
): Cell[][] {
  const copy = board.slice();
  const copiedRows = new Set<number>();
  for (const pos of positions) {
    const y = pos.y;
    if (y < 0 || y >= board.length) continue;
    if (copiedRows.has(y)) continue;
    copy[y] = board[y].slice();
    copiedRows.add(y);
  }
  return copy;
}

export function applyMove(state: GameState, move: Move): GameState {
  const next = cloneState(state, move.positions);
  const value: Cell = move.player === 'BLACK' ? 1 : 2;

  const seen = new Set<number>();

  for (const pos of move.positions) {
    const key = posIdx(pos.x, pos.y);
    if (seen.has(key)) continue;
    seen.add(key);
    next.board[pos.y][pos.x] = value;
    next.zobristHash ^= ZOBRIST_TABLE[pos.y][pos.x][value === 1 ? 0 : 1];
  }

  next.lastMove = move;
  next.currentPlayer = move.player === 'BLACK' ? 'WHITE' : 'BLACK';
  next.moveNumber += 1;
  next.zobristHash = toggleSideHash(next.zobristHash);
  // 注意：applyMove 未做规则校验/胜负判定；但会维护哈希以保持一致。
  return next;
}

export function isInsideBoard(pos: Position): boolean {
  return (
    pos.x >= 0 && pos.x < BOARD_SIZE && pos.y >= 0 && pos.y < BOARD_SIZE
  );
}
