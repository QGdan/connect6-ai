import { BOARD_SIZE } from './game_state';
import type { Cell, GameState, Position } from '../types';

export type DirId = 0 | 1 | 2 | 3;

export function dirToId(dir: Position): DirId {
  if (dir.x === 1 && dir.y === 0) return 0;
  if (dir.x === 0 && dir.y === 1) return 1;
  if (dir.x === 1 && dir.y === 1) return 2;
  if (dir.x === 1 && dir.y === -1) return 3;
  throw new Error(`Unknown dir: ${dir.x},${dir.y}`);
}

export function dirIdToName(
  id: DirId,
): 'horizontal' | 'vertical' | 'diag_nw_se' | 'diag_ne_sw' {
  switch (id) {
    case 0:
      return 'horizontal';
    case 1:
      return 'vertical';
    case 2:
      return 'diag_nw_se';
    case 3:
      return 'diag_ne_sw';
    default:
      throw new Error(`Unknown dirId: ${id}`);
  }
}

export interface RoadOffset {
  roadId: number;
  offset: number;
}

export interface Road {
  id: number;
  cells: Position[]; // length=6
  dir: Position;
  dirId: DirId;
  start: Position;
  end: Position;
  before: Position | null;
  after: Position | null;
  // keep existing fields for compatibility
}

export interface Line {
  id: number;
  cells: Position[]; // full line, length >= 6
  dir: Position;
  dirId: DirId;
  start: Position;
  end: Position;
  before: Position | null;
  after: Position | null;
  indexOf: Int16Array; // idx -> position index in line, -1 if not in this line
}

const DIRS: Array<{ dir: Position; id: DirId }> = [
  { dir: { x: 1, y: 0 }, id: 0 },
  { dir: { x: 0, y: 1 }, id: 1 },
  { dir: { x: 1, y: 1 }, id: 2 },
  { dir: { x: 1, y: -1 }, id: 3 },
];

const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
const toIndex = (x: number, y: number) => y * BOARD_SIZE + x;
const inBoard = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;

const CELL_ROADS: Road[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const CELL_ROAD_OFFSETS: RoadOffset[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const LINE_CELLS: Line[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const ALL_ROADS: Road[] = precomputeRoads();
const ALL_LINES: Line[] = precomputeLines();

function precomputeRoads(): Road[] {
  const roads: Road[] = [];
  let id = 0;

  for (const { dir, id: dirId } of DIRS) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cells: Position[] = [];
        for (let k = 0; k < 6; k++) {
          const nx = x + dir.x * k;
          const ny = y + dir.y * k;
          if (!inBoard(nx, ny)) {
            cells.length = 0;
            break;
          }
          cells.push({ x: nx, y: ny });
        }
        if (cells.length === 6) {
          const start = cells[0];
          const end = cells[cells.length - 1];
          const beforeX = start.x - dir.x;
          const beforeY = start.y - dir.y;
          const afterX = end.x + dir.x;
          const afterY = end.y + dir.y;
          const road: Road = {
            id: id++,
            cells,
            dir,
            dirId,
            start,
            end,
            before: inBoard(beforeX, beforeY) ? { x: beforeX, y: beforeY } : null,
            after: inBoard(afterX, afterY) ? { x: afterX, y: afterY } : null,
          };
          roads.push(road);
          for (let idx = 0; idx < cells.length; idx++) {
            const c = cells[idx];
            const flat = toIndex(c.x, c.y);
            CELL_ROADS[flat].push(road);
            CELL_ROAD_OFFSETS[flat].push({ roadId: road.id, offset: idx });
          }
        }
      }
    }
  }
  return roads;
}

