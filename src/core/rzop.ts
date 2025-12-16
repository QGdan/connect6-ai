import type { GameState, Position } from '../types';
import { BOARD_SIZE } from './game_state';
import { isHighValueRoadCell } from './road_encoding';

/**
 * 计算局面的“相关区域”（Relevance Zone）
 * - 若棋盘为空：返回棋盘中心及其周围若干点
 * - 若已有棋子：以每颗棋子为中心，在给定半径内取所有空点
 *   并去重后作为候选基础集合
 */
function computeRelevantZones(state: GameState, radius = 3): Position[] {
  const occupied: Position[] = [];

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (state.board[y][x] !== 0) {
        occupied.push({ x, y });
      }
    }
  }

  const result: Position[] = [];

  // 空盘：直接在中心附近布点
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

  // 有棋子：以每颗棋子为中心，在 radius 内扩张
  const marked = new Set<string>();

  for (const p of occupied) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
        if (state.board[ny][nx] !== 0) continue;

        const key = `${nx},${ny}`;
        if (!marked.has(key)) {
          marked.add(key);
          result.push({ x: nx, y: ny });
        }
      }
    }
  }

  return result;
}

/**
 * 检测当前局面对“落子方”的对手所构成的紧急威胁，
 * 返回所有应优先考虑的“必防点”：
 * - 对手在某条长为 6 的线段上：
 *   · >=5 子 + 至少 1 个空位      → 冲五/成五，必须立刻堵
 *   · >=4 子 + >=2 空位 + 无己子 → 活四/跳四，两个空位都应高度优先
 */
function findUrgentThreatBlocks(state: GameState): Position[] {
  const dirs = [
    { dx: 1, dy: 0 },  // 横
    { dx: 0, dy: 1 },  // 竖
    { dx: 1, dy: 1 },  // 撇
    { dx: 1, dy: -1 }, // 捺
  ];

  const myVal = state.currentPlayer === 'BLACK' ? 1 : 2;
  const oppVal = myVal === 1 ? 2 : 1;

  const result: Position[] = [];
  const marked = new Set<string>();

  for (const { dx, dy } of dirs) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const endX = x + dx * 5;
        const endY = y + dy * 5;
        if (
          endX < 0 ||
          endY < 0 ||
          endX >= BOARD_SIZE ||
          endY >= BOARD_SIZE
        ) {
          continue;
        }

        const cells: { x: number; y: number; v: number }[] = [];
        for (let k = 0; k < 6; k++) {
          const cx = x + dx * k;
          const cy = y + dy * k;
          cells.push({ x: cx, y: cy, v: state.board[cy][cx] });
        }

        let oppCount = 0;
        let myCount = 0;
        const empties: { x: number; y: number }[] = [];

        for (const c of cells) {
          if (c.v === oppVal) oppCount++;
          else if (c.v === myVal) myCount++;
          else if (c.v === 0) empties.push({ x: c.x, y: c.y });
        }

        if (myCount > 0) {
          // 自己的子掺在里面了，这条线对对手不是“纯威胁线”
          continue;
        }

        // ① 冲五 / 已成五
        if (oppCount >= 5 && empties.length >= 1) {
          for (const e of empties) {
            const key = `${e.x},${e.y}`;
            if (!marked.has(key)) {
              marked.add(key);
              result.push(e);
            }
          }
          continue;
        }

        // ② 活四 / 跳四
        if (oppCount >= 4 && empties.length >= 2) {
          for (const e of empties) {
            const key = `${e.x},${e.y}`;
            if (!marked.has(key)) {
              marked.add(key);
              result.push(e);
            }
          }
        }
      }
    }
  }

  return result;
}

/**
 * 预留策略位：以后可以在这里加“距中心优先”“离已有棋团更近”等逻辑。
 * 当前实现为全部接受。
 */
function isStrategicPosition(_state: GameState, _pos: Position): boolean {
  return true;
}

/** 
 * 判断某个点在所有通过它的 6 格窗口上，是否已经都是“黑白皆有”的死线。
 * 若是，则在非紧急情况下不再考虑这里落子。
 */
