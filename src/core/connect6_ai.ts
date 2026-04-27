/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { EvaluationWeights, GameState, Move, Player, Position } from '../types';
import { evaluateWithThreatReport, pvsSearchBestMove } from './pvs_search';
import { MCTSConnect6AI } from './mcts_ai_engine';
import type { IResNetEvaluator } from './resnet_ai';
import { DummyResNetEvaluator, createDefaultEvaluator } from './resnet_ai';
import { analyzeBothSidesCached } from './threat_service';
import type { ThreatReport } from './pattern_library';
import { getOpeningMove } from './opening_book';
import { applyMoveWithWinner, getStonesToPlace } from './rules';
import { BOARD_SIZE } from './game_state';
import { posIdx } from './pos_key';
import { buildSmartBlockForOpponentLive4 } from './smart_defense';
import { generateRZOPCandidates } from './rzop';
import { getLinesForCell } from './road_encoding';
import { sortByCenter, uniqueEmptyPoints } from './position_utils';
import { isDeadLineCell } from './line_potential';
import {
  collectOpenThreeThreats,
  computeSpanLen,
  countOpenThreeLines,
} from './threat_utils';

type Mode = 'fast' | 'normal' | 'deep';

interface TimeBudget {
  l0l1: number; // fraction
  l2: number;
  l3: number;
}

interface Config {
  weights: EvaluationWeights;
  pvsDepth: number;
  quickDepth: number;
  mctsBranch: number;
  budgets: Record<Mode, TimeBudget>;
  complexityThreshold?: number;
  dlTimeShare?: number;
}

const DEFAULT_CONFIG: Config = {
  weights: {
    road_3_score: 12_000,
    road_4_score: 45_000,
    live4_score: 80_000,
    live5_score: 150_000,
    vcdt_bonus: 6_000,
  },
  pvsDepth: 8,
  quickDepth: 4,
  mctsBranch: 40,
  budgets: {
    fast: { l0l1: 0.25, l2: 0.6, l3: 0.15 },
    normal: { l0l1: 0.2, l2: 0.6, l3: 0.2 },
    deep: { l0l1: 0.15, l2: 0.6, l3: 0.25 },
  },
};

const MODE_KEYS: Mode[] = ['fast', 'normal', 'deep'];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mergeWeights(
  base: EvaluationWeights,
  override?: Partial<EvaluationWeights>,
): EvaluationWeights {
  const src = override ?? {};
  return {
    road_3_score: isFiniteNumber(src.road_3_score)
      ? src.road_3_score
      : base.road_3_score,
    road_4_score: isFiniteNumber(src.road_4_score)
      ? src.road_4_score
      : base.road_4_score,
    live4_score: isFiniteNumber(src.live4_score)
      ? src.live4_score
      : base.live4_score,
    live5_score: isFiniteNumber(src.live5_score)
      ? src.live5_score
      : base.live5_score,
    vcdt_bonus: isFiniteNumber(src.vcdt_bonus)
      ? src.vcdt_bonus
      : base.vcdt_bonus,
  };
}

function mergeBudget(
  base: TimeBudget,
  override?: Partial<TimeBudget>,
): TimeBudget {
  const src = override ?? {};
  return {
    l0l1: isFiniteNumber(src.l0l1) ? src.l0l1 : base.l0l1,
    l2: isFiniteNumber(src.l2) ? src.l2 : base.l2,
    l3: isFiniteNumber(src.l3) ? src.l3 : base.l3,
  };
}

function mergeBudgets(
  base: Record<Mode, TimeBudget>,
  override?: Partial<Record<Mode, Partial<TimeBudget>>>,
): Record<Mode, TimeBudget> {
  const out = { ...base };
  for (const mode of MODE_KEYS) {
    out[mode] = mergeBudget(base[mode], override?.[mode]);
  }
  return out;
}

type RawConfig = Partial<Config> & { tssDepth?: unknown };

