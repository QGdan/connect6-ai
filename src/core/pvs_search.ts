// core/pvs_search.ts

import type {
  AIMoveDecision,
  AIMoveDebugInfo,
  EvaluationWeights,
  GameState,
  Move,
  Player,
  SearchConfig,
  Position,
} from '../types';
import {
  applyMoveWithWinner,
  getStonesToPlace,
  tryApplyMoveWithWinner,
} from './rules';
import { generateRZOPCandidates } from './rzop';
import { evaluateFromThreatReport } from './evaluation';
import { mergeThreatReports } from './threat_analyzer';
import { analyzeBothCached, analyzeCached, clearThreatCache } from './threat_service';
import { getLinesForCell } from './road_encoding';
import { stableKey, type PatternHit, type PatternType, type ThreatReport } from './pattern_library';
import { PatternEvaluator } from './pattern_evaluator';
import { BOARD_SIZE } from './game_state';
import { posIdx, fromIdx } from './pos_key';
import { sortByCenter, uniqueEmptyPoints } from './position_utils';
import { collectOpenThreeThreats, countOpenThreeLines } from './threat_utils';
import {
  buildVcfVctDefenseMoves,
  findVcfVctRootHints,
} from './vcf_vct_solver';
import { isDeadLineCell } from './line_potential';
import {
  beginDecisionTrace,
  endDecisionTrace,
  traceDecisionEvent,
} from './decision_trace';
import {
  addKillerMove as addKillerMoveStore,
  clearAspirationWindows,
  clearKillerMoves,
  clearTranspositionTable,
  decayHistory as decayHistoryStore,
  getAspirationWindows,
  getHistoryEvictionsThisMove,
  getHistoryScore as getHistoryScoreStore,
  getHistorySize,
  getKillerMoves,
  getTTEvictionsThisMove,
  getTTBestMove,
  getTTSize,
  probeTT as probeTTStore,
  pushAspirationWindow,
  resetHistoryEvictionsThisMove,
  resetTTEvictionsThisMove,
  storeTT as storeTTStore,
  type AspirationWindow,
  updateHistory as updateHistoryStore,
} from './pvs/tt_history';

type ThreatKind = Exclude<PatternType, 'CONNECT6'>;

interface ThreatInfo {
  positions: Position[];
  isWinning: boolean;
  threatLevel: number;
  kind: ThreatKind;
  defenseCost?: number;
}

// ===== Threat 缓存（单次搜索周期）=====
const THREAT_LIST_CACHE_LIMIT = 100_000;
const threatListCacheBlack = new Map<bigint, ThreatInfo[]>();
const threatListCacheWhite = new Map<bigint, ThreatInfo[]>();
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
const QUIET_THREAT_TYPES: PatternType[] = [
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
];
const QUIET_EXTRA_TYPES: PatternType[] = [
  'LIVE5',
  'CHARGE5',
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
  'LIVE3',
];
const QUIET_EXTRA_MAX_POINTS = 6;
const QUIET_BLEND_FACTOR = 0.15;
const QUIET_SCORE_CAP = 120_000;

function clampEvalScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > QUIET_SCORE_CAP) return QUIET_SCORE_CAP;
  if (value < -QUIET_SCORE_CAP) return -QUIET_SCORE_CAP;
  return value;
}

function threatListCacheFor(player: Player): Map<bigint, ThreatInfo[]> {
  return player === 'BLACK' ? threatListCacheBlack : threatListCacheWhite;
}

function cachedAnalyzeThreats(state: GameState, player: Player): ThreatReport {
  return analyzeCached(state, player);
}

function pairKey(a: Position, b: Position): number {
  const aIdx = posIdx(a.x, a.y);
  const bIdx = posIdx(b.x, b.y);
  return aIdx < bIdx ? aIdx * BOARD_CELLS + bIdx : bIdx * BOARD_CELLS + aIdx;
}

function collectKeyPointsByType(
  report: ThreatReport,
  types: PatternType[],
): Position[] {
  const out = new Map<number, Position>();
  for (const type of types) {
    const hits = report.byType[type];
    for (const hit of hits) {
      const source = hit.keyPoints.length > 0 ? hit.keyPoints : hit.defensePoints;
      for (const p of source) {
        const idx = posIdx(p.x, p.y);
        if (!out.has(idx)) out.set(idx, p);
      }
    }
  }
  return [...out.values()];
}


function collectOpenThreeEnds(
  state: GameState,
  report: ThreatReport,
): Position[] {
  const val = report.player === 'BLACK' ? 1 : 2;
  const threats = collectOpenThreeThreats(state, val);
  if (countOpenThreeLines(threats) < 2) return [];
  const out = new Map<number, Position>();
  for (const t of threats) {
    for (const p of t.ends) {
      out.set(posIdx(p.x, p.y), p);
    }
  }
  return [...out.values()];
}

type OpenThreeLineInfo = { ends: Set<number>; threatCount: number };

function collectOpenThreeLineInfo(
  state: GameState,
  playerVal: number,
): Map<number, OpenThreeLineInfo> {
  const threats = collectOpenThreeThreats(state, playerVal);
  const lines = new Map<number, OpenThreeLineInfo>();
  for (const threat of threats) {
    let entry = lines.get(threat.lineId);
    if (!entry) {
      entry = { ends: new Set<number>(), threatCount: 0 };
      lines.set(threat.lineId, entry);
    }
    entry.threatCount += 1;
    for (const p of threat.ends) {
      entry.ends.add(posIdx(p.x, p.y));
    }
  }
  return lines;
}

function hasStrictDoubleLive3(state: GameState, report: ThreatReport): boolean {
  const val = report.player === 'BLACK' ? 1 : 2;
  const threats = collectOpenThreeThreats(state, val);
  return countOpenThreeLines(threats) >= 2;
}

const OPP_INITIATIVE_TYPES: PatternType[] = [
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
  'LIVE4',
  'CHARGE4',
];

function mergeCandidatePoints(primary: Position[], secondary: Position[]): Position[] {
  const out: Position[] = [];
  const seen = new Set<number>();
  for (const p of primary) {
    const idx = p.y * BOARD_SIZE + p.x;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(p);
  }
  for (const p of secondary) {
    const idx = p.y * BOARD_SIZE + p.x;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(p);
  }
  return out;
}

const INITIATIVE_BLOCK_WEIGHTS: Partial<Record<PatternType, number>> = {
  DOUBLE_FOUR: 9,
  FOUR_THREE: 7,
  DOUBLE_THREE: 5,
  LIVE4: 4,
  CHARGE4: 3,
  LIVE3: 1,
};
const DOUBLE_LIVE3_BLOCK_WEIGHT = 2.2;

function collectInitiativeBlockPoints(
  state: GameState,
  report: ThreatReport,
): Array<{ p: Position; score: number }> {
  const scores = new Map<number, { p: Position; score: number }>();
  for (const type of OPP_INITIATIVE_TYPES) {
    const hits = report.byType[type];
    const weight = INITIATIVE_BLOCK_WEIGHTS[type] ?? 0;
    for (const hit of hits) {
      const source = hit.keyPoints.length > 0 ? hit.keyPoints : hit.defensePoints;
      for (const p of source) {
        const idx = p.y * BOARD_SIZE + p.x;
        const prev = scores.get(idx);
        const nextScore = (prev?.score ?? 0) + weight;
        scores.set(idx, { p, score: nextScore });
      }
    }
  }
  const live3Points = collectOpenThreeEnds(state, report);
  if (live3Points.length > 0) {
    for (const p of live3Points) {
      const idx = posIdx(p.x, p.y);
      const prev = scores.get(idx);
      const nextScore = (prev?.score ?? 0) + DOUBLE_LIVE3_BLOCK_WEIGHT;
      scores.set(idx, { p, score: nextScore });
    }
  }

  const center = (BOARD_SIZE - 1) / 2;
  return [...scores.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = Math.abs(a.p.x - center) + Math.abs(a.p.y - center);
    const db = Math.abs(b.p.x - center) + Math.abs(b.p.y - center);
    return da - db;
  });
}

function threatLevelFor(kind: ThreatKind, isWinning: boolean): number {
  if (isWinning) return 0;
  switch (kind) {
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
    case 'CHARGE5':
    case 'LIVE4':
    case 'CHARGE4':
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'DEAD4':
    case 'DEAD5':
    case 'LIVE3':
    case 'SLEEP3':
      return 3;
    case 'WIN_IN_1':
    default:
      return 3;
  }
}

function defenseCostFor(kind: ThreatKind): number {
  switch (kind) {
    case 'WIN_IN_1':
      return 1;
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
      return 2;
    case 'CHARGE5':
      return 1;
    case 'LIVE4':
      return 2;
    case 'CHARGE4':
      return 1;
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'LIVE3':
    case 'SLEEP3':
      return 1;
    case 'DEAD4':
    case 'DEAD5':
      return 1;
    default:
      return 1;
  }
}

function hitToThreat(
  hit: PatternHit,
  seen: Set<string>,
  win2Pairs: Set<number>,
): ThreatInfo[] {
  if (hit.type === 'CONNECT6') return [];

  if (hit.type === 'WIN_IN_2') {
    if (hit.keyPoints.length < 2) return [];
    const [p1, p2] = hit.keyPoints;
    const key = pairKey(p1, p2);
    if (win2Pairs.has(key)) return [];
    win2Pairs.add(key);
    return [
      {
        positions: [p1, p2],
        isWinning: true,
        threatLevel: 1,
        kind: 'WIN_IN_2',
        defenseCost: defenseCostFor('WIN_IN_2'),
      },
    ];
  }

  const key = stableKey(hit);
  if (seen.has(key)) return [];
  seen.add(key);

  const positions = hit.keyPoints.length > 0 ? hit.keyPoints : hit.stones;
  const isWinning = hit.type === 'WIN_IN_1';
  const kind = hit.type as ThreatKind;
  return [
    {
      positions,
      isWinning,
      threatLevel: threatLevelFor(kind, isWinning),
      kind,
      defenseCost: defenseCostFor(kind),
    },
  ];
}

function buildThreatList(report: ThreatReport): ThreatInfo[] {
  const threats: ThreatInfo[] = [];
  const seen = new Set<string>();
  const win2Pairs = new Set<number>();
  for (const hit of report.patterns) {
    threats.push(...hitToThreat(hit, seen, win2Pairs));
  }
  return threats;
}

