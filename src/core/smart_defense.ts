// core/smart_defense.ts

import type { GameState, Player, Position, Move } from '../types';
import { applyMoveWithWinner } from './rules';
import { generateRZOPCandidates } from './rzop';
import { detectVCDT, type VCDTThreat } from './vcdt';
import { BOARD_SIZE } from './game_state';

function otherPlayer(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

/**
 * 在给定 state 下，假设 rootPlayer 只在 blockPos 落 1 子，
 * 检查对手是否还存在任何 “一手必杀”（threatLevel 0 或 1）。
 * 若没有，则认为“只堵这一边是安全的”。
 */
function isSingleBlockSafe(
  state: GameState,
  rootPlayer: Player,
  blockPos: Position,
): boolean {
  // 该点必须是空位
  if (state.board[blockPos.y][blockPos.x] !== 0) return false;

  const tmpState = applyMoveWithWinner(state, {
    player: rootPlayer,
    positions: [blockPos],
  });

  const opp = otherPlayer(rootPlayer);
  const oppThreatsAfter = detectVCDT(tmpState, opp);

  // 对手是否还存在任何一手获胜（单点赢 / 一手两子必杀）
  const hasImmediateWin = oppThreatsAfter.some(
    t => t.isWinning && (t.threatLevel === 0 || t.threatLevel === 1),
  );

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
 * - 先尝试“只堵一边是否安全”（用 isSingleBlockSafe 模拟）；
 * - 若有安全的一边，则只堵这一点，第二子交给 RZOP；
 * - 若都不安全，则退回“两头都堵”的传统策略。
 */
export function buildSmartBlockForOpponentLive4(
  state: GameState,
  rootPlayer: Player,
  threat: VCDTThreat,
): Move {
  const empties: Position[] = [];
  const seen = new Set<string>();

  for (const p of threat.positions) {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) continue;
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    empties.push(p);
  }

  // 正常活四应该有两个空位
  if (empties.length >= 2) {
    const safeSingles: Position[] = [];

    for (const e of empties) {
      if (isSingleBlockSafe(state, rootPlayer, e)) {
        safeSingles.push(e);
      }
    }

    if (safeSingles.length > 0) {
      // 有至少一边，单边堵是安全的 → 选一个相对更好的点
      const must = pickBestByCenter(safeSingles);
      const candidates = generateRZOPCandidates(state).filter(
        p => !(p.x === must.x && p.y === must.y),
      );
      const second = candidates[0] ?? must;
      return {
        player: rootPlayer,
        positions: [must, second],
      };
    }

    // 没有安全的单边 → 保险起见，还是两头都堵
    return {
      player: rootPlayer,
      positions: [empties[0], empties[1]],
    };
  }

  // 如果只有一个空位（说明另一头早被你或边界封死），那就只堵这一个，
  // 第二子正常运营。
  if (empties.length === 1) {
    const must = empties[0];
    const candidates = generateRZOPCandidates(state).filter(
      p => !(p.x === must.x && p.y === must.y),
    );
    const second = candidates[0] ?? must;
    return {
      player: rootPlayer,
      positions: [must, second],
    };
  }

  // 理论上不太会到这一步，兜底给一个随便的落子
  const candidates = generateRZOPCandidates(state);
  if (candidates.length === 0) {
    return {
      player: rootPlayer,
      positions: [],
    };
  }
  if (candidates.length === 1) {
    return {
      player: rootPlayer,
      positions: [candidates[0]],
    };
  }
  return {
    player: rootPlayer,
    positions: [candidates[0], candidates[1]],
  };
}
