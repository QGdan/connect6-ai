import type { Move, Player, Position } from '../../types';

export type AspirationWindow = {
  depth: number;
  retry: number;
  alpha: number;
  beta: number;
};

export type TTFlag = 'EXACT' | 'LOWER' | 'UPPER';

type TTEntry = {
  depth: number;
  score: number;
  flag: TTFlag;
  bestMove?: Move;
};

const transpositionTable = new Map<bigint, TTEntry>();
const historyTable = new Map<number, number>();
const killerMoves = new Map<number, Move[]>();
const lastAspirationWindows: AspirationWindow[] = [];

let ttEvictionsThisMove = 0;
let historyEvictionsThisMove = 0;

function historyKey(player: Player, pos: Position, boardSize: number): number {
  const base = player === 'BLACK' ? 0 : boardSize * boardSize;
  return base + pos.y * boardSize + pos.x;
}

export function clearTranspositionTable(): void {
  transpositionTable.clear();
}

export function getTTSize(): number {
  return transpositionTable.size;
}

export function getTTBestMove(hash: bigint): Move | undefined {
  return transpositionTable.get(hash)?.bestMove;
}

export function resetTTEvictionsThisMove(): void {
  ttEvictionsThisMove = 0;
}

export function getTTEvictionsThisMove(): number {
  return ttEvictionsThisMove;
}

export function probeTT(
  hash: bigint,
  depth: number,
  alpha: number,
  beta: number,
): { score: number; depth: number; flag: TTFlag; bestMove?: Move } | null {
  const entry = transpositionTable.get(hash);
  if (!entry || entry.depth < depth) return null;
  transpositionTable.delete(hash);
  transpositionTable.set(hash, entry);

  if (entry.flag === 'EXACT') return entry;
  if (entry.flag === 'LOWER' && entry.score >= beta) return entry;
  if (entry.flag === 'UPPER' && entry.score <= alpha) return entry;
  return null;
}

export function storeTT(
  hash: bigint,
  depth: number,
  score: number,
  alpha: number,
  beta: number,
  bestMove: Move | undefined,
  maxTTEntries: number,
): void {
  const existing = transpositionTable.get(hash);
  if (existing && existing.depth > depth) return;

  let flag: TTFlag = 'EXACT';
  if (score <= alpha) flag = 'UPPER';
  else if (score >= beta) flag = 'LOWER';

  transpositionTable.set(hash, { depth, score, flag, bestMove });

  if (transpositionTable.size > maxTTEntries) {
    const evictCount = Math.max(1, Math.floor(maxTTEntries * 0.2));
    for (let i = 0; i < evictCount; i += 1) {
      const oldest = transpositionTable.keys().next();
      if (oldest.done) break;
      transpositionTable.delete(oldest.value);
      ttEvictionsThisMove += 1;
    }
  }
}

export function getHistorySize(): number {
  return historyTable.size;
}

export function resetHistoryEvictionsThisMove(): void {
  historyEvictionsThisMove = 0;
}

export function getHistoryEvictionsThisMove(): number {
  return historyEvictionsThisMove;
}

export function updateHistory(
  player: Player,
  pos: Position,
  depth: number,
  boardSize: number,
  maxHistoryEntries: number,
): void {
  const key = historyKey(player, pos, boardSize);
  const old = historyTable.get(key) ?? 0;
  const next = old + depth * depth;
  historyTable.set(key, Math.min(next, 1_000_000));

  if (historyTable.size > maxHistoryEntries) {
    const evictCount = Math.max(1, Math.floor(maxHistoryEntries * 0.2));
    for (let i = 0; i < evictCount; i += 1) {
      const oldest = historyTable.keys().next();
      if (oldest.done) break;
      historyTable.delete(oldest.value);
      historyEvictionsThisMove += 1;
    }
  }
}

export function getHistoryScore(
  player: Player,
  pos: Position,
  boardSize: number,
): number {
  const key = historyKey(player, pos, boardSize);
  const val = historyTable.get(key);
  if (val === undefined) return 0;
  historyTable.delete(key);
  historyTable.set(key, val);
  return val;
}

export function decayHistory(minHistoryThreshold: number): void {
  for (const [k, v] of historyTable.entries()) {
    const decayed = Math.floor(v * 0.9);
    if (decayed <= minHistoryThreshold) {
      historyTable.delete(k);
    } else {
      historyTable.set(k, decayed);
    }
  }
}

export function clearKillerMoves(): void {
  killerMoves.clear();
}

export function getKillerMoves(depth: number): Move[] {
  return killerMoves.get(depth) ?? [];
}

export function addKillerMove(
  depth: number,
  move: Move,
  sameMove: (a: Move, b: Move) => boolean,
): void {
  const list = killerMoves.get(depth) ?? [];
  if (list.some(m => sameMove(m, move))) return;
  const next = [move, ...list].slice(0, 2);
  killerMoves.set(depth, next);
}

export function clearAspirationWindows(): void {
  lastAspirationWindows.length = 0;
}

export function pushAspirationWindow(window: AspirationWindow): void {
  lastAspirationWindows.push(window);
}

export function getAspirationWindows(): AspirationWindow[] {
  return lastAspirationWindows.slice();
}