function normalizeConfig(raw: RawConfig | null): Config {
  const rawWeights =
    raw?.weights && typeof raw.weights === 'object'
      ? (raw.weights as Partial<EvaluationWeights>)
      : undefined;
  const rawBudgets =
    raw?.budgets && typeof raw.budgets === 'object'
      ? (raw.budgets as Partial<Record<Mode, Partial<TimeBudget>>>)
      : undefined;

  const merged: Config = {
    ...DEFAULT_CONFIG,
    weights: mergeWeights(DEFAULT_CONFIG.weights, rawWeights),
    budgets: mergeBudgets(DEFAULT_CONFIG.budgets, rawBudgets),
  };

  if (!raw) return merged;

  const quickDepth = isFiniteNumber(raw.quickDepth)
    ? raw.quickDepth
    : isFiniteNumber(raw.tssDepth)
      ? raw.tssDepth
      : undefined;
  if (isFiniteNumber(quickDepth)) merged.quickDepth = quickDepth;
  if (isFiniteNumber(raw.pvsDepth)) merged.pvsDepth = raw.pvsDepth;
  if (isFiniteNumber(raw.mctsBranch)) merged.mctsBranch = raw.mctsBranch;
  if (isFiniteNumber(raw.complexityThreshold)) {
    merged.complexityThreshold = raw.complexityThreshold;
  }
  if (isFiniteNumber(raw.dlTimeShare)) merged.dlTimeShare = raw.dlTimeShare;

  return merged;
}


function hasStrictDoubleLive3(
  state: GameState,
  report: ThreatReport,
): boolean {
  const val = report.player === 'BLACK' ? 1 : 2;
  const threats = collectOpenThreeThreats(state, val);
  return countOpenThreeLines(threats) >= 2;
}

function live3LineIds(
  state: GameState,
  myVal: 1 | 2,
  pos: Position,
): number[] {
  const lines = getLinesForCell(pos);
  const cellIdx = posIdx(pos.x, pos.y);
  const ids: number[] = [];
  const oppVal = myVal === 1 ? 2 : 1;

  for (const line of lines) {
    const idx = line.indexOf[cellIdx];
    if (idx < 0) continue;
    const vals = line.cells.map(p => state.board[p.y][p.x]);
    vals[idx] = myVal;

    let left = idx;
    while (left - 1 >= 0 && vals[left - 1] === myVal) left -= 1;
    let right = idx;
    while (right + 1 < vals.length && vals[right + 1] === myVal) right += 1;
    const runLen = right - left + 1;
    const spanLen = computeSpanLen(vals, left, right, oppVal);
    if (spanLen < 6) continue;

    const leftPos = left - 1 >= 0 ? line.cells[left - 1] : line.before;
    const rightPos = right + 1 < vals.length ? line.cells[right + 1] : line.after;
    const leftOpen =
      !!leftPos && state.board[leftPos.y][leftPos.x] === 0;
    const rightOpen =
      !!rightPos && state.board[rightPos.y][rightPos.x] === 0;
    if (runLen === 3 && leftOpen && rightOpen) {
      ids.push(line.id);
      continue;
    }

    const startMin = Math.max(0, idx - 5);
    const startMax = Math.min(idx, vals.length - 6);
    let foundSplit = false;
    for (let start = startMin; start <= startMax; start++) {
      if (vals[start] !== 0 || vals[start + 5] !== 0) continue;
      const v1 = vals[start + 1];
      const v2 = vals[start + 2];
      const v3 = vals[start + 3];
      const v4 = vals[start + 4];
      const patternA =
        v1 === myVal && v2 === myVal && v3 === 0 && v4 === myVal;
      const patternB =
        v1 === myVal && v2 === 0 && v3 === myVal && v4 === myVal;
      if (!patternA && !patternB) continue;
      const stoneHit =
        patternA
          ? idx === start + 1 || idx === start + 2 || idx === start + 4
          : idx === start + 1 || idx === start + 3 || idx === start + 4;
      if (!stoneHit) continue;
      const splitSpan = computeSpanLen(vals, start + 1, start + 4, oppVal);
      if (splitSpan < 6) continue;
      foundSplit = true;
      break;
    }
    if (foundSplit) ids.push(line.id);
  }

  return ids;
}

