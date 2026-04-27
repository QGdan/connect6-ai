import { BOARD_SIZE } from '../types';

export function posIdx(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

export function fromIdx(idx: number): { x: number; y: number } {
  return { x: idx % BOARD_SIZE, y: Math.floor(idx / BOARD_SIZE) };
}
