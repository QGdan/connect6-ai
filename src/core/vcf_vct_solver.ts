import type { GameState, Move, Player, Position } from '../types';
import { BOARD_SIZE } from '../types';
import type { PatternType, ThreatReport } from './pattern_library';
import { analyzeThreatCached } from './threat_service';
import { getStonesToPlace, tryApplyMoveWithWinner } from './rules';
import { posIdx } from './pos_key';
import { sortByCenter, uniqueEmptyPoints } from './position_utils';

export type TacticalHint = {
  kind: 'vcf' | 'vct';
  moves: Move[];
  line?: Move[];
  nodes: number;
  depth: number;
};

export type TacticalSolveOptions = {
  maxDepth: number;
  maxNodes: number;
  timeLimitMs: number;
  maxBranch?: number;
};

type SolverContext = {
  nodes: number;
  maxNodes: number;
  deadline: number;
  maxBranch: number;
};

const VCF_TYPES: PatternType[] = [
  'WIN_IN_1',
  'WIN_IN_2',
  'LIVE5',
  'CHARGE5',
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
];

const VCT_TYPES: PatternType[] = [...VCF_TYPES, 'LIVE3'];

const DEFAULT_MAX_BRANCH = 6;
const MAX_COMBOS = 20;

function moveKey(move: Move): string {
  return move.positions
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
}

function pairKey(a: Position, b: Position): number {
  const base = BOARD_SIZE * BOARD_SIZE;
  const aIdx = posIdx(a.x, a.y);
  const bIdx = posIdx(b.x, b.y);
  return aIdx < bIdx ? aIdx * base + bIdx : bIdx * base + aIdx;
}

function hasForcingThreat(report: ThreatReport, types: PatternType[]): boolean {
  if (report.winIn1.length > 0 || report.winIn2.length > 0) return true;
  return types.some(type => report.byType[type].length > 0);
}

function collectPointsFromHits(
  report: ThreatReport,
  types: PatternType[],
  useDefensePoints: boolean,
): Position[] {
  const out: Position[] = [];
  for (const type of types) {
    for (const hit of report.byType[type]) {
      const pts = useDefensePoints ? hit.defensePoints : hit.keyPoints;
      for (const p of pts) out.push(p);
    }
  }
  return out;
}

function pickSecondaryPoint(
  state: GameState,
  report: ThreatReport,
  primary: Position,
): Position | null {
  const avoid = new Set<number>([posIdx(primary.x, primary.y)]);
  const pool = uniqueEmptyPoints(
    state,
    [...report.attackPoints, ...report.candidatePoints],
    avoid,
  );
  const sorted = sortByCenter(pool);
  return sorted.length > 0 ? sorted[0] : null;
}

function buildSingleMoves(player: Player, points: Position[]): Move[] {
  return points.map(p => ({ player, positions: [p] }));
}

function buildTwoStoneMoves(
  state: GameState,
  player: Player,
  points: Position[],
  limit: number,
): Move[] {
  const moves: Move[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < points.length && moves.length < limit; i++) {
    for (let j = i + 1; j < points.length && moves.length < limit; j++) {
      const a = points[i];
      const b = points[j];
      if (state.board[a.y][a.x] !== 0 || state.board[b.y][b.x] !== 0) continue;
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      moves.push({ player, positions: [a, b] });
    }
  }
  return moves;
}

function collectAttackMoves(
  state: GameState,
  player: Player,
  report: ThreatReport,
  types: PatternType[],
  maxBranch: number,
): Move[] {
  const stones = getStonesToPlace(state.moveNumber, player);
  const points = collectPointsFromHits(report, types, false);
  const ordered = sortByCenter(uniqueEmptyPoints(state, points));
  const limited = ordered.slice(0, maxBranch);

  if (stones === 1) {
    return buildSingleMoves(player, limited);
  }

  const moves: Move[] = [];
  const moveSet = new Set<string>();

  for (const [a, b] of report.winIn2) {
    const key = moveKey({ player, positions: [a, b] });
    if (!moveSet.has(key)) {
      moves.push({ player, positions: [a, b] });
      moveSet.add(key);
    }
  }

  const combos = buildTwoStoneMoves(state, player, limited, MAX_COMBOS);
  for (const mv of combos) {
    const key = moveKey(mv);
    if (moveSet.has(key)) continue;
    moves.push(mv);
    moveSet.add(key);
  }

  for (const p of report.winIn1.slice(0, maxBranch)) {
    if (state.board[p.y]?.[p.x] !== 0) continue;
    const second = pickSecondaryPoint(state, report, p);
    if (!second) continue;
    const mv = { player, positions: [p, second] };
    const key = moveKey(mv);
    if (!moveSet.has(key)) {
      moves.push(mv);
      moveSet.add(key);
    }
  }

  return moves;
}