function pickDoubleLive3TwoStoneMove(
  report: ThreatReport,
  state: GameState,
): Position[] | null {
  const hits = report.byType.LIVE3;
  if (hits.length < 2) return null;

  const myVal = report.player === 'BLACK' ? 1 : 2;
  const center = (BOARD_SIZE - 1) / 2;
  const lineCandidates = new Map<number, Map<number, { p: Position; dist: number }>>();
  for (const hit of hits) {
    const points = hit.keyPoints.length > 0 ? hit.keyPoints : hit.defensePoints;
    for (const p of points) {
      if (state.board[p.y]?.[p.x] !== 0) continue;
      const lineIds = live3LineIds(state, myVal, p);
      if (lineIds.length === 0) continue;
      const dist = Math.abs(p.x - center) + Math.abs(p.y - center);
      const key = posIdx(p.x, p.y);
      for (const lineId of lineIds) {
        let bucket = lineCandidates.get(lineId);
        if (!bucket) {
          bucket = new Map<number, { p: Position; dist: number }>();
          lineCandidates.set(lineId, bucket);
        }
        const prev = bucket.get(key);
        if (!prev || dist < prev.dist) {
          bucket.set(key, { p, dist });
        }
      }
    }
  }

  if (lineCandidates.size < 2) return null;

  const lineIds = [...lineCandidates.keys()];
  let bestPair: [Position, Position] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < lineIds.length; i++) {
    const listA = [...lineCandidates.get(lineIds[i])!.values()].sort(
      (a, b) => a.dist - b.dist,
    );
    for (let j = i + 1; j < lineIds.length; j++) {
      const listB = [...lineCandidates.get(lineIds[j])!.values()].sort(
        (a, b) => a.dist - b.dist,
      );
      for (const a of listA) {
        for (const b of listB) {
          if (posIdx(a.p.x, a.p.y) === posIdx(b.p.x, b.p.y)) continue;
          const score = a.dist + b.dist;
          if (score < bestScore) {
            bestScore = score;
            bestPair = [a.p, b.p];
          }
        }
      }
    }
  }

  return bestPair ? [bestPair[0], bestPair[1]] : null;
}

function hasOpponentInitiative(
  state: GameState,
  report: ThreatReport,
  includeDoubleLive3 = true,
): boolean {
  return (
    report.winIn1.length > 0 ||
    report.winIn2.length > 0 ||
    report.byType.LIVE4.length > 0 ||
    report.byType.DOUBLE_FOUR.length > 0 ||
    report.byType.FOUR_THREE.length > 0 ||
    report.byType.DOUBLE_THREE.length > 0 ||
    (includeDoubleLive3 && hasStrictDoubleLive3(state, report))
  );
}

function pickClosestEmpty(
  state: GameState,
  avoid: Set<number>,
): Position | null {
  const center = (BOARD_SIZE - 1) / 2;
  let bestNonDead: Position | null = null;
  let bestNonDeadDist = Infinity;
  let bestAny: Position | null = null;
  let bestAnyDist = Infinity;
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) continue;
      const key = posIdx(x, y);
      if (avoid.has(key)) continue;
      const dist = Math.abs(x - center) + Math.abs(y - center);
      if (dist < bestAnyDist) {
        bestAnyDist = dist;
        bestAny = { x, y };
      }
      const p = { x, y };
      if (isDeadLineCell(state, p)) continue;
      if (dist < bestNonDeadDist) {
        bestNonDeadDist = dist;
        bestNonDead = p;
      }
    }
  }
  return bestNonDead ?? bestAny;
}

