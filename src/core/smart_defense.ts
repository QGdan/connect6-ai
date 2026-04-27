// core/smart_defense.ts

import type { GameState, Player, Position, Move } from '../types';
import { applyMoveWithWinner, checkWinner, getStonesToPlace } from './rules';
import { generateRZOPCandidates } from './rzop';
import { analyzeBothSidesCached, analyzeCached } from './threat_service';
import type { PatternType, ThreatReport } from './pattern_library';
import { applyMove, BOARD_SIZE } from './game_state';
import { posIdx } from './pos_key';
import { isDeadLineCell } from './line_potential';

function otherPlayer(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

const DEFENSE_TYPE_WEIGHTS: Partial<Record<PatternType, number>> = {
  WIN_IN_1: 12,
  WIN_IN_2: 8,
  DOUBLE_FOUR: 9,
  FOUR_THREE: 7,
  LIVE4: 5,
  CHARGE4: 3,
  DOUBLE_THREE: 2,
  LIVE3: 1,
};
const MAX_DEFENSE_CANDIDATES = 12;

type DefenseScore = {
  win1: number;
  win2: number;
  doubleFour: number;
  fourThree: number;
  live4: number;
  doubleThree: number;
  dist: number;
};

function collectDefenseCandidates(
  state: GameState,
  report: ThreatReport,
): Position[] {
  const scored = new Map<number, { p: Position; score: number }>();
  for (const [type, weight] of Object.entries(DEFENSE_TYPE_WEIGHTS)) {
    const hits = report.byType[type as PatternType];
    if (!hits || hits.length === 0) continue;
    for (const hit of hits) {
      const source =
        hit.defensePoints.length > 0 ? hit.defensePoints : hit.keyPoints;
      for (const p of source) {
        if (state.board[p.y]?.[p.x] !== 0) continue;
        const key = posIdx(p.x, p.y);
        const prev = scored.get(key);
        const nextScore = (prev?.score ?? 0) + (weight ?? 0);
        scored.set(key, { p, score: nextScore });
      }
    }
  }

  for (const p of report.defensePoints) {
    if (state.board[p.y]?.[p.x] !== 0) continue;
    const key = posIdx(p.x, p.y);
    if (!scored.has(key)) scored.set(key, { p, score: 0 });
  }

  const center = (BOARD_SIZE - 1) / 2;
  return [...scored.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const da = Math.abs(a.p.x - center) + Math.abs(a.p.y - center);
      const db = Math.abs(b.p.x - center) + Math.abs(b.p.y - center);
      return da - db;
    })
    .map(item => item.p);
}

function scoreDefenseMove(
  state: GameState,
  player: Player,
  positions: Position[],
): DefenseScore | null {
  try {
    const next = applyMoveWithWinner(state, { player, positions });
    const { my: oppAfter } = analyzeBothSidesCached(
      next,
      next.currentPlayer,
    );
    const center = (BOARD_SIZE - 1) / 2;
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
}

function isBetterDefense(a: DefenseScore, b: DefenseScore): boolean {
  if (a.win1 !== b.win1) return a.win1 < b.win1;
  if (a.win2 !== b.win2) return a.win2 < b.win2;
  if (a.doubleFour !== b.doubleFour) return a.doubleFour < b.doubleFour;
  if (a.fourThree !== b.fourThree) return a.fourThree < b.fourThree;
  if (a.live4 !== b.live4) return a.live4 < b.live4;
  if (a.doubleThree !== b.doubleThree) return a.doubleThree < b.doubleThree;
  return a.dist < b.dist;
}

function allowsOpponentImmediateWin(
  state: GameState,
  rootPlayer: Player,
): boolean {
  const opp = otherPlayer(rootPlayer);
  const oppReport = analyzeCached(state, opp);
  const oppNeed = getStonesToPlace(state.moveNumber, opp);
  return (
    oppReport.winIn1.length > 0 ||
    (oppNeed >= 2 && oppReport.winIn2.length > 0)
  );
}

function findAnyEmpty(
  state: GameState,
  avoid?: Position,
): Position | null {
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) continue;
      if (avoid && avoid.x === x && avoid.y === y) continue;
      const p = { x, y };
      if (!isDeadLineCell(state, p)) return p;
    }
  }
  for (let y = 0; y < state.board.length; y++) {
    for (let x = 0; x < state.board[y].length; x++) {
      if (state.board[y][x] !== 0) continue;
      if (avoid && avoid.x === x && avoid.y === y) continue;
      return { x, y };
    }
  }
  return null;
}

function pickSecondStone(
  state: GameState,
  rootPlayer: Player,
  must: Position,
  candidates: Position[],
): Position | null {
  const preferred: Position[] = [];
  const fallback: Position[] = [];
  const seen = new Set<number>();

  for (const p of candidates) {
    if (state.board[p.y]?.[p.x] !== 0) continue;
    if (p.x === must.x && p.y === must.y) continue;
    const key = posIdx(p.x, p.y);
    if (seen.has(key)) continue;
    seen.add(key);

    let next: GameState;
    try {
      next = applyMoveWithWinner(state, {
        player: rootPlayer,
        positions: [must, p],
      });
    } catch {
      continue;
    }

    if (next.winner && next.winner !== rootPlayer) continue;
    if (allowsOpponentImmediateWin(next, rootPlayer)) continue;

    if (isMoveSafe(state, rootPlayer, p)) preferred.push(p);
    else fallback.push(p);
  }

  const pool = preferred.length > 0 ? preferred : fallback;
  return pool.length > 0 ? pickBestByCenter(pool) : null;
}