function collectDefenseMoves(
  state: GameState,
  defender: Player,
  attackReport: ThreatReport,
  types: PatternType[],
  maxBranch: number,
): Move[] {
  const stones = getStonesToPlace(state.moveNumber, defender);
  const defensePoints = [
    ...attackReport.winIn1,
    ...attackReport.winIn2.flat(),
    ...collectPointsFromHits(attackReport, types, true),
  ];
  const ordered = sortByCenter(uniqueEmptyPoints(state, defensePoints));
  const limited = ordered.slice(0, maxBranch);

  if (limited.length === 0) return [];
  if (stones === 1) return buildSingleMoves(defender, limited);

  const moves: Move[] = [];
  const moveSet = new Set<string>();

  const combos = buildTwoStoneMoves(state, defender, limited, MAX_COMBOS);
  for (const mv of combos) {
    const key = moveKey(mv);
    if (moveSet.has(key)) continue;
    moves.push(mv);
    moveSet.add(key);
  }

  if (limited.length === 1) {
    const primary = limited[0];
    const second = pickSecondaryPoint(state, attackReport, primary);
    if (second) {
      const mv = { player: defender, positions: [primary, second] };
      const key = moveKey(mv);
      if (!moveSet.has(key)) moves.push(mv);
    }
  }

  return moves;
}

function solveForcedLine(
  state: GameState,
  attacker: Player,
  types: PatternType[],
  ctx: SolverContext,
  depth: number,
): Move[] | null {
  if (ctx.nodes++ >= ctx.maxNodes) return null;
  if (Date.now() >= ctx.deadline) return null;
  if (state.winner) {
    return state.winner === attacker ? [] : null;
  }
  if (depth <= 0) return null;

  const toMove = state.currentPlayer;
  if (toMove === attacker) {
    const report = analyzeThreatCached(state, attacker);
    if (!hasForcingThreat(report, types)) return null;
    const attackMoves = collectAttackMoves(
      state,
      attacker,
      report,
      types,
      ctx.maxBranch,
    );
    for (const move of attackMoves) {
      const applied = tryApplyMoveWithWinner(state, move);
      if (!applied.ok) continue;
      const next = applied.state;
      if (next.winner === attacker) return [move];
      const line = solveForcedLine(next, attacker, types, ctx, depth - 1);
      if (line) return [move, ...line];
    }
    return null;
  }

  const attackReport = analyzeThreatCached(state, attacker);
  if (!hasForcingThreat(attackReport, types)) return null;
  const defenseMoves = collectDefenseMoves(
    state,
    toMove,
    attackReport,
    types,
    ctx.maxBranch,
  );
  if (defenseMoves.length === 0) return null;

  let bestLine: Move[] | null = null;
  for (const move of defenseMoves) {
    const applied = tryApplyMoveWithWinner(state, move);
    if (!applied.ok) continue;
    const next = applied.state;
    if (next.winner === toMove) return null;
    const line = solveForcedLine(next, attacker, types, ctx, depth - 1);
    if (!line) return null;
    if (!bestLine || line.length < bestLine.length) {
      bestLine = [move, ...line];
    }
  }

  return bestLine;
}

function findForcedMoves(
  state: GameState,
  player: Player,
  types: PatternType[],
  options: TacticalSolveOptions,
): TacticalHint | null {
  const ctx: SolverContext = {
    nodes: 0,
    maxNodes: options.maxNodes,
    deadline: Date.now() + options.timeLimitMs,
    maxBranch: options.maxBranch ?? DEFAULT_MAX_BRANCH,
  };

  const report = analyzeThreatCached(state, player);
  const attackMoves = collectAttackMoves(
    state,
    player,
    report,
    types,
    ctx.maxBranch,
  );
  const forced: Move[] = [];
  let line: Move[] | undefined;

  for (const move of attackMoves) {
    if (ctx.nodes >= ctx.maxNodes || Date.now() >= ctx.deadline) break;
    const applied = tryApplyMoveWithWinner(state, move);
    if (!applied.ok) continue;
    const next = applied.state;
    if (next.winner === player) {
      forced.push(move);
      line = line ?? [move];
      continue;
    }
    const branch = solveForcedLine(next, player, types, ctx, options.maxDepth - 1);
    if (branch) {
      forced.push(move);
      line = line ?? [move, ...branch];
    }
  }

  if (forced.length === 0) return null;
  return {
    kind: types === VCF_TYPES ? 'vcf' : 'vct',
    moves: forced,
    line,
    nodes: ctx.nodes,
    depth: options.maxDepth,
  };
}

export function buildVcfVctDefenseMoves(
  state: GameState,
  defender: Player,
  attacker: Player,
  hintKind: TacticalHint['kind'],
  options: TacticalSolveOptions,
): Move[] {
  const types = hintKind === 'vcf' ? VCF_TYPES : VCT_TYPES;
  const report = analyzeThreatCached(state, attacker);
  return collectDefenseMoves(
    state,
    defender,
    report,
    types,
    options.maxBranch ?? DEFAULT_MAX_BRANCH,
  );
}

export function findVcfVctRootHints(
  state: GameState,
  player: Player,
  options: TacticalSolveOptions,
): TacticalHint | null {
  const vcf = findForcedMoves(state, player, VCF_TYPES, options);
  if (vcf) return vcf;
  return findForcedMoves(state, player, VCT_TYPES, options);
}
