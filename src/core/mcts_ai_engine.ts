import type { GameState, Player, AIMoveDecision, Move, Position } from '../types';
import type { IResNetEvaluator } from './resnet_ai';
import { applyMoveWithWinner } from './rules';
import { generateRZOPCandidates } from './rzop';
import { BOARD_SIZE } from './game_state';

interface MCTSNode {
  state: GameState;
  player: Player;
  visits: number;
  wins: number;
  prior: number;
  children: Map<string, MCTSNode>;
  isExpanded: boolean;
  lastVisitId: number;
}

const selfTable = new Map<string, MCTSNode>();
const oppTable = new Map<string, MCTSNode>();

let visitClock = 0;

function dirichletNoise(size: number, alpha = 0.3): number[] {
  if (size <= 0) return [];
  const samples = Array.from({ length: size }, () => -Math.log(Math.random()) / alpha);
  const sum = samples.reduce((acc, v) => acc + v, 0) || 1;
  return samples.map(v => v / sum);
}

export interface MCTSConfig {
  simulationCount: number;
  simulationSteps: number;
  expandNodes: number;
  minWinRateThreshold: number;
  ucbConstant?: number;
  dirichletEpsilon?: number;
  maxTranspositionSize?: number;
  rolloutTopK?: number;
}

export class MCTSConnect6AI {
  // ★ 显式声明成员
  private evaluator: IResNetEvaluator;
  private config: MCTSConfig;
  private rootPlayer: Player | null = null;

  // ★ 普通构造函数，内部赋值
  constructor(evaluator: IResNetEvaluator, config: MCTSConfig) {
    this.evaluator = evaluator;
    this.config = {
      ucbConstant: 1.4,
      dirichletEpsilon: 0.25,
      maxTranspositionSize: 50_000,
      rolloutTopK: 6,
      ...config,
    };
  }

  async decideMove(root: GameState, player: Player): Promise<AIMoveDecision> {
    this.rootPlayer = player;
    const rootNode = this.getOrCreateNode(root, player, true);

    this.pruneTranspositionTables();

    for (let i = 0; i < this.config.simulationCount; i++) {
      await this.runSimulation(rootNode);
    }

    let bestMove: Move | null = null;
    let bestVisits = -1;
    let bestScore = -Infinity;

    for (const [key, child] of rootNode.children.entries()) {
      const winRate = child.visits > 0 ? child.wins / child.visits : 0;
      const visits = child.visits;
      if (visits > bestVisits || (visits === bestVisits && winRate > bestScore)) {
        bestScore = winRate;
        bestVisits = visits;
        bestMove = decodeMoveKey(key, player);
      }
    }

    if (!bestMove) {
      throw new Error('MCTS failed to generate a move');
    }

    return {
      move: bestMove,
      score: bestScore,
      debugInfo: { strategy: 'deep', visits: rootNode.visits },
    };
  }

  private async runSimulation(root: MCTSNode): Promise<void> {
    const path: MCTSNode[] = [root];
    let node = root;

    while (node.isExpanded && node.children.size > 0) {
      node = this.selectChild(node);
      path.push(node);
    }

    if (!node.isExpanded) {
      await this.expandNode(node);
    }

    const value = await this.simulate(node);
    for (const n of path) {
      n.visits += 1;
      n.wins += value;
      n.lastVisitId = ++visitClock;
    }
  }

  private projectValueToRoot(value: number, perspective: Player): number {
    if (!this.rootPlayer) return value;
    return perspective === this.rootPlayer ? value : -value;
  }

  private isSelfTable(player: Player): boolean {
    return this.rootPlayer === player;
  }

