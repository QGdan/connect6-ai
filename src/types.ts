// types.ts

// 玩家类型
export type Player = 'BLACK' | 'WHITE';

// 每个单元格的类型（0 为空，1 为黑子，2 为白子）
export type Cell = 0 | 1 | 2;

// 棋盘的大小（19x19）
export const BOARD_SIZE = 19;

// 定义每步棋的类型
export interface Move {
  player: Player;  // 执子玩家
  positions: { x: number; y: number }[];  // 当前步的多个位置
}

export interface Position {
  x: number;
  y: number;
}

// 游戏状态类型
export interface GameState {
  board: Cell[][];           // 19x19 棋盘
  currentPlayer: Player;     // 当前执子玩家
  moveNumber: number;        // 当前回合的回合数（一次两子算一手）
  lastMove?: Move;           // 上一步棋
  winner?: Player | 'DRAW';  // 胜利者（如果有）
}

// 估值权重（自博弈优化的目标参数）
export interface EvaluationWeights {
  road_3_score: number;
  road_4_score: number;
  live4_score: number;
  live5_score: number;
  vcdt_bonus: number;
}

// AI 决策类型
export interface AIMoveDecision {
  move: Move;
  score: number;             // 打分 / 胜率估计等
  debugInfo?: any;           // 用于教学展示
}

// 搜索配置类型
export interface SearchConfig {
  maxDepth: number;
  timeLimitMs: number;
  useMultithreading: boolean;
}

// 性能监控指标类型
export interface PerformanceStats {
  avgThinkTimeMs: number;
  maxThinkTimeMs: number;
  threatDetectionAccuracy: number;
  searchDepthAvg: number;
}