function isDeadLineCell(state: GameState, pos: Position): boolean {
  const board = state.board;
  const n = BOARD_SIZE;

  const dirs = [
    { dx: 1, dy: 0 },   // 横
    { dx: 0, dy: 1 },   // 竖
    { dx: 1, dy: 1 },   // 撇
    { dx: 1, dy: -1 },  // 捺
  ];

  const inBoard = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n;

  // 对 4 个方向分别检查
  for (const { dx, dy } of dirs) {
    let thisDirHasPotential = false;

    // 枚举所有“经过 pos 的 6 格窗口”
    for (let k = -5; k <= 0; k++) {
      const sx = pos.x + k * dx;
      const sy = pos.y + k * dy;
      const ex = sx + dx * 5;
      const ey = sy + dy * 5;

      if (!inBoard(sx, sy) || !inBoard(ex, ey)) continue;

      let hasBlack = false;
      let hasWhite = false;

      for (let t = 0; t < 6; t++) {
        const x = sx + dx * t;
        const y = sy + dy * t;
        const v = board[y][x];
        if (v === 1) hasBlack = true;
        else if (v === 2) hasWhite = true;
      }

      // 如果有某个窗口只包含一种颜色（或空 + 一种颜色），
      // 说明这方向上仍有“纯色 6 连”潜力，不是死线。
      if (!(hasBlack && hasWhite)) {
        thisDirHasPotential = true;
        break;
      }
    }

    // 只要某个方向还有潜力，就不能说是死线
    if (thisDirHasPotential) {
      return false;
    }
  }

  // 所有方向上，凡是经过 pos 的 6 格窗口都已经“黑白皆有”，
  // 说明无论谁在这里下，都不可能在该方向形成 6 连 → 死线点
  return true;
}

/** 判断是否处于开局阶段（用于 RZOP 轻量偏置） */
function isOpeningPhase(state: GameState): boolean {
  // 粗略：前 6 手 / 棋子较少时都算开局
  const moveNum = state.moveNumber ?? 0;
  if (moveNum <= 6) return true;

  let occupied = 0;
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (state.board[y][x] !== 0) occupied++;
    }
  }
  return occupied <= 24;
}

/**
 * 计算某个点在“开局阶段”的形状加分：
 * - 邻近己方棋子越多越好（鼓励做 2x2 / 3x3 小团）
 * - 同时在横 + 竖、或横 + 斜方向上都能连接到己方棋 → 加较大分
 */
function openingShapeScore(state: GameState, pos: Position): number {
  const myVal = state.currentPlayer === 'BLACK' ? 1 : 2;
  const board = state.board;
  const x = pos.x;
  const y = pos.y;

  const inBoard = (nx: number, ny: number) =>
    nx >= 0 && ny >= 0 && nx < BOARD_SIZE && ny < BOARD_SIZE;

  // 1) 邻近己方子数量（8 邻域）
  let adjCount = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (!inBoard(nx, ny)) continue;
      if (board[ny][nx] === myVal) adjCount++;
    }
  }

  // 2) 四个方向上，是否在「短距离内」能连到己方子
  const hasFriendlyInDir = (dx: number, dy: number, maxStep = 3): boolean => {
    for (let k = 1; k <= maxStep; k++) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      if (!inBoard(nx, ny)) break;
      const v = board[ny][nx];
      if (v === myVal) return true;
      if (v !== 0) break; // 被对方子挡住
    }
    return false;
  };

  const hor = hasFriendlyInDir(1, 0) || hasFriendlyInDir(-1, 0);
  const ver = hasFriendlyInDir(0, 1) || hasFriendlyInDir(0, -1);
  const diag1 = hasFriendlyInDir(1, 1) || hasFriendlyInDir(-1, -1);
  const diag2 = hasFriendlyInDir(1, -1) || hasFriendlyInDir(-1, 1);

  let bonus = 0;

  // 邻近子鼓励做厚团
  bonus += adjCount * 8;

  // 横 + 竖 交叉：优先考虑十字骨架
  if (hor && ver) bonus += 35;
  // 横 + 斜：优先考虑 T 型 / 斜向连接
  if (hor && (diag1 || diag2)) bonus += 25;
  // 竖 + 斜：稍弱，但也加一点
  if (ver && (diag1 || diag2)) bonus += 18;

  return bonus;
}

/**
 * RZOP 候选生成：
 * 1. 先用 findUrgentThreatBlocks 找出对手的致命威胁点（活四 / 跳四 / 冲五 等），
 *    无条件加入候选并在排序中优先；
 * 2. 用 computeRelevantZones 得到相关区域内的空点；
 * 3. 用 isHighValueRoadCell 做一次线路价值过滤；
 * 4. （可选）再通过 isStrategicPosition 做棋形级过滤；
 * 5. 最后按“是否紧急威胁点 + 开局形状加分 + 离棋盘中心的曼哈顿距离”排序。
 */