function pickDoubleLive3DefenseMove(
  oppReport: ThreatReport,
  state: GameState,
  player: Player,
): Move | null {
  const need = getStonesToPlace(state.moveNumber, player);
  const oppVal = oppReport.player === 'BLACK' ? 1 : 2;
  const center = (BOARD_SIZE - 1) / 2;

  const threats = collectOpenThreeThreats(state, oppVal);
  if (countOpenThreeLines(threats) < 2) return null;

  const lineMap = new Map<number, { lineId: number; threatCount: number; ends: Map<number, Position> }>();
  for (const threat of threats) {
    let entry = lineMap.get(threat.lineId);
    if (!entry) {
      entry = { lineId: threat.lineId, threatCount: 0, ends: new Map<number, Position>() };
      lineMap.set(threat.lineId, entry);
    }
    entry.threatCount += 1;
    for (const p of threat.ends) {
      const key = posIdx(p.x, p.y);
      entry.ends.set(key, p);
    }
  }

  const lineEntries = [...lineMap.values()]
    .map(entry => ({
      lineId: entry.lineId,
      threatCount: entry.threatCount,
      ends: [...entry.ends.values()].filter(p => state.board[p.y]?.[p.x] === 0),
    }))
    .filter(entry => entry.ends.length > 0);

  if (lineEntries.length < 2) return null;

  const coverage = new Map<number, { p: Position; lines: Set<number>; dist: number }>();
  for (const entry of lineEntries) {
    for (const p of entry.ends) {
      const key = posIdx(p.x, p.y);
      const dist = Math.abs(p.x - center) + Math.abs(p.y - center);
      let cover = coverage.get(key);
      if (!cover) {
        cover = { p, lines: new Set<number>(), dist };
        coverage.set(key, cover);
      }
      if (dist < cover.dist) cover.dist = dist;
      cover.lines.add(entry.lineId);
    }
  }

  if (coverage.size === 0) return null;

  if (need === 1) {
    const best = [...coverage.values()].sort((a, b) => {
      if (b.lines.size !== a.lines.size) return b.lines.size - a.lines.size;
      return a.dist - b.dist;
    })[0];
    return { player, positions: [best.p] };
  }

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
    return { player, positions: [bestPair[0], bestPair[1]] };
  }

  const fallback = [...coverage.values()].sort((a, b) => a.dist - b.dist);
  if (fallback.length >= 2) {
    return { player, positions: [fallback[0].p, fallback[1].p] };
  }

  return null;
}

function pickDoubleLive3AttackMove(
  myReport: ThreatReport,
  state: GameState,
  player: Player,
): Move | null {
  const need = getStonesToPlace(state.moveNumber, player);
  if (need !== 2) return null;
  const two = pickDoubleLive3TwoStoneMove(myReport, state);
  return two ? { player, positions: two } : null;
}

function isOpeningMoveSafe(state: GameState, move: Move): boolean {
  try {
    const next = applyMoveWithWinner(state, move);
    if (next.winner && next.winner !== move.player) return false;
    const { my: oppReport } = analyzeBothSidesCached(
      next,
      next.currentPlayer,
    );
    return !hasOpponentInitiative(next, oppReport, true);
  } catch {
    return false;
  }
}

function pickSafeSecondStone(
  state: GameState,
  player: Player,
  first: Position,
  avoid?: Set<number>,
): Position {
  const avoidKey = posIdx(first.x, first.y);
  const avoidSet = avoid ? new Set<number>(avoid) : new Set<number>();
  avoidSet.add(avoidKey);
  const candidates = generateRZOPCandidates(state);
  const opp = player === 'BLACK' ? 'WHITE' : 'BLACK';
  const maxScan = Math.min(24, candidates.length);
  let best: Position | null = null;
  let bestScore = -Infinity;
  let bestDist = Infinity;
  const center = (BOARD_SIZE - 1) / 2;

  const attackScore = (report: ThreatReport): number => {
    const live3Weight = 8;
    const live3Count = report.byType.LIVE3.length;
    const doubleLive3Bonus =
      live3Count >= 2 ? live3Count * live3Weight * 1.2 : 0;
    return (
      report.byType.DOUBLE_FOUR.length * 120 +
      report.byType.FOUR_THREE.length * 100 +
      report.byType.DOUBLE_THREE.length * 70 +
      report.byType.LIVE4.length * 60 +
      report.byType.CHARGE4.length * 35 +
      live3Count * live3Weight +
      doubleLive3Bonus
    );
  };

  for (let i = 0; i < maxScan; i++) {
    const p = candidates[i];
    if (state.board[p.y]?.[p.x] !== 0) continue;
    if (isDeadLineCell(state, p)) continue;
    const key = posIdx(p.x, p.y);
    if (avoidSet.has(key)) continue;
    try {
      const move: Move = { player, positions: [first, p] };
      const nextState = applyMoveWithWinner(state, move);
      const oppNeed = getStonesToPlace(nextState.moveNumber, opp);
      const { my, opp: nextOpp } = analyzeBothSidesCached(
        nextState,
        player,
      );
      if (nextOpp.winIn1.length > 0) continue;
      if (oppNeed >= 2 && nextOpp.winIn2.length > 0) continue;

      const score = attackScore(my);
      const dist = Math.abs(p.x - center) + Math.abs(p.y - center);
      if (score > bestScore || (score === bestScore && dist < bestDist)) {
        bestScore = score;
        bestDist = dist;
        best = p;
      }
    } catch {
      continue;
    }
  }

  if (best) return best;

  const fallback = pickClosestEmpty(state, avoidSet);
  if (!fallback) {
    throw new Error('No legal second stone found');
  }
  return fallback;
}

