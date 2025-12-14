// src/ai/ai_engine.ts
import { GameState, Move } from '../game/types';
import { createMctsEngine } from './mcts_ai_engine';
import { createPvsEngine } from './pvs_ai_engine';
import { createHybridEngine } from './hybrid_strategy';

export type AIEngineType = 'MCTS' | 'PVS' | 'HYBRID';

export interface AIEngine {
  name: string;
  getMove(state: GameState): Promise<Move>;
  analyze?(state: GameState): Promise<{
    bestLine: Move[];
    score: number;
    // 其它你想展示的分析信息
  }>;
  dispose?(): void;
}

export interface AIEngineConfig {
  type: AIEngineType;
  // 不同算法的具体参数（思考时间、模拟次数、搜索深度等）
  timeLimitMs?: number;
  simulations?: number;
  depthLimit?: number;
}

export function createAIEngine(config: AIEngineConfig): AIEngine {
  switch (config.type) {
    case 'MCTS':
      return createMctsEngine(config);
    case 'PVS':
      return createPvsEngine(config);
    case 'HYBRID':
      return createHybridEngine(config);
    default:
      throw new Error(`Unsupported AI engine type: ${config.type}`);
  }
}
