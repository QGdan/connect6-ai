import type { Cell, GameState, Player, Position } from '../types';
import { BOARD_SIZE } from '../types';
import { generateRZOPCandidates } from './rzop';
import { analyzeBothSidesCached } from './threat_service';
import { posIdx } from './pos_key';
import { computeValueFeatures, VALUE_FEATURE_NAMES } from './value_features';
import { VALUE_MODEL } from '../models/value_model';
import {
  isValueModelCompatible,
  type ValueModelSnapshot,
} from './value_model_snapshot';
import { computeZobristHash } from './zobrist';
import { isDeadLineCell } from './line_potential';

export interface PolicyValue {
  policy: number[]; // 361 维
  value: number;    // -1..1
}

export interface ResNetConfig {
  inputChannels: number;
  residualBlocks: number;
  boardSize: number;
}

export interface IResNetEvaluator {
  evaluate(state: GameState): Promise<PolicyValue>;
}

export class DummyResNetEvaluator implements IResNetEvaluator {
  async evaluate(_state: GameState): Promise<PolicyValue> {
    const size = 19 * 19;
    const policy = Array(size).fill(1 / size);
    return { policy, value: 0 };
  }
}

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

const POLICY_DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

const inBounds = (x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;

function countAdjacency(
  board: Cell[][],
  pos: Position,
  playerVal: Cell,
): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nx = pos.x + dx;
      const ny = pos.y + dy;
      if (!inBounds(nx, ny)) continue;
      if (board[ny][nx] === playerVal) count += 1;
    }
  }
  return count;
}

function linePotentialScore(
  board: Cell[][],
  pos: Position,
  playerVal: Cell,
): number {
  let total = 0;
  for (const { dx, dy } of POLICY_DIRS) {
    let run = 1;
    let openEnds = 0;

    let nx = pos.x + dx;
    let ny = pos.y + dy;
    while (inBounds(nx, ny) && board[ny][nx] === playerVal) {
      run += 1;
      nx += dx;
      ny += dy;
    }
    if (inBounds(nx, ny) && board[ny][nx] === 0) openEnds += 1;

    nx = pos.x - dx;
    ny = pos.y - dy;
    while (inBounds(nx, ny) && board[ny][nx] === playerVal) {
      run += 1;
      nx -= dx;
      ny -= dy;
    }
    if (inBounds(nx, ny) && board[ny][nx] === 0) openEnds += 1;

    const blocked = openEnds === 0;
    const base = blocked ? 0.25 : openEnds === 1 ? 0.75 : 1.25;
    total += run * base;
  }
  return total;
}

function buildThreatPolicy(state: GameState, player: Player): number[] {
  const size = BOARD_SIZE * BOARD_SIZE;
  const policy = new Array<number>(size).fill(0.0001);
  const candidates = generateRZOPCandidates(state);
  const { my, opp } = analyzeBothSidesCached(state, player);
  const board = state.board;
  const myVal: Cell = player === 'BLACK' ? 1 : 2;
  const oppVal: Cell = myVal === 1 ? 2 : 1;

  const buildSet = (points: Position[]) =>
    new Set(points.map(p => posIdx(p.x, p.y)));
  const flattenPairs = (pairs: [Position, Position][]) => {
    const out: Position[] = [];
    for (const [a, b] of pairs) out.push(a, b);
    return out;
  };

  const myWin1 = buildSet(my.winIn1);
  const oppWin1 = buildSet(opp.winIn1);
  const myWin2 = buildSet(flattenPairs(my.winIn2));
  const oppWin2 = buildSet(flattenPairs(opp.winIn2));
  const myAttack = buildSet(my.attackPoints);
  const oppAttack = buildSet(opp.attackPoints);
  const myDefense = buildSet(my.defensePoints);
  const oppDefense = buildSet(opp.defensePoints);
  const center = (BOARD_SIZE - 1) / 2;

  for (const p of candidates) {
    const idx = posIdx(p.x, p.y);
    if (board[p.y]?.[p.x] !== 0) continue;
    let score = 1;
    if (oppWin1.has(idx)) score += 140;
    if (myWin1.has(idx)) score += 120;
    if (oppWin2.has(idx)) score += 90;
    if (myWin2.has(idx)) score += 70;
    if (oppAttack.has(idx)) score += 25;
    if (myAttack.has(idx)) score += 20;
    if (oppDefense.has(idx)) score += 14;
    if (myDefense.has(idx)) score += 10;
    const dist =
      Math.abs(p.x - center) + Math.abs(p.y - center);
    score += Math.max(0, 6 - dist) * 2;
    const myAdj = countAdjacency(board, p, myVal);
    const oppAdj = countAdjacency(board, p, oppVal);
    score += myAdj * 4 + oppAdj * 3;
    const myLine = linePotentialScore(board, p, myVal);
    const oppLine = linePotentialScore(board, p, oppVal);
    score += myLine * 6 + oppLine * 5;
    if (isDeadLineCell(state, p)) score *= 0.2;
    policy[idx] = score;
  }

  return policy;
}

export class LinearPolicyValueEvaluator implements IResNetEvaluator {
  private readonly weights: number[];
  private readonly bias: number;
  private readonly cache = new Map<bigint, PolicyValue>();
  private readonly cacheLimit: number;

  constructor(weights: number[], bias: number, cacheLimit = 12000) {
    this.weights = weights;
    this.bias = bias;
    this.cacheLimit = cacheLimit;
  }

  async evaluate(state: GameState): Promise<PolicyValue> {
    const hash =
      typeof state.zobristHash === 'bigint'
        ? state.zobristHash
        : computeZobristHash(state.board, state.currentPlayer);
    const cached = this.cache.get(hash);
    if (cached) {
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }

    const { features, names } = computeValueFeatures(state, state.currentPlayer);
    if (names.length !== VALUE_FEATURE_NAMES.length) {
      throw new Error('Value feature mismatch');
    }
    if (this.weights.length !== names.length) {
      throw new Error('Value model shape mismatch');
    }
    let sum = this.bias;
    for (let i = 0; i < features.length; i += 1) {
      sum += features[i] * this.weights[i];
    }
    const pred = sigmoid(sum);
    const value = pred * 2 - 1;
    const policy = buildThreatPolicy(state, state.currentPlayer);
    const output = { policy, value };

    this.cache.set(hash, output);
    if (this.cache.size > this.cacheLimit) {
      const evictCount = Math.max(1, Math.floor(this.cacheLimit * 0.2));
      for (let i = 0; i < evictCount; i += 1) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
    }

    return output;
  }
}

export function createDefaultEvaluator(): IResNetEvaluator {
  if (VALUE_MODEL.enabled) {
    return new LinearPolicyValueEvaluator(
      VALUE_MODEL.weights,
      VALUE_MODEL.bias,
    );
  }
  return new DummyResNetEvaluator();
}

export function createEvaluatorFromSnapshot(
  snapshot?: ValueModelSnapshot | null,
): IResNetEvaluator {
  if (snapshot && snapshot.enabled && isValueModelCompatible(snapshot)) {
    return new LinearPolicyValueEvaluator(snapshot.weights, snapshot.bias);
  }
  return createDefaultEvaluator();
}