function pickForcedWinMove(
  state: GameState,
  player: Player,
  myReport: ThreatReport,
): Move | null {
  const required = getStonesToPlace(state.moveNumber, player);
  const win1 = sortByCenter(uniqueEmptyPoints(state, myReport.winIn1));
  if (win1.length > 0) {
    if (required === 1) {
      return { player, positions: [win1[0]] };
    }
    if (required === 2) {
      if (win1.length >= 2) {
        return { player, positions: [win1[0], win1[1]] };
      }
      const second = pickSafeSecondStone(state, player, win1[0]);
      return { player, positions: [win1[0], second] };
    }
  }

  if (required === 2 && myReport.winIn2.length > 0) {
    const center = (BOARD_SIZE - 1) / 2;
    let bestPair: [Position, Position] | null = null;
    let bestDist = Infinity;
    for (const [a, b] of myReport.winIn2) {
      if (state.board[a.y]?.[a.x] !== 0) continue;
      if (state.board[b.y]?.[b.x] !== 0) continue;
      if (posIdx(a.x, a.y) === posIdx(b.x, b.y)) continue;
      const dist =
        Math.abs(a.x - center) +
        Math.abs(a.y - center) +
        Math.abs(b.x - center) +
        Math.abs(b.y - center);
      if (dist < bestDist) {
        bestDist = dist;
        bestPair = [a, b];
      }
    }
    if (bestPair) {
      return { player, positions: [bestPair[0], bestPair[1]] };
    }
  }

  return null;
}

function buildBlockMoveForWin1(
  state: GameState,
  player: Player,
  oppReport: ThreatReport,
): Move | null {
  const stones = getStonesToPlace(state.moveNumber, player);
  const win1 = sortByCenter(uniqueEmptyPoints(state, oppReport.winIn1));
  if (win1.length === 0) return null;

  if (stones === 1) {
    return { player, positions: [win1[0]] };
  }

  if (win1.length >= 2) {
    return { player, positions: [win1[0], win1[1]] };
  }

  const second = pickSafeSecondStone(state, player, win1[0]);
  return { player, positions: [win1[0], second] };
}

function buildBlockMoveForWin2(
  state: GameState,
  player: Player,
  oppReport: ThreatReport,
): Move | null {
  const stones = getStonesToPlace(state.moveNumber, player);
  const pairs = oppReport.winIn2;
  if (pairs.length === 0) return null;

  const coverage = new Map<number, { p: Position; covered: Set<number> }>();
  for (let i = 0; i < pairs.length; i += 1) {
    const [a, b] = pairs[i];
    for (const p of [a, b]) {
      if (state.board[p.y]?.[p.x] !== 0) continue;
      const key = posIdx(p.x, p.y);
      if (!coverage.has(key)) {
        coverage.set(key, { p, covered: new Set<number>() });
      }
      coverage.get(key)?.covered.add(i);
    }
  }

  const items = [...coverage.entries()].map(([key, entry]) => ({
    key,
    p: entry.p,
    covered: entry.covered,
  }));
  if (items.length === 0) return null;

  const center = (BOARD_SIZE - 1) / 2;
  items.sort((a, b) => {
    if (b.covered.size !== a.covered.size) return b.covered.size - a.covered.size;
    const da = Math.abs(a.p.x - center) + Math.abs(a.p.y - center);
    const db = Math.abs(b.p.x - center) + Math.abs(b.p.y - center);
    return da - db;
  });

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
      const { my: oppAfter } = analyzeBothSidesCached(
        next,
        next.currentPlayer,
      );
      const dist = positions.reduce(
        (sum, p) => sum + Math.abs(p.x - center) + Math.abs(p.y - center),
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
  const candidates = items.slice(0, MAX_WIN2_DEFENSE_POINTS).map(item => item.p);

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
    return bestMove ?? { player, positions: [items[0].p] };
  }

  let bestMove: Move | null = null;
  let bestScore: DefenseScore | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      if (posIdx(a.x, a.y) === posIdx(b.x, b.y)) continue;
      const score = scoreDefenseMove([a, b]);
      if (!score) continue;
      if (!bestScore || isBetter(score, bestScore)) {
        bestScore = score;
        bestMove = { player, positions: [a, b] };
      }
    }
  }

  if (bestMove) return bestMove;

  const primary = items[0].p;
  const second = pickSafeSecondStone(state, player, primary);
  return { player, positions: [primary, second] };
}