function precomputeLines(): Line[] {
  const lines: Line[] = [];
  let id = 0;

  const addLine = (sx: number, sy: number, dir: Position, dirId: DirId) => {
    const cells: Position[] = [];
    let x = sx;
    let y = sy;
    while (inBoard(x, y)) {
      cells.push({ x, y });
      x += dir.x;
      y += dir.y;
    }
    if (cells.length < 6) return;
    const start = cells[0];
    const end = cells[cells.length - 1];
    const beforeX = start.x - dir.x;
    const beforeY = start.y - dir.y;
    const afterX = end.x + dir.x;
    const afterY = end.y + dir.y;
    const indexOf = new Int16Array(BOARD_CELLS);
    indexOf.fill(-1);
    const line: Line = {
      id: id++,
      cells,
      dir,
      dirId,
      start,
      end,
      before: inBoard(beforeX, beforeY) ? { x: beforeX, y: beforeY } : null,
      after: inBoard(afterX, afterY) ? { x: afterX, y: afterY } : null,
      indexOf,
    };
    lines.push(line);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const idx = toIndex(c.x, c.y);
      LINE_CELLS[idx].push(line);
      line.indexOf[idx] = i;
    }
  };

  for (const { dir, id: dirId } of DIRS) {
    if (dir.x === 1 && dir.y === 0) {
      for (let y = 0; y < BOARD_SIZE; y++) addLine(0, y, dir, dirId);
    } else if (dir.x === 0 && dir.y === 1) {
      for (let x = 0; x < BOARD_SIZE; x++) addLine(x, 0, dir, dirId);
    } else if (dir.x === 1 && dir.y === 1) {
      for (let x = 0; x < BOARD_SIZE; x++) addLine(x, 0, dir, dirId);
      for (let y = 1; y < BOARD_SIZE; y++) addLine(0, y, dir, dirId);
    } else if (dir.x === 1 && dir.y === -1) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        addLine(x, BOARD_SIZE - 1, dir, dirId);
      }
      for (let y = BOARD_SIZE - 2; y >= 0; y--) addLine(0, y, dir, dirId);
    }
  }

  return lines;
}

// 2-bit encoding: 00=empty, 01=black, 10=white
export function encodeRoad(state: GameState, road: Road): number {
  let code = 0;
  for (let i = 0; i < road.cells.length; i++) {
    const { x, y } = road.cells[i];
    const cell: Cell = state.board[y][x];
    let bits = 0;
    if (cell === 1) bits = 0b01;
    else if (cell === 2) bits = 0b10;
    code |= bits << (i * 2);
  }
  return code;
}

export function getAllRoadCodes(state: GameState): number[] {
  return ALL_ROADS.map(road => encodeRoad(state, road));
}

export function getAllRoads(): Road[] {
  return ALL_ROADS;
}

export function getAllLines(): Line[] {
  return ALL_LINES;
}

export function getRoadsForCell(pos: Position): Road[] {
  if (!inBoard(pos.x, pos.y)) return [];
  return CELL_ROADS[toIndex(pos.x, pos.y)];
}

export function getRoadOffsetsForCell(pos: Position): RoadOffset[] {
  if (!inBoard(pos.x, pos.y)) return [];
  return CELL_ROAD_OFFSETS[toIndex(pos.x, pos.y)];
}

export function getLinesForCell(pos: Position): Line[] {
  if (!inBoard(pos.x, pos.y)) return [];
  return LINE_CELLS[toIndex(pos.x, pos.y)];
}

export function getLinesForCellWithIndex(
  pos: Position,
): Array<{ line: Line; index: number }> {
  if (!inBoard(pos.x, pos.y)) return [];
  const idx = toIndex(pos.x, pos.y);
  return LINE_CELLS[idx].map(line => ({
    line,
    index: line.indexOf[idx],
  }));
}

export function isHighValueRoadCell(
  state: GameState,
  pos: Position,
  minSameColor: number,
): boolean {
  const roads = getRoadsForCell(pos);
  const board = state.board;
  for (const road of roads) {
    let black = 0;
    let white = 0;
    for (const c of road.cells) {
      const cell = board[c.y][c.x];
      if (cell === 1) {
        black++;
        if (black >= minSameColor) return true;
      } else if (cell === 2) {
        white++;
        if (white >= minSameColor) return true;
      }
    }
  }
  return false;
}