function cachedThreats(state: GameState, player: Player): ThreatInfo[] {
  const cache = threatListCacheFor(player);
  const key = hashState(state);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const report = cachedAnalyzeThreats(state, player);
  const val = buildThreatList(report);
  cache.set(key, val);
  if (cache.size > THREAT_LIST_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return val;
}

export function evaluateWithThreatReport(
  state: GameState,
  rootPlayer: Player,
  weights: EvaluationWeights,
  cached?: { self?: ThreatReport; opp?: ThreatReport },
  patternEval?: PatternEvaluator,
): number {
  const selfReport =
    cached?.self ?? cachedAnalyzeThreats(state, rootPlayer);
  const oppReport =
    cached?.opp ?? cachedAnalyzeThreats(state, switchPlayer(rootPlayer));
  const merged = mergeThreatReports(selfReport, oppReport);
  const threatScore = evaluateFromThreatReport(merged, rootPlayer, weights);
  if (!patternEval) return threatScore;

  const oppWin1 = merged.oppWin1Points?.length ?? 0;
  const oppWin2 = merged.oppWin2Pairs?.length ?? 0;
  const hasImmediate =
    merged.winIn1.length > 0 ||
    merged.winIn2.length > 0 ||
    oppWin1 > 0 ||
    oppWin2 > 0;

  let hasTactical = false;
  for (const type of QUIET_THREAT_TYPES) {
    if (merged.byType[type].length > 0) {
      hasTactical = true;
      break;
    }
    if ((merged.oppByType?.[type]?.length ?? 0) > 0) {
      hasTactical = true;
      break;
    }
  }

  if (hasImmediate || hasTactical) return threatScore;

  const patternScore = patternEval.evaluate(state.board).score;
  const blended = threatScore + patternScore * QUIET_BLEND_FACTOR;
  return clampEvalScore(blended);
}

function evaluateForToMove(
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  weights: EvaluationWeights,
  cached?: { self?: ThreatReport; opp?: ThreatReport },
  patternEval?: PatternEvaluator,
): number {
  const rootScore = evaluateWithThreatReport(
    state,
    rootPlayer,
    weights,
    cached,
    patternEval,
  );
  return toMove === rootPlayer ? rootScore : -rootScore;
}

// ===== 甯搁噺 =====
const MAX_ROOT_MOVE_COMBOS = 50;
const MAX_CHILD_MOVE_COMBOS = 30;
const MAX_ROOT_CANDIDATE_POINTS = 48;
const MAX_CHILD_CANDIDATE_POINTS = 28;
const TACTICAL_HINT_BONUS = 220_000;
const VCF_VCT_MAX_DEPTH = 5;
const VCF_VCT_MAX_NODES = 1400;
const VCF_VCT_MAX_TIME_MS = 120;
const VCF_VCT_TIME_RATIO = 0.12;
const VCF_VCT_MAX_BRANCH = 6;
const VCF_VCT_DEFENSE_CHECKS = 6;
const LOCALITY_MAX_DIST = 6;
const LOCALITY_BONUS_PER_STEP = 1500;
const TWO_STONE_MAX_GENERATED = 140;
const TWO_STONE_FIRST_POOL = 40;
const TWO_STONE_FIRST_BEAM = 18;
const TWO_STONE_SECOND_BEAM = 8;
const SINGLE_STONE_CANDIDATE_LIMIT = 20;
const TWO_STONE_CANDIDATE_LIMIT = 36;
const SINGLE_LIVE3_DOUBLE_BLOCK_PENALTY = 60_000;
const THREAT_TIME_BASE_RATIO = 0.75;
const THREAT_TIME_BASE_MIN_MS = 3500;

const MAX_TT_ENTRIES = 1_000_000;
const MAX_HISTORY_ENTRIES = 500_000;
const MIN_HISTORY_THRESHOLD = 100;

const ASPIRATION_WINDOW = 120_000;
const QUIESCENCE_MAX_DEPTH = 2;
const MAX_LOCAL_EXTENSION = 2; // 遇到强威胁/强杀时，局部最多延伸 1 层
const MAX_TIME_THREAT_BOOST = 1.6; // 危急局面最多放大 1.6x 时间

// ===== 置换表 =====
let lastEvalSignature: string | null = null;

function formatEvalSig(value: unknown): string {
  return Number.isFinite(value) ? Number(value).toFixed(6) : 'na';
}

function buildEvalSignature(weights: EvaluationWeights): string {
  const base = [
    formatEvalSig(weights.road_3_score),
    formatEvalSig(weights.road_4_score),
    formatEvalSig(weights.live4_score),
    formatEvalSig(weights.live5_score),
    formatEvalSig(weights.vcdt_bonus),
  ].join('|');
  const defense = (weights as { threat_defense_weight?: number }).threat_defense_weight;
  return `${base}|def:${formatEvalSig(defense)}`;
}

function hashState(state: GameState): bigint {
  return state.zobristHash;
}

function probeTT(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
): { score: number; depth: number; flag: 'EXACT' | 'LOWER' | 'UPPER'; bestMove?: Move } | null {
  return probeTTStore(hashState(state), depth, alpha, beta);
}

function storeTT(
  state: GameState,
  depth: number,
  score: number,
  alpha: number,
  beta: number,
  bestMove?: Move,
): void {
  storeTTStore(
    hashState(state),
    depth,
    score,
    alpha,
    beta,
    bestMove,
    MAX_TT_ENTRIES,
  );
}

// ===== history 启发 =====
function updateHistory(player: Player, pos: Position, depth: number): void {
  updateHistoryStore(player, pos, depth, BOARD_SIZE, MAX_HISTORY_ENTRIES);
}

function getHistoryScore(player: Player, pos: Position): number {
  return getHistoryScoreStore(player, pos, BOARD_SIZE);
}

function decayHistory(): void {
  decayHistoryStore(MIN_HISTORY_THRESHOLD);
}

// ===== 宸ュ叿 =====
function switchPlayer(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

function getCurrentTime(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}

function computeThreatTimeFactor(
  state: GameState,
  player: Player,
  base: number,
  cached?: { my?: ThreatInfo[]; opp?: ThreatInfo[] },
): number {
  // 对手有即时双点必杀或大量活四时，适度放宽时间；自己有即胜时轻微放宽（降低幅度防止超时）
  const opp = switchPlayer(player);
  const myThreats = cached?.my ?? cachedThreats(state, player);
  const oppThreats = cached?.opp ?? cachedThreats(state, opp);

  const oppImmediate = oppThreats.some(
    t => t.isWinning && (t.threatLevel === 0 || t.threatLevel === 1),
  );
  const oppCritical = oppThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  ).length;
  const myImmediate = myThreats.some(
    t => t.isWinning && (t.threatLevel === 0 || t.threatLevel === 1),
  );

  let factor = 1;
  if (oppImmediate) factor = 1.3;
  else if (oppCritical >= 2) factor = 1.15;
  else if (myImmediate) factor = 1.08;

  return Math.min(factor, MAX_TIME_THREAT_BOOST) * base;
}

function computeLocalExtension(
  state: GameState,
  toMove: Player,
  cached?: { self?: ThreatInfo[]; opp?: ThreatInfo[] },
): number {
  // 在“必须看清”的局面多延伸 1 层：双方即胜/双点必杀/活四
  const opp = switchPlayer(toMove);
  const myThreats = cached?.self ?? cachedThreats(state, toMove);
  const oppThreats = cached?.opp ?? cachedThreats(state, opp);

  const myImmediate = myThreats.some(
    t => t.isWinning && t.threatLevel <= 1,
  );
  const oppImmediate = oppThreats.some(
    t => t.isWinning && t.threatLevel <= 1,
  );
  const myCritical = myThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  ).length;
  const oppCritical = oppThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  ).length;
  const criticalCount = myCritical + oppCritical;

  const isKeyShape = (t: ThreatInfo) =>
    t.kind === 'DOUBLE_FOUR' ||
    t.kind === 'FOUR_THREE' ||
    t.kind === 'DOUBLE_THREE';
  const isStrongShape = (t: ThreatInfo) =>
    t.kind === 'DOUBLE_FOUR' || t.kind === 'FOUR_THREE';
  const myKeyShapes = myThreats.filter(isKeyShape).length;
  const oppKeyShapes = oppThreats.filter(isKeyShape).length;
  const strongShapes =
    myThreats.filter(isStrongShape).length +
    oppThreats.filter(isStrongShape).length;
  const keyShapeTotal = myKeyShapes + oppKeyShapes;

  if (
    (myImmediate && oppImmediate) ||
    (myImmediate && criticalCount >= 2) ||
    (oppImmediate && criticalCount >= 2) ||
    criticalCount >= 3 ||
    keyShapeTotal >= 2 ||
    (strongShapes > 0 && (myImmediate || oppImmediate)) ||
    (strongShapes > 0 && criticalCount >= 2)
  ) {
    return 2;
  }

  if (myImmediate || oppImmediate || criticalCount >= 1 || keyShapeTotal >= 1) {
    return 1;
  }
  return 0;
}

