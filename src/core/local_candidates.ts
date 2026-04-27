import type { GameState, Position } from '../types';
import { BOARD_SIZE } from '../types';

export function generateLocalCandidates(
  state: GameState,
  radius = 3,
  minCount = 6,
): Position[] {
  const board = state.board;
  const empties = new Map<number, Position>();
  let hasStone = false;

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] === 0) continue;
      hasStone = true;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= BOARD_SIZE) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= BOARD_SIZE) continue;
          if (board[ny][nx] !== 0) continue;
          const key = ny * BOARD_SIZE + nx;
          if (!empties.has(key)) {
            empties.set(key, { x: nx, y: ny });
          }
        }
      }
    }
  }

  if (!hasStone) {
    const center = Math.floor(BOARD_SIZE / 2);
    return [{ x: center, y: center }];
  }

  if (empties.size < minCount) {
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        if (board[y][x] !== 0) continue;
        const key = y * BOARD_SIZE + x;
        if (!empties.has(key)) {
          empties.set(key, { x, y });
        }
      }
    }
  }

  return [...empties.values()];
}
