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
}

const selfTable = new Map<string, MCTSNode>();
const oppTable = new Map<string, MCTSNode>();

export interface MCTSConfig {
  simulationCount: number;
  simulationSteps: number;
  expandNodes: number;
  minWinRateThreshold: number;
}

export class MCTSConnect6AI {
  // ★ 显式声明成员
  private evaluator: IResNetEvaluator;
  private config: MCTSConfig;

  // ★ 普通构造函数，内部赋值
  constructor(evaluator: IResNetEvaluator, config: MCTSConfig) {
    this.evaluator = evaluator;
    this.config = config;
  }

  async decideMove(root: GameState, player: Player): Promise<AIMoveDecision> {
    const rootNode = this.getOrCreateNode(root, player, true);

    for (let i = 0; i < this.config.simulationCount; i++) {
      await this.runSimulation(rootNode);
    }

    let bestMove: Move | null = null;
    let bestScore = -Infinity;

    for (const [key, child] of rootNode.children.entries()) {
      const winRate = child.visits > 0 ? child.wins / child.visits : 0;
      if (winRate > bestScore) {
        bestScore = winRate;
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
    }
  }

  private selectChild(node: MCTSNode): MCTSNode {
    let bestChild: MCTSNode | null = null;
    let bestScore = -Infinity;
    const parentVisits = Math.max(1, node.visits);

    for (const [, child] of node.children) {
      const q = child.visits > 0 ? child.wins / child.visits : 0;
      const u = 1.4 * child.prior * Math.sqrt(parentVisits) / (1 + child.visits);
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

    const scoredPoints: { pos: Position; p: number }[] = candidates.map(pos => {
      const idx = pos.y * BOARD_SIZE + pos.x;
      return { pos, p: policy[idx] ?? 0.0001 };
    });

    scoredPoints.sort((a, b) => b.p - a.p);

    const maxPoints = Math.min(scoredPoints.length, this.config.expandNodes * 2);
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
        const nextState = applyMoveWithWinner(node.state, move);
        const child: MCTSNode = {
          state: nextState,
          player: node.player === 'BLACK' ? 'WHITE' : 'BLACK',
          visits: 0,
          wins: 0,
          prior,
          children: new Map(),
          isExpanded: false,
        };
        children.push([key, child]);
        sumPrior += prior;

        if (children.length >= this.config.expandNodes) break;
      }
      if (children.length >= this.config.expandNodes) break;
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
    const { value } = await this.evaluator.evaluate(node.state);
    return value;
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
      };
      table.set(key, node);
    }
    return node;
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