// ===== 静态搜索 =====
function quiescenceSearch(
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  alpha: number,
  beta: number,
  weights: EvaluationWeights,
  depth: number,
  patternEval?: PatternEvaluator,
): number {
  const standPat = evaluateForToMove(
    state,
    rootPlayer,
    toMove,
    weights,
    undefined,
    patternEval,
  );

  if (depth >= QUIESCENCE_MAX_DEPTH) return standPat;
  if (standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;

  // 只扩展战术相关行动：赢点 / 必挡点 / 少量高优先 RZOP
  const moves: Move[] = [];
  const stones = getStonesToPlace(state.moveNumber, toMove);
  const myThreats = cachedThreats(state, toMove);
  const oppThreats = cachedThreats(state, switchPlayer(toMove));

  // 1) 我方直接赢点（5+1）
  for (const t of myThreats) {
    if (!(t.isWinning && t.threatLevel === 0)) continue;
    if (stones === 1) {
      moves.push({ player: toMove, positions: [t.positions[0]] });
    } else {
      const sec = pickSmartSecond(state, toMove, t.positions[0]);
      moves.push({ player: toMove, positions: [t.positions[0], sec] });
    }
  }

  // 2) 必挡点：对方 5+1 或 4+2（defenseCost=1）
  const mustDefend: Position[] = [];
  for (const t of oppThreats) {
    if (t.threatLevel === 0 && t.isWinning) {
      mustDefend.push(...t.positions);
    } else if (t.threatLevel === 1 && (t.defenseCost ?? 2) <= 1) {
      mustDefend.push(...t.positions);
    }
  }
  const uniqueDef = [
    ...new Map(mustDefend.map(p => [posIdx(p.x, p.y), p])).values(),
  ];
  if (uniqueDef.length > 0) {
    if (stones === 1) {
      for (const p of uniqueDef) {
        moves.push({ player: toMove, positions: [p] });
      }
    } else {
      for (const p of uniqueDef) {
        const sec = pickSmartSecond(state, toMove, p);
        moves.push({ player: toMove, positions: [p, sec] });
      }
    }
  }

  const myReport = cachedAnalyzeThreats(state, toMove);
  const oppReport = cachedAnalyzeThreats(state, switchPlayer(toMove));
  const extraPoints = uniqueEmptyPoints(state, [
    ...collectKeyPointsByType(myReport, QUIET_EXTRA_TYPES),
    ...collectKeyPointsByType(oppReport, QUIET_EXTRA_TYPES),
  ]);
  const quietExtras = sortByCenter(extraPoints).slice(0, QUIET_EXTRA_MAX_POINTS);
  if (quietExtras.length > 0) {
    if (stones === 1) {
      for (const p of quietExtras) {
        moves.push({ player: toMove, positions: [p] });
      }
    } else {
      for (const p of quietExtras) {
        const sec = pickSmartSecond(state, toMove, p);
        moves.push({ player: toMove, positions: [p, sec] });
      }
    }
  }

  // 3) 补充少量 top-K RZOP 候选，避免遗漏主动手
  const rzopTopK = generateRZOPCandidates(state).slice(0, 8);
  if (rzopTopK.length > 0) {
    const rzopMoves = generateMoves(state, rzopTopK, toMove).slice(
      0,
      Math.min(8, MAX_CHILD_MOVE_COMBOS),
    );
    moves.push(...rzopMoves);
  }

  // 去重并限制数量，避免分支爆炸
  const seen = new Set<number>();
  const dedup: Move[] = [];
  for (const m of moves) {
    const k =
      m.positions.length === 1
        ? posIdx(m.positions[0].x, m.positions[0].y)
        : pairKey(m.positions[0], m.positions[1]);
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(m);
    if (dedup.length >= MAX_CHILD_MOVE_COMBOS) break;
  }

  for (const move of dedup) {
    const next = applyMoveWithWinner(state, move);
    const score = -quiescenceSearch(
      next,
      rootPlayer,
      switchPlayer(toMove),
      -beta,
      -alpha,
      weights,
      depth + 1,
      patternEval,
    );

    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

// ===== PVS 核心 =====
let lastSearchNodeCount = 0;
let lastSearchDepth = 0;
let currentSearchAborted = false;

export function getLastSearchStats() {
  return {
    nodes: lastSearchNodeCount,
    depth: lastSearchDepth,
    ttSize: getTTSize(),
  };
}

export function getLastAspirationWindows(): AspirationWindow[] {
  return getAspirationWindows();
}

function normalizeWindow(alpha: number, beta: number): { alpha: number; beta: number } {
  if (Number.isNaN(alpha) || Number.isNaN(beta) || alpha >= beta) {
    return { alpha: -Infinity, beta: Infinity };
  }
  return { alpha, beta };
}

function pvs(
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  alpha: number,
  beta: number,
  depth: number,
  weights: EvaluationWeights,
  deadline: number,
  isPV: boolean,
  extensionBudget: number,
  threatCache?: { self?: ThreatInfo[]; opp?: ThreatInfo[] },
  patternEval?: PatternEvaluator,
): number {
  const normalized = normalizeWindow(alpha, beta);
  alpha = normalized.alpha;
  beta = normalized.beta;
  lastSearchNodeCount++;

  if (currentSearchAborted) {
    return evaluateForToMove(
      state,
      rootPlayer,
      toMove,
      weights,
      undefined,
      patternEval,
    );
  }

  if (getCurrentTime() > deadline) {
    currentSearchAborted = true;
    return evaluateForToMove(
      state,
      rootPlayer,
      toMove,
      weights,
      undefined,
      patternEval,
    );
  }

  if (state.winner) {
    if (state.winner === 'DRAW') return 0;
    const base = state.winner === rootPlayer ? 1_000_000 : -1_000_000;
    const bonus = depth * 10_000;
    const rootScore = state.winner === rootPlayer ? base + bonus : base - bonus;
    return toMove === rootPlayer ? rootScore : -rootScore;
  }

  if (depth <= 0) {
    return quiescenceSearch(
      state,
      rootPlayer,
      toMove,
      alpha,
      beta,
      weights,
      0,
      patternEval,
    );
  }

  const ttEntry = probeTT(state, depth, alpha, beta);
  if (ttEntry) return ttEntry.score;

  const myThreats = threatCache?.self ?? cachedThreats(state, toMove);
  const oppThreats = threatCache?.opp ?? cachedThreats(state, switchPlayer(toMove));

  const candidates = collectThreatCandidates(
    state,
    toMove,
    MAX_CHILD_CANDIDATE_POINTS,
  );
  let moves = generateMoves(state, candidates, toMove);

  if (moves.length === 0) {
    const evalScore = evaluateForToMove(
      state,
      rootPlayer,
      toMove,
      weights,
      undefined,
      patternEval,
    );
    if (!currentSearchAborted) {
      storeTT(state, depth, evalScore, alpha, beta);
    }
    return evalScore;
  }
  if (moves.length > MAX_CHILD_MOVE_COMBOS) {
    moves = moves.slice(0, MAX_CHILD_MOVE_COMBOS);
  }

  const ordered = orderMoves(
    moves,
    state,
    rootPlayer,
    toMove,
    weights,
    depth,
    { self: myThreats, opp: oppThreats },
    false,
    patternEval,
    undefined,
  );

  let bestScore = -Infinity;
  let bestMove: Move | undefined;
  let localAlpha = alpha;

  const rawExtension =
    extensionBudget > 0
      ? computeLocalExtension(state, toMove, {
          self: myThreats,
          opp: oppThreats,
        })
      : 0;
  const localExtension = Math.min(extensionBudget, rawExtension);
  const nextExtensionBudget = Math.max(0, extensionBudget - localExtension);

  for (let i = 0; i < ordered.length; i++) {
    if (currentSearchAborted) break;
    const move = ordered[i];
    const next = applyMoveWithWinner(state, move);
    const opp = switchPlayer(toMove);
    const nextDepth = Math.max(0, depth - 1 + localExtension);
    const nextThreatCache = {
      self: cachedThreats(next, opp),
      opp: cachedThreats(next, toMove),
    };

    let score: number;
    if (i === 0) {
      score = -pvs(
        next,
        rootPlayer,
        opp,
        -beta,
        -localAlpha,
        nextDepth,
        weights,
        deadline,
        isPV,
        nextExtensionBudget,
        nextThreatCache,
        patternEval,
      );
    } else {
      // PVS 窄窗（zero-window）
      score = -pvs(
        next,
        rootPlayer,
        opp,
        -localAlpha - 1,
        -localAlpha,
        nextDepth,
        weights,
        deadline,
        false,
        nextExtensionBudget,
        nextThreatCache,
        patternEval,
      );
      if (score > localAlpha && score < beta) {
        score = -pvs(
          next,
          rootPlayer,
          opp,
          -beta,
          -localAlpha,
          nextDepth,
          weights,
          deadline,
          true,
          nextExtensionBudget,
          nextThreatCache,
          patternEval,
        );
      }
    }
    if (currentSearchAborted) break;

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }

    if (score > localAlpha) {
      localAlpha = score;
      if (!currentSearchAborted) {
        for (const p of move.positions) {
          updateHistory(toMove, p, depth);
        }
      }
    }

    if (localAlpha >= beta) {
      if (!currentSearchAborted) {
        addKillerMove(depth, move);
      }
      break;
    }
  }

  if (currentSearchAborted) {
    return evaluateForToMove(
      state,
      rootPlayer,
      toMove,
      weights,
      undefined,
      patternEval,
    );
  }

  if (bestMove) {
    storeTT(state, depth, bestScore, alpha, beta, bestMove);
  }

  if (!Number.isFinite(bestScore)) {
    return evaluateForToMove(
      state,
      rootPlayer,
      toMove,
      weights,
      undefined,
      patternEval,
    );
  }

  return bestScore;
}

// ===== 候选生成与排序 =====
function generateSingleStoneMoves(
  state: GameState,
  candidates: Position[],
  player: Player,
): Move[] {
  const seen = new Set<number>();
  const center = (state.board.length - 1) / 2;

  const filtered = candidates.filter(p => {
    if (state.board[p.y][p.x] !== 0) return false;
    const key = posIdx(p.x, p.y);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  filtered.sort((a, b) => {
    const da = Math.abs(a.x - center) + Math.abs(a.y - center);
    const db = Math.abs(b.x - center) + Math.abs(b.y - center);
    return da - db;
  });

  return filtered.map(p => ({ player, positions: [p] }));
}

function generateTwoStoneMoves(
  state: GameState,
  candidates: Position[],
  player: Player,
): Move[] {
  const moves: Move[] = [];
  const n = candidates.length;
  const maxCombos = Math.min((n * (n - 1)) / 2, 1000);
  const maxGenerated = Math.min(maxCombos, TWO_STONE_MAX_GENERATED);

  // 去重工具：同一对点只生成一次
  const seen = new Set<number>();
  const addMove = (p1: Position, p2: Position) => {
    // 不能是同一个点
  if (p1.x === p2.x && p1.y === p2.y) return;
    // 必须都是空位
  if (state.board[p1.y][p1.x] !== 0) return;
    if (state.board[p2.y][p2.x] !== 0) return;

    // 无序 key（保证 (a,b) 和 (b,a) 视为同一对）
    const aFirst =
      p1.x < p2.x || (p1.x === p2.x && p1.y <= p2.y) ? p1 : p2;
    const bFirst = aFirst === p1 ? p2 : p1;
    const key = pairKey(aFirst, bFirst);

    if (seen.has(key)) return;
    seen.add(key);

    if (moves.length < maxGenerated) {
      moves.push({ player, positions: [aFirst, bFirst] });
    }
  };

  // ---------- 1) 先处理强制攻防：VCDT 双点必杀 ----------
  const myReport = cachedAnalyzeThreats(state, player);
  const oppReport = cachedAnalyzeThreats(state, switchPlayer(player));
  const oppVal = player === 'BLACK' ? 2 : 1;
  const oppLive3Threats = collectOpenThreeThreats(state, oppVal);
  const oppLive3LineCount = countOpenThreeLines(oppLive3Threats);
  const hasOppUrgent =
    oppReport.winIn1.length > 0 ||
    oppReport.winIn2.length > 0 ||
    oppReport.byType.DOUBLE_FOUR.length > 0 ||
    oppReport.byType.FOUR_THREE.length > 0 ||
    oppReport.byType.DOUBLE_THREE.length > 0 ||
    oppReport.byType.LIVE4.length > 0 ||
    oppReport.byType.CHARGE4.length > 0;
  const singleOppLive3Pairs =
    !hasOppUrgent && oppLive3LineCount === 1
      ? new Set<number>(
          oppLive3Threats.map(t => pairKey(t.ends[0], t.ends[1])),
        )
      : null;
  const myWinPairKeys = new Set<number>(
    myReport.winPairs.map(([a, b]) => pairKey(a, b)),
  );

  const addWinPairs = (pairs: [Position, Position][]) => {
    for (const [p1, p2] of pairs) {
      if (moves.length >= maxGenerated) break;
      addMove(p1, p2);
    }
  };
  addWinPairs(oppReport.winPairs);
  addWinPairs(myReport.winPairs);
  if (moves.length >= maxGenerated) return moves;

  // ---------- 2) 顺序双落子 beam：先扩，再筛，最后收敛 ----------
  const BOARD_CENTER = (BOARD_SIZE - 1) / 2;
  const lastPositions = state.lastMove?.positions ?? [];
  const lastDist = (p: Position): number => {
    if (lastPositions.length === 0) return Infinity;
    let best = Infinity;
    for (const q of lastPositions) {
      const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (d < best) best = d;
    }
    return best;
  };

  const toSet = (points: Position[]): Set<number> =>
    new Set<number>(points.map(p => posIdx(p.x, p.y)));
  const myWin1 = toSet(myReport.winningPoints);
  const oppWin1 = toSet(oppReport.winningPoints);
  const myAttack = toSet(myReport.attackPoints);
  const oppDefense = toSet(oppReport.defensePoints);
  const myCandidate = toSet(myReport.candidatePoints);
  const oppCandidate = toSet(oppReport.candidatePoints);
  const rzop = toSet(generateRZOPCandidates(state));
  const myWinPairKeySet = new Set<number>(myReport.winPairs.map(([a, b]) => pairKey(a, b)));
  const oppWinPairKeySet = new Set<number>(oppReport.winPairs.map(([a, b]) => pairKey(a, b)));

  const endpointWeight = (key: number): number => {
    let score = 0;
    if (oppWin1.has(key)) score += 260_000;
    if (myWin1.has(key)) score += 240_000;
    if (oppDefense.has(key)) score += 72_000;
    if (myAttack.has(key)) score += 54_000;
    if (myCandidate.has(key)) score += 16_000;
    if (oppCandidate.has(key)) score += 12_000;
    if (rzop.has(key)) score += 8_000;
    return score;
  };

  const dedup = new Set<number>();
  const scored = candidates
    .filter(p => state.board[p.y]?.[p.x] === 0)
    .filter(p => {
      const key = posIdx(p.x, p.y);
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    })
    .map((p, order) => {
      const key = posIdx(p.x, p.y);
      const centerDist = Math.abs(p.x - BOARD_CENTER) + Math.abs(p.y - BOARD_CENTER);
      const proximity = lastDist(p);
      const deadPenalty = isDeadLineCell(state, p) ? 35_000 : 0;
      const history = getHistoryScore(player, p);
      const score =
        endpointWeight(key) +
        history * 0.25 +
        Math.max(0, 10 - centerDist) * 950 +
        (Number.isFinite(proximity) ? Math.max(0, 7 - proximity) * 850 : 0) -
        deadPenalty;
      return { p, key, score, centerDist, order };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.centerDist !== b.centerDist) return a.centerDist - b.centerDist;
      return a.order - b.order;
    });

  const firstPoolSize = Math.min(scored.length, Math.max(TWO_STONE_FIRST_POOL, TWO_STONE_FIRST_BEAM));
  const firstBeamSize = Math.min(firstPoolSize, TWO_STONE_FIRST_BEAM);
  for (let i = 0; i < firstBeamSize && moves.length < maxGenerated; i += 1) {
    const first = scored[i];
    const rankedSecond = scored
      .filter(item => item.key !== first.key)
      .map(item => {
        const dist = Math.abs(item.p.x - first.p.x) + Math.abs(item.p.y - first.p.y);
        const key = pairKey(first.p, item.p);
        const tacticalBonus =
          (oppWinPairKeySet.has(key) ? 140_000 : 0) +
          (myWinPairKeySet.has(key) ? 125_000 : 0);
        const shapeBonus =
          dist <= 2 ? 7_000 : dist <= 5 ? 4_000 : dist >= 10 ? -2_500 : 0;
        const doubleBlockSingleLive3Penalty =
          singleOppLive3Pairs &&
          singleOppLive3Pairs.has(key) &&
          !myWinPairKeys.has(key) &&
          candidates.length > 2
            ? SINGLE_LIVE3_DOUBLE_BLOCK_PENALTY
            : 0;
        const pairScore =
          first.score +
          item.score +
          tacticalBonus +
          shapeBonus -
          doubleBlockSingleLive3Penalty;
        return { item, pairScore };
      })
      .sort((a, b) => b.pairScore - a.pairScore);

    let usedSecond = 0;
    for (const { item } of rankedSecond) {
      addMove(first.p, item.p);
      if (moves.length >= maxGenerated) break;
      usedSecond += 1;
      if (usedSecond >= TWO_STONE_SECOND_BEAM) break;
    }
  }

  // 保留一层通用兜底，避免极端局面候选不足
  if (moves.length < Math.min(maxGenerated, 24)) {
    const pri = scored.slice(0, Math.min(24, scored.length)).map(s => s.p);
    for (let i = 0; i < pri.length && moves.length < maxGenerated; i += 1) {
      for (let j = i + 1; j < pri.length && moves.length < maxGenerated; j += 1) {
        addMove(pri[i], pri[j]);
      }
    }
  }

  return moves;
}

function generateMoves(
  state: GameState,
  candidates: Position[],
  player: Player,
): Move[] {
  const stones = getStonesToPlace(state.moveNumber, player);
  const rzopPoints = generateRZOPCandidates(state);
  const base = mergeCandidatePoints(rzopPoints, candidates);
  const filtered = base.filter(p => {
    if (state.board[p.y]?.[p.x] !== 0) return false;
    if (isDeadLineCell(state, p)) return false;
    return true;
  });
  const topK = Math.min(
    filtered.length,
    stones === 1 ? SINGLE_STONE_CANDIDATE_LIMIT : TWO_STONE_CANDIDATE_LIMIT,
  );
  const limited = filtered.slice(0, topK);

  if (stones === 1) {
    return generateSingleStoneMoves(state, limited, player);
  }
  return generateTwoStoneMoves(state, limited, player);
}

function collectThreatCandidates(
  state: GameState,
  player: Player,
  maxPoints: number,
): Position[] {
  const stones = getStonesToPlace(state.moveNumber, player);
  const myReport = cachedAnalyzeThreats(state, player);
  const oppReport = cachedAnalyzeThreats(state, switchPlayer(player));

  const center = (state.board.length - 1) / 2;
  const occupied: Position[] = [];
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) occupied.push({ x, y });
    }
  }
  const minDistToOccupied = (p: Position): number => {
    if (occupied.length === 0) return Infinity;
    let best = Infinity;
    for (const q of occupied) {
      const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (d < best) best = d;
    }
    return best;
  };
  const lastPositions = state.lastMove?.positions ?? [];
  const lastDist = (p: Position): number => {
    if (lastPositions.length === 0) return Infinity;
    let best = Infinity;
    for (const q of lastPositions) {
      const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (d < best) best = d;
    }
    return best;
  };

  type CandidateScore = {
    p: Position;
    priority: number;
    history: number;
    last: number;
    center: number;
    order: number;
  };

  const candidates = new Map<number, CandidateScore>();
  let orderSeq = 0;

  const addPoint = (p: Position, priority: number, allowDead = false) => {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) return;
    if (!allowDead && isDeadLineCell(state, p)) return;
    const key = posIdx(p.x, p.y);
    const entry: CandidateScore = {
      p,
      priority,
      history: getHistoryScore(player, p),
      last: lastDist(p),
      center: Math.abs(p.x - center) + Math.abs(p.y - center),
      order: orderSeq++,
    };
    const prev = candidates.get(key);
    if (
      !prev ||
      priority > prev.priority ||
      (priority === prev.priority && entry.history > prev.history)
    ) {
      candidates.set(key, entry);
    }
  };

  const addList = (points: Position[], priority: number, allowDead = false) => {
    for (const p of points) {
      addPoint(p, priority, allowDead);
    }
  };

  const addPairs = (
    pairs: [Position, Position][],
    priority: number,
    allowDead = false,
  ) => {
    for (const [a, b] of pairs) {
      addPoint(a, priority, allowDead);
      addPoint(b, priority, allowDead);
    }
  };

  const PRIORITY = {
    oppWin: 1000,
    oppWinPair: 960,
    myWinPair: 940,
    oppInitiative: 900,
    oppLive3: 880,
    myWin: 980,
    oppDefense: 830,
    myLive3: 800,
    myInitiative: 780,
    myAttack: 740,
    myCandidate: 620,
    oppCandidate: 600,
    rzop: 520,
  };

  const finalize = (): Position[] => {
    const entries = [...candidates.values()];
    let filtered = entries;
    if (occupied.length > 0) {
      filtered = entries.filter(entry => {
        if (entry.priority > PRIORITY.myCandidate) return true;
        return minDistToOccupied(entry.p) <= LOCALITY_MAX_DIST;
      });
      if (filtered.length === 0) filtered = entries;
    }
    const sorted = filtered.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (b.history !== a.history) return b.history - a.history;
      if (a.last !== b.last) return a.last - b.last;
      if (a.center !== b.center) return a.center - b.center;
      return a.order - b.order;
    });
    return sorted.slice(0, maxPoints).map(item => item.p);
  };

  addList(oppReport.winningPoints, PRIORITY.oppWin, true);
  addPairs(oppReport.winPairs, PRIORITY.oppWinPair, true);
  if (candidates.size >= maxPoints) {
    return finalize();
  }

  if (stones >= 2) {
    addPairs(myReport.winPairs, PRIORITY.myWinPair, true);
  }

  const oppInitiative = collectKeyPointsByType(oppReport, OPP_INITIATIVE_TYPES);
  addList(oppInitiative, PRIORITY.oppInitiative, true);
  const oppLive3 = collectOpenThreeEnds(state, oppReport);
  addList(oppLive3, PRIORITY.oppLive3, true);

  addList(myReport.winningPoints, PRIORITY.myWin, true);
  addList(oppReport.defensePoints, PRIORITY.oppDefense, true);

  const myLive3 = collectOpenThreeEnds(state, myReport);
  addList(myLive3, PRIORITY.myLive3, false);
  const initiative = collectKeyPointsByType(myReport, [
    'DOUBLE_FOUR',
    'FOUR_THREE',
    'DOUBLE_THREE',
    'LIVE4',
    'CHARGE4',
    'LIVE3',
  ]);
  addList(initiative, PRIORITY.myInitiative, true);

  addList(myReport.attackPoints, PRIORITY.myAttack, true);
  addList(myReport.candidatePoints, PRIORITY.myCandidate, false);
  addList(oppReport.candidatePoints, PRIORITY.oppCandidate, false);

  const rzop = generateRZOPCandidates(state);
  addList(rzop, PRIORITY.rzop, false);

  return finalize();
}

