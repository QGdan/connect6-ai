import { BOARD_SIZE, type Position } from '../types';

const A_CODE = 65;

export function colFromX(x: number): string {
  if (x < 0 || x >= BOARD_SIZE) return '';
  return String.fromCharCode(A_CODE + x);
}

export function rowFromY(y: number): number {
  return BOARD_SIZE - y;
}

export function toBoardCoord(pos: Position): { col: string; row: number } {
  return { col: colFromX(pos.x), row: rowFromY(pos.y) };
}

export function formatBoardCoord(pos: Position): string {
  const { col, row } = toBoardCoord(pos);
  return `${col}${row}`;
}

export function formatBoardCoordTuple(pos: Position): string {
  const { col, row } = toBoardCoord(pos);
  return `${col},${row}`;
}

export function parseBoardCoord(token: string): Position | null {
  const match = /^([A-Sa-s])(\d{1,2})$/.exec(token.trim());
  if (!match) return null;
  const x = match[1].toUpperCase().charCodeAt(0) - A_CODE;
  const row = Number.parseInt(match[2], 10);
  if (!Number.isFinite(row) || row < 1 || row > BOARD_SIZE) return null;
  if (x < 0 || x >= BOARD_SIZE) return null;
  return { x, y: BOARD_SIZE - row };
}
