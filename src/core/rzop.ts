import type { GameState, Position } from '../types';
import { BOARD_SIZE } from './game_state';
import { posIdx } from './pos_key';
import { sortByCenter } from './position_utils';
import { analyzeBothCached } from './threat_service';
import type { PatternHit, PatternType, ThreatReport } from './pattern_library';
import { collectOpenThreeThreats, countOpenThreeLines } from './threat_utils';

type GameStage = 'early' | 'mid' | 'late';

const EARLY_DENSITY = 0.08;
const MID_DENSITY = 0.18;
const EARLY_MOVE_LIMIT = 12;
const MID_MOVE_LIMIT = 32;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function lerpInt(max: number, min: number, t: number): number {
  return Math.round(max - (max - min) * clamp01(t));
}

function countStones(state: GameState): number {
  let stones = 0;
  for (let y = 0; y < state.board.length; y++) {
    const row = state.board[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== 0) stones += 1;
    }
  }
  return stones;
}

function stageByMove(moveNumber: number): GameStage {
  if (moveNumber <= EARLY_MOVE_LIMIT) return 'early';
  if (moveNumber <= MID_MOVE_LIMIT) return 'mid';
  return 'late';
}

function stageByDensity(density: number): GameStage {
  if (density < EARLY_DENSITY) return 'early';
  if (density < MID_DENSITY) return 'mid';
  return 'late';
}

function maxStage(a: GameStage, b: GameStage): GameStage {
  const rank = { early: 0, mid: 1, late: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function getStage(state: GameState): { stage: GameStage; density: number } {
  const stones = countStones(state);
  const density = stones / (BOARD_SIZE * BOARD_SIZE);
  const byMove = stageByMove(state.moveNumber);
  const byDensity = stageByDensity(density);
  return { stage: maxStage(byMove, byDensity), density };
}

function computeTopK(state: GameState): number {
  const { stage, density } = getStage(state);
  switch (stage) {
    case 'early':
      return lerpInt(32, 24, density / EARLY_DENSITY);
    case 'mid':
      return lerpInt(20, 16, (density - EARLY_DENSITY) / (MID_DENSITY - EARLY_DENSITY));
    case 'late':
    default:
      return lerpInt(16, 12, (density - MID_DENSITY) / (1 - MID_DENSITY));
  }
}

function computeNearRadius(state: GameState): number {
  const { stage } = getStage(state);
  if (stage === 'early') return 3;
  if (stage === 'mid') return 2;
  return 1;
}

function sortByScore(
  points: Position[],
  scorePosition: (p: Position) => number,
): Position[] {
  const center = (BOARD_SIZE - 1) / 2;
  return points
    .map((p, index) => ({
      p,
      index,
      score: scorePosition(p),
      dist: Math.abs(p.x - center) + Math.abs(p.y - center),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.index - b.index;
    })
    .map(item => item.p);
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

function uniqueEmptyPoints(
  state: GameState,
  points: Position[],
  seen: Set<number>,
  out: Position[],
  limit?: number,
): void {
  for (const p of points) {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) continue;
    const key = posIdx(p.x, p.y);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (limit !== undefined && out.length >= limit) return;
  }
}

function collectSingleDefensePoints(
  report: ThreatReport,
  type: PatternType,
): Position[] {
  const hits: PatternHit[] = report.byType[type];
  const points: Position[] = [];
  for (const hit of hits) {
    const source = hit.defensePoints.length > 0 ? hit.defensePoints : hit.keyPoints;
    if (source.length !== 1) continue;
    points.push(source[0]);
  }
  return points;
}

function addPointsToSet(dst: Set<number>, points: Position[]): void {
  for (const p of points) {
    dst.add(posIdx(p.x, p.y));
  }
}

function computeRelevantZones(state: GameState, radius: number): Position[] {
  const occupied: Position[] = [];

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (state.board[y][x] !== 0) {
        occupied.push({ x, y });
      }
    }
  }

  const result: Position[] = [];

  if (occupied.length === 0) {
    const c = Math.floor(BOARD_SIZE / 2);
    const base: Position[] = [{ x: c, y: c }];
    const offsets = [
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: -1 },
    ];

    for (const { dx, dy } of offsets) {
      const nx = c + dx;
      const ny = c + dy;
      if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
      base.push({ x: nx, y: ny });
    }

    for (const p of base) {
      if (state.board[p.y][p.x] === 0) {
        result.push(p);
      }
    }
    return result;
  }

  const marked = new Set<number>();

  for (const p of occupied) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        if (state.board[ny][nx] !== 0) continue;

        const key = posIdx(nx, ny);
        if (!marked.has(key)) {
          marked.add(key);
          result.push({ x: nx, y: ny });
        }
      }
    }
  }

  return result;
}

