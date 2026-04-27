import type { GameState, Position } from '../types';
import { BOARD_SIZE } from './game_state';
import { posIdx } from './pos_key';

export function sortByCenter(points: Position[]): Position[] {
  const center = (BOARD_SIZE - 1) / 2;
  return [...points].sort((a, b) => {
    const da = Math.abs(a.x - center) + Math.abs(a.y - center);
    const db = Math.abs(b.x - center) + Math.abs(b.y - center);
    return da - db;
  });
}

export function uniqueEmptyPoints(
  state: GameState,
  points: Position[],
  avoid?: Set<number>,
): Position[] {
  const seen = new Set<number>();
  const out: Position[] = [];
  for (const p of points) {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) continue;
    const key = posIdx(p.x, p.y);
    if (avoid && avoid.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
