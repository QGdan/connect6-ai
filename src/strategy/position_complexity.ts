import type{ GameState } from '../types';
import { getAllRoads } from '../core/road_encoding';

export function estimateComplexity(state: GameState): number {
  const board = state.board;
  let stones = 0;
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      if (board[y][x] !== 0) stones++;
    }
  }

  const roads = getAllRoads();
  let mixedRoads = 0;
  for (const road of roads) {
    let hasBlack = false;
    let hasWhite = false;
    for (const p of road.cells) {
      const v = board[p.y][p.x];
      if (v === 1) hasBlack = true;
      if (v === 2) hasWhite = true;
    }
    if (hasBlack && hasWhite) mixedRoads++;
  }

  const maxStones = board.length * board.length;
  const stonesFactor = stones / maxStones;
  const mixedFactor = mixedRoads / roads.length;

  return Math.min(1, stonesFactor * 0.5 + mixedFactor * 0.5);
}
