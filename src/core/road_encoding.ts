import { BOARD_SIZE } from './game_state';
import type { Cell, GameState, Position } from '../types';

export interface Road {
  id: number;
  cells: Position[]; // 长度=6
}

const ALL_ROADS: Road[] = precomputeRoads();

function precomputeRoads(): Road[] {
  const roads: Road[] = [];
  let id = 0;

  const directions: Position[] = [
    { x: 1, y: 0 },  // 横
    { x: 0, y: 1 },  // 竖
    { x: 1, y: 1 },  // 斜 \
    { x: 1, y: -1 }, // 斜 /
  ];

  for (const dir of directions) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cells: Position[] = [];
        for (let k = 0; k < 6; k++) {
          const nx = x + dir.x * k;
          const ny = y + dir.y * k;
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) {
            cells.length = 0;
            break;
          }
          cells.push({ x: nx, y: ny });
        }
        if (cells.length === 6) {
          roads.push({ id: id++, cells });
        }
      }
    }
  }
  return roads;
}

// 2 bit 编码：00=空, 01=黑, 10=白
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

export function isHighValueRoadCell(
  state: GameState,
  pos: Position,
  minSameColor: number,
): boolean {
  for (const road of ALL_ROADS) {
    if (!road.cells.some(c => c.x === pos.x && c.y === pos.y)) continue;
    let black = 0;
    let white = 0;
    for (const c of road.cells) {
      const cell = state.board[c.y][c.x];
      if (cell === 1) black++;
      else if (cell === 2) white++;
    }
    if (black >= minSameColor || white >= minSameColor) return true;
  }
  return false;
}
