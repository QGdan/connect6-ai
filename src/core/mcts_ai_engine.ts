import type { GameState, Player, AIMoveDecision, Move, Position } from '../types';
import type { IResNetEvaluator } from './resnet_ai';
import { applyMoveWithWinner, getStonesToPlace } from './rules';
import { generateRZOPCandidates } from './rzop';
import { BOARD_SIZE } from './game_state';
import { fromIdx, posIdx } from './pos_key';
import { computeZobristHash } from './zobrist';

interface MCTSNode {
  state: GameState;
  player: Player;
  visits: number;
  wins: number;
  prior: number;
  children: Map<number, MCTSNode>;
  isExpanded: boolean;
  lastTouched: number;
}

export interface MCTSConfig {
  simulationCount: number;
  simulationSteps: number;
  expandNodes: number;
  minWinRateThreshold: number;
  valueRange?: 'zeroOne' | 'minusOneOne';
  valuePerspective?: 'sideToMove' | 'rootPlayer' | 'blackFixed';
  maxTableEntries?: number;
  dirichletAlpha?: number;
  dirichletEps?: number;
  candidateGenerator?: (state: GameState) => Position[];
  reuseDecay?: number;
  reuseTtl?: number;
}

export type MCTSChildStats = {
  move: Move;
  visits: number;
  wins: number;
};

export type MCTSRootStats = {
  rootVisits: number;
  deltaVisits: number;
  children: MCTSChildStats[];
};

export type MCTSSelection = {
  move: Move;
  score: number;
  winRate: number;
  selection: string;
  visits: number;
};

function moveKeyForStats(move: Move): string {
  return move.positions
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
}

function cloneMove(move: Move): Move {
  return {
    player: move.player,
    positions: move.positions.map(p => ({ x: p.x, y: p.y })),
  };
}

export function mergeMCTSRootStats(list: MCTSRootStats[]): MCTSRootStats {
  let rootVisits = 0;
  let deltaVisits = 0;
  const merged = new Map<string, MCTSChildStats>();

  for (const stats of list) {
    rootVisits += stats.rootVisits;
    deltaVisits += stats.deltaVisits;
    for (const child of stats.children) {
      const key = moveKeyForStats(child.move);
      const existing = merged.get(key);
      if (existing) {
        existing.visits += child.visits;
        existing.wins += child.wins;
      } else {
        merged.set(key, {
          move: cloneMove(child.move),
          visits: child.visits,
          wins: child.wins,
        });
      }
    }
  }

  return { rootVisits, deltaVisits, children: [...merged.values()] };
}

export function selectMoveFromStats(
  stats: MCTSRootStats,
  threshold: number,
): MCTSSelection | null {
  let bestMove: MCTSChildStats | null = null;
  let bestScore = -Infinity;
  let bestVisitsMove: MCTSChildStats | null = null;
  let bestVisits = -Infinity;
  let bestVisitsScore = -Infinity;

  for (const child of stats.children) {
    const visits = child.visits;
    const winRate = visits > 0 ? child.wins / visits : 0;
    if (visits > bestVisits) {
      bestVisits = visits;
      bestVisitsMove = child;
      bestVisitsScore = winRate;
    }
    if (winRate > bestScore) {
      bestScore = winRate;
      bestMove = child;
    }
  }

  if (!bestMove && bestVisitsMove) {
    bestMove = bestVisitsMove;
    bestScore = bestVisitsScore;
  }

  if (!bestMove) return null;

  let selection = 'winRate';
  let finalMove = bestMove;
  let finalScore = bestScore;
  if (threshold > 0 && bestScore < threshold && bestVisitsMove) {
    finalMove = bestVisitsMove;
    finalScore = bestVisitsScore;
    selection = 'visits';
  }

  return {
    move: finalMove.move,
    score: finalScore,
    winRate: finalScore,
    selection,
    visits: finalMove.visits,
  };
}

export class MCTSConnect6AI {
  // ★ 显式声明成员
  private evaluator: IResNetEvaluator;
  private config: MCTSConfig;
  private readonly tablesByRoot: Record<
    Player,
    { self: Map<bigint, MCTSNode>; opp: Map<bigint, MCTSNode> }
  >;
  private reuseTick = 0;

  // ★ 普通构造函数，内部赋值
  constructor(evaluator: IResNetEvaluator, config: MCTSConfig) {
    this.evaluator = evaluator;
    this.config = {
      ...config,
      valueRange: config.valueRange ?? 'minusOneOne',
      valuePerspective: config.valuePerspective ?? 'rootPlayer',
      maxTableEntries: config.maxTableEntries ?? 200_000,
    };
    this.tablesByRoot = {
      BLACK: { self: new Map(), opp: new Map() },
      WHITE: { self: new Map(), opp: new Map() },
    };
  }

