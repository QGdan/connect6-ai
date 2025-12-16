import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  Player,
  SearchConfig,
} from '../types';
import { pvsSearchBestMove } from '../core/pvs_search';
import type { MCTSConnect6AI } from '../core/mcts_ai_engine';
import type { IResNetEvaluator } from '../core/resnet_ai';
import { estimateComplexity } from './position_complexity';

export type AIStrategy = 'traditional' | 'hybrid' | 'deep';

export interface HybridStrategyConfig {
  pvsConfig: SearchConfig;
  weights: EvaluationWeights;
}

export class HybridStrategyManager {
  // ★ 显式字段
  private mctsAI: MCTSConnect6AI;
  private config: HybridStrategyConfig;

  constructor(
    mctsAI: MCTSConnect6AI,
    _resnet: IResNetEvaluator, // 保留接口，供未来使用
    config: HybridStrategyConfig,
  ) {
    this.mctsAI = mctsAI;
    this.config = config;
  }

  updateConfig(config: Partial<HybridStrategyConfig>) {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  async decideMove(state: GameState, player: Player): Promise<AIMoveDecision> {
    const step = state.moveNumber;
    const complexity = estimateComplexity(state);

    const strategy = this.selectStrategy(step, complexity);

    if (strategy === 'traditional') {
      const result = pvsSearchBestMove(
        state,
        player,
        this.config.weights,
        this.config.pvsConfig,
      );
      result.debugInfo = {
        ...(result.debugInfo ?? {}),
        engine: result.debugInfo?.engine ?? 'pvs+vcdt+zorp',
        strategy,
      };
      return result;
    }

    if (strategy === 'deep') {
      const result = await this.mctsAI.decideMove(state, player);
      result.debugInfo = {
        ...(result.debugInfo ?? {}),
        engine: result.debugInfo?.engine ?? 'mcts',
        strategy,
      };
      return result;
    }

    const pvsResult = pvsSearchBestMove(
      state,
      player,
      this.config.weights,
      this.config.pvsConfig,
    );
    const mctsResult = await this.mctsAI.decideMove(state, player);

    const final =
      mctsResult.score > pvsResult.score ? mctsResult : pvsResult;
    final.debugInfo = {
      ...(final.debugInfo ?? {}),
      engine:
        final.debugInfo?.engine ??
        (final === mctsResult ? 'mcts' : 'pvs+vcdt+zorp'),
      strategy: 'hybrid',
    };
    return final;
  }

  private selectStrategy(step: number, complexity: number): AIStrategy {
    if (step <= 10) return 'traditional';
    if (step <= 30 && complexity > 0.6) return 'hybrid';
    if (step <= 30 && complexity <= 0.6) return 'traditional';
    if (step > 30) return 'traditional';
    return 'hybrid';
  }
}
