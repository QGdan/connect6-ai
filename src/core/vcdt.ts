import type { GameState, Player, Position } from '../types';
import { getAllRoads } from './road_encoding';

export interface VCDTThreat {
  positions: Position[]; // 一个或两个关键点（同一条路上的关键空点）
  isWinning: boolean;
  /**
   * 0 = 单点赢局（5 子 + 1 空，只下一个就赢）
   * 1 = 双点赢局 / 一手两子即可连六（两个点都下就赢）
   * 2 = 活四威胁（4 子 + 2 空，一般性威胁，两个点在同一路上）
   * 3 = 预留：活三威胁
   */
  threatLevel: number;
}

// 1. 直接赢局点（5 子 + 1 空：只下一个就能连六）
function detectWinningMoves(state: GameState, player: Player): Position[] {
  const roads = getAllRoads();
  const myVal = player === 'BLACK' ? 1 : 2;
  const oppVal = player === 'BLACK' ? 2 : 1;
  const winningCells = new Set<string>();

  for (const road of roads) {
    const cells = road.cells.map(p => state.board[p.y][p.x]);
    const myCount = cells.filter(c => c === myVal).length;
    const oppCount = cells.filter(c => c === oppVal).length;

    // 在该 6 格路段上，只有己方子和空位，且己方已有 5 子 → 剩余那个空位即为必杀点
    if (oppCount === 0 && myCount === 5) {
      road.cells.forEach((p, idx) => {
        if (cells[idx] === 0) {
          winningCells.add(`${p.x},${p.y}`);
        }
      });
    }
  }

  return Array.from(winningCells).map(key => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  });
}

/**
 * 2. 活四威胁：按“路”为单位返回
 *    - 条件：4 子 + 2 空，且该路上无对方棋
 *    - 返回：每条满足条件的路上的“两个空位”作为一个 segment
 */
function detectLive4Segments(
  state: GameState,
  player: Player,
): Position[][] {
  const roads = getAllRoads();
  const myVal = player === 'BLACK' ? 1 : 2;
  const oppVal = player === 'BLACK' ? 2 : 1;

  const segments: Position[][] = [];
  const segSet = new Set<string>(); // 用空位坐标对做无序去重

  for (const road of roads) {
    const cells = road.cells.map(p => state.board[p.y][p.x]);

    let myCount = 0;
    let oppCount = 0;
    const empties: Position[] = [];

    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (v === myVal) myCount++;
      else if (v === oppVal) oppCount++;
      else if (v === 0) {
        const p = road.cells[i];
        empties.push({ x: p.x, y: p.y });
      }
    }

    // 该 6 格路段上只有己方子和空位，且恰好是“4 子 + 2 空”
    if (oppCount === 0 && myCount === 4 && empties.length === 2) {
      // 无序去重，避免同一个“4 子 + 2 空”模式被滑窗重复统计
      const [e1, e2] = empties;
      const k1 = `${e1.x},${e1.y}`;
      const k2 = `${e2.x},${e2.y}`;
      const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;

      if (!segSet.has(key)) {
        segSet.add(key);
        segments.push(empties);
      }
    }
  }

  return segments;
}

// 3. 一手两子即可连六的「双点必杀」（4 子 + 2 空，且该路上无对手棋）
//    与活四 segment 类似，但这里专门用来标记“当前一手两子就能直接获胜”的情况
function detectTwoStoneWinningPairs(
  state: GameState,
  player: Player,
): [Position, Position][] {
  const roads = getAllRoads();
  const myVal = player === 'BLACK' ? 1 : 2;
  const oppVal = player === 'BLACK' ? 2 : 1;

  const pairSet = new Set<string>();
  const pairs: [Position, Position][] = [];

  for (const road of roads) {
    const cells = road.cells.map(p => state.board[p.y][p.x]);

    let myCount = 0;
    let oppCount = 0;
    const emptyIdx: number[] = [];

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c === myVal) myCount++;
      else if (c === oppVal) oppCount++;
      else if (c === 0) emptyIdx.push(i);
    }

    // 本路上 4 子 + 2 空，且没有对方棋：
    // 当前方只要在这两个空位下一手两子，就能在这条路上形成 6 连。
    if (oppCount === 0 && myCount === 4 && emptyIdx.length === 2) {
      const p1 = road.cells[emptyIdx[0]];
      const p2 = road.cells[emptyIdx[1]];

      // 无序去重（同一对点可能出现在多条 6 格路的滑窗里）
      const key =
        p1.x < p2.x || (p1.x === p2.x && p1.y <= p2.y)
          ? `${p1.x},${p1.y}|${p2.x},${p2.y}`
          : `${p2.x},${p2.y}|${p1.x},${p1.y}`;

      if (!pairSet.has(key)) {
        pairSet.add(key);
        pairs.push([p1, p2]);
      }
    }
  }

  return pairs;
}

export function detectVCDT(state: GameState, player: Player): VCDTThreat[] {
  const winningCells = detectWinningMoves(state, player);          // 单点 5+1 赢
  const live4Segments = detectLive4Segments(state, player);        // 按路划分的活四段（每段两个空点）
  const twoStonePairs = detectTwoStoneWinningPairs(state, player); // 4+2 一手两子赢

  const threats: VCDTThreat[] = [];

  // 1. 直接赢局点（单点赢局）
  for (const pos of winningCells) {
    threats.push({
      positions: [pos],
      isWinning: true,
      threatLevel: 0,
    });
  }

  // 1.b 一手两子即可连六的双点必杀（4 子 + 2 空）
  for (const [p1, p2] of twoStonePairs) {
    threats.push({
      positions: [p1, p2],
      isWinning: true,
      threatLevel: 1,
    });
  }

  // 2. 多个单点赢局组合成的双点必杀（经典“双活五”）
  if (winningCells.length >= 2) {
    for (let i = 0; i < winningCells.length; i++) {
      for (let j = i + 1; j < winningCells.length; j++) {
        threats.push({
          positions: [winningCells[i], winningCells[j]],
          isWinning: true,
          threatLevel: 1,
        });
      }
    }
  }

  // 3. 活四威胁（4 子 + 2 空），但不一定是当前这一手的直接必杀
  //    每个 threat 对应“同一条 6 格路上的两个空位”，方便后续防守/进攻逻辑一次性处理
  for (const seg of live4Segments) {
    threats.push({
      positions: seg,
      isWinning: false,
      threatLevel: 2,
    });
  }

  return threats;
}