  async decideMove(root: GameState, player: Player): Promise<AIMoveDecision> {
    const threshold = this.config.minWinRateThreshold ?? 0;
    const stats = await this.runBatch(root, player, this.config.simulationCount);
    const selection = selectMoveFromStats(stats, threshold);
    if (!selection) {
      throw new Error('MCTS failed to generate a move');
    }
    const visits = stats.deltaVisits > 0 ? stats.deltaVisits : stats.rootVisits;
    return {
      move: selection.move,
      score: selection.score,
      debugInfo: {
        strategy: 'deep',
        visits,
        totalVisits: stats.rootVisits,
        selection: selection.selection,
        winRate: selection.winRate,
        threshold,
        reuseDecay: this.config.reuseDecay,
        reuseTtl: this.config.reuseTtl,
      },
    };
  }

  async runBatch(
    root: GameState,
    player: Player,
    simulations: number,
  ): Promise<MCTSRootStats> {
    this.reuseTick += 1;
    const rootNode = this.getOrCreateNode(root, player, player);
    const startVisits = rootNode.visits;
    const total = Number.isFinite(simulations)
      ? Math.max(0, Math.floor(simulations))
      : 0;

    if (total === 0 && !rootNode.isExpanded) {
      await this.expandNode(rootNode, true, player);
    } else {
      for (let i = 0; i < total; i++) {
        await this.runSimulation(rootNode, player);
      }
    }

    const stats = this.buildRootStats(rootNode, player);
    stats.deltaVisits = rootNode.visits - startVisits;
    stats.rootVisits = rootNode.visits;
    return stats;
  }

  private buildRootStats(rootNode: MCTSNode, player: Player): MCTSRootStats {
    const children: MCTSChildStats[] = [];
    for (const [key, child] of rootNode.children.entries()) {
      children.push({
        move: decodeMoveKey(key, player),
        visits: child.visits,
        wins: child.wins,
      });
    }
    return { rootVisits: rootNode.visits, deltaVisits: 0, children };
  }

  private async runSimulation(root: MCTSNode, rootPlayer: Player): Promise<void> {
    const path: MCTSNode[] = [root];
    let node = root;

    while (node.isExpanded && node.children.size > 0) {
      node = this.selectChild(node, rootPlayer);
      path.push(node);
    }

    if (!node.isExpanded) {
      await this.expandNode(node, node === root, rootPlayer);
    }

    const value = await this.simulate(node, rootPlayer);
    for (const n of path) {
      n.visits += 1;
      n.wins += value;
    }
  }

  private selectChild(node: MCTSNode, rootPlayer: Player): MCTSNode {
    let bestChild: MCTSNode | null = null;
    let bestScore = -Infinity;
    const parentVisits = Math.max(1, node.visits);

    for (const [, child] of node.children) {
      const q = child.visits > 0 ? child.wins / child.visits : 0;
      const exploitation = node.player === rootPlayer ? q : 1 - q;
      const u = 1.4 * child.prior * Math.sqrt(parentVisits) / (1 + child.visits);
      const score = exploitation + u;
      if (score > bestScore) {
        bestScore = score;
        bestChild = child;
      }
    }

    if (!bestChild) {
      throw new Error('No child to select');
    }
    return bestChild;
  }

