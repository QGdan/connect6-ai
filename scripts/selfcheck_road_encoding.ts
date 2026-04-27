import { BOARD_SIZE } from '../src/core/game_state.ts';
import {
  getAllRoads,
  getRoadOffsetsForCell,
  getRoadsForCell,
  getLinesForCell,
  getLinesForCellWithIndex,
} from '../src/core/road_encoding.ts';
import type { Position } from '../src/types.ts';

const mulberry32 = (a: number) => () => {
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const inBoard = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;

const posEqual = (a: Position | null, b: Position | null) => {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y;
};

const toIndex = (x: number, y: number) => y * BOARD_SIZE + x;

const run = (seed = 123456, samples = 200) => {
  const rng = mulberry32(seed);
  const randInt = (max: number) => Math.floor(rng() * max);

  const roads = getAllRoads();

  for (let i = 0; i < samples; i++) {
    const road = roads[randInt(roads.length)];
    const start = road.start;
    const end = road.end;
    const beforeX = start.x - road.dir.x;
    const beforeY = start.y - road.dir.y;
    const afterX = end.x + road.dir.x;
    const afterY = end.y + road.dir.y;
    const expectedBefore = inBoard(beforeX, beforeY)
      ? { x: beforeX, y: beforeY }
      : null;
    const expectedAfter = inBoard(afterX, afterY)
      ? { x: afterX, y: afterY }
      : null;
    if (!posEqual(road.before, expectedBefore)) {
      throw new Error('before mismatch');
    }
    if (!posEqual(road.after, expectedAfter)) {
      throw new Error('after mismatch');
    }
  }

  for (let i = 0; i < samples; i++) {
    const pos = { x: randInt(BOARD_SIZE), y: randInt(BOARD_SIZE) };
    const roadsForCell = getRoadsForCell(pos);
    const offsets = getRoadOffsetsForCell(pos);
    if (roadsForCell.length !== offsets.length) {
      throw new Error('road offset count mismatch');
    }
    const roadIdsFromOffsets = new Set(offsets.map(o => o.roadId));
    const roadIds = new Set(roadsForCell.map(r => r.id));
    if (roadIdsFromOffsets.size !== roadIds.size) {
      throw new Error('road offset id size mismatch');
    }
    for (const rid of roadIdsFromOffsets) {
      if (!roadIds.has(rid)) throw new Error('road offset id mismatch');
    }
    for (const off of offsets) {
      const road = roadsForCell.find(r => r.id === off.roadId);
      if (!road) throw new Error('missing road for offset');
      const at = road.cells[off.offset];
      if (!at || at.x !== pos.x || at.y !== pos.y) {
        throw new Error('offset points to wrong cell');
      }
    }
  }

  for (let i = 0; i < samples; i++) {
    const pos = { x: randInt(BOARD_SIZE), y: randInt(BOARD_SIZE) };
    const linesRaw = getLinesForCell(pos);
    const withIdx = getLinesForCellWithIndex(pos);
    if (linesRaw.length !== withIdx.length) {
      throw new Error('lines with index count mismatch');
    }
    for (const { line, index } of withIdx) {
      const flat = toIndex(pos.x, pos.y);
      if (line.indexOf[flat] !== index) {
        throw new Error('line indexOf mismatch');
      }
      const cell = line.cells[index];
      if (!cell || cell.x !== pos.x || cell.y !== pos.y) {
        throw new Error('line index points wrong cell');
      }
    }
  }
};

run();
console.log('selfcheck_road_encoding: OK');