/**
 * 在给定 state 下，假设 rootPlayer 只在 blockPos 落 1 子，
 * 检查对手是否还存在任何 “一手必杀”（threatLevel 0 或 1）。
 * 若没有，则认为“只堵这一边是安全的”。
 */
export function isMoveSafe(
  state: GameState,
  rootPlayer: Player,
  blockPos: Position,
): boolean {
  // 该点必须是空位
  if (state.board[blockPos.y][blockPos.x] !== 0) return false;

  const required = getStonesToPlace(state.moveNumber, rootPlayer);
  let tmpState: GameState;
  if (required === 1) {
    tmpState = applyMoveWithWinner(state, {
      player: rootPlayer,
      positions: [blockPos],
    });

    if (tmpState.winner) {
      return tmpState.winner === rootPlayer;
    }
  } else {
    tmpState = applyMove(state, {
      player: rootPlayer,
      positions: [blockPos],
    });
    const winner = checkWinner(tmpState);
    if (winner) {
      return winner === rootPlayer;
    }
  }

  const opp = otherPlayer(rootPlayer);
  const oppReport = analyzeCached(tmpState, opp);
  const oppNeed = getStonesToPlace(tmpState.moveNumber, opp);
  const hasImmediateWin =
    oppReport.winIn1.length > 0 ||
    (oppNeed >= 2 && oppReport.winIn2.length > 0);

  return !hasImmediateWin;
}

/**
 * 从若干候选点中，选一个离棋盘中心更近的（稍微好看一点）。
 */
function pickBestByCenter(candidates: Position[]): Position {
  if (candidates.length === 0) {
    throw new Error('pickBestByCenter called with empty candidates');
  }
  const center = (BOARD_SIZE - 1) / 2;
  let best = candidates[0];
  let bestDist =
    Math.abs(best.x - center) + Math.abs(best.y - center);

  for (let i = 1; i < candidates.length; i++) {
    const p = candidates[i];
    const d = Math.abs(p.x - center) + Math.abs(p.y - center);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * 对手活四（threatLevel=2）的智能防守：
 * - 先尝试“只堵一边是否安全”（用 isMoveSafe 模拟）；
 * - 若有安全的一边，则只堵这一点，第二子交给 RZOP；
 * - 若都不安全，则退回“两头都堵”的传统策略。
 */
export function buildSmartBlockForOpponentLive4(
  state: GameState,
  rootPlayer: Player,
  report: ThreatReport,
): Move {
  const need = getStonesToPlace(state.moveNumber, rootPlayer);
  const candidates = collectDefenseCandidates(state, report).slice(
    0,
    MAX_DEFENSE_CANDIDATES,
  );

  if (candidates.length > 0) {
    if (need === 1) {
      let bestMove: Move | null = null;
      let bestScore: DefenseScore | null = null;
      for (const p of candidates) {
        const score = scoreDefenseMove(state, rootPlayer, [p]);
        if (!score) continue;
        if (!bestScore || isBetterDefense(score, bestScore)) {
          bestScore = score;
          bestMove = { player: rootPlayer, positions: [p] };
        }
      }
      if (bestMove) return bestMove;
    } else if (need === 2 && candidates.length >= 2) {
      let bestMove: Move | null = null;
      let bestScore: DefenseScore | null = null;
      for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
          const a = candidates[i];
          const b = candidates[j];
          if (posIdx(a.x, a.y) === posIdx(b.x, b.y)) continue;
          const score = scoreDefenseMove(state, rootPlayer, [a, b]);
          if (!score) continue;
          if (!bestScore || isBetterDefense(score, bestScore)) {
            bestScore = score;
            bestMove = { player: rootPlayer, positions: [a, b] };
          }
        }
      }
      if (bestMove) return bestMove;
    }
  }

  const seen = new Set<number>();
  const empties: Position[] = [];
  for (const p of report.defensePoints) {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) continue;
    const key = posIdx(p.x, p.y);
    if (seen.has(key)) continue;
    seen.add(key);
    empties.push(p);
  }

  const safeSingles = empties.filter(p => isMoveSafe(state, rootPlayer, p));
  const must =
    empties.length > 0
      ? pickBestByCenter(safeSingles.length > 0 ? safeSingles : empties)
      : null;

  if (need === 1) {
    const primary = must ?? findAnyEmpty(state);
    if (!primary) {
      throw new Error('No legal block position available');
    }
    return { player: rootPlayer, positions: [primary] };
  }

  const primary = must ?? findAnyEmpty(state);
  if (!primary) {
    throw new Error('No legal block position available');
  }

  const rzopCandidates = generateRZOPCandidates(state).filter(
    p => !(p.x === primary.x && p.y === primary.y),
  );
  let second = pickSecondStone(state, rootPlayer, primary, rzopCandidates);

  if (!second) {
    const allCandidates: Position[] = [];
    for (let y = 0; y < state.board.length; y++) {
      for (let x = 0; x < state.board[y].length; x++) {
        if (state.board[y][x] !== 0) continue;
        if (x === primary.x && y === primary.y) continue;
        allCandidates.push({ x, y });
      }
    }
    second = pickSecondStone(state, rootPlayer, primary, allCandidates);
  }

  if (!second) {
    throw new Error('No legal second stone found');
  }
  return { player: rootPlayer, positions: [primary, second] };
}
