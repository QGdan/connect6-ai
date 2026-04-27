import type { Cell, Player } from '../types';
import { BOARD_SIZE } from '../types';

// Zobrist hashing utilities (shared)
export type ZobristTable = bigint[][][]; // [y][x][pieceIndex], pieceIndex: 0=BLACK,1=WHITE

const MASK_64 = (1n << 64n) - 1n;
const SPLITMIX64_INC = 0x9e3779b97f4a7c15n;
const ZOBRIST_SEED = 0x6a09e667f3bcc909n;

function createSplitmix64(seed: bigint): () => bigint {
  let state = seed & MASK_64;
  return () => {
    state = (state + SPLITMIX64_INC) & MASK_64;
    let z = state;
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n & MASK_64;
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  };
}

const nextRand64 = createSplitmix64(ZOBRIST_SEED);

export const ZOBRIST_TABLE: ZobristTable = (() => {
  const table: ZobristTable = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    table[y] = [];
    for (let x = 0; x < BOARD_SIZE; x++) {
      table[y][x] = [nextRand64(), nextRand64()];
    }
  }
  return table;
})();

export const ZOBRIST_SIDE_TO_MOVE = nextRand64();

export function computeZobristHash(
  board: Cell[][],
  sideToMove: Player,
): bigint {
  let h = 0n;
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      const cell = board[y][x];
      if (cell === 1) h ^= ZOBRIST_TABLE[y][x][0];
      else if (cell === 2) h ^= ZOBRIST_TABLE[y][x][1];
    }
  }
  if (sideToMove === 'BLACK') h ^= ZOBRIST_SIDE_TO_MOVE;
  return h;
}

export function toggleSideHash(hash: bigint): bigint {
  return hash ^ ZOBRIST_SIDE_TO_MOVE;
}