function findFallbackMove(
  state: GameState,
  player: Player,
): Move {
  const required = getStonesToPlace(state.moveNumber, player);
  const picks: Position[] = [];
  const seen = new Set<number>();

  for (let y = 0; y < state.board.length && picks.length < required; y++) {
    for (
      let x = 0;
      x < state.board[y].length && picks.length < required;
      x++
    ) {
      if (state.board[y][x] !== 0) continue;
      const p = { x, y };
      if (isDeadLineCell(state, p)) continue;
      const key = posIdx(x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(p);
    }
  }

  for (let y = 0; y < state.board.length && picks.length < required; y++) {
    for (
      let x = 0;
      x < state.board[y].length && picks.length < required;
      x++
    ) {
      if (state.board[y][x] !== 0) continue;
      const key = posIdx(x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ x, y });
    }
  }

  return { player, positions: picks.slice(0, required) };
}

function scoreMoveForOrdering(
  move: Move,
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  weights: EvaluationWeights,
  depth: number,
  preMyThreats: ThreatInfo[],
  preOppThreats: ThreatInfo[],
  isRoot: boolean,
  patternEval?: PatternEvaluator,
  tacticalHints?: Set<string>,
  baseEval?: number | null,
): number {
  const preMy = preMyThreats;
  const preOpp = preOppThreats;

  const historyScore = move.positions.reduce(
    (s, p) => s + getHistoryScore(toMove, p),
    0,
  );

  const killers = getKillerMoves(depth);
  const isKiller = killers.some(k => sameMove(k, move));
  const killerBonus = isKiller ? 80_000 : 0;
  const tacticalBonus =
    isRoot && tacticalHints && tacticalHints.has(moveKey(move))
      ? TACTICAL_HINT_BONUS
      : 0;
  const lastPositions = state.lastMove?.positions ?? [];
  let localityScore = 0;
  if (lastPositions.length > 0) {
    for (const p of move.positions) {
      let best = Infinity;
      for (const q of lastPositions) {
        const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
        if (d < best) best = d;
      }
      if (best <= LOCALITY_MAX_DIST) {
        localityScore +=
          (LOCALITY_MAX_DIST - best + 1) * LOCALITY_BONUS_PER_STEP;
      }
    }
  }

  const useHeavyOrdering = isRoot;
  let evalScore = 0;
  let threatScore = 0;
  let vcstScore = 0;
  let initiativeScore = 0;
  let neutralPenalty = 0;
  let foresightPenalty = 0;
  let postMyThreats: ThreatInfo[] | null = null;
  let postOppThreats: ThreatInfo[] | null = null;
  const countCritical = (list: ThreatInfo[]) =>
    list.filter(t => t.threatLevel <= 2).length;
  const countKeyShape = (list: ThreatInfo[]) =>
    list.filter(
      t =>
        t.kind === 'DOUBLE_FOUR' ||
        t.kind === 'FOUR_THREE' ||
        t.kind === 'DOUBLE_THREE',
    ).length;
  const countLive3 = (list: ThreatInfo[]) =>
    list.filter(t => t.kind === 'LIVE3').length;
  const preMyCritical = countCritical(preMy);
  const preOppCritical = countCritical(preOpp);
  const preMyKey = countKeyShape(preMy);
  const preOppKey = countKeyShape(preOpp);
  const preMyLive3 = countLive3(preMy);
  let postMyCritical = 0;
  let postOppCritical = 0;
  let postMyKey = 0;
  let postOppKey = 0;
  let live3Delta = 0;

  if (useHeavyOrdering) {
    const nextState = applyMoveWithWinner(state, move);
    evalScore = evaluateWithThreatReport(
      nextState,
      rootPlayer,
      weights,
      undefined,
      patternEval,
    );

    const myThreats = cachedThreats(nextState, toMove);
    const oppThreats = cachedThreats(nextState, switchPlayer(toMove));
    postMyThreats = myThreats;
    postOppThreats = oppThreats;
    postMyCritical = countCritical(myThreats);
    postOppCritical = countCritical(oppThreats);
    postMyKey = countKeyShape(myThreats);
    postOppKey = countKeyShape(oppThreats);
    const postMyLive3 = countLive3(myThreats);
    live3Delta = Math.max(0, postMyLive3 - preMyLive3);

    if (postMyCritical > preMyCritical) {
      initiativeScore += (postMyCritical - preMyCritical) * 22_000;
    }
    if (postOppCritical > preOppCritical) {
      initiativeScore -= (postOppCritical - preOppCritical) * 30_000;
    }
    if (postMyKey > preMyKey) {
      initiativeScore += (postMyKey - preMyKey) * 28_000;
    }
    if (postOppKey > preOppKey) {
      initiativeScore -= (postOppKey - preOppKey) * 36_000;
    }
    if (live3Delta > 0) {
      initiativeScore += Math.min(2, live3Delta) * 8_000;
    }

    const costInv = (t: ThreatInfo) => 1 / Math.max(1, t.defenseCost ?? 1);
    const kindWeight = (t: ThreatInfo) => {
      switch (t.kind) {
        case 'WIN_IN_1':
          return 120_000;
        case 'LIVE5':
          return 120_000;
        case 'CHARGE5':
          return 72_000;
        case 'DEAD5':
          return 0;
        case 'WIN_IN_2':
        case 'LIVE4':
          return 85_000;
        case 'CHARGE4':
          return 51_000;
        case 'DEAD4':
          return 0;
        case 'DOUBLE_FOUR':
          return 110_000;
        case 'FOUR_THREE':
          return 100_000;
        case 'DOUBLE_THREE':
          return 65_000;
        case 'LIVE3':
          return 20_000;
        case 'SLEEP3':
          return 8_000;
        default:
          return 10_000;
      }
    };

    const strength = (ts: ThreatInfo[]) => {
      let sum = 0;
      let winOrDouble = 0;
      let critCount = 0;
      for (const t of ts) {
        const w = kindWeight(t) * costInv(t);
        sum += w;
        if (t.isWinning) winOrDouble++;
        if (!t.isWinning && t.threatLevel === 2) critCount++;
      }
      const synergy =
        (winOrDouble >= 2 ? 40_000 : 0) +
        (critCount >= 2 ? 15_000 : 0);
      return sum + synergy;
    };

    const myStrength = strength(myThreats);
    const oppStrength = strength(oppThreats);
    threatScore += myStrength - oppStrength;

    const myWinning = myThreats.filter(t => t.isWinning && t.threatLevel === 0).length;
    const myDouble = myThreats.filter(t => t.isWinning && t.threatLevel === 1).length;
    const myCritical = myThreats.filter(t => !t.isWinning && t.threatLevel === 2).length;

    const preOppImmediate = preOpp.filter(
      t => t.isWinning && t.threatLevel <= 1,
    ).length;
    const postOppImmediate = oppThreats.filter(
      t => t.isWinning && t.threatLevel <= 1,
    ).length;
    const blockedCritical = Math.max(0, preOppImmediate - postOppImmediate);
    const createdPressure =
      myWinning + myDouble + myCritical + Math.min(2, live3Delta) * 0.5;
    vcstScore =
      blockedCritical > 0 && createdPressure > 0
        ? blockedCritical * 90_000 + createdPressure * 15_000
        : 0;
  }

  let coverageScore = 0;
  const distinctThreatHits = new Set<string>();
  const threatHitCount = new Map<string, number>();
  for (const p of move.positions) {
    for (const t of preOpp) {
      const hit = t.positions.some(pos => pos.x === p.x && pos.y === p.y);
      if (!hit) continue;
      const key = `opp_${t.threatLevel}_${t.isWinning}_${t.positions
        .map(pos => `${pos.x},${pos.y}`)
        .join('|')}`;
      distinctThreatHits.add(`opp_${t.threatLevel}_${t.isWinning}`);
      threatHitCount.set(key, (threatHitCount.get(key) ?? 0) + 1);
      if (t.isWinning && t.threatLevel === 0) coverageScore += 120_000;
      else if (t.isWinning && t.threatLevel === 1) coverageScore += 90_000;
      else if (!t.isWinning && t.threatLevel === 2) coverageScore += 60_000;
    }
    for (const t of preMy) {
      const hit = t.positions.some(pos => pos.x === p.x && pos.y === p.y);
      if (!hit) continue;
      const key = `me_${t.threatLevel}_${t.isWinning}_${t.positions
        .map(pos => `${pos.x},${pos.y}`)
        .join('|')}`;
      distinctThreatHits.add(`me_${t.threatLevel}_${t.isWinning}`);
      threatHitCount.set(key, (threatHitCount.get(key) ?? 0) + 1);
      if (t.isWinning && t.threatLevel === 0) coverageScore += 100_000;
      else if (t.isWinning && t.threatLevel === 1) coverageScore += 70_000;
      else if (!t.isWinning && t.threatLevel === 2) coverageScore += 45_000;
    }
  }

  if (useHeavyOrdering && postMyThreats && postOppThreats) {
    const created = postMyCritical > preMyCritical;
    const blocked = postOppCritical < preOppCritical;
    const hasPressure = preMyCritical + preOppCritical > 0;
    if (!created && !blocked && coverageScore === 0 && vcstScore === 0 && hasPressure) {
      neutralPenalty = -28_000;
    }
  }

  let spacingScore = 0;
  if (move.positions.length === 2) {
    const [a, b] = move.positions;
    const dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (dist <= 1) spacingScore -= 20_000;
    else if (dist === 2) spacingScore -= 6_000;
    else spacingScore += Math.min(dist, 6) * 800;

    if (distinctThreatHits.size >= 2) {
      spacingScore += 25_000;
    }
    if ([...threatHitCount.values()].some(c => c >= 2)) {
      spacingScore -= 40_000;
    }
    if ((a.x === b.x || a.y === b.y) && dist <= 2) {
      spacingScore -= 20_000;
    }
  }

  let overDefendPenalty = 0;
  if (move.positions.length === 2) {
    const oppHasHardThreat = preOpp.some(t => t.threatLevel <= 2);
    if (!oppHasHardThreat) {
      for (const t of preOpp) {
        if (t.kind !== 'LIVE3' && t.kind !== 'SLEEP3') continue;
        let hits = 0;
        for (const p of move.positions) {
          if (t.positions.some(pos => pos.x === p.x && pos.y === p.y)) hits += 1;
        }
        if (hits >= 2) {
          overDefendPenalty -= 55_000;
        }
      }

      const oppVal = toMove === 'BLACK' ? 2 : 1;
      const openThreeLines = collectOpenThreeLineInfo(state, oppVal);
      if (openThreeLines.size > 0) {
        const [a, b] = move.positions;
        const aKey = posIdx(a.x, a.y);
        const bKey = posIdx(b.x, b.y);
        for (const entry of openThreeLines.values()) {
          if (!entry.ends.has(aKey) || !entry.ends.has(bKey)) continue;
          const penalty =
            openThreeLines.size >= 2 || entry.threatCount >= 2 ? 25_000 : 55_000;
          overDefendPenalty -= penalty;
          break;
        }
      }
    }
  }

  if (useHeavyOrdering && typeof baseEval === 'number') {
    const drop = baseEval - evalScore;
    const createsThreat =
      postMyCritical > preMyCritical || postMyKey > preMyKey || live3Delta > 0;
    const hasTacticalImpact = coverageScore > 0 || vcstScore > 0 || createsThreat;
    if (drop > 45_000 && !hasTacticalImpact) {
      foresightPenalty -= Math.min(90_000, drop * 0.6);
    }
  }
  if (useHeavyOrdering && postOppCritical > preOppCritical && coverageScore === 0) {
    foresightPenalty -= (postOppCritical - preOppCritical) * 35_000;
  }

  let deadLinePenalty = 0;
  if (useHeavyOrdering) {
    for (const p of move.positions) {
      if (isDeadLineCell(state, p)) deadLinePenalty -= 6_000;
    }
  }

  return (
    evalScore +
    threatScore * 0.3 +
    historyScore * 0.1 +
    killerBonus +
    tacticalBonus +
    localityScore +
    vcstScore +
    initiativeScore +
    coverageScore +
    spacingScore +
    overDefendPenalty +
    foresightPenalty +
    deadLinePenalty +
    neutralPenalty
  );
}
function moveKey(move: Move): string {
  return move.positions
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
}

function sameMove(a: Move, b: Move): boolean {
  if (a.positions.length !== b.positions.length) return false;
  return moveKey(a) === moveKey(b);
}

function prependUniqueMoves(base: Move[], prepends: Move[]): Move[] {
  if (prepends.length === 0 || base.length === 0) {
    return prepends.length === 0 ? base : [...prepends, ...base];
  }
  const existing = new Set(base.map(moveKey));
  const unique: Move[] = [];
  for (const move of prepends) {
    const key = moveKey(move);
    if (existing.has(key)) continue;
    existing.add(key);
    unique.push(move);
  }
  if (unique.length === 0) return base;
  return [...unique, ...base];
}

function addKillerMove(depth: number, move: Move): void {
  addKillerMoveStore(depth, move, sameMove);
}

function orderMoves(
  moves: Move[],
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  weights: EvaluationWeights,
  depth: number,
  preThreatCache?: { self?: ThreatInfo[]; opp?: ThreatInfo[] },
  isRoot = false,
  patternEval?: PatternEvaluator,
  tacticalHints?: Set<string>,
): Move[] {
  const required = getStonesToPlace(state.moveNumber, toMove);
  const valid = moves.filter(m => m.positions.length === required);
  const ttBest = getTTBestMove(hashState(state));

  const preMy = preThreatCache?.self ?? cachedThreats(state, toMove);
  const preOpp =
    preThreatCache?.opp ?? cachedThreats(state, switchPlayer(toMove));

  const baseEval = isRoot
    ? evaluateWithThreatReport(state, rootPlayer, weights, undefined, patternEval)
    : null;
  const scored = valid.map(m => ({
    move: m,
    orderScore: scoreMoveForOrdering(
      m,
      state,
      rootPlayer,
      toMove,
      weights,
      depth,
      preMy,
      preOpp,
      isRoot,
      patternEval,
      tacticalHints,
      baseEval,
    ),
    ttBonus: ttBest && sameMove(m, ttBest) ? 300_000 : 0,
  }));

  scored.sort((a, b) => b.orderScore + b.ttBonus - (a.orderScore + a.ttBonus));
  return scored.map(s => s.move);
}

// ===== VCDT 根节点决策 =====

// 针对“对手一手两子必杀（threatLevel=1）”的专门防守：
// 尽量找一个点，能同时破掉所有必杀对；
// 如果只有一个 pair（两个点），就直接两头都堵。