  private selectChild(node: MCTSNode): MCTSNode {
    let bestChild: MCTSNode | null = null;
    let bestScore = -Infinity;
    const parentVisits = Math.max(1, node.visits);

    const ucb = this.config.ucbConstant ?? 1.4;

    for (const [, child] of node.children) {
      const q = child.visits > 0 ? child.wins / child.visits : 0;
      const u = ucb * child.prior * Math.sqrt(parentVisits) / (1 + child.visits);
      const score = q + u;
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

  private async expandNode(node: MCTSNode): Promise<void> {
    const { policy } = await this.evaluator.evaluate(node.state);
    const candidates = generateRZOPCandidates(node.state);

    // 根节点添加 Dirichlet 噪声，鼓励探索
    const isRoot = this.rootPlayer === node.player;
    const noise = isRoot ? dirichletNoise(candidates.length) : null;
    const noiseWeight = this.config.dirichletEpsilon ?? 0.25;

    const scoredPoints: { pos: Position; p: number }[] = candidates.map(pos => {
      const idx = pos.y * BOARD_SIZE + pos.x;
      const base = policy[idx] ?? 0.0001;
      const p =
        noise && isRoot
          ? (1 - noiseWeight) * base + noiseWeight * (noise.shift() ?? 0)
          : base;
      return { pos, p };
    });

    scoredPoints.sort((a, b) => b.p - a.p);

    const maxPoints = Math.min(scoredPoints.length, this.config.expandNodes * 3);
    const topPoints = scoredPoints.slice(0, maxPoints);

    const children: [string, MCTSNode][] = [];
    let sumPrior = 0;

    for (let i = 0; i < topPoints.length; i++) {
      for (let j = i + 1; j < topPoints.length; j++) {
        const move: Move = {
          player: node.player,
          positions: [topPoints[i].pos, topPoints[j].pos],
        };
        const prior = topPoints[i].p * topPoints[j].p;
        const key = encodeMoveKey(move);
        const nextPlayer: Player = node.player === 'BLACK' ? 'WHITE' : 'BLACK';
        const nextState = applyMoveWithWinner(node.state, move);
        const child = this.getOrCreateNode(nextState, nextPlayer, this.isSelfTable(nextPlayer));
        const winRate = child.visits > 0 ? child.wins / child.visits : 0.5;

        // 低胜率（且有统计量）的节点会被跳过，确保搜索聚焦高潜力区域
        if (child.visits > 5 && winRate < this.config.minWinRateThreshold) {
          continue;
        }

        child.prior = prior;
        children.push([key, child]);
        sumPrior += prior || 0.0001;

        if (children.length >= this.config.expandNodes) break;
      }
      if (children.length >= this.config.expandNodes) break;
    }

    // 如果全部被阈值过滤，至少保留一个最高概率孩子防止搜索断层
    if (children.length === 0 && topPoints.length >= 2) {
      const move: Move = {
        player: node.player,
        positions: [topPoints[0].pos, topPoints[1].pos],
      };
      const nextState = applyMoveWithWinner(node.state, move);
      const fallback = this.getOrCreateNode(
        nextState,
        node.player === 'BLACK' ? 'WHITE' : 'BLACK',
        this.isSelfTable(node.player === 'BLACK' ? 'WHITE' : 'BLACK'),
      );
      fallback.prior = topPoints[0].p * topPoints[1].p;
      children.push([encodeMoveKey(move), fallback]);
      sumPrior = fallback.prior;
    }

    if (sumPrior > 0) {
      for (const [, child] of children) {
        child.prior /= sumPrior;
      }
    }

    for (const [key, child] of children) {
      node.children.set(key, child);
    }

    node.isExpanded = true;
  }

  private async simulate(node: MCTSNode): Promise<number> {
    // 如果已经有终局结果，直接返回胜负值（对根玩家视角）
    if (node.state.winner) {
      if (!this.rootPlayer) return 0;
      if (node.state.winner === 'DRAW') return 0;
      return node.state.winner === this.rootPlayer ? 1 : -1;
    }

    let rolloutState = node.state;
    let currentPlayer = node.player;
    let latestValue = 0;

    for (let step = 0; step < this.config.simulationSteps; step++) {
      const { policy, value } = await this.evaluator.evaluate(rolloutState);
      latestValue = this.projectValueToRoot(value, currentPlayer);

      if (rolloutState.winner) break;

      const candidates = generateRZOPCandidates(rolloutState);
      if (candidates.length < 2) break;

      const scored = candidates
        .map(pos => ({ pos, score: policy[pos.y * BOARD_SIZE + pos.x] ?? 0 }))
        .sort((a, b) => b.score - a.score);

      const topK = Math.max(2, this.config.rolloutTopK ?? 6);
      const pool = scored.slice(0, Math.min(topK, scored.length));
      const draw = (list: typeof pool, sum: number) => {
        let r = Math.random() * sum;
        for (const item of list) {
          r -= item.score || 0.0001;
          if (r <= 0) return item;
        }
        return list[list.length - 1];
      };

      const total = pool.reduce((s, p) => s + (p.score || 0.0001), 0) || 1;
      const first = draw(pool, total);
      const remaining = pool.filter(
        p => p.pos.x !== first.pos.x || p.pos.y !== first.pos.y,
      );
      const secondPool = remaining.length > 0 ? remaining : pool;
      const secondTotal = secondPool.reduce((s, p) => s + (p.score || 0.0001), 0) || 1;
      const second = draw(secondPool, secondTotal);

      const nextMove: Move = {
        player: currentPlayer,
        positions: [first.pos, second.pos],
      };

      rolloutState = applyMoveWithWinner(rolloutState, nextMove);
      currentPlayer = currentPlayer === 'BLACK' ? 'WHITE' : 'BLACK';

      if (rolloutState.winner) {
        if (!this.rootPlayer) break;
        return rolloutState.winner === 'DRAW'
          ? 0
          : rolloutState.winner === this.rootPlayer
            ? 1
            : -1;
      }
    }

    return latestValue;
  }

  private getOrCreateNode(
    state: GameState,
    player: Player,
    isSelf: boolean,
  ): MCTSNode {
    const key = encodeStateKey(state, player);
    const table = isSelf ? selfTable : oppTable;
    let node = table.get(key);
    if (!node) {
      node = {
        state,
        player,
        visits: 0,
        wins: 0,
        prior: 1,
        children: new Map(),
        isExpanded: false,
        lastVisitId: ++visitClock,
      };
      table.set(key, node);
    } else {
      node.lastVisitId = ++visitClock;
    }
    return node;
  }

  clearTranspositionTables(): void {
    selfTable.clear();
    oppTable.clear();
  }

  private pruneTranspositionTables(): void {
    const maxSize = this.config.maxTranspositionSize ?? 50_000;
    const totalSize = selfTable.size + oppTable.size;
    if (totalSize <= maxSize) return;

    const collectAndSort = (table: Map<string, MCTSNode>) =>
      Array.from(table.entries()).sort((a, b) => b[1].lastVisitId - a[1].lastVisitId);

    const entries = [...collectAndSort(selfTable), ...collectAndSort(oppTable)];
    const keep = Math.floor(maxSize * 0.9);

    selfTable.clear();
    oppTable.clear();

    for (let i = 0; i < entries.length && i < keep; i++) {
      const [key, node] = entries[i];
      if (node.player === this.rootPlayer) {
        selfTable.set(key, node);
      } else {
        oppTable.set(key, node);
      }
    }
  }
}

function encodeStateKey(state: GameState, player: Player): string {
  const rows = state.board.map(row => row.join('')).join('');
  return `${player}:${rows}`;
}

function encodeMoveKey(move: Move): string {
  const [a, b] = move.positions;
  return `${a.x},${a.y},${b.x},${b.y}`;
}

function decodeMoveKey(key: string, player: Player): Move {
  const parts = key.split(',').map(Number);
  if (parts.length !== 4) {
    throw new Error(`Invalid move key: ${key}`);
  }
  const [x1, y1, x2, y2] = parts;
  return {
    player,
    positions: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
  };
}
