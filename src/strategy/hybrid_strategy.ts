import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  Player,
  SearchConfig,
} from '../types';
import { pvsSearchBestMoveAsync } from '../core/pvs_worker_client';
import { evaluateWithThreatReport } from '../core/pvs_search';
import { analyzeBothCached } from '../core/threat_service';
import { applyMoveWithWinner, getStonesToPlace } from '../core/rules';
import {
  beginDecisionTrace,
  endDecisionTrace,
  traceDecisionEvent,
} from '../core/decision_trace';
import type { MCTSConnect6AI } from '../core/mcts_ai_engine';
import type { IResNetEvaluator } from '../core/resnet_ai';
import { estimateComplexity } from './position_complexity';

export type AIStrategy = 'traditional' | 'hybrid' | 'deep';

export interface HybridStrategyConfig {
  pvsConfig: SearchConfig;
  weights: EvaluationWeights;
}

type CandidateReview = {
  engine: 'mcts' | 'pvs+threat+zorp';
  decision: AIMoveDecision;
  judgeScore: number;
  unsafeImmediateLoss: boolean;
  oppWin1: number;
  oppWin2: number;
};

function switchPlayer(player: Player): Player {
  return player === 'BLACK' ? 'WHITE' : 'BLACK';
}

function hasUrgentThreatForDecision(state: GameState, player: Player): boolean {
  const { my, opp } = analyzeBothCached(state, player);
  const myNeed = getStonesToPlace(state.moveNumber, player);
  const oppNeed = getStonesToPlace(state.moveNumber + 1, switchPlayer(player));
  const myImmediate = my.winIn1.length > 0 || (myNeed >= 2 && my.winIn2.length > 0);
  const oppImmediate =
    opp.winIn1.length > 0 || (oppNeed >= 2 && opp.winIn2.length > 0);
  const oppInitiative =
    opp.byType.LIVE4.length > 0 ||
    opp.byType.CHARGE4.length > 0 ||
    opp.byType.DOUBLE_FOUR.length > 0 ||
    opp.byType.FOUR_THREE.length > 0 ||
    opp.byType.DOUBLE_THREE.length > 0;
  return myImmediate || oppImmediate || oppInitiative;
}

export class HybridStrategyManager {
  private mctsAI: MCTSConnect6AI;
  private config: HybridStrategyConfig;

  constructor(
    mctsAI: MCTSConnect6AI,
    _resnet: IResNetEvaluator,
    config: HybridStrategyConfig,
  ) {
    this.mctsAI = mctsAI;
    this.config = config;
  }