export function generateRZOPCandidates(state: GameState): Position[] {
  const player = state.currentPlayer;
  const { my: myReport, opp: oppReport } = analyzeBothCached(state, player);
  const topK = computeTopK(state);
  const nearRadius = computeNearRadius(state);

  const oppWinBlock = new Set<number>();
  addPointsToSet(oppWinBlock, oppReport.winIn1);
  for (const [a, b] of oppReport.winIn2) {
    addPointsToSet(oppWinBlock, [a, b]);
  }

  const oppDefense = new Set<number>();
  addPointsToSet(oppDefense, oppReport.defensePoints);
  addPointsToSet(oppDefense, oppReport.mustDefendPoints);

  const myAttack = new Set<number>();
  addPointsToSet(myAttack, myReport.attackPoints);

  const scorePosition = (p: Position): number => {
    const key = posIdx(p.x, p.y);
    if (oppWinBlock.has(key)) return 3;
    if (oppDefense.has(key)) return 2;
    if (myAttack.has(key)) return 1;
    return 0;
  };

  const urgent: Position[] = [];
  const seen = new Set<number>();

  uniqueEmptyPoints(state, oppReport.winIn1, seen, urgent);
  for (const [a, b] of oppReport.winIn2) {
    uniqueEmptyPoints(state, [a, b], seen, urgent);
  }

  const chargeDefense = [
    ...collectSingleDefensePoints(oppReport, 'CHARGE5'),
    ...collectSingleDefensePoints(oppReport, 'CHARGE4'),
  ];
  uniqueEmptyPoints(state, chargeDefense, seen, urgent);

  const compositeDefense = collectKeyPointsByType(oppReport, [
    'DOUBLE_FOUR',
    'FOUR_THREE',
    'DOUBLE_THREE',
    'LIVE4',
  ]);
  uniqueEmptyPoints(state, compositeDefense, seen, urgent);

  // Connect6: 单条活三不值得“二子两头都堵”；这里只把“严格双活三”（两条不同线路）作为紧急候选。
  const oppVal = player === 'BLACK' ? 2 : 1;
  const oppOpen3 = collectOpenThreeThreats(state, oppVal);
  if (countOpenThreeLines(oppOpen3) >= 2) {
    const ends = new Map<number, Position>();
    for (const t of oppOpen3) {
      for (const p of t.ends) {
        ends.set(posIdx(p.x, p.y), p);
      }
    }
    uniqueEmptyPoints(state, [...ends.values()], seen, urgent);
  }

  const limit = Math.min(topK, 16);

  if (urgent.length >= limit) {
    return sortByScore(urgent.slice(0, limit), scorePosition);
  }

  const nonUrgent: Position[] = [];
  const remainingSlots = () => limit - urgent.length - nonUrgent.length;
  if (remainingSlots() <= 0) return urgent;

  const myLive3 = collectKeyPointsByType(myReport, ['LIVE3']);
  if (myLive3.length >= 2) {
    uniqueEmptyPoints(
      state,
      sortByCenter(myLive3),
      seen,
      nonUrgent,
      remainingSlots(),
    );
  }

  const initiative = sortByCenter(
    collectKeyPointsByType(myReport, [
      'DOUBLE_FOUR',
      'FOUR_THREE',
      'DOUBLE_THREE',
      'LIVE4',
      'CHARGE4',
      'LIVE3',
    ]),
  );
  if (remainingSlots() > 0) {
    uniqueEmptyPoints(state, initiative, seen, nonUrgent, remainingSlots());
  }

  if (remainingSlots() > 0) {
    const attackPoints = sortByCenter(myReport.attackPoints);
    uniqueEmptyPoints(state, attackPoints, seen, nonUrgent, remainingSlots());
  }

  if (remainingSlots() > 0) {
    const neighbors = sortByCenter(computeRelevantZones(state, nearRadius));
    uniqueEmptyPoints(
      state,
      neighbors,
      seen,
      nonUrgent,
      remainingSlots(),
    );
  }

  return sortByScore([...urgent, ...nonUrgent], scorePosition).slice(0, limit);
}
