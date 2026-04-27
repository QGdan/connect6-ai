import type { Cell, GameState, Move, Player, Position } from '../types';
import { BOARD_SIZE, createEmptyBoard } from './game_state';
import { getStonesToPlace } from './rules';
import { computeZobristHash } from './zobrist';
import { posIdx } from './pos_key';
import { OPENING_BOOK_RAW } from './opening_book_data';
import { SYMMETRIES, transformBoard, transformPosition } from './symmetry';
import { parseBoardCoord } from './board_coords';

type BookMove = { positions: Position[]; weight: number };

const BOOK_INDEX = buildOpeningBook(OPENING_BOOK_RAW);

function centerPosition(): Position {
  const c = Math.floor(BOARD_SIZE / 2);
  return { x: c, y: c };
}

function parseSequence(text: string): Position[] | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const out: Position[] = [];
  for (const token of tokens) {
    const pos = parseBoardCoord(token);
    if (!pos) return null;
    out.push(pos);
  }
  return out;
}

function canPlace(board: Cell[][], pos: Position): boolean {
  return board[pos.y]?.[pos.x] === 0;
}

function applyStone(
  board: Cell[][],
  pos: Position,
  player: Player,
): boolean {
  if (!canPlace(board, pos)) return false;
  board[pos.y][pos.x] = player === 'BLACK' ? 1 : 2;
  return true;
}

function stateFromSequence(sequence: Position[]): {
  board: Cell[][];
  currentPlayer: Player;
  moveNumber: number;
} | null {
  const board = createEmptyBoard();
  let moveNumber = 0;
  let currentPlayer: Player = 'BLACK';

  if (sequence.length === 0) {
    return { board, currentPlayer, moveNumber };
  }

  if (!applyStone(board, sequence[0], 'BLACK')) return null;
  moveNumber = 1;
  currentPlayer = 'WHITE';

  const remaining = sequence.length - 1;
  if (remaining % 2 !== 0) return null;

  let idx = 1;
  while (idx < sequence.length) {
    if (!applyStone(board, sequence[idx], currentPlayer)) return null;
    if (!applyStone(board, sequence[idx + 1], currentPlayer)) return null;
    idx += 2;
    moveNumber += 1;
    currentPlayer = currentPlayer === 'BLACK' ? 'WHITE' : 'BLACK';
  }

  return { board, currentPlayer, moveNumber };
}

function parseMoves(
  text: string,
  board: Cell[][],
  required: number,
): BookMove[] {
  const segments = text.split(';').map(seg => seg.trim()).filter(Boolean);
  const moves: BookMove[] = [];

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const weight = Number(tokens[tokens.length - 1]);
    if (!Number.isFinite(weight)) continue;

    const posTokens = tokens.slice(0, -1);
    const positions: Position[] = [];
    const seen = new Set<number>();
    let valid = true;
    for (const token of posTokens) {
      const pos = parseBoardCoord(token);
      if (!pos) {
        valid = false;
        break;
      }
      const key = posIdx(pos.x, pos.y);
      if (seen.has(key)) {
        valid = false;
        break;
      }
      if (!canPlace(board, pos)) {
        valid = false;
        break;
      }
      seen.add(key);
      positions.push(pos);
    }
    if (!valid) continue;
    if (positions.length !== required) continue;
    moves.push({ positions, weight });
  }

  return moves;
}

function moveKey(positions: Position[]): string {
  const idxs = positions.map(p => posIdx(p.x, p.y));
  idxs.sort((a, b) => a - b);
  return idxs.join(',');
}

function buildOpeningBook(raw: string): Map<bigint, BookMove[]> {
  const index = new Map<bigint, Map<string, BookMove>>();
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.split('#')[0].trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) continue;

    const left = trimmed.slice(0, sep).trim();
    const right = trimmed.slice(sep + 1).trim();
    if (!right) continue;

    const sequence = parseSequence(left);
    if (!sequence) continue;
    const derived = stateFromSequence(sequence);
    if (!derived) continue;

    const required = getStonesToPlace(
      derived.moveNumber,
      derived.currentPlayer,
    );
    const moves = parseMoves(right, derived.board, required);
    if (moves.length === 0) continue;

    for (const sym of SYMMETRIES) {
      const board =
        sym === 0 ? derived.board : transformBoard(derived.board, sym);
      const hash = computeZobristHash(board, derived.currentPlayer);
      let bucket = index.get(hash);
      if (!bucket) {
        bucket = new Map<string, BookMove>();
        index.set(hash, bucket);
      }
      for (const move of moves) {
        const transformed =
          sym === 0
            ? move.positions
            : move.positions.map(p => transformPosition(p, board.length, sym));
        const key = moveKey(transformed);
        const existing = bucket.get(key);
        if (!existing || move.weight > existing.weight) {
          bucket.set(key, { positions: transformed, weight: move.weight });
        }
      }
    }
  }

  const flattened = new Map<bigint, BookMove[]>();
  for (const [hash, bucket] of index.entries()) {
    const moves = [...bucket.values()];
    moves.sort((a, b) => b.weight - a.weight);
    flattened.set(hash, moves);
  }

  return flattened;
}

function pickBestBookMove(
  state: GameState,
  moves: BookMove[],
  required: number,
): BookMove | null {
  const center = (BOARD_SIZE - 1) / 2;
  let best: BookMove | null = null;
  let bestWeight = -Infinity;
  let bestDist = Infinity;

  for (const move of moves) {
    if (move.positions.length !== required) continue;
    let valid = true;
    const seen = new Set<number>();
    let dist = 0;
    for (const pos of move.positions) {
      if (state.board[pos.y]?.[pos.x] !== 0) {
        valid = false;
        break;
      }
      const key = posIdx(pos.x, pos.y);
      if (seen.has(key)) {
        valid = false;
        break;
      }
      seen.add(key);
      dist += Math.abs(pos.x - center) + Math.abs(pos.y - center);
    }
    if (!valid) continue;

    if (move.weight > bestWeight) {
      best = move;
      bestWeight = move.weight;
      bestDist = dist;
    } else if (move.weight === bestWeight && dist < bestDist) {
      best = move;
      bestDist = dist;
    }
  }

  return best;
}

export function getOpeningMove(
  state: GameState,
  player: Player,
): Move | null {
  const bookMoves = BOOK_INDEX.get(state.zobristHash);
  if (bookMoves) {
    const required = getStonesToPlace(state.moveNumber, player);
    const selected = pickBestBookMove(state, bookMoves, required);
    if (selected) {
      return { player, positions: selected.positions };
    }
  }

  if (state.moveNumber !== 0) return null;
  if (player !== 'BLACK') return null;
  const hasStone = state.board.some(row => row.some(c => c !== 0));
  if (hasStone) return null;

  const pos = centerPosition();
  if (state.board[pos.y][pos.x] !== 0) return null;

  return {
    player: 'BLACK',
    positions: [pos],
  };
}