// 第二颗子优先做聪明补强：覆盖对方威胁 > 己方威胁 > 距离/中心
function pickSmartSecond(
  state: GameState,
  player: Player,
  primary: Position,
  avoid?: Set<number>,
): Position {
  const opp = switchPlayer(player);
  const myThreats = cachedThreats(state, player);
  const oppThreats = cachedThreats(state, opp);
  const oppVal = opp === 'BLACK' ? 1 : 2;
  const primaryHitsSingleBlock = oppThreats.some(
    t =>
      (t.defenseCost ?? 2) <= 1 &&
      t.positions.some(p => p.x === primary.x && p.y === primary.y),
  );
  const primaryLines = primaryHitsSingleBlock
    ? getLinesForCell(primary)
    : [];
  const dangerLineIds = new Set<number>();
  if (primaryHitsSingleBlock) {
    for (const line of primaryLines) {
      let run = 0;
      let maxRun = 0;
      for (const c of line.cells) {
        const v = state.board[c.y][c.x];
        if (v === oppVal) {
          run += 1;
          if (run > maxRun) maxRun = run;
        } else {
          run = 0;
        }
      }
      if (maxRun >= 4) dangerLineIds.add(line.id);
    }
  }

  const avoidSet = new Set<number>(avoid ?? []);
  avoidSet.add(posIdx(primary.x, primary.y));
  const candidates = generateRZOPCandidates(state).filter(p => {
    if (p.x === primary.x && p.y === primary.y) return false;
    return !avoidSet.has(posIdx(p.x, p.y));
  });
  if (candidates.length === 0) return primary;

  let pool = candidates;
  if (primaryHitsSingleBlock && dangerLineIds.size > 0) {
    const safe = candidates.filter(c => {
      const lines = getLinesForCell(c);
      return lines.every(line => !dangerLineIds.has(line.id));
    });
    if (safe.length > 0) {
      pool = safe;
    }
  }

  const center = (state.board.length - 1) / 2;
  const centerScore = (p: Position) =>
    -Math.abs(p.x - center) - Math.abs(p.y - center);

  const threatScore = (p: Position) => {
    let s = 0;
    for (const t of oppThreats) {
      const hit = t.positions.some(pos => pos.x === p.x && pos.y === p.y);
      if (!hit) continue;
      if (t.isWinning && t.threatLevel === 0) s += 150_000;
      else if (t.isWinning && t.threatLevel === 1) s += 110_000;
      else if (!t.isWinning && t.threatLevel === 2) s += 70_000;
    }
    for (const t of myThreats) {
      const hit = t.positions.some(pos => pos.x === p.x && pos.y === p.y);
      if (!hit) continue;
      if (t.isWinning && t.threatLevel === 0) s += 90_000;
      else if (t.isWinning && t.threatLevel === 1) s += 65_000;
      else if (!t.isWinning && t.threatLevel === 2) s += 40_000;
    }
    return s;
  };

  const distBonus = (p: Position) => {
    const dist = Math.abs(p.x - primary.x) + Math.abs(p.y - primary.y);
    let bonus = 0;
    if (dist <= 1) bonus -= 40_000;
    else if (dist === 2) bonus -= 15_000;
    else bonus += Math.min(dist, 6) * 1_500;
    return bonus;
  };

  let best = pool[0];
  let bestScore = -Infinity;
  for (const c of pool) {
    if (avoidSet.has(posIdx(c.x, c.y))) continue;
    let linePenalty = 0;
    if (primaryHitsSingleBlock && dangerLineIds.size > 0) {
      for (const line of primaryLines) {
        if (!dangerLineIds.has(line.id)) continue;
        if (line.cells.some(p => p.x === c.x && p.y === c.y)) {
          linePenalty -= 25_000;
          break;
        }
      }
    }
    const deadPenalty = isDeadLineCell(state, c) ? -25_000 : 0;
    const s =
      threatScore(c) +
      distBonus(c) +
      centerScore(c) * 800 +
      deadPenalty +
      linePenalty;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}


function pickSecondFromThreatReport(
  state: GameState,
  report: ThreatReport,
  avoid: Set<number>,
): Position {
  const pools = [
    report.defensePoints,
    report.attackPoints,
    report.candidatePoints,
    generateRZOPCandidates(state),
  ];

  for (const pool of pools) {
    const filtered = uniqueEmptyPoints(state, pool, avoid);
    if (filtered.length === 0) continue;
    const ordered = sortByCenter(filtered);
    const nonDead = ordered.filter(p => !isDeadLineCell(state, p));
    if (nonDead.length > 0) return nonDead[0];
    return ordered[0];
  }

  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) continue;
      const key = posIdx(x, y);
      if (avoid.has(key)) continue;
      const p = { x, y };
      if (!isDeadLineCell(state, p)) return p;
    }
  }

  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) continue;
      const key = posIdx(x, y);
      if (!avoid.has(key)) return { x, y };
    }
  }

  return { x: 0, y: 0 };
}
function pickBestWin2Pair(
  state: GameState,
  pairs: [Position, Position][],
): [Position, Position] | null {
  const center = (BOARD_SIZE - 1) / 2;
  let best: [Position, Position] | null = null;
  let bestScore = Infinity;
  for (const [a, b] of pairs) {
    if (state.board[a.y][a.x] !== 0 || state.board[b.y][b.x] !== 0) continue;
    const score =
      Math.abs(a.x - center) +
      Math.abs(a.y - center) +
      Math.abs(b.x - center) +
      Math.abs(b.y - center);
    if (score < bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

function hasOpponentInitiative(state: GameState, report: ThreatReport): boolean {
  return (
    report.winIn1.length > 0 ||
    report.winIn2.length > 0 ||
    report.byType.DOUBLE_FOUR.length > 0 ||
    report.byType.FOUR_THREE.length > 0 ||
    report.byType.LIVE4.length > 0 ||
    report.byType.CHARGE4.length > 0 ||
    hasStrictDoubleLive3(state, report)
  );
}

function pickDefensiveRootMoveAgainstInitiative(
  state: GameState,
  rootPlayer: Player,
  merged: ThreatReport,
  oppReport: ThreatReport,
): Move | null {
  if (!hasOpponentInitiative(state, oppReport)) return null;

  const stones = getStonesToPlace(state.moveNumber, rootPlayer);
  const oppVal = rootPlayer === 'BLACK' ? 2 : 1;
  const oppLive3Threats = collectOpenThreeThreats(state, oppVal);
  const oppLive3LineCount = countOpenThreeLines(oppLive3Threats);
  const hasOppHardThreat =
    oppReport.winIn1.length > 0 ||
    oppReport.winIn2.length > 0 ||
    oppReport.byType.DOUBLE_FOUR.length > 0 ||
    oppReport.byType.FOUR_THREE.length > 0 ||
    oppReport.byType.LIVE4.length > 0 ||
    oppReport.byType.CHARGE4.length > 0;

  if (stones === 2 && oppLive3LineCount >= 2 && !hasOppHardThreat) {
    const lineMap = new Map<number, { lineId: number; threatCount: number; ends: Map<number, Position> }>();
    for (const threat of oppLive3Threats) {
      let entry = lineMap.get(threat.lineId);
      if (!entry) {
        entry = {
          lineId: threat.lineId,
          threatCount: 0,
          ends: new Map<number, Position>(),
        };
        lineMap.set(threat.lineId, entry);
      }
      entry.threatCount += 1;
      for (const p of threat.ends) {
        entry.ends.set(posIdx(p.x, p.y), p);
      }
    }

    const lineEntries = [...lineMap.values()]
      .map(entry => ({
        lineId: entry.lineId,
        threatCount: entry.threatCount,
        ends: [...entry.ends.values()].filter(p => state.board[p.y]?.[p.x] === 0),
      }))
      .filter(entry => entry.ends.length > 0);

    if (lineEntries.length >= 2) {
      const center = (BOARD_SIZE - 1) / 2;
      let bestPair: [Position, Position] | null = null;
      let bestLineScore = -1;
      let bestDist = Infinity;
      for (let i = 0; i < lineEntries.length; i++) {
        for (let j = i + 1; j < lineEntries.length; j++) {
          const lineA = lineEntries[i];
          const lineB = lineEntries[j];
          const lineScore = lineA.threatCount + lineB.threatCount;
          for (const a of lineA.ends) {
            for (const b of lineB.ends) {
              if (posIdx(a.x, a.y) === posIdx(b.x, b.y)) continue;
              const dist =
                Math.abs(a.x - center) +
                Math.abs(a.y - center) +
                Math.abs(b.x - center) +
                Math.abs(b.y - center);
              if (lineScore > bestLineScore || (lineScore === bestLineScore && dist < bestDist)) {
                bestLineScore = lineScore;
                bestDist = dist;
                bestPair = [a, b];
              }
            }
          }
        }
      }
      if (bestPair) {
        return { player: rootPlayer, positions: [bestPair[0], bestPair[1]] };
      }
    }
  }

  const scored = collectInitiativeBlockPoints(state, oppReport).filter(
    item => state.board[item.p.y]?.[item.p.x] === 0,
  );
  if (scored.length === 0) return null;

  const nonDead = scored.filter(item => !isDeadLineCell(state, item.p));
  const pool = nonDead.length > 0 ? nonDead : scored;
  const primary = pool[0].p;
  const primaryKey = posIdx(primary.x, primary.y);
  const singleLive3Ends = new Set<number>();
  if (
    stones === 2 &&
    oppLive3LineCount === 1 &&
    oppReport.winIn1.length === 0 &&
    oppReport.winIn2.length === 0
  ) {
    for (const threat of oppLive3Threats) {
      for (const end of threat.ends) {
        if (state.board[end.y]?.[end.x] !== 0) continue;
        singleLive3Ends.add(posIdx(end.x, end.y));
      }
    }
  }

  if (stones === 1) {
    return { player: rootPlayer, positions: [primary] };
  }

  let second: Position | null = null;
  const primaryHitsSingleLive3End = singleLive3Ends.has(primaryKey);
  if (primaryHitsSingleLive3End) {
    const avoid = new Set<number>(singleLive3Ends);
    avoid.delete(primaryKey);
    const smart = pickSmartSecond(state, rootPlayer, primary, avoid);
    const smartKey = posIdx(smart.x, smart.y);
    if (
      smartKey !== primaryKey &&
      state.board[smart.y]?.[smart.x] === 0 &&
      !singleLive3Ends.has(smartKey)
    ) {
      second = smart;
    }
  }

  for (const item of pool) {
    const p = item.p;
    if (p.x === primary.x && p.y === primary.y) continue;
    if (state.board[p.y]?.[p.x] !== 0) continue;
    if (
      primaryHitsSingleLive3End &&
      singleLive3Ends.has(posIdx(p.x, p.y))
    ) {
      continue;
    }
    second = p;
    break;
  }

  if (!second) {
    const avoid = new Set<number>([primaryKey]);
    if (primaryHitsSingleLive3End) {
      for (const key of singleLive3Ends) {
        if (key === primaryKey) continue;
        avoid.add(key);
      }
    }
    second = pickSecondFromThreatReport(state, merged, avoid);
  }

  return { player: rootPlayer, positions: [primary, second] };
}

function pickCalmDoubleLive3BuildMove(
  state: GameState,
  rootPlayer: Player,
  myReport: ThreatReport,
  oppReport: ThreatReport,
): Move | null {
  if (
    myReport.winIn1.length > 0 ||
    myReport.winIn2.length > 0 ||
    oppReport.winIn1.length > 0 ||
    oppReport.winIn2.length > 0
  ) {
    return null;
  }
  if (hasStrictDoubleLive3(state, oppReport)) return null;

  const stones = getStonesToPlace(state.moveNumber, rootPlayer);
  const candidates = generateRZOPCandidates(state)
    .filter(p => !isDeadLineCell(state, p))
    .slice(0, 16);
  if (candidates.length === 0) return null;

  const myVal = rootPlayer === 'BLACK' ? 1 : 2;
  const baseThreats = countOpenThreeLines(
    collectOpenThreeThreats(state, myVal),
  );
  const center = (BOARD_SIZE - 1) / 2;
  let bestMove: Move | null = null;
  let bestCount = -1;
  let bestPairDist = -1;
  let bestDist = Infinity;

  const consider = (positions: Position[]) => {
    if (positions.length !== stones) return;
    const move: Move = { player: rootPlayer, positions };
    try {
      const next = applyMoveWithWinner(state, move);
      if (next.winner && next.winner !== rootPlayer) return;
      const opp = switchPlayer(rootPlayer);
      const oppNeed = getStonesToPlace(next.moveNumber, opp);
      const nextOppReport = cachedAnalyzeThreats(next, opp);
      if (nextOppReport.winIn1.length > 0) return;
      if (oppNeed >= 2 && nextOppReport.winIn2.length > 0) return;

      const count = countOpenThreeLines(
        collectOpenThreeThreats(next, myVal),
      );
      const pairDist =
        positions.length === 2
          ? Math.abs(positions[0].x - positions[1].x) +
            Math.abs(positions[0].y - positions[1].y)
          : 0;
      const dist = positions.reduce(
        (sum, p) => sum + Math.abs(p.x - center) + Math.abs(p.y - center),
        0,
      );
      if (
        count > bestCount ||
        (count === bestCount && pairDist > bestPairDist) ||
        (count === bestCount && pairDist === bestPairDist && dist < bestDist)
      ) {
        bestCount = count;
        bestPairDist = pairDist;
        bestDist = dist;
        bestMove = move;
      }
    } catch {
      return;
    }
  };

  if (stones === 1) {
    for (const p of candidates) {
      if (state.board[p.y]?.[p.x] !== 0) continue;
      consider([p]);
    }
  } else {
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (state.board[a.y]?.[a.x] !== 0) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (state.board[b.y]?.[b.x] !== 0) continue;
        consider([a, b]);
      }
    }
  }

  if (!bestMove) return null;
  if (bestCount >= 2) return bestMove;
  if (bestCount > baseThreats) return bestMove;
  return null;
}

function buildBlockMoveForWin2Pairs(
  state: GameState,
  player: Player,
  report: ThreatReport,
): Move | null {
  const stones = getStonesToPlace(state.moveNumber, player);
  const pairs = report.oppWin2Pairs;
  if (pairs.length === 0) return null;

  const emptyPairs = pairs.filter(
    // A win-in-2 pair is only active when both endpoints are still empty.
    ([a, b]) => state.board[a.y][a.x] === 0 && state.board[b.y][b.x] === 0,
  );
  if (emptyPairs.length === 0) return null;
  const emptyPairKeySet = new Set<number>(emptyPairs.map(([a, b]) => pairKey(a, b)));

  if (emptyPairs.length === 1) {
    const [a, b] = emptyPairs[0];
    const choices = uniqueEmptyPoints(state, [a, b]);
    if (choices.length === 0) return null;
    if (stones === 1) {
      return { player, positions: [sortByCenter(choices)[0]] };
    }
    const primary = sortByCenter(choices)[0];
    const avoid = new Set<number>([
      posIdx(primary.x, primary.y),
      posIdx(a.x, a.y),
      posIdx(b.x, b.y),
    ]);
    const second = pickSecondFromThreatReport(state, report, avoid);
    return { player, positions: [primary, second] };
  }

  const coverage = new Map<number, Set<number>>();
  for (let i = 0; i < emptyPairs.length; i++) {
    const [a, b] = emptyPairs[i];
    for (const p of [a, b]) {
      if (state.board[p.y][p.x] !== 0) continue;
      const key = posIdx(p.x, p.y);
      if (!coverage.has(key)) coverage.set(key, new Set<number>());
      coverage.get(key)?.add(i);
    }
  }

  const ranked = [...coverage.entries()]
    .map(([key, set]) => {
      return { key, p: fromIdx(key), covered: set };
    })
    .sort((a, b) => {
      if (b.covered.size !== a.covered.size) return b.covered.size - a.covered.size;
      const ca = sortByCenter([a.p, b.p])[0];
      return ca.x === a.p.x && ca.y === a.p.y ? -1 : 1;
    });

  if (ranked.length === 0) return null;

  type DefenseScore = {
    win1: number;
    win2: number;
    doubleFour: number;
    fourThree: number;
    live4: number;
    doubleThree: number;
    dist: number;
  };

  const scoreDefenseMove = (positions: Position[]): DefenseScore | null => {
    try {
      const next = applyMoveWithWinner(state, { player, positions });
      const opp = switchPlayer(player);
      const oppAfter = cachedAnalyzeThreats(next, opp);
      const dist = positions.reduce(
        (sum, p) =>
          sum +
          Math.abs(p.x - (BOARD_SIZE - 1) / 2) +
          Math.abs(p.y - (BOARD_SIZE - 1) / 2),
        0,
      );
      return {
        win1: oppAfter.winIn1.length,
        win2: oppAfter.winIn2.length,
        doubleFour: oppAfter.byType.DOUBLE_FOUR.length,
        fourThree: oppAfter.byType.FOUR_THREE.length,
        live4: oppAfter.byType.LIVE4.length + oppAfter.byType.CHARGE4.length,
        doubleThree: oppAfter.byType.DOUBLE_THREE.length,
        dist,
      };
    } catch {
      return null;
    }
  };

  const isBetter = (a: DefenseScore, b: DefenseScore): boolean => {
    if (a.win1 !== b.win1) return a.win1 < b.win1;
    if (a.win2 !== b.win2) return a.win2 < b.win2;
    if (a.doubleFour !== b.doubleFour) return a.doubleFour < b.doubleFour;
    if (a.fourThree !== b.fourThree) return a.fourThree < b.fourThree;
    if (a.live4 !== b.live4) return a.live4 < b.live4;
    if (a.doubleThree !== b.doubleThree) return a.doubleThree < b.doubleThree;
    return a.dist < b.dist;
  };

  const MAX_WIN2_DEFENSE_POINTS = 12;
  const candidates = ranked
    .slice(0, MAX_WIN2_DEFENSE_POINTS)
    .map(item => item.p);

  if (stones === 1) {
    let bestMove: Move | null = null;
    let bestScore: DefenseScore | null = null;
    for (const p of candidates) {
      const score = scoreDefenseMove([p]);
      if (!score) continue;
      if (!bestScore || isBetter(score, bestScore)) {
        bestScore = score;
        bestMove = { player, positions: [p] };
      }
    }
    return bestMove ?? { player, positions: [ranked[0].p] };
  }

  let bestMove: Move | null = null;
  let bestScore: DefenseScore | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (posIdx(a.x, a.y) === posIdx(b.x, b.y)) continue;
      if (emptyPairKeySet.has(pairKey(a, b))) continue;
      const score = scoreDefenseMove([a, b]);
      if (!score) continue;
      if (!bestScore || isBetter(score, bestScore)) {
        bestScore = score;
        bestMove = { player, positions: [a, b] };
      }
    }
  }

  if (bestMove) return bestMove;

  const primary = ranked[0];
  const covered = new Set<number>(primary.covered);
  const remainingPairs = new Set<number>();
  for (let i = 0; i < emptyPairs.length; i++) {
    if (!covered.has(i)) remainingPairs.add(i);
  }

  let bestSecond: Position | null = null;
  let bestAdded = -1;
  let bestCenter = Infinity;
  for (const item of ranked) {
    if (item.key === primary.key) continue;
    if (emptyPairKeySet.has(pairKey(primary.p, item.p))) continue;
    let added = 0;
    for (const idx of item.covered) {
      if (remainingPairs.has(idx)) added += 1;
    }
    if (added <= 0) continue;
    const centerScore =
      Math.abs(item.p.x - (BOARD_SIZE - 1) / 2) +
      Math.abs(item.p.y - (BOARD_SIZE - 1) / 2);
    if (added > bestAdded || (added === bestAdded && centerScore < bestCenter)) {
      bestAdded = added;
      bestCenter = centerScore;
      bestSecond = item.p;
    }
  }

  if (bestSecond) {
    return { player, positions: [primary.p, bestSecond] };
  }

  const avoid = new Set<number>();
  avoid.add(primary.key);
  for (const [a, b] of emptyPairs) {
    const aKey = posIdx(a.x, a.y);
    const bKey = posIdx(b.x, b.y);
    if (aKey === primary.key) avoid.add(bKey);
    if (bKey === primary.key) avoid.add(aKey);
  }
  if (remainingPairs.size === 0) {
    for (const [a, b] of emptyPairs) {
      avoid.add(posIdx(a.x, a.y));
      avoid.add(posIdx(b.x, b.y));
    }
  }
  const second = pickSecondFromThreatReport(state, report, avoid);
  return { player, positions: [primary.p, second] };
}