  async decideMove(state: GameState, player: Player): Promise<AIMoveDecision> {
    const traceId = beginDecisionTrace('HybridStrategyManager.decideMove', {
      player,
      moveNumber: state.moveNumber,
    });
    const step = state.moveNumber;
    const complexity = estimateComplexity(state);
    const urgent = hasUrgentThreatForDecision(state, player);

    const strategy = this.selectStrategy(step, complexity, urgent);
    traceDecisionEvent(traceId, 'HybridStrategyManager.decideMove', 'strategy_selected', {
      strategy,
      complexity,
      step,
      urgent,
    });

    if (strategy === 'traditional') {
      const result = await pvsSearchBestMoveAsync(
        state,
        player,
        this.config.weights,
        this.config.pvsConfig,
      );
      result.debugInfo = {
        ...(result.debugInfo ?? {}),
        engine: result.debugInfo?.engine ?? 'pvs+threat+zorp',
        strategy,
        decisionStage: result.debugInfo?.decisionStage ?? 'pvs',
      };
      traceDecisionEvent(traceId, 'HybridStrategyManager.decideMove', 'return_traditional', {
        mode: result.debugInfo?.mode,
        reason: result.debugInfo?.reason,
      });
      endDecisionTrace(traceId, {
        strategy,
        engine: result.debugInfo?.engine,
        stage: result.debugInfo?.decisionStage,
      });
      return result;
    }

    if (strategy === 'deep') {
      const result = await this.mctsAI.decideMove(state, player);
      result.debugInfo = {
        ...(result.debugInfo ?? {}),
        engine: result.debugInfo?.engine ?? 'mcts',
        strategy,
        decisionStage: result.debugInfo?.decisionStage ?? 'deep',
      };
      traceDecisionEvent(traceId, 'HybridStrategyManager.decideMove', 'return_deep', {
        selection: result.debugInfo?.selection,
      });
      endDecisionTrace(traceId, {
        strategy,
        engine: result.debugInfo?.engine,
        stage: result.debugInfo?.decisionStage,
      });
      return result;
    }

    const pvsResult = await pvsSearchBestMoveAsync(
      state,
      player,
      this.config.weights,
      this.config.pvsConfig,
    );
    const mctsResult = await this.mctsAI.decideMove(state, player);

    const reviewed: CandidateReview[] = [
      this.reviewCandidate(state, player, pvsResult, 'pvs+threat+zorp'),
      this.reviewCandidate(state, player, mctsResult, 'mcts'),
    ];
    const safe = reviewed.filter(r => !r.unsafeImmediateLoss);
    traceDecisionEvent(traceId, 'HybridStrategyManager.decideMove', 'hybrid_candidates', {
      safeCandidates: safe.length,
      pvsUnsafe: reviewed[0].unsafeImmediateLoss,
      mctsUnsafe: reviewed[1].unsafeImmediateLoss,
    });
    const pool = safe.length > 0 ? safe : reviewed;
    pool.sort((a, b) => {
      if (b.judgeScore !== a.judgeScore) return b.judgeScore - a.judgeScore;
      return b.decision.score - a.decision.score;
    });
    const winner = pool[0];
    const final = winner.decision;
    final.debugInfo = {
      ...(final.debugInfo ?? {}),
      engine: winner.engine,
      strategy: 'hybrid',
      decisionStage: 'hybrid_final',
      decisionReason:
        safe.length > 0 ? 'same_judge' : 'all_candidates_immediate_loss',
      hybridJudge: {
        safeCandidates: safe.length,
        pickedEngine: winner.engine,
        pickedScore: winner.judgeScore,
        pvs: {
          judgeScore: reviewed[0].judgeScore,
          unsafeImmediateLoss: reviewed[0].unsafeImmediateLoss,
          oppWin1: reviewed[0].oppWin1,
          oppWin2: reviewed[0].oppWin2,
        },
        mcts: {
          judgeScore: reviewed[1].judgeScore,
          unsafeImmediateLoss: reviewed[1].unsafeImmediateLoss,
          oppWin1: reviewed[1].oppWin1,
          oppWin2: reviewed[1].oppWin2,
        },
      },
    };
    traceDecisionEvent(traceId, 'HybridStrategyManager.decideMove', 'return_hybrid', {
      pickedEngine: winner.engine,
      safeCandidates: safe.length,
      reason: final.debugInfo.decisionReason,
    });
    endDecisionTrace(traceId, {
      strategy,
      engine: final.debugInfo.engine,
      stage: final.debugInfo.decisionStage,
      safeCandidates: safe.length,
    });
    return final;
  }

  private reviewCandidate(
    state: GameState,
    player: Player,
    decision: AIMoveDecision,
    engine: CandidateReview['engine'],
  ): CandidateReview {
    try {
      const next = applyMoveWithWinner(state, decision.move);
      const opp = switchPlayer(player);
      const oppNeed = getStonesToPlace(next.moveNumber, opp);
      const { my: oppReport } = analyzeBothCached(next, opp);
      const oppWin1 = oppReport.winIn1.length;
      const oppWin2 = oppNeed >= 2 ? oppReport.winIn2.length : 0;
      const unsafeImmediateLoss = oppWin1 > 0 || oppWin2 > 0;
      const judgeScore = evaluateWithThreatReport(
        next,
        player,
        {
          ...this.config.weights,
          threat_defense_weight: 1,
        } as EvaluationWeights & { threat_defense_weight: number },
      );
      return {
        engine,
        decision,
        judgeScore,
        unsafeImmediateLoss,
        oppWin1,
        oppWin2,
      };
    } catch {
      return {
        engine,
        decision,
        judgeScore: -Infinity,
        unsafeImmediateLoss: true,
        oppWin1: Number.POSITIVE_INFINITY,
        oppWin2: Number.POSITIVE_INFINITY,
      };
    }
  }

  private selectStrategy(
    step: number,
    _complexity: number,
    urgent: boolean,
  ): AIStrategy {
    // Tactical emergency should stay on deterministic threat/PVS chain.
    if (urgent) return 'traditional';
    // Opening remains stable with the traditional engine.
    if (step <= 10) return 'traditional';
    // Non-urgent midgame should use hybrid arbitration by design.
    if (step <= 40) return 'hybrid';
    // Late game falls back to traditional for deterministic endgame handling.
    return 'traditional';
  }
}
