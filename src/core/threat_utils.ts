import type { GameState, Position } from '../types';
import { getAllLines } from './road_encoding';

export type Live3Threat = { id: number; lineId: number; ends: [Position, Position] };

export function computeSpanLen(
  vals: number[],
  start: number,
  end: number,
  oppVal: number,
): number {
  let spanLeft = start;
  while (spanLeft - 1 >= 0 && vals[spanLeft - 1] !== oppVal) spanLeft -= 1;
  let spanRight = end;
  while (spanRight + 1 < vals.length && vals[spanRight + 1] !== oppVal) {
    spanRight += 1;
  }
  return spanRight - spanLeft + 1;
}

export function collectOpenThreeThreats(
  state: GameState,
  playerVal: number,
): Live3Threat[] {
  const threats: Live3Threat[] = [];
  const seen = new Set<string>();
  const oppVal = playerVal === 1 ? 2 : 1;
  const pushThreat = (
    lineId: number,
    leftPos: Position,
    rightPos: Position,
    id: number,
  ) => {
    const key = `${lineId}:${leftPos.x},${leftPos.y}:${rightPos.x},${rightPos.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    threats.push({ id, lineId, ends: [leftPos, rightPos] });
  };
  for (const line of getAllLines()) {
    const vals = line.cells.map(p => state.board[p.y][p.x]);
    let i = 0;
    while (i < vals.length) {
      if (vals[i] !== playerVal) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < vals.length && vals[i] === playerVal) i += 1;
      const end = i - 1;
      const runLen = end - start + 1;
      if (runLen === 3) {
        const spanLen = computeSpanLen(vals, start, end, oppVal);
        if (spanLen < 6) continue;
        const leftPos = start - 1 >= 0 ? line.cells[start - 1] : line.before;
        const rightPos = end + 1 < vals.length ? line.cells[end + 1] : line.after;
        if (!leftPos || !rightPos) continue;
        if (state.board[leftPos.y][leftPos.x] !== 0) continue;
        if (state.board[rightPos.y][rightPos.x] !== 0) continue;
        pushThreat(line.id, leftPos, rightPos, line.id * 64 + start);
      }
    }

    // Split live3: .XX.X. or .X.XX.
    for (let start = 0; start + 5 < vals.length; start++) {
      if (vals[start] !== 0 || vals[start + 5] !== 0) continue;
      const v1 = vals[start + 1];
      const v2 = vals[start + 2];
      const v3 = vals[start + 3];
      const v4 = vals[start + 4];
      const patternA =
        v1 === playerVal && v2 === playerVal && v3 === 0 && v4 === playerVal;
      const patternB =
        v1 === playerVal && v2 === 0 && v3 === playerVal && v4 === playerVal;
      if (!patternA && !patternB) continue;
      const spanLen = computeSpanLen(vals, start + 1, start + 4, oppVal);
      if (spanLen < 6) continue;
      const leftPos = line.cells[start];
      const rightPos = line.cells[start + 5];
      pushThreat(line.id, leftPos, rightPos, line.id * 64 + start + 32);
    }
  }
  return threats;
}

export function countOpenThreeLines(threats: Live3Threat[]): number {
  const lines = new Set<number>();
  for (const t of threats) lines.add(t.lineId);
  return lines.size;
}