  private async expandNode(
    node: MCTSNode,
    isRoot: boolean,
    rootPlayer: Player,
  ): Promise<void> {
    const { policy } = await this.evaluator.evaluate(node.state);
    const candidates =
      this.config.candidateGenerator?.(node.state) ??
      generateRZOPCandidates(node.state);
    const need = getStonesToPlace(node.state.moveNumber, node.player);

    const scoredPoints: { pos: Position; p: number }[] = candidates.map(pos => {
      const idx = pos.y * BOARD_SIZE + pos.x;
      return { pos, p: policy[idx] ?? 0.0001 };
    });

    scoredPoints.sort((a, b) => b.p - a.p);

    const maxPoints = Math.min(scoredPoints.length, this.config.expandNodes * 2);
    const topPoints = scoredPoints.slice(0, maxPoints);

    const children: [number, MCTSNode][] = [];
    let sumPrior = 0;

    if (need === 1) {
      for (let i = 0; i < topPoints.length; i++) {
        const move: Move = {
          player: node.player,
          positions: [topPoints[i].pos],
        };
        const prior = topPoints[i].p;
        const key = encodeMoveKey(move);
        const nextState = applyMoveWithWinner(node.state, move);
        const child = this.getOrCreateNode(
          nextState,
          nextState.currentPlayer,
          rootPlayer,
        );
        child.prior = prior;
        children.push([key, child]);
        sumPrior += prior;
        if (children.length >= this.config.expandNodes) break;
      }
    } else {
      for (let i = 0; i < topPoints.length; i++) {
        for (let j = i + 1; j < topPoints.length; j++) {
          const move: Move = {
            player: node.player,
            positions: [topPoints[i].pos, topPoints[j].pos],
          };
          const prior = topPoints[i].p * topPoints[j].p;
          const key = encodeMoveKey(move);
          const nextState = applyMoveWithWinner(node.state, move);
          const child = this.getOrCreateNode(
            nextState,
            nextState.currentPlayer,
            rootPlayer,
          );
          child.prior = prior;
          children.push([key, child]);
          sumPrior += prior;

          if (children.length >= this.config.expandNodes) break;
        }
        if (children.length >= this.config.expandNodes) break;
      }
    }

    if (sumPrior > 0) {
      for (const [, child] of children) {
        child.prior /= sumPrior;
      }
    }

    if (
      isRoot &&
      this.config.dirichletAlpha &&
      this.config.dirichletEps &&
      children.length > 0
    ) {
      this.applyRootNoise(children, this.config.dirichletAlpha, this.config.dirichletEps);
    }

    for (const [key, child] of children) {
      node.children.set(key, child);
    }

    node.isExpanded = true;
  }

  private async simulate(node: MCTSNode, rootPlayer: Player): Promise<number> {
    const rolloutSteps = Math.max(0, this.config.simulationSteps ?? 0);
    let state = node.state;
    let toMove = node.player;

    for (let i = 0; i < rolloutSteps; i++) {
      if (state.winner) break;
      const move = this.pickRolloutMove(state, toMove);
      if (!move) break;
      try {
        state = applyMoveWithWinner(state, move);
      } catch {
        break;
      }
      toMove = state.currentPlayer;
    }

    if (state.winner) {
      if (state.winner === 'DRAW') return 0.5;
      return state.winner === rootPlayer ? 1 : 0;
    }

    const { value } = await this.evaluator.evaluate(state);
    return this.valueToRootWinProb(value, toMove, rootPlayer);
  }

  private pickRolloutMove(state: GameState, player: Player): Move | null {
    const candidates =
      this.config.candidateGenerator?.(state) ?? generateRZOPCandidates(state);
    if (candidates.length === 0) return null;
    const need = getStonesToPlace(state.moveNumber, player);
    const maxPoints = Math.min(
      candidates.length,
      Math.max(6, this.config.expandNodes * 2),
    );
    const pool = candidates.slice(0, maxPoints);

    if (need === 1) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      return { player, positions: [pick] };
    }

