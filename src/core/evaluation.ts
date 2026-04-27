import type { EvaluationWeights, GameState, Player } from '../types';
import { mergeThreatReports } from './threat_analyzer';
import { analyzeBothCached } from './threat_service';
import type { PatternType, ThreatReport } from './pattern_library';

export interface ExtendedEvaluationWeights extends EvaluationWeights {
  threat_defense_weight?: number;
}

export const DEFAULT_EVALUATION_WEIGHTS: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};
export const EVALUATION_WEIGHT_KEYS = Object.keys(
  DEFAULT_EVALUATION_WEIGHTS,
) as Array<keyof EvaluationWeights>;

const DEFAULT_WEIGHTS = DEFAULT_EVALUATION_WEIGHTS;

const MAX_LIVE5_SCORE = 60_000;
const MAX_NON_TERMINAL_SCORE = 120_000;
const WIN_SCORE = 180_000;

const EMPTY_BY_TYPE: ThreatReport['byType'] = {
  CONNECT6: [],
  LIVE5: [],
  CHARGE5: [],
  DEAD5: [],
  LIVE4: [],
  CHARGE4: [],
  DEAD4: [],
  LIVE3: [],
  SLEEP3: [],
  WIN_IN_1: [],
  WIN_IN_2: [],
  DOUBLE_THREE: [],
  DOUBLE_FOUR: [],
  FOUR_THREE: [],
};

type ScaledWeights = {
  win1: number;
  win2: number;
  live5: number;
  charge5: number;
  live4: number;
  charge4: number;
  live3: number;
  sleep3: number;
  doubleThree: number;
  doubleFour: number;
  fourThree: number;
  point: number;
  pointCap: number;
};

function resolveWeights(weights?: EvaluationWeights): EvaluationWeights {
  if (!weights) return { ...DEFAULT_WEIGHTS };
  return {
    road_3_score: Number.isFinite(weights.road_3_score)
      ? weights.road_3_score
      : DEFAULT_WEIGHTS.road_3_score,
    road_4_score: Number.isFinite(weights.road_4_score)
      ? weights.road_4_score
      : DEFAULT_WEIGHTS.road_4_score,
    live4_score: Number.isFinite(weights.live4_score)
      ? weights.live4_score
      : DEFAULT_WEIGHTS.live4_score,
    live5_score: Number.isFinite(weights.live5_score)
      ? weights.live5_score
      : DEFAULT_WEIGHTS.live5_score,
    vcdt_bonus: Number.isFinite(weights.vcdt_bonus)
      ? weights.vcdt_bonus
      : DEFAULT_WEIGHTS.vcdt_bonus,
  };
}

function scaleWeights(weights: EvaluationWeights): ScaledWeights {
  const live5Base = Math.max(1, weights.live5_score);
  const scale = live5Base > MAX_LIVE5_SCORE
    ? MAX_LIVE5_SCORE / live5Base
    : 1;

  const live5 = live5Base * scale;
  const live4 = Math.min(
    Math.max(1, weights.live4_score) * scale,
    live5 * 0.75,
  );
  const live3 = Math.min(
    Math.max(1, weights.road_3_score) * scale,
    live4 * 0.35,
  );

  return {
    win1: live5 * 1.15,
    win2: live4 * 1.1,
    live5,
    charge5: live5 * 0.6,
    live4,
    charge4: live4 * 0.6,
    live3,
    sleep3: live3 * 0.5,
    doubleThree: live3 * 2.0,
    doubleFour: live4 * 1.5,
    fourThree: live4 * 1.15,
    point: Math.max(4, live3 * 0.05),
    pointCap: 14,
  };
}

function clampScore(value: number, maxAbs: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > maxAbs) return maxAbs;
  if (value < -maxAbs) return -maxAbs;
  return value;
}

function scoreFromReport(
  byType: Record<PatternType, { length: number }>,
  win1Count: number,
  win2Count: number,
  pointCount: number,
  weights: ScaledWeights,
): number {
  const cappedPoints = Math.min(pointCount, weights.pointCap);
  return (
    win1Count * weights.win1 +
    win2Count * weights.win2 +
    byType.LIVE5.length * weights.live5 +
    byType.CHARGE5.length * weights.charge5 +
    byType.LIVE4.length * weights.live4 +
    byType.CHARGE4.length * weights.charge4 +
    byType.DOUBLE_FOUR.length * weights.doubleFour +
    byType.FOUR_THREE.length * weights.fourThree +
    byType.DOUBLE_THREE.length * weights.doubleThree +
    byType.LIVE3.length * weights.live3 +
    byType.SLEEP3.length * weights.sleep3 +
    cappedPoints * weights.point
  );
}

export function evaluateFromThreatReport(
  report: ThreatReport,
  playerToMove: Player,
  weights: EvaluationWeights = DEFAULT_WEIGHTS,
): number {
  const resolved = resolveWeights(weights);
  const scaled = scaleWeights(resolved);
  const defenseWeight =
    (weights as ExtendedEvaluationWeights).threat_defense_weight ?? 1.2;

  const reportForPlayer = report.player === playerToMove;
  const myByType = reportForPlayer ? report.byType : report.oppByType ?? EMPTY_BY_TYPE;
  const oppByType = reportForPlayer ? report.oppByType ?? EMPTY_BY_TYPE : report.byType;

  if (myByType.CONNECT6.length > 0) return WIN_SCORE;
  if (oppByType.CONNECT6.length > 0) return -WIN_SCORE;

  const myWin1 = reportForPlayer
    ? report.winIn1.length
    : report.oppWin1Points?.length ?? 0;
  const myWin2 = reportForPlayer
    ? report.winIn2.length
    : report.oppWin2Pairs?.length ?? 0;
  const oppWin1 = reportForPlayer
    ? report.oppWin1Points?.length ?? 0
    : report.winIn1.length;
  const oppWin2 = reportForPlayer
    ? report.oppWin2Pairs?.length ?? 0
    : report.winIn2.length;

  const myPoints = reportForPlayer
    ? report.attackPoints.length
    : report.defensePoints.length;
  const oppPoints = reportForPlayer
    ? report.defensePoints.length
    : report.attackPoints.length;

  const myScore = scoreFromReport(myByType, myWin1, myWin2, myPoints, scaled);
  const oppScore = scoreFromReport(oppByType, oppWin1, oppWin2, oppPoints, scaled);
  const raw = myScore - oppScore * defenseWeight;

  return clampScore(raw, MAX_NON_TERMINAL_SCORE);
}

export function evaluateState(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
): number {
  const { my: myReport, opp: oppReport } = analyzeBothCached(state, player);
  const merged = mergeThreatReports(myReport, oppReport);
  return evaluateFromThreatReport(merged, player, weights);
}