type RootDefenseScore = {
  immediate: boolean;
  oppWin1: number;
  oppWin2: number;
  oppDoubleFour: number;
  oppFourThree: number;
  oppLive4: number;
  oppDoubleThree: number;
  myWin1: number;
  myWin2: number;
  centerDist: number;
};

function evaluateRootDefenseScore(
  state: GameState,
  player: Player,
  move: Move,
): RootDefenseScore | null {
  try {
    const next = applyMoveWithWinner(state, move);
    if (next.winner === player) {
      return {
        immediate: false,
        oppWin1: 0,
        oppWin2: 0,
        oppDoubleFour: 0,
        oppFourThree: 0,
        oppLive4: 0,
        oppDoubleThree: 0,
        myWin1: Number.MAX_SAFE_INTEGER,
        myWin2: Number.MAX_SAFE_INTEGER,
        centerDist: 0,
      };
    }

    const opp = switchPlayer(player);
    const oppNeed = getStonesToPlace(next.moveNumber, opp);
    const oppAfter = cachedAnalyzeThreats(next, opp);
    const myNeed = getStonesToPlace(next.moveNumber, player);
    const myAfter = cachedAnalyzeThreats(next, player);
    const immediate =
      oppAfter.winIn1.length > 0 || (oppNeed >= 2 && oppAfter.winIn2.length > 0);
    const centerDist = move.positions.reduce(
      (sum, p) =>
        sum +
        Math.abs(p.x - (BOARD_SIZE - 1) / 2) +
        Math.abs(p.y - (BOARD_SIZE - 1) / 2),
      0,
    );
    return {
      immediate,
      oppWin1: oppAfter.winIn1.length,
      oppWin2: oppAfter.winIn2.length,
      oppDoubleFour: oppAfter.byType.DOUBLE_FOUR.length,
      oppFourThree: oppAfter.byType.FOUR_THREE.length,
      oppLive4: oppAfter.byType.LIVE4.length + oppAfter.byType.CHARGE4.length,
      oppDoubleThree: oppAfter.byType.DOUBLE_THREE.length,
      myWin1: myAfter.winIn1.length,
      myWin2: myNeed >= 2 ? myAfter.winIn2.length : 0,
      centerDist,
    };
  } catch {
    return null;
  }
}

function isBetterRootDefenseScore(a: RootDefenseScore, b: RootDefenseScore): boolean {
  if (a.immediate !== b.immediate) return !a.immediate;
  if (a.oppWin1 !== b.oppWin1) return a.oppWin1 < b.oppWin1;
  if (a.oppWin2 !== b.oppWin2) return a.oppWin2 < b.oppWin2;
  if (a.oppDoubleFour !== b.oppDoubleFour) return a.oppDoubleFour < b.oppDoubleFour;
  if (a.oppFourThree !== b.oppFourThree) return a.oppFourThree < b.oppFourThree;
  if (a.oppLive4 !== b.oppLive4) return a.oppLive4 < b.oppLive4;
  if (a.oppDoubleThree !== b.oppDoubleThree) return a.oppDoubleThree < b.oppDoubleThree;
  if (a.myWin1 !== b.myWin1) return a.myWin1 > b.myWin1;
  if (a.myWin2 !== b.myWin2) return a.myWin2 > b.myWin2;
  return a.centerDist < b.centerDist;
}