    if (pool.length < 2) return null;
    const aIndex = Math.floor(Math.random() * pool.length);
    let bIndex = Math.floor(Math.random() * (pool.length - 1));
    if (bIndex >= aIndex) bIndex += 1;
    return {
      player,
      positions: [pool[aIndex], pool[bIndex]],
    };
  }

  private applyDecay(node: MCTSNode, factor: number): void {
    if (factor <= 0 || factor >= 1) return;
    node.visits *= factor;
    node.wins *= factor;
    if (node.visits < 0.01) node.visits = 0;
    if (Math.abs(node.wins) < 0.01) node.wins = 0;
  }

  private resetNode(node: MCTSNode): void {
    node.visits = 0;
    node.wins = 0;
    node.prior = 1;
    node.children = new Map();
    node.isExpanded = false;
    node.lastTouched = this.reuseTick;
  }

  private applyReusePolicy(node: MCTSNode, age: number): void {
    if (age <= 0) return;
    const ttl = this.config.reuseTtl;
    if (Number.isFinite(ttl) && (ttl as number) > 0 && age >= (ttl as number)) {
      this.resetNode(node);
      return;
    }
    const decay = this.config.reuseDecay;
    if (Number.isFinite(decay) && (decay as number) > 0 && (decay as number) < 1) {
      const factor = Math.pow(decay as number, age);
      this.applyDecay(node, factor);
      if (node.children.size > 0) {
        for (const child of node.children.values()) {
          this.applyDecay(child, factor);
          child.lastTouched = this.reuseTick;
        }
      }
    }
  }

  private getOrCreateNode(
    state: GameState,
    player: Player,
    rootPlayer: Player,
  ): MCTSNode {
    const key = this.getStateKey(state);
    const table = this.tableFor(player, rootPlayer);
    let node = this.touchTable(table, key);
    if (!node) {
      node = {
        state,
        player,
        visits: 0,
        wins: 0,
        prior: 1,
        children: new Map(),
        isExpanded: false,
        lastTouched: this.reuseTick,
      };
      table.set(key, node);
      this.enforceTableLimit(table);
    } else {
      node.state = state;
      node.player = player;
      node.lastTouched = this.reuseTick;
    }
    return node;
  }

  private getStateKey(state: GameState): bigint {
    return typeof state.zobristHash === 'bigint'
      ? state.zobristHash
      : computeZobristHash(state.board, state.currentPlayer);
  }

  private tableFor(player: Player, rootPlayer: Player): Map<bigint, MCTSNode> {
    const tables = this.tablesByRoot[rootPlayer];
    return player === rootPlayer ? tables.self : tables.opp;
  }

  private touchTable(
    table: Map<bigint, MCTSNode>,
    key: bigint,
  ): MCTSNode | undefined {
    const hit = table.get(key);
    if (!hit) return undefined;
    const age = Math.max(0, this.reuseTick - hit.lastTouched);
    this.applyReusePolicy(hit, age);
    table.delete(key);
    table.set(key, hit);
    return hit;
  }

  private enforceTableLimit(table: Map<bigint, MCTSNode>): void {
    const limit = this.config.maxTableEntries ?? 200_000;
    while (table.size > limit) {
      const oldest = table.keys().next();
      if (oldest.done) break;
      table.delete(oldest.value);
    }
  }

  private valueToRootWinProb(
    value: number,
    nodePlayer: Player,
    rootPlayer: Player,
  ): number {
    if (!Number.isFinite(value)) return 0.5;
    const range = this.config.valueRange ?? 'minusOneOne';
    const perspective = this.config.valuePerspective ?? 'sideToMove';
    let v = value;
    if (range === 'minusOneOne') {
      v = (v + 1) / 2;
    }
    v = Math.min(1, Math.max(0, v));

    if (perspective === 'sideToMove') {
      return nodePlayer === rootPlayer ? v : 1 - v;
    }
    if (perspective === 'blackFixed') {
      return rootPlayer === 'BLACK' ? v : 1 - v;
    }
    return v;
  }

  private applyRootNoise(
    children: Array<[number, MCTSNode]>,
    alpha: number,
    eps: number,
  ): void {
    const noise = sampleDirichlet(alpha, children.length);
    let sum = 0;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i][1];
      child.prior = child.prior * (1 - eps) + noise[i] * eps;
      sum += child.prior;
    }
    if (sum > 0) {
      for (const [, child] of children) {
        child.prior /= sum;
      }
    }
  }
}

const PAIR_BASE = 1024;
const PAIR_OFFSET = PAIR_BASE * PAIR_BASE;

function pairKey(a: number, b: number): number {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return PAIR_OFFSET + min * PAIR_BASE + max;
}

function encodeMoveKey(move: Move): number {
  if (move.positions.length === 1) {
    const [a] = move.positions;
    return posIdx(a.x, a.y);
  }
  if (move.positions.length === 2) {
    const [a, b] = move.positions;
    return pairKey(posIdx(a.x, a.y), posIdx(b.x, b.y));
  }
  throw new Error(`Invalid move length: ${move.positions.length}`);
}

function decodeMoveKey(key: number, player: Player): Move {
  if (key < PAIR_OFFSET) {
    const pos = fromIdx(key);
    return {
      player,
      positions: [pos],
    };
  }
  const base = key - PAIR_OFFSET;
  const a = Math.floor(base / PAIR_BASE);
  const b = base % PAIR_BASE;
  return {
    player,
    positions: [
      fromIdx(a),
      fromIdx(b),
    ],
  };
}

function sampleDirichlet(alpha: number, size: number): number[] {
  const samples = new Array<number>(size).fill(0);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const v = sampleGamma(alpha);
    samples[i] = v;
    sum += v;
  }
  if (sum <= 0) {
    return samples.map(() => 1 / size);
  }
  return samples.map(v => v / sum);
}

function sampleGamma(alpha: number): number {
  if (alpha <= 0) return 0;
  if (alpha < 1) {
    const u = Math.random();
    return sampleGamma(alpha + 1) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x = 0;
    let v = 0;
    do {
      const u1 = Math.random();
      const u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u3 = Math.random();
    if (u3 < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u3) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
