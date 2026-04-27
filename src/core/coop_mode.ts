import type { Move, Player } from '../types';

export type HumanVsAiMode = 'normal' | 'coop';
export type HybridActor = 'HUMAN_B' | 'AI';

export type HybridTurnPlan = {
  actor: HybridActor;
  stones: number;
};

/**
 * 混合方（B+AI）的轮次规划：
 * - 黑：idx1=B,1 子；其余轮次固定 2 子，轮次偶数=AI，奇数(>=3)=B
 * - 白：idx1=AI,2 子；其余轮次固定 2 子，轮次奇数=AI，偶数=B
 */
export function getHybridTurnPlan(
  hybridColor: Player,
  hybridTurnIndex: number,
): HybridTurnPlan {
  if (hybridTurnIndex <= 0) {
    throw new Error('hybridTurnIndex must start from 1');
  }

  let actor: HybridActor;
  if (hybridColor === 'BLACK') {
    // BLACK: idx1 B(1 子), idx2 AI, idx3 B, idx4 AI...
    actor = hybridTurnIndex % 2 === 1 ? 'HUMAN_B' : 'AI';
  } else {
    // WHITE: idx1 AI, idx2 B, idx3 AI, idx4 B...
    actor = hybridTurnIndex % 2 === 1 ? 'AI' : 'HUMAN_B';
  }

  const stones =
    hybridColor === 'BLACK' && hybridTurnIndex === 1 ? 1 : 2;

  return { actor, stones };
}

export function countHybridTurnsSoFar(
  moves: Move[],
  hybridColor: Player,
): number {
  return moves.filter(m => m.player === hybridColor).length;
}