function refineThreatRootDefenseMove(
  state: GameState,
  player: Player,
  report: ThreatReport,
  oppReport: ThreatReport,
  reason: string,
  baseMove: Move,
): Move {
  const required = getStonesToPlace(state.moveNumber, player);
  if (baseMove.positions.length !== required) return baseMove;
  if (
    reason !== 'block_opp_win1' &&
    reason !== 'block_opp_win1_multi' &&
    reason !== 'block_opp_win2' &&
    reason !== 'block_opp_initiative'
  ) {
    return baseMove;
  }

  const mustTouch = new Set<number>();
  if (reason === 'block_opp_win1' || reason === 'block_opp_win1_multi') {
    for (const p of oppReport.winIn1) mustTouch.add(posIdx(p.x, p.y));
  } else if (reason === 'block_opp_win2') {
    for (const [a, b] of report.oppWin2Pairs) {
      mustTouch.add(posIdx(a.x, a.y));
      mustTouch.add(posIdx(b.x, b.y));
    }
  } else {
    for (const item of collectInitiativeBlockPoints(state, oppReport).slice(0, 16)) {
      mustTouch.add(posIdx(item.p.x, item.p.y));
    }
  }

  const extraCandidates = collectThreatCandidates(
    state,
    player,
    Math.max(MAX_ROOT_CANDIDATE_POINTS, 64),
  );
  let moves = generateMoves(state, extraCandidates, player);
  if (moves.length > 120) {
    moves = moves.slice(0, 120);
  }

  const blocksBothWin2PairEnds = (move: Move): boolean => {
    if (reason !== 'block_opp_win2') return false;
    const hit = new Set<number>(move.positions.map(p => posIdx(p.x, p.y)));
    for (const [a, b] of report.oppWin2Pairs) {
      const ka = posIdx(a.x, a.y);
      const kb = posIdx(b.x, b.y);
      if (hit.has(ka) && hit.has(kb)) return true;
    }
    return false;
  };

  const blocksSingleLive3BothEnds = (move: Move): boolean => {
    if (reason !== 'block_opp_initiative') return false;
    if (required !== 2) return false;
    if (oppReport.winIn1.length > 0 || oppReport.winIn2.length > 0) return false;
    const oppVal = player === 'BLACK' ? 2 : 1;
    const oppLive3Threats = collectOpenThreeThreats(state, oppVal);
    if (countOpenThreeLines(oppLive3Threats) !== 1) return false;
    const ends = new Set<number>();
    for (const threat of oppLive3Threats) {
      for (const p of threat.ends) {
        if (state.board[p.y]?.[p.x] !== 0) continue;
        ends.add(posIdx(p.x, p.y));
      }
    }
    if (ends.size < 2) return false;
    const hit = move.positions.filter(p => ends.has(posIdx(p.x, p.y)));
    return hit.length >= 2;
  };

  if (mustTouch.size > 0) {
    const filtered = moves.filter(move =>
      move.positions.some(p => mustTouch.has(posIdx(p.x, p.y))),
    );
    if (filtered.length > 0) moves = filtered;
  }

  const extra = moves.filter(
    m =>
      m.positions.length === required &&
      !blocksBothWin2PairEnds(m) &&
      !blocksSingleLive3BothEnds(m),
  );
  const pool = [baseMove, ...extra];
  const dedup = new Set<string>();
  let bestMove = baseMove;
  let bestScore = evaluateRootDefenseScore(state, player, baseMove);
  if (!bestScore) return baseMove;

  for (const move of pool) {
    const key = moveKey(move);
    if (dedup.has(key)) continue;
    dedup.add(key);
    const score = evaluateRootDefenseScore(state, player, move);
    if (!score) continue;
    if (isBetterRootDefenseScore(score, bestScore)) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

function findThreatRootMove(
  state: GameState,
  rootPlayer: Player,
  myReport: ThreatReport,
  oppReport: ThreatReport,
): { move: Move; reason: string } | null {
  const report = mergeThreatReports(myReport, oppReport);
  const stones = getStonesToPlace(state.moveNumber, rootPlayer);

  const myWin1 = uniqueEmptyPoints(state, myReport.winIn1);
  if (myWin1.length > 0) {
    const primary = sortByCenter(myWin1)[0];
    if (stones === 1) {
      return {
        move: { player: rootPlayer, positions: [primary] },
        reason: 'own_win1',
      };
    }
    const avoid = new Set<number>([posIdx(primary.x, primary.y)]);
    const second = pickSecondFromThreatReport(state, report, avoid);
    return {
      move: { player: rootPlayer, positions: [primary, second] },
      reason: 'own_win1',
    };
  }

  if (stones >= 2 && myReport.winIn2.length > 0) {
    const pair = pickBestWin2Pair(state, myReport.winIn2);
    if (pair) {
      return {
        move: { player: rootPlayer, positions: [pair[0], pair[1]] },
        reason: 'own_win2',
      };
    }
  }

  const oppWin1 = uniqueEmptyPoints(state, oppReport.winIn1);
  if (oppWin1.length > 0) {
    const sorted = sortByCenter(oppWin1);
    if (stones === 1) {
      const base = {
        move: { player: rootPlayer, positions: [sorted[0]] },
        reason: 'block_opp_win1',
      };
      return {
        move: refineThreatRootDefenseMove(
          state,
          rootPlayer,
          report,
          oppReport,
          base.reason,
          base.move,
        ),
        reason: base.reason,
      };
    }
    if (sorted.length >= 2) {
      const base = {
        move: { player: rootPlayer, positions: [sorted[0], sorted[1]] },
        reason: 'block_opp_win1_multi',
      };
      return {
        move: refineThreatRootDefenseMove(
          state,
          rootPlayer,
          report,
          oppReport,
          base.reason,
          base.move,
        ),
        reason: base.reason,
      };
    }
    const primary = sorted[0];
    const avoid = new Set<number>([posIdx(primary.x, primary.y)]);
    const second = pickSecondFromThreatReport(state, report, avoid);
    const base = {
      move: { player: rootPlayer, positions: [primary, second] },
      reason: 'block_opp_win1',
    };
    return {
      move: refineThreatRootDefenseMove(
        state,
        rootPlayer,
        report,
        oppReport,
        base.reason,
        base.move,
      ),
      reason: base.reason,
    };
  }

  if (oppReport.winIn2.length > 0) {
    const mv = buildBlockMoveForWin2Pairs(state, rootPlayer, report);
    if (mv) {
      const reason = 'block_opp_win2';
      return {
        move: refineThreatRootDefenseMove(
          state,
          rootPlayer,
          report,
          oppReport,
          reason,
          mv,
        ),
        reason,
      };
    }
  }

  const def = pickDefensiveRootMoveAgainstInitiative(
    state,
    rootPlayer,
    report,
    oppReport,
  );
  if (def) {
    const reason = 'block_opp_initiative';
    return {
      move: refineThreatRootDefenseMove(
        state,
        rootPlayer,
        report,
        oppReport,
        reason,
        def,
      ),
      reason,
    };
  }

  return null;
}

function pickVcdtRootAttackMove(
  state: GameState,
  rootPlayer: Player,
  myReport: ThreatReport,
  oppReport: ThreatReport,
): Move | null {
  if (hasOpponentInitiative(state, oppReport)) return null;

  const stones = getStonesToPlace(state.moveNumber, rootPlayer);
  const attackPoints = collectKeyPointsByType(myReport, [
    'DOUBLE_FOUR',
    'FOUR_THREE',
    'DOUBLE_THREE',
    'LIVE4',
    'CHARGE4',
    'LIVE3',
  ]);
  const candidates = uniqueEmptyPoints(state, attackPoints);
  if (candidates.length === 0) return null;

  const sorted = sortByCenter(candidates);
  const primary = sorted[0];
  if (stones === 1) {
    return { player: rootPlayer, positions: [primary] };
  }

  const avoid = new Set<number>([posIdx(primary.x, primary.y)]);
  const secondary = uniqueEmptyPoints(state, sorted.slice(1), avoid);
  if (secondary.length > 0) {
    return { player: rootPlayer, positions: [primary, secondary[0]] };
  }

  const merged = mergeThreatReports(myReport, oppReport);
  const second = pickSecondFromThreatReport(state, merged, avoid);
  return { player: rootPlayer, positions: [primary, second] };
}

// ===== 根搜索（带 VCDT + 迭代加深）=====

export function pvsSearchBestMove(
  rootState: GameState,
  rootPlayer: Player,
  weights: EvaluationWeights,
  config: SearchConfig,
): AIMoveDecision {
  // 清理一次搜索周期的 VCDT 缓存
  const searchWeights = {
    ...weights,
    threat_defense_weight: 1,
  } as EvaluationWeights & { threat_defense_weight: number };
  const multithreadingHint: Partial<Pick<AIMoveDebugInfo, 'multithreading'>> =
    config.useMultithreading
    ? { multithreading: 'requested_but_unsupported' }
    : {};

  const evalSignature = buildEvalSignature(searchWeights);
  let ttClearsThisMove = 0;
  resetTTEvictionsThisMove();
  resetHistoryEvictionsThisMove();
  if (evalSignature !== lastEvalSignature) {
    clearTranspositionTable();
    lastEvalSignature = evalSignature;
    ttClearsThisMove = 1;
  }
  const ttSizeBefore = getTTSize();
  const historySizeBefore = getHistorySize();
  const debugSizes = () => ({
    ttSizeBefore,
    ttSizeAfter: getTTSize(),
    ttEvictionsThisMove: getTTEvictionsThisMove(),
    historySizeBefore,
    historySizeAfter: getHistorySize(),
    historyEvictionsThisMove: getHistoryEvictionsThisMove(),
  });
  clearThreatCache();
  threatListCacheBlack.clear();
  threatListCacheWhite.clear();
  lastSearchNodeCount = 0;
  currentSearchAborted = false;
  clearKillerMoves();
  clearAspirationWindows();
  decayHistory();

  const maxDepth = Math.max(1, config.maxDepth ?? 8);
  const maxTime = config.timeLimitMs ?? 5000;
  const baseTime = Math.min(
    maxTime,
    Math.max(THREAT_TIME_BASE_MIN_MS, Math.floor(maxTime * THREAT_TIME_BASE_RATIO)),
  );
  const timeBudget = Math.min(
    maxTime,
    computeThreatTimeFactor(rootState, rootPlayer, baseTime),
  );
  const deadline = getCurrentTime() + timeBudget;
  const patternEval = new PatternEvaluator(rootPlayer);
  const traceId = beginDecisionTrace('pvsSearchBestMove', {
    player: rootPlayer,
    moveNumber: rootState.moveNumber,
    maxDepth,
    timeBudget,
  });
  const finalizeDecision = (decision: AIMoveDecision): AIMoveDecision => {
    traceDecisionEvent(traceId, 'pvsSearchBestMove', 'return', {
      mode: decision.debugInfo?.mode,
      reason: decision.debugInfo?.reason,
      depth: decision.debugInfo?.depth,
      nodes: decision.debugInfo?.nodes,
    });
    endDecisionTrace(traceId, {
      mode: decision.debugInfo?.mode,
      reason: decision.debugInfo?.reason,
      depth: decision.debugInfo?.depth,
      nodes: decision.debugInfo?.nodes,
    });
    return decision;
  };
  traceDecisionEvent(traceId, 'pvsSearchBestMove', 'enter', {
    moveNumber: rootState.moveNumber,
    maxDepth,
    timeBudget,
  });
  const tacticalHintMoves: Move[] = [];
  let tacticalHintSet: Set<string> | undefined;
  let tacticalHintInfo: Record<string, number | string> | undefined;
  const threatRootHintReasons = new Map<string, string>();
  const vcdtRootHintReasons = new Map<string, 'double_live3_build' | 'vcdt_attack'>();
  const tacticalRootHintKinds = new Map<string, 'vcf' | 'vct'>();
  const forcedDefenseMoves: Move[] = [];
  let forcedDefenseInfo: Record<string, number | string> | undefined;
  let counterLive3HintInfo: Record<string, number> | undefined;

  type RootDebugOptions = {
    includeTacticalHintInfo?: boolean;
    includeForcedDefenseInfo?: boolean;
    includeCounterLive3HintInfo?: boolean;
  };

  const buildRootDebugInfo = (
    mode: string,
    extra?: Partial<AIMoveDebugInfo>,
    options?: RootDebugOptions,
  ): AIMoveDebugInfo => {
    const info: AIMoveDebugInfo = {
      engine: 'pvs+threat+zorp',
      mode,
      nodes: lastSearchNodeCount,
      ttSize: getTTSize(),
      ttClearsThisMove,
      ...multithreadingHint,
      ...debugSizes(),
    };
    if (options?.includeTacticalHintInfo && tacticalHintInfo) {
      Object.assign(info, tacticalHintInfo);
    }
    if (options?.includeForcedDefenseInfo && forcedDefenseInfo) {
      Object.assign(info, forcedDefenseInfo);
    }
    if (options?.includeCounterLive3HintInfo && counterLive3HintInfo) {
      Object.assign(info, counterLive3HintInfo);
    }
    if (extra) Object.assign(info, extra);
    return info;
  };

  const evaluateRootMove = (move: Move): number => {
    const next = applyMoveWithWinner(rootState, move);
    return evaluateWithThreatReport(
      next,
      rootPlayer,
      searchWeights,
      undefined,
      patternEval,
    );
  };

  const finalizeEvaluatedRootMove = (
    move: Move,
    mode: string,
    extra?: Partial<AIMoveDebugInfo>,
    options?: RootDebugOptions,
  ): AIMoveDecision =>
    finalizeDecision({
      move,
      score: evaluateRootMove(move),
      debugInfo: buildRootDebugInfo(mode, extra, options),
    });

  const ensureTacticalHintSet = (): Set<string> => {
    if (!tacticalHintSet) tacticalHintSet = new Set<string>();
    return tacticalHintSet;
  };

  const addTacticalHintMove = (move: Move): { key: string; added: boolean } => {
    const key = moveKey(move);
    const hintSet = ensureTacticalHintSet();
    if (hintSet.has(key)) return { key, added: false };
    hintSet.add(key);
    tacticalHintMoves.push(move);
    return { key, added: true };
  };

  const addRootHintMove = (
    move: Move,
    reason: 'double_live3_build' | 'vcdt_attack',
  ): void => {
    const { key } = addTacticalHintMove(move);
    vcdtRootHintReasons.set(key, reason);
  };

  const addThreatRootHintMove = (move: Move, reason: string): void => {
    const { key } = addTacticalHintMove(move);
    threatRootHintReasons.set(key, reason);
  };

  // 0) 根节点 VCDT：必杀 / 必防 / 活四
  const { my: rootMyReport, opp: rootOppReport } = analyzeBothCached(
    rootState,
    rootPlayer,
  );
  const threatRoot = findThreatRootMove(
    rootState,
    rootPlayer,
    rootMyReport,
    rootOppReport,
  );
  if (threatRoot) {
    traceDecisionEvent(traceId, 'pvsSearchBestMove', 'threat_root_hit', {
      reason: threatRoot.reason,
    });
    if (threatRoot.reason === 'block_opp_initiative') {
      addThreatRootHintMove(threatRoot.move, threatRoot.reason);
      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'threat_root_hint', {
        reason: threatRoot.reason,
      });
    } else {
      const next = applyMoveWithWinner(rootState, threatRoot.move);
      const opp = switchPlayer(rootPlayer);

      const remainDepth = Math.max(0, maxDepth - 1);
      let score: number;
      let searchedDepth = 1;

      if (remainDepth > 0) {
        score = -pvs(
          next,
          rootPlayer,
          opp,
          -Infinity,
          Infinity,
          remainDepth,
          searchWeights,
          deadline,
          true,
          MAX_LOCAL_EXTENSION,
          undefined,
          patternEval,
        );
        searchedDepth = 1 + remainDepth;
      } else {
        score = evaluateWithThreatReport(
          next,
          rootPlayer,
          searchWeights,
          undefined,
          patternEval,
        );
      }

      lastSearchDepth = searchedDepth;

      return finalizeDecision({
        move: threatRoot.move,
        score,
        debugInfo: buildRootDebugInfo('threat_root', {
          reason: threatRoot.reason,
          depth: searchedDepth,
        }),
      });
    }
  }
  const tacticalDepth = Math.min(VCF_VCT_MAX_DEPTH, maxDepth);
  const tacticalTimeMs = Math.min(
    VCF_VCT_MAX_TIME_MS,
    Math.max(6, Math.floor(timeBudget * VCF_VCT_TIME_RATIO)),
  );
  const tacticalSearchOptions = {
    maxDepth: tacticalDepth,
    maxNodes: VCF_VCT_MAX_NODES,
    timeLimitMs: tacticalTimeMs,
    maxBranch: VCF_VCT_MAX_BRANCH,
  };
  const tacticalMode = (
    kind: 'vcf' | 'vct',
    suffix: 'root' | 'defense',
  ): string => `${kind}_${suffix}`;
  const opponentStonesAfterRoot = getStonesToPlace(
    rootState.moveNumber + 1,
    switchPlayer(rootPlayer),
  );
  const hasHardOpponentThreat = (report: ThreatReport): boolean =>
    report.winIn1.length > 0 ||
    (opponentStonesAfterRoot >= 2 && report.winIn2.length > 0) ||
    report.byType.LIVE4.length > 0 ||
    report.byType.CHARGE4.length > 0 ||
    report.byType.DOUBLE_FOUR.length > 0 ||
    report.byType.FOUR_THREE.length > 0;
  const rootOppHardThreat = hasHardOpponentThreat(rootOppReport);
  const requiredStones = getStonesToPlace(rootState.moveNumber, rootPlayer);
  const isLegalRootMove = (move?: Move | null): move is Move => {
    if (!move) return false;
    if (move.player !== rootPlayer) return false;
    if (move.positions.length !== requiredStones) return false;
    const seen = new Set<number>();
    for (const p of move.positions) {
      if (!rootState.board[p.y] || rootState.board[p.y][p.x] !== 0) {
        return false;
      }
      const key = posIdx(p.x, p.y);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  };

  const tacticalHints = findVcfVctRootHints(
    rootState,
    rootPlayer,
    tacticalSearchOptions,
  );
  if (tacticalHints) {
    let tacticalAdded = 0;
    for (const move of tacticalHints.moves) {
      if (!isLegalRootMove(move)) continue;
      if (!addTacticalHintMove(move).added) continue;
      tacticalAdded += 1;
    }
    if (tacticalAdded > 0) {
      tacticalHintInfo = {
        tacticalKind: tacticalHints.kind,
        tacticalMoves: tacticalAdded,
        tacticalNodes: tacticalHints.nodes,
        tacticalDepth: tacticalHints.depth,
      };
      if (tacticalHints.line && tacticalHints.line.length > 0) {
        tacticalHintInfo.tacticalLine = tacticalHints.line.length;
      }
    }
  }

  const tacticalForcedLineMove =
    tacticalHints?.line && tacticalHints.line.length > 0
      ? tacticalHints.line[0]
      : null;
  const tacticalForcedLineLegal =
    tacticalForcedLineMove !== null && isLegalRootMove(tacticalForcedLineMove)
      ? tacticalForcedLineMove
      : null;

  const opponent = switchPlayer(rootPlayer);
  const opponentHints = findVcfVctRootHints(
    rootState,
    opponent,
    tacticalSearchOptions,
  );
  if (opponentHints?.line && opponentHints.line.length > 0) {
    const defenseCandidatesRaw = buildVcfVctDefenseMoves(
      rootState,
      rootPlayer,
      opponent,
      opponentHints.kind,
      tacticalSearchOptions,
    );
    const defenseCandidates: Move[] = [];
    const seen = new Set<string>();
    for (const move of defenseCandidatesRaw) {
      if (!isLegalRootMove(move)) continue;
      const key = moveKey(move);
      if (seen.has(key)) continue;
      seen.add(key);
      defenseCandidates.push(move);
      if (defenseCandidates.length >= VCF_VCT_DEFENSE_CHECKS) break;
    }
    for (const move of defenseCandidates) {
      const applied = tryApplyMoveWithWinner(rootState, move);
      if (!applied.ok) continue;
      const response = findVcfVctRootHints(
        applied.state,
        opponent,
        tacticalSearchOptions,
      );
      if (!response) {
        forcedDefenseMoves.push(move);
      }
    }
    if (forcedDefenseMoves.length > 0) {
      forcedDefenseInfo = {
        tacticalDefenseKind: opponentHints.kind,
        tacticalDefenseMoves: forcedDefenseMoves.length,
        tacticalDefenseChecks: defenseCandidates.length,
      };
      if (forcedDefenseMoves.length === 1) {
        traceDecisionEvent(traceId, 'pvsSearchBestMove', 'forced_defense_single', {
          kind: opponentHints.kind,
        });
        return finalizeEvaluatedRootMove(
          forcedDefenseMoves[0],
          tacticalMode(opponentHints.kind, 'defense'),
          {
            reason: 'tactical_defense',
            depth: 0,
          },
          {
            includeTacticalHintInfo: true,
            includeForcedDefenseInfo: true,
          },
        );
      }
    }
  }

  if (tacticalForcedLineLegal) {
    const lineMove = tacticalForcedLineLegal;
    const lineKey = moveKey(lineMove);
    const isVctLine = tacticalHints?.kind === 'vct';
    const hasDefenseGate =
      forcedDefenseMoves.length > 0 || rootOppHardThreat;
    let unsafeUnderGate = false;
    if (!isVctLine && hasDefenseGate) {
      const next = applyMoveWithWinner(rootState, lineMove);
      const nextOppReport = analyzeCached(next, opponent);
      unsafeUnderGate = hasHardOpponentThreat(nextOppReport);
    }

    if (
      !isVctLine &&
      !unsafeUnderGate &&
      forcedDefenseMoves.length === 0 &&
      !rootOppHardThreat
    ) {
      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'tactical_forced_line', {
        kind: tacticalHints?.kind,
      });
      return finalizeEvaluatedRootMove(
        lineMove,
        tacticalMode(tacticalHints!.kind, 'root'),
        {
          reason: `${tacticalHints!.kind}_forced`,
          depth: 0,
        },
        {
          includeTacticalHintInfo: true,
        },
      );
    }

    addTacticalHintMove(lineMove);
    if (tacticalHints) {
      tacticalRootHintKinds.set(lineKey, tacticalHints.kind);
    }
    traceDecisionEvent(
      traceId,
      'pvsSearchBestMove',
      'tactical_forced_line_deferred',
      {
        kind: tacticalHints?.kind,
        reason: isVctLine
          ? 'vct_hint_only'
          : unsafeUnderGate
            ? 'defense_gate_unsafe'
            : hasDefenseGate
              ? 'defense_gate_active'
              : 'deferred_to_root_search',
      },
    );
  }


  if (forcedDefenseMoves.length === 0) {
    const calmDoubleLive3 = pickCalmDoubleLive3BuildMove(
      rootState,
      rootPlayer,
      rootMyReport,
      rootOppReport,
    );
    if (calmDoubleLive3) {
      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'double_live3_build', {});
      addRootHintMove(calmDoubleLive3, 'double_live3_build');
    }

    const vcdtAttack = pickVcdtRootAttackMove(
      rootState,
      rootPlayer,
      rootMyReport,
      rootOppReport,
    );
    if (vcdtAttack) {
      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'vcdt_attack', {});
      addRootHintMove(vcdtAttack, 'vcdt_attack');
    }
  }

    // Connect6: 对手只有“单条活三”时，避免“二子两头都堵”的俗手；
    // 提前塞入“挡一头 + 顺手造势”的候选，让主搜更容易找到反击型防守。
    const counterLive3HintMoves: Move[] = [];
    const stones = requiredStones;
    if (stones === 2 && !hasOpponentInitiative(rootState, rootOppReport)) {
      const oppVal = rootPlayer === 'BLACK' ? 2 : 1;
      const oppOpen3 = collectOpenThreeThreats(rootState, oppVal);
      if (countOpenThreeLines(oppOpen3) === 1) {
        const endMap = new Map<number, Position>();
        for (const t of oppOpen3) {
          for (const p of t.ends) {
            if (rootState.board[p.y]?.[p.x] !== 0) continue;
            endMap.set(posIdx(p.x, p.y), p);
          }
        }
        const ends = [...endMap.values()];
        if (ends.length >= 2) {
          const endsSet = new Set<number>(ends.map(p => posIdx(p.x, p.y)));
          for (const block of ends) {
            const avoid = new Set<number>(endsSet);
            avoid.delete(posIdx(block.x, block.y));
            const sec = pickSmartSecond(rootState, rootPlayer, block, avoid);
            if (sec.x === block.x && sec.y === block.y) continue;
            if (rootState.board[sec.y]?.[sec.x] !== 0) continue;
            if (endsSet.has(posIdx(sec.x, sec.y))) continue; // 不要直接两头都堵
            counterLive3HintMoves.push({
              player: rootPlayer,
              positions: [block, sec],
            });
            if (counterLive3HintMoves.length >= 2) break;
          }
        }
      }
      if (counterLive3HintMoves.length > 0) {
        counterLive3HintInfo = { counterLive3Hints: counterLive3HintMoves.length };
      }
    }

    // 1) RZOP 生成根候选
    const candidates = collectThreatCandidates(
      rootState,
      rootPlayer,
      MAX_ROOT_CANDIDATE_POINTS,
    );
    let moveCombos = generateMoves(rootState, candidates, rootPlayer);
    moveCombos = prependUniqueMoves(moveCombos, tacticalHintMoves);
    moveCombos = prependUniqueMoves(moveCombos, counterLive3HintMoves);
    if (forcedDefenseMoves.length > 0) {
      moveCombos = forcedDefenseMoves;
    }

    if (moveCombos.length === 0) {
      const fallback = findFallbackMove(rootState, rootPlayer);
      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'no_candidate_fallback', {});
      return finalizeDecision({
        move: fallback,
        score: evaluateWithThreatReport(
          rootState,
          rootPlayer,
          searchWeights,
          undefined,
          patternEval,
        ),
        debugInfo: buildRootDebugInfo(
          'no_candidate_fallback',
          {
            depth: 0,
            nodes: 0,
          },
          {
            includeTacticalHintInfo: true,
            includeForcedDefenseInfo: true,
            includeCounterLive3HintInfo: true,
          },
        ),
      });
    }

    if (moveCombos.length > MAX_ROOT_MOVE_COMBOS) {
      const scored = moveCombos.map(move => {
        const next = applyMoveWithWinner(rootState, move);
        const base = evaluateWithThreatReport(
          next,
          rootPlayer,
          searchWeights,
          undefined,
          patternEval,
        );
        const myWins = cachedThreats(next, rootPlayer).filter(
          t => t.isWinning && t.threatLevel === 0,
        ).length;
        const hintBonus =
          tacticalHintSet && tacticalHintSet.has(moveKey(move))
            ? TACTICAL_HINT_BONUS
            : 0;
        return { move, score: base + myWins * 100_000 + hintBonus };
      });
      scored.sort((a, b) => b.score - a.score);
      moveCombos = scored.slice(0, MAX_ROOT_MOVE_COMBOS).map(s => s.move);
    }

  // 2) 迭代加深 PVS
  let bestMove = moveCombos[0];
  let bestScore = -Infinity;
  let searchedDepth = 0;

  const startDepth = 1;
  const MAX_ASP_RETRY = 2;
  const MIN_ASP_RETRY_TIME_MS = 60;
  const MIN_FULL_WINDOW_TIME_MS = 140;
  for (let d = startDepth; d <= maxDepth; d++) {
    const timeLeft = deadline - getCurrentTime();
    if (timeLeft < 100) break;

    // First iteration or invalid score uses full window.
    let window = ASPIRATION_WINDOW;
    const useAspiration = Number.isFinite(bestScore) && d > startDepth;
    let baseAlpha = useAspiration ? bestScore - window : -Infinity;
    let baseBeta = useAspiration ? bestScore + window : Infinity;

    const sorted = orderMoves(
      moveCombos,
      rootState,
      rootPlayer,
      rootPlayer,
      searchWeights,
      d,
      undefined,
      true,
      patternEval,
      tacticalHintSet,
    );

    let iterBestMove = bestMove;
    let iterBestScore = -Infinity;
    let completed = false;

    for (let retry = 0; retry <= MAX_ASP_RETRY; retry++) {
      const normalizedBase = normalizeWindow(baseAlpha, baseBeta);
      baseAlpha = normalizedBase.alpha;
      baseBeta = normalizedBase.beta;

      let alpha = baseAlpha;
      const beta = baseBeta;
      pushAspirationWindow({ depth: d, retry, alpha, beta });
      let failed = false;
      iterBestMove = bestMove;
      iterBestScore = -Infinity;

      for (let i = 0; i < sorted.length; i++) {
        if (currentSearchAborted) {
          failed = true;
          break;
        }
        const move = sorted[i];
        const next = applyMoveWithWinner(rootState, move);
        const opp = switchPlayer(rootPlayer);

        let score: number;
        if (i === 0 || failed) {
          score = -pvs(
            next,
            rootPlayer,
            opp,
            -beta,
            -alpha,
            d - 1,
            searchWeights,
            deadline,
            true,
            MAX_LOCAL_EXTENSION,
            undefined,
            patternEval,
          );
        } else {
          score = -pvs(
            next,
            rootPlayer,
            opp,
            -alpha - 1,
            -alpha,
            d - 1,
            searchWeights,
            deadline,
            false,
            MAX_LOCAL_EXTENSION,
            undefined,
            patternEval,
          );
          if (score > alpha && score < beta) {
            score = -pvs(
              next,
              rootPlayer,
              opp,
              -beta,
              -alpha,
              d - 1,
              searchWeights,
              deadline,
              true,
              MAX_LOCAL_EXTENSION,
              undefined,
              patternEval,
            );
          }
        }
        if (currentSearchAborted) {
          failed = true;
          break;
        }

        if (score > iterBestScore) {
          iterBestScore = score;
          iterBestMove = move;
          if (score > alpha) alpha = score;
        }

        if (getCurrentTime() > deadline) {
          failed = true;
          break;
        }
      }

      if (failed) break; // 本深度失败，直接退出 aspiration 重试

      const now = getCurrentTime();
      const timeLeftRetry = deadline - now;
      const canRetry = retry < MAX_ASP_RETRY && timeLeftRetry > MIN_ASP_RETRY_TIME_MS;
      const failLow = iterBestScore <= baseAlpha;
      const failHigh = iterBestScore >= baseBeta;

      if (failLow || failHigh) {
        if (!canRetry) {
          completed = true; // accept best so far when near deadline
          break;
        }

        const useFullWindow =
          timeLeftRetry < MIN_FULL_WINDOW_TIME_MS || retry >= MAX_ASP_RETRY - 1;
        const center = Number.isFinite(iterBestScore) ? iterBestScore : bestScore;

        if (!Number.isFinite(center) || useFullWindow) {
          baseAlpha = -Infinity;
          baseBeta = Infinity;
          continue;
        }

        window *= 2;
        if (failLow) {
          // widen downward: keep beta near center but open alpha
          baseAlpha = -Infinity;
          baseBeta = center + window;
        } else {
          // fail-high: widen upward
          baseAlpha = center - window;
          baseBeta = Infinity;
        }
        continue;
      }

      completed = true;
      break;
    }

    if (completed || d === 1) {
      bestMove = iterBestMove;
      bestScore = iterBestScore;
      searchedDepth = d;
    } else {
      // 当前深度未完整收敛，保留上一层结果
      break;
    }
  }

  lastSearchDepth = searchedDepth;

  if (!Number.isFinite(bestScore)) {
    bestScore = evaluateWithThreatReport(
      rootState,
      rootPlayer,
      searchWeights,
      undefined,
      patternEval,
    );
  }
  const bestKey = moveKey(bestMove);
  const selectedThreatRootHintReason = threatRootHintReasons.get(bestKey);
  const selectedTacticalRootKind = tacticalRootHintKinds.get(bestKey);
  const selectedVcdtHintReason = vcdtRootHintReasons.get(bestKey);
  const finalMode = selectedThreatRootHintReason
    ? 'threat_root'
    : selectedTacticalRootKind
      ? tacticalMode(selectedTacticalRootKind, 'root')
    : selectedVcdtHintReason
      ? 'vcdt_root'
      : 'normal';
  const finalReason = selectedThreatRootHintReason
    ? `${selectedThreatRootHintReason}_hint_selected`
    : selectedTacticalRootKind
      ? `${selectedTacticalRootKind}_forced_hint_selected`
    : selectedVcdtHintReason
      ? `${selectedVcdtHintReason}_hint_selected`
      : undefined;

      traceDecisionEvent(traceId, 'pvsSearchBestMove', 'normal_search_complete', {
        depth: searchedDepth,
        nodes: lastSearchNodeCount,
      });
      return finalizeDecision({
        move: bestMove,
        score: bestScore,
        debugInfo: buildRootDebugInfo(
          finalMode,
          finalReason
            ? { depth: searchedDepth, reason: finalReason }
            : { depth: searchedDepth },
          {
            includeTacticalHintInfo: true,
            includeForcedDefenseInfo: true,
          },
        ),
      });
}

