import type { GameState, Player } from '../types';
import { BOARD_SIZE } from '../types';
import { computeZobristHash } from './zobrist';
import { computeValueFeatures } from './value_features';
import type { ValueTrainingSample } from './value_trainer';

export type JsonlSampleRecord = {
  board: string;
  currentPlayer: Player;
  moveNumber: number;
  result: number;
};

export function decodeBoard(serialized: string): number[][] | null {
  if (serialized.length !== BOARD_SIZE * BOARD_SIZE) return null;
  const board: number[][] = [];
  let idx = 0;
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const val = Number(serialized[idx]);
      row.push(Number.isFinite(val) ? val : 0);
      idx += 1;
    }
    board.push(row);
  }
  return board;
}

export function buildValueSampleFromJson(
  record: JsonlSampleRecord,
): ValueTrainingSample | null {
  if (!record || typeof record.board !== 'string') return null;
  const board = decodeBoard(record.board);
  if (!board) return null;
  const currentPlayer: Player =
    record.currentPlayer === 'WHITE' ? 'WHITE' : 'BLACK';
  const moveNumber = Number.isFinite(record.moveNumber)
    ? Math.max(0, Math.floor(record.moveNumber))
    : 0;
  const result = Number(record.result);
  if (!Number.isFinite(result)) return null;

  const state: GameState = {
    board,
    currentPlayer,
    moveNumber,
    zobristHash: computeZobristHash(board, currentPlayer),
  };

  const { features } = computeValueFeatures(state, currentPlayer);
  return {
    features,
    result: Math.max(0, Math.min(1, result)),
  };
}

export function buildValueSampleFromState(
  state: Pick<GameState, 'board' | 'currentPlayer' | 'moveNumber'>,
  result: number,
): ValueTrainingSample {
  const currentPlayer: Player =
    state.currentPlayer === 'WHITE' ? 'WHITE' : 'BLACK';
  const safeResult = Math.max(0, Math.min(1, result));
  const snapshot: GameState = {
    board: state.board,
    currentPlayer,
    moveNumber: state.moveNumber,
    zobristHash: computeZobristHash(state.board, currentPlayer),
  };
  const { features } = computeValueFeatures(snapshot, currentPlayer);
  return { features, result: safeResult };
}