export function generateRZOPCandidates(state: GameState): Position[] {
  const relevant = computeRelevantZones(state, 3);
  const urgent = findUrgentThreatBlocks(state);

  const urgentSet = new Set<string>();
  for (const p of urgent) {
    urgentSet.add(`${p.x},${p.y}`);
  }

  const candidates: Position[] = [];
  const seen = new Set<string>();

  // ⭐ 每一条线上的“非紧急候选名额”计数
  const rowCount = new Map<number, number>();   // y
  const diag1Count = new Map<number, number>(); // x - y
  const diag2Count = new Map<number, number>(); // x + y
  const MAX_NON_URGENT_PER_LINE = 4;            // 可以根据体验调 3~5

  const push = (p: Position) => {
    const key = `${p.x},${p.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(p);
    }
  };

  // ① 紧急防守点：无条件加入（不走 isHighValueRoadCell 过滤）
  for (const p of urgent) {
    push(p);
  }

    // ② 正常 RZOP 候选（非紧急防守点）
  for (const pos of relevant) {
    const key = `${pos.x},${pos.y}`;
    if (urgentSet.has(key)) continue; // 已经作为紧急点加入

    if (!isHighValueRoadCell(state, pos, 3)) continue;
    if (!isStrategicPosition(state, pos)) continue;
    if (isPureLineExtension(state, pos)) continue;
    if (isDeadLineCell(state, pos)) continue;

    // ⭐ 行 / 对角线“名额限制”：防止一条线出现太多候选点
    const rowKey = pos.y;
    const d1Key = pos.x - pos.y;
    const d2Key = pos.x + pos.y;

    const rowUsed = rowCount.get(rowKey) ?? 0;
    const d1Used = diag1Count.get(d1Key) ?? 0;
    const d2Used = diag2Count.get(d2Key) ?? 0;

    // 只要某个方向已经用了很多名额，就不要再给这条线塞候选点
    if (rowUsed >= MAX_NON_URGENT_PER_LINE) continue;
    if (d1Used >= MAX_NON_URGENT_PER_LINE) continue;
    if (d2Used >= MAX_NON_URGENT_PER_LINE) continue;

    push(pos);

    rowCount.set(rowKey, rowUsed + 1);
    diag1Count.set(d1Key, d1Used + 1);
    diag2Count.set(d2Key, d2Used + 1);
  }
  // 极端情况下过滤完没有候选，则退回原始相关区域兜底
  if (candidates.length === 0) {
    return relevant;
  }

  const center = (BOARD_SIZE - 1) / 2;
  const openingPhase = isOpeningPhase(state);

  candidates.sort((a, b) => {
    const aKey = `${a.x},${a.y}`;
    const bKey = `${b.x},${b.y}`;

    const aUrgent = urgentSet.has(aKey) ? 0 : 1;
    const bUrgent = urgentSet.has(bKey) ? 0 : 1;
    if (aUrgent !== bUrgent) {
      // 紧急点优先
      return aUrgent - bUrgent;
    }

    const da = Math.abs(a.x - center) + Math.abs(a.y - center);
    const db = Math.abs(b.x - center) + Math.abs(b.y - center);
    return da - db;
  });

  return candidates;
}

/** 是否是“纯直线延伸点”：只是在某条长直线两端继续加一格 */
function isPureLineExtension(state: GameState, pos: Position): boolean {
  const board = state.board;
  const n = BOARD_SIZE;

  const inBoard = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < n && y < n;

  // 只关心 4 个主方向：横、竖、两条斜线
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 },
  ];

  for (const { dx, dy } of dirs) {
    let runLen = 0;

    // 往一个方向数连续非空
    let x = pos.x + dx;
    let y = pos.y + dy;
    while (inBoard(x, y) && board[y][x] !== 0) {
      runLen++;
      x += dx;
      y += dy;
    }

    // 往反方向数连续非空
    x = pos.x - dx;
    y = pos.y - dy;
    while (inBoard(x, y) && board[y][x] !== 0) {
      runLen++;
      x -= dx;
      y -= dy;
    }

    // 如果这一条线的连续棋子已经很长（≥5），
    // 再在这条线延伸一般就是“修铁路”，非紧急情况就过滤掉。
    if (runLen >= 5) {
      return true;
    }
  }

  return false;
}

