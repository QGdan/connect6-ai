import type { GameState, Position } from '../types';
import { BOARD_SIZE } from '../types';

const LINE_DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

function isInsideBoard(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function lineSpanWithoutOpponent(
  state: GameState,
  pos: Position,
  oppVal: 1 | 2,
  dx: number,
  dy: number,
): number {
  let count = 1;
  let nx = pos.x + dx;
  let ny = pos.y + dy;
  while (isInsideBoard(nx, ny) && state.board[ny][nx] !== oppVal) {
    count += 1;
    nx += dx;
    ny += dy;
  }
  nx = pos.x - dx;
  ny = pos.y - dy;
  while (isInsideBoard(nx, ny) && state.board[ny][nx] !== oppVal) {
    count += 1;
    nx -= dx;
    ny -= dy;
  }
  return count;
}

function hasLinePotential(
  state: GameState,
  pos: Position,
  oppVal: 1 | 2,
): boolean {
  for (const { dx, dy } of LINE_DIRS) {
    if (lineSpanWithoutOpponent(state, pos, oppVal, dx, dy) >= 6) return true;
  }
  return false;
}

export function isDeadLineCell(state: GameState, pos: Position): boolean {
  const cell = state.board[pos.y]?.[pos.x];
  if (cell !== 0) return false;
  const blackAlive = hasLinePotential(state, pos, 2);
  if (blackAlive) return false;
  const whiteAlive = hasLinePotential(state, pos, 1);
  return !whiteAlive;
}
