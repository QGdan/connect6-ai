import type { GameState, Player, Position } from '../types';
import { getAllRoads } from './road_encoding';

export type RoadExtension = { pos: Position; dir: 'left' | 'right' };

export type RoadSuggestion = {
  roadId: number;
  count: number;
  cells: Position[];
  extensions: RoadExtension[];
};

function getRoadExtensions(
  cells: Position[],
  board: number[][],
  myVal: number,
): RoadExtension[] {
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;

  let i = 0;
  while (i < cells.length) {
    const c = cells[i];
    if (board[c.y]?.[c.x] !== myVal) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < cells.length) {
      const next = cells[j];
      if (board[next.y]?.[next.x] !== myVal) break;
      j += 1;
    }
    const len = j - i;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
      bestEnd = j - 1;
    }
    i = j;
  }

  if (bestLen === 0) return [];
  const out: RoadExtension[] = [];
  const leftIdx = bestStart - 1;
  if (leftIdx >= 0) {
    const p = cells[leftIdx];
    if (board[p.y]?.[p.x] === 0) out.push({ pos: p, dir: 'left' });
  }
  const rightIdx = bestEnd + 1;
  if (rightIdx < cells.length) {
    const p = cells[rightIdx];
    if (board[p.y]?.[p.x] === 0) out.push({ pos: p, dir: 'right' });
  }
  return out;
}

export function computeRoadSuggestions(
  state: GameState,
  focusPlayer: Player,
  maxRoads = 6,
): RoadSuggestion[] {
  const myVal = focusPlayer === 'BLACK' ? 1 : 2;
  const roads = getAllRoads();

  const roadScores = roads.map(road => {
    let count = 0;
    for (const p of road.cells) {
      if (state.board[p.y][p.x] === myVal) count += 1;
    }
    return { road, count };
  });

  roadScores.sort((a, b) => b.count - a.count);
  const top = roadScores.slice(0, maxRoads).filter(r => r.count > 0);

  return top.map(item => ({
    roadId: item.road.id,
    count: item.count,
    cells: item.road.cells,
    extensions: getRoadExtensions(item.road.cells, state.board, myVal),
  }));
}