function pickForcedDefenseMove(
  state: GameState,
  player: Player,
  oppReport: ThreatReport,
): Move | null {
  const win1Block = buildBlockMoveForWin1(state, player, oppReport);
  if (win1Block) return win1Block;

  const win2Block = buildBlockMoveForWin2(state, player, oppReport);
  if (win2Block) return win2Block;

  const hasInitiative =
    oppReport.byType.LIVE4.length > 0 ||
    oppReport.byType.DOUBLE_FOUR.length > 0 ||
    oppReport.byType.FOUR_THREE.length > 0;

  if (hasInitiative) {
    return buildSmartBlockForOpponentLive4(state, player, oppReport);
  }

  return null;
}

function loadConfigFromYaml(): RawConfig | null {
  const canReadFile =
    typeof fs?.existsSync === 'function' &&
    typeof fs?.readFileSync === 'function' &&
    typeof process?.cwd === 'function';
  if (!canReadFile) return null;
  const file = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as RawConfig;
  } catch {
    return null;
  }
}

export class Connect6AI {
  private mode: Mode = 'normal';
  private cfg: Config;
  private readonly evaluator: IResNetEvaluator;

  constructor(mode: Mode = 'normal', evaluator?: IResNetEvaluator) {
    const loaded = loadConfigFromYaml();
    this.cfg = normalizeConfig(loaded);
    this.mode = mode;
    this.evaluator = evaluator ?? createDefaultEvaluator();
  }

  set_search_mode(mode: Mode) {
    this.mode = mode;
  }

