import type { Cell, Move, Position } from '../types';

export type Symmetry = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const SYMMETRIES: Symmetry[] = [0, 1, 2, 3, 4, 5, 6, 7];

function rotate(pos: Position, size: number, r: number): Position {
  const { x, y } = pos;
  switch (r) {
    case 0:
      return { x, y };
    case 1:
      return { x: size - 1 - y, y: x };
    case 2:
      return { x: size - 1 - x, y: size - 1 - y };
    case 3:
      return { x: y, y: size - 1 - x };
    default:
      return { x, y };
  }
}

export function transformPosition(
  pos: Position,
  size: number,
  symmetry: Symmetry,
): Position {
  if (symmetry < 4) {
    return rotate(pos, size, symmetry);
  }
  const mirrored = { x: size - 1 - pos.x, y: pos.y };
  return rotate(mirrored, size, symmetry - 4);
}

export function transformMove(
  move: Move,
  size: number,
  symmetry: Symmetry,
): Move {
  return {
    player: move.player,
    positions: move.positions.map(p => transformPosition(p, size, symmetry)),
  };
}

export function transformBoard(board: Cell[][], symmetry: Symmetry): Cell[][] {
  const size = board.length;
  const out: Cell[][] = Array.from({ length: size }, () =>
    Array<Cell>(size).fill(0),
  );

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = board[y]?.[x] ?? 0;
      if (cell === 0) continue;
      const next = transformPosition({ x, y }, size, symmetry);
      out[next.y][next.x] = cell;
    }
  }

  return out;
}