  async get_best_move(state: GameState, timeMs: number): Promise<Move> {
    const { my: myReport, opp: oppReport } = analyzeBothSidesCached(
      state,
      state.currentPlayer,
    );
    const forcedWin = pickForcedWinMove(
      state,
      state.currentPlayer,
      myReport,
    );
    if (forcedWin) {
      return forcedWin;
    }
    const forcedDefense = pickForcedDefenseMove(
      state,
      state.currentPlayer,
      oppReport,
    );
    if (forcedDefense) {
      return forcedDefense;
    }

    const doubleLive3Defense = pickDoubleLive3DefenseMove(
      oppReport,
      state,
      state.currentPlayer,
    );
    if (doubleLive3Defense) return doubleLive3Defense;

    const doubleLive3Attack = pickDoubleLive3AttackMove(
      myReport,
      state,
      state.currentPlayer,
    );
    if (doubleLive3Attack) return doubleLive3Attack;

    let opening: Move | null = null;
    if (!hasOpponentInitiative(state, oppReport, true)) {
      opening = getOpeningMove(state, state.currentPlayer);
      if (opening) {
        const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
        if (required === 1 && opening.positions.length > 1) {
          opening = { player: opening.player, positions: [opening.positions[0]] };
        }
        if (opening.positions.length === required && isOpeningMoveSafe(state, opening)) {
          return opening;
        }
      }
    }

    const start = Date.now();
    const budget = this.cfg.budgets[this.mode] ?? this.cfg.budgets.normal;
    const l0l1Time = Math.max(5, Math.floor(timeMs * budget.l0l1));
    const l2Time = Math.max(20, Math.floor(timeMs * budget.l2));
    const l3Time = Math.max(0, timeMs - l0l1Time - l2Time);

    // L0: Threat root direct win proof
    const l0Deadline = start + l0l1Time;
    let best: Move | null = null;

    const vcdtDeadline = start + l0l1Time;
    if (Date.now() < vcdtDeadline) {
      const vcdtTry = pvsSearchBestMove(state, state.currentPlayer, this.cfg.weights, {
        maxDepth: Math.max(1, this.cfg.quickDepth),
        timeLimitMs: Math.max(5, l0l1Time / 2),
        useMultithreading: false,
      });
      if (
        vcdtTry.debugInfo?.mode === 'threat_root' ||
        vcdtTry.debugInfo?.mode === 'vcdt_root'
      ) {
        return vcdtTry.move;
      }
      best = vcdtTry.move;
    }
    const afterL0 = Date.now();
    const remL1 = Math.max(5, l0Deadline - afterL0);

    // L1: 快速 PVS 轻搜索（使用现有 pvs_search）
    const quick = pvsSearchBestMove(state, state.currentPlayer, this.cfg.weights, {
      maxDepth: this.cfg.quickDepth,
      timeLimitMs: remL1,
      useMultithreading: false,
    });
    best = quick.move;

    const l2Deadline = start + l0l1Time + l2Time;
    const remL2 = Math.max(20, l2Deadline - Date.now());

    // L2: 深层 PVS（主搜索）
    const pvsRes = pvsSearchBestMove(state, state.currentPlayer, this.cfg.weights, {
      maxDepth: this.cfg.pvsDepth,
      timeLimitMs: remL2,
      useMultithreading: false,
    });
    let fusedMove = pvsRes.move;
    const pvsConfidence = Math.max(1, Math.log(1 + (pvsRes.debugInfo?.nodes ?? 0)));
    const evalWeights = {
      ...this.cfg.weights,
      threat_defense_weight: 1,
    } as EvaluationWeights & { threat_defense_weight: number };

    // L3: 深度 MCTS+ResNet（高复杂度中局才启用）
    let mctsMove: Move | null = null;
    let mctsConfidence = 0;
    const remTime = Math.max(0, timeMs - (Date.now() - start));
    const complexity = this.estimateComplexity(state);
    const threshold = this.cfg.complexityThreshold ?? 0.6;
    const canUseMcts = !(this.evaluator instanceof DummyResNetEvaluator);
    if (canUseMcts && remTime > 50 && l3Time > 0 && complexity >= threshold) {
      const mcts = new MCTSConnect6AI(this.evaluator, {
        simulationCount: 200,
        simulationSteps: 30,
        expandNodes: Math.max(10, Math.min(40, this.cfg.mctsBranch)),
        minWinRateThreshold: 0,
      });
      const res = await mcts.decideMove(state, state.currentPlayer);
      mctsMove = res.move;
      mctsConfidence = Math.max(1, Math.log(1 + (res.debugInfo?.visits ?? 0)));
    }

    if (mctsMove) {
      // weighted vote
      const key = (m: Move) =>
        m.positions
          .map(p => `${p.x},${p.y}`)
          .sort()
          .join('|');
      const kPvs = key(fusedMove);
      const kMcts = key(mctsMove);
      if (kPvs !== kMcts) {
        let pvsEval = 0;
        let mctsEval = 0;
        try {
          const nextPvs = applyMoveWithWinner(state, fusedMove);
          const nextMcts = applyMoveWithWinner(state, mctsMove);
          pvsEval = evaluateWithThreatReport(
            nextPvs,
            state.currentPlayer,
            evalWeights,
          );
          mctsEval = evaluateWithThreatReport(
            nextMcts,
            state.currentPlayer,
            evalWeights,
          );
        } catch {
          pvsEval = 0;
          mctsEval = 0;
        }
        const margin = Math.max(8000, Math.abs(pvsEval) * 0.08);
        if (mctsEval > pvsEval + margin) {
          fusedMove = mctsMove;
        } else if (mctsEval + margin >= pvsEval && mctsConfidence > pvsConfidence) {
          fusedMove = mctsMove;
        }
      }
    }

    return fusedMove ?? best ?? quick.move;
  }

  private estimateComplexity(state: GameState): number {
    const stones = state.board.flat().filter(c => c !== 0).length;
    const density = stones / (state.board.length * state.board.length);
    const { my, opp } = analyzeBothSidesCached(state, state.currentPlayer);
    const myThreats = my.patterns.length;
    const oppThreats = opp.patterns.length;
    const threatScore = Math.min(1, (myThreats + oppThreats) / 8);
    return Math.min(1, density * 0.5 + threatScore * 0.5);
  }
}

export const __test__ = {
  collectOpenThreeThreats,
  hasStrictDoubleLive3,
  pickDoubleLive3DefenseMove,
};
