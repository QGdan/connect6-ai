// core/pvs_search.ts

import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  Move,
  Player,
  SearchConfig,
  Position,
} from '../types';
import { applyMoveWithWinner } from './rules';
import { generateRZOPCandidates } from './rzop';
import { evaluateState } from './evaluation';
import { detectVCDT, type VCDTThreat } from './vcdt';
import { buildSmartBlockForOpponentLive4 } from './smart_defense';

// ===== 常量 =====
const MAX_ROOT_MOVE_COMBOS = 50;
const MAX_CHILD_MOVE_COMBOS = 30;

const MAX_TT_ENTRIES = 1_000_000;
const MAX_HISTORY_ENTRIES = 500_000;
const MIN_HISTORY_THRESHOLD = 100;

const ASPIRATION_WINDOW = 50_000;
const QUIESCENCE_MAX_DEPTH = 2;
const MAX_KILLER_DEPTH = 32;

// ===== 置换表 =====
type TTFlag = 'EXACT' | 'LOWER' | 'UPPER';

interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  bestMove?: Move;
}

const transpositionTable = new Map<string, TTEntry>();

function hashState(state: GameState): string {
  const boardStr = state.board.map(row => row.join('')).join('|');
  return `${boardStr}_${state.currentPlayer}_${state.moveNumber}`;
}

function probeTT(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
): TTEntry | null {
  const entry = transpositionTable.get(hashState(state));
  if (!entry || entry.depth < depth) return null;

  if (entry.flag === 'EXACT') return entry;
  if (entry.flag === 'LOWER' && entry.score >= beta) return entry;
  if (entry.flag === 'UPPER' && entry.score <= alpha) return entry;

  return null;
}

function storeTT(
  state: GameState,
  depth: number,
  score: number,
  alpha: number,
  beta: number,
  bestMove?: Move,
): void {
  const hash = hashState(state);
  const existing = transpositionTable.get(hash);
  if (existing && existing.depth > depth) return;

  let flag: TTFlag = 'EXACT';
  if (score <= alpha) flag = 'UPPER';
  else if (score >= beta) flag = 'LOWER';

  transpositionTable.set(hash, { depth, score, flag, bestMove });

  if (transpositionTable.size > MAX_TT_ENTRIES) {
    const entries = Array.from(transpositionTable.entries());
    entries.sort((a, b) => b[1].depth - a[1].depth);
    transpositionTable.clear();
    const keep = Math.floor(MAX_TT_ENTRIES * 0.8);
    for (let i = 0; i < keep && i < entries.length; i++) {
      transpositionTable.set(entries[i][0], entries[i][1]);
    }
  }
}

// ===== history 启发 =====
const historyTable = new Map<string, number>();

function historyKey(player: Player, pos: Position): string {
  return `${player}_${pos.x}_${pos.y}`;
}

function updateHistory(player: Player, pos: Position, depth: number): void {
  const key = historyKey(player, pos);
  const old = historyTable.get(key) ?? 0;
  const next = old + depth * depth;
  historyTable.set(key, Math.min(next, 1_000_000));

  if (historyTable.size > MAX_HISTORY_ENTRIES) {
    const entries = Array.from(historyTable.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    historyTable.clear();
    const keep = Math.floor(MAX_HISTORY_ENTRIES * 0.7);
    for (let i = 0; i < keep && i < entries.length; i++) {
      const [k, v] = entries[i];
      const aged = Math.floor(v / 2);
      if (aged > MIN_HISTORY_THRESHOLD) {
        historyTable.set(k, aged);
      }
    }
  }
}

function getHistoryScore(player: Player, pos: Position): number {
  return historyTable.get(historyKey(player, pos)) ?? 0;
}

// ===== 工具 =====
function switchPlayer(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

function getCurrentTime(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
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
): number {
  const standPat = evaluateState(state, rootPlayer, weights);

  if (depth >= QUIESCENCE_MAX_DEPTH) return standPat;
  if (standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;

  const candidates = generateRZOPCandidates(state);
  const moves = generateTwoStoneMoves(state, candidates, toMove).slice(
    0,
    MAX_CHILD_MOVE_COMBOS,
  );

  for (const move of moves) {
    const next = applyMoveWithWinner(state, move);
    const score = -quiescenceSearch(
      next,
      rootPlayer,
      switchPlayer(toMove),
      -beta,
      -alpha,
      weights,
      depth + 1,
    );

    if (score >= beta) return score;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

// ===== PVS 核心 =====
let lastSearchNodeCount = 0;
let lastSearchDepth = 0;
const killerMoves: (Move | undefined)[][] = Array.from({ length: MAX_KILLER_DEPTH }, () => [
  undefined,
  undefined,
]);

export function getLastSearchStats() {
  return {
    nodes: lastSearchNodeCount,
    depth: lastSearchDepth,
    ttSize: transpositionTable.size,
  };
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
): number {
  lastSearchNodeCount++;

  if (getCurrentTime() > deadline) {
    return evaluateState(state, rootPlayer, weights);
  }

  if (state.winner) {
    const base = state.winner === rootPlayer ? 1_000_000 : -1_000_000;
    const bonus = depth * 10_000;
    return state.winner === rootPlayer ? base + bonus : base - bonus;
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
    );
  }

  const ttEntry = probeTT(state, depth, alpha, beta);
  if (ttEntry) return ttEntry.score;

  const candidates = generateRZOPCandidates(state);
  let moves = generateTwoStoneMoves(state, candidates, toMove);

  if (moves.length === 0) {
    const evalScore = evaluateState(state, rootPlayer, weights);
    storeTT(state, depth, evalScore, alpha, beta);
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
  );

  let bestScore = -Infinity;
  let bestMove: Move | undefined;
  let localAlpha = alpha;

  for (let i = 0; i < ordered.length; i++) {
    const move = ordered[i];
    const next = applyMoveWithWinner(state, move);
    const opp = switchPlayer(toMove);

    let score: number;
    if (i === 0 || !isPV) {
      score = -pvs(
        next,
        rootPlayer,
        opp,
        -beta,
        -localAlpha,
        depth - 1,
        weights,
        deadline,
        isPV,
      );
    } else {
      // PVS 缩窗
      score = -pvs(
        next,
        rootPlayer,
        opp,
        -localAlpha - 1,
        -localAlpha,
        depth - 1,
        weights,
        deadline,
        false,
      );
      if (score > localAlpha && score < beta) {
        score = -pvs(
          next,
          rootPlayer,
          opp,
          -beta,
          -localAlpha,
          depth - 1,
          weights,
          deadline,
          true,
        );
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }

    if (score > localAlpha) {
      localAlpha = score;
      for (const p of move.positions) {
        updateHistory(toMove, p, depth);
      }
    }

    if (localAlpha >= beta) {
      storeKiller(depth, move);
      break;
    }
  }

  if (bestMove) {
    storeTT(state, depth, bestScore, alpha, beta, bestMove);
  }

  return bestScore;
}

// ===== 候选生成与排序 =====
function generateTwoStoneMoves(
  state: GameState,
  candidates: Position[],
  player: Player,
): Move[] {
  const moves: Move[] = [];
  const n = candidates.length;
  const maxCombos = Math.min((n * (n - 1)) / 2, 1000);

  // 去重工具：同一对点只生成一次
  const seen = new Set<string>();
  const addMove = (p1: Position, p2: Position) => {
    // 不能是同一个点
    if (p1.x === p2.x && p1.y === p2.y) return;
    // 要确实是空位
    if (state.board[p1.y][p1.x] !== 0) return;
    if (state.board[p2.y][p2.x] !== 0) return;

    // 无序 key（保证 (a,b) 和 (b,a) 视为同一对）
    const aFirst =
      p1.x < p2.x || (p1.x === p2.x && p1.y <= p2.y) ? p1 : p2;
    const bFirst = aFirst === p1 ? p2 : p1;
    const key = `${aFirst.x},${aFirst.y}|${bFirst.x},${bFirst.y}`;

    if (seen.has(key)) return;
    seen.add(key);

    if (moves.length < maxCombos) {
      moves.push({ player, positions: [aFirst, bFirst] });
    }
  };

  // ---------- 1) 先处理强制攻防：VCDT 双点必杀 ----------
  const myThreats = detectVCDT(state, player);
  const oppThreats = detectVCDT(state, switchPlayer(player));

  const addDoubleWinningPairs = (
    threats: ReturnType<typeof detectVCDT>,
  ) => {
    for (const t of threats) {
      if (moves.length >= maxCombos) break;
      // 只关心 "一手两子即可连六 / 双点必杀"
      if (!t.isWinning || t.threatLevel !== 1) continue;
      if (t.positions.length !== 2) continue;
      const [p1, p2] = t.positions;
      addMove(p1, p2);
    }
  };

  // 优先：防对方的双点必杀（包括 4+2 一手两子赢）
  addDoubleWinningPairs(oppThreats);
  // 其次：下出我方的双点必杀
  addDoubleWinningPairs(myThreats);

  // ---------- 2) 再补原来的“中心优先”组合逻辑 ----------
  const BOARD_CENTER = 9.5;
  const scored = candidates.map((p, idx) => ({
    pos: p,
    idx,
    centerDist: Math.abs(p.x - BOARD_CENTER) + Math.abs(p.y - BOARD_CENTER),
  }));
  scored.sort((a, b) => a.centerDist - b.centerDist);

  const pri = scored.slice(0, Math.min(30, n)).map(s => s.pos);
  const backup = scored.slice(30).map(s => s.pos);

  // 高优：两个都在中心区域
  for (let i = 0; i < pri.length && moves.length < maxCombos; i++) {
    for (let j = i + 1; j < pri.length && moves.length < maxCombos; j++) {
      addMove(pri[i], pri[j]);
    }
  }

  // 次优：一个在中心，一个在外围
  for (let i = 0; i < pri.length && moves.length < maxCombos; i++) {
    for (let j = 0; j < backup.length && moves.length < maxCombos; j++) {
      addMove(pri[i], backup[j]);
    }
  }

  // 再次：外围和外围
  for (
    let i = 0;
    i < Math.min(20, backup.length) && moves.length < maxCombos;
    i++
  ) {
    for (
      let j = i + 1;
      j < Math.min(20, backup.length) && moves.length < maxCombos;
      j++
    ) {
      addMove(backup[i], backup[j]);
    }
  }

  return moves;
}

function findFallbackTwoStoneMove(
  state: GameState,
  player: Player,
): Move {
  const empties: Position[] = [];
  for (let y = 0; y < state.board.length && empties.length < 2; y++) {
    for (let x = 0; x < state.board[y].length && empties.length < 2; x++) {
      if (state.board[y][x] === 0) empties.push({ x, y });
    }
  }
  if (empties.length === 0) return { player, positions: [] };
  if (empties.length === 1) return { player, positions: [empties[0]] };
  return { player, positions: [empties[0], empties[1]] };
}

function scoreMoveForOrdering(
  move: Move,
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  weights: EvaluationWeights,
  depth: number,
): number {
  const nextState = applyMoveWithWinner(state, move);

  // 1. 基础评估分（主要指标）
  const evalScore = evaluateState(nextState, rootPlayer, weights);

  // 2. 历史启发分
  const historyScore = move.positions.reduce(
    (s, p) => s + getHistoryScore(toMove, p),
    0,
  );

  // 3. 杀手移动加分（暂未启用）
  const killerBonus = findKillerBonus(depth, move);

  // 4. 威胁评估分（重点修正）
  let threatScore = 0;
  const myThreats = detectVCDT(nextState, toMove);
  const oppThreats = detectVCDT(nextState, switchPlayer(toMove));

  // ---- 我方威胁：创造就是好事 ----
  const myWinning = myThreats.filter(
    t => t.isWinning && t.threatLevel === 0,
  ).length;
  if (myWinning > 0) {
    threatScore += myWinning * 200_000;
  }

  const myDouble = myThreats.filter(
    t => t.isWinning && t.threatLevel === 1,
  ).length;
  if (myDouble > 0) {
    // 包括「一手两子连六」的双点必杀
    threatScore += myDouble * 100_000;
  }

  const myLive4 = myThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  ).length;
  threatScore += myLive4 * 10_000;

  // ---- 对方威胁：留下就是灾难（这里从“加分”改为“减分”）----
  const oppWinning = oppThreats.filter(
    t => t.isWinning && t.threatLevel === 0,
  ).length;
  if (oppWinning > 0) {
    // 走完这步之后对方还保留单点必胜，是非常糟糕的局面
    threatScore -= oppWinning * 180_000;
  }

  const oppDouble = oppThreats.filter(
    t => t.isWinning && t.threatLevel === 1,
  ).length;
  if (oppDouble > 0) {
    // 对方还保留双点必杀 / 一手两子连六
    threatScore -= oppDouble * 90_000;
  }

  const oppLive4 = oppThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  ).length;
  // 活四越多越危险，略微惩罚
  threatScore -= oppLive4 * 80_000;

  // 综合排序分数：基础评估 + 部分威胁权重 + 历史 / 杀手
  return evalScore + threatScore * 0.3 + historyScore * 0.1 + killerBonus;
}

function sameMove(a: Move | undefined, b: Move): boolean {
  if (!a) return false;
  if (a.positions.length !== b.positions.length) return false;
  const sortPositions = (positions: Position[]) =>
    [...positions].sort((p1, p2) => (p1.x === p2.x ? p1.y - p2.y : p1.x - p2.x));
  const ap = sortPositions(a.positions);
  const bp = sortPositions(b.positions);
  return ap.every((p, idx) => p.x === bp[idx].x && p.y === bp[idx].y);
}

function storeKiller(depth: number, move: Move) {
  if (depth <= 0 || depth > MAX_KILLER_DEPTH) return;
  const slot = killerMoves[depth - 1];
  if (!sameMove(slot[0], move)) {
    slot[1] = slot[0];
    slot[0] = move;
  }
}

function findKillerBonus(depth: number, move: Move): number {
  if (depth <= 0 || depth > MAX_KILLER_DEPTH) return 0;
  const slot = killerMoves[depth - 1];
  if (sameMove(slot[0], move)) return 25_000;
  if (sameMove(slot[1], move)) return 12_000;
  return 0;
}

function resetKillers() {
  for (let i = 0; i < killerMoves.length; i++) {
    killerMoves[i][0] = undefined;
    killerMoves[i][1] = undefined;
  }
}

function orderMoves(
  moves: Move[],
  state: GameState,
  rootPlayer: Player,
  toMove: Player,
  weights: EvaluationWeights,
  depth: number,
): Move[] {
  const scored = moves.map(m => ({
    move: m,
    orderScore: scoreMoveForOrdering(
      m,
      state,
      rootPlayer,
      toMove,
      weights,
      depth,
    ),
  }));

  scored.sort((a, b) => b.orderScore - a.orderScore);
  return scored.map(s => s.move);
}

// ===== VCDT 根节点决策 =====

function buildTwoStoneMoveFromThreat(
  state: GameState,
  player: Player,
  threat: VCDTThreat,
): Move {
  const empties: Position[] = [];
  const seen = new Set<string>();

  // VCDTThreat.positions 里已经是关键空位（对我们或对手），但先防御性过滤一遍
  for (const p of threat.positions) {
    if (!state.board[p.y] || state.board[p.y][p.x] !== 0) continue;
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    empties.push(p);
  }

  // threatLevel=2：活四（4 子 + 2 空）→ 必须两头都堵
  if (threat.threatLevel === 2 && empties.length >= 2) {
    return { player, positions: [empties[0], empties[1]] };
  }

  // 其它情况（0: 单点胜, 1: 双点必杀；或兜底）：
  // 至少保证一个子下在关键点，另一个走正常 RZOP 候选。
  if (empties.length >= 1) {
    const must = empties[0];
    const candidates = generateRZOPCandidates(state).filter(
      p => !(p.x === must.x && p.y === must.y),
    );
    const second = candidates[0] ?? must;
    return { player, positions: [must, second] };
  }

  // 万一 threat 里没有可下空位，就退回兜底逻辑
  return findFallbackTwoStoneMove(state, player);
}

// 针对“对手一手两子必杀（threatLevel=1）”的专门防守：
// 尽量找一个点，能同时破掉所有必杀对；
// 如果只有一个 pair（两个点），就直接两头都堵。
function buildBlockMoveForOpponentDoubleWins(
  state: GameState,
  rootPlayer: Player,
  threats: VCDTThreat[],
): Move | null {
  if (threats.length === 0) return null;

  const samePos = (a: Position, b: Position) =>
    a.x === b.x && a.y === b.y;

  // ✅ 情况一：只有一个双点必杀 pair，例如 .XXXXX.
  if (threats.length === 1 && threats[0].positions.length === 2) {
    const [p1, p2] = threats[0].positions;
    const empties = [p1, p2].filter(p => state.board[p.y][p.x] === 0);
    if (empties.length === 2) {
      // 直接两头都堵
      return {
        player: rootPlayer,
        positions: [empties[0], empties[1]],
      };
    }
    // 如果只剩一个空位，就退化成“至少先占那个必杀点”
    if (empties.length === 1) {
      const must = empties[0];
      const candidates = generateRZOPCandidates(state).filter(
        p => !(p.x === must.x && p.y === must.y),
      );
      const second = candidates[0] ?? must;
      return { player: rootPlayer, positions: [must, second] };
    }
    // 没空位，防不着
    return null;
  }

  // ✅ 情况二：多个双点必杀 pair，尝试找“公共交叉点”
  const first = threats[0].positions;
  const intersection: Position[] = [];

  for (const p of first) {
    if (state.board[p.y][p.x] !== 0) continue; // 必须是空位
    let ok = true;
    for (let i = 1; i < threats.length; i++) {
      if (!threats[i].positions.some(q => samePos(q, p))) {
        ok = false;
        break;
      }
    }
    if (ok) intersection.push(p);
  }

  // 如果有交集点：只需在这个点落一子就能把所有双点必杀全断掉
  if (intersection.length > 0) {
    const must = intersection[0];
    const candidates = generateRZOPCandidates(state).filter(
      p => !(p.x === must.x && p.y === must.y),
    );
    const second = candidates[0] ?? must;
    return { player: rootPlayer, positions: [must, second] };
  }

  // ✅ 情况三：没有公共交叉点 → 选“覆盖率”最高的两点
  const countMap = new Map<string, { p: Position; count: number }>();

  for (const t of threats) {
    for (const p of t.positions) {
      if (state.board[p.y][p.x] !== 0) continue;
      const key = `${p.x},${p.y}`;
      const entry = countMap.get(key);
      if (entry) entry.count++;
      else countMap.set(key, { p, count: 1 });
    }
  }

  const arr = Array.from(countMap.values()).sort(
    (a, b) => b.count - a.count,
  );
  if (arr.length === 0) return null;

  const firstBlock = arr[0].p;
  let secondBlock = firstBlock;
  if (arr.length >= 2) {
    secondBlock = arr[1].p;
    if (samePos(firstBlock, secondBlock)) {
      const candidates = generateRZOPCandidates(state).filter(
        p => !(p.x === firstBlock.x && p.y === firstBlock.y),
      );
      secondBlock = candidates[0] ?? firstBlock;
    }
  } else {
    const candidates = generateRZOPCandidates(state).filter(
      p => !(p.x === firstBlock.x && p.y === firstBlock.y),
    );
    secondBlock = candidates[0] ?? firstBlock;
  }

  return {
    player: rootPlayer,
    positions: [firstBlock, secondBlock],
  };
}


function findVcdtRootMove(
  state: GameState,
  rootPlayer: Player,
): { move: Move; reason: string } | null {
  const myThreats = detectVCDT(state, rootPlayer);
  const oppThreats = detectVCDT(state, switchPlayer(rootPlayer));

  // ① 我方单点赢（5+1 直接杀）→ 直接赢
  const myWin = myThreats.find(
    t => t.isWinning && t.threatLevel === 0,
  );
  if (myWin) {
    return {
      move: buildTwoStoneMoveFromThreat(state, rootPlayer, myWin),
      reason: 'own_win',
    };
  }

  // ② 对方一手两子必杀（threatLevel = 1）→ 先算最少防守点
  const oppDoubleWins = oppThreats.filter(
    t => t.isWinning && t.threatLevel === 1,
  );
  if (oppDoubleWins.length > 0) {
    const mv = buildBlockMoveForOpponentDoubleWins(
      state,
      rootPlayer,
      oppDoubleWins,
    );
    if (mv) {
      return {
        move: mv,
        reason: 'block_opp_double_win',
      };
    }
  }

  // ③ 对方单点赢（只有一个 5+1）→ 挡这个点即可
  const oppWin = oppThreats.find(
    t => t.isWinning && t.threatLevel === 0,
  );
  if (oppWin) {
    return {
      move: buildTwoStoneMoveFromThreat(state, rootPlayer, oppWin),
      reason: 'block_opp_win',
    };
  }

  // ④ 对方活四：两头都堵（VCDT threatLevel=2，positions 为两个空位）
    // 对方活四：优先尝试“智能省子防守”
  const oppLive4 = oppThreats.find(
    t => !t.isWinning && t.threatLevel === 2,
  );
  if (oppLive4) {
    const mv = buildSmartBlockForOpponentLive4(state, rootPlayer, oppLive4);
    return {
      move: mv,
      reason:
        mv.positions.length >= 2
          ? 'block_opp_live4_both_ends'
          : 'block_opp_live4_smart_single',
    };
  }
  return null;
}


// ===== 根搜索（带 VCDT + 迭代加深） =====

export function pvsSearchBestMove(
  rootState: GameState,
  rootPlayer: Player,
  weights: EvaluationWeights,
  config: SearchConfig,
): AIMoveDecision {
  lastSearchNodeCount = 0;
  resetKillers();

  const maxDepth = Math.max(1, config.maxDepth ?? 2);
  const timeLimit = config.timeLimitMs ?? 3000;
  const deadline = getCurrentTime() + timeLimit;

  // 0）根节点 VCDT：必杀 / 必防 / 活四
  const vcdtRoot = findVcdtRootMove(rootState, rootPlayer);
  if (vcdtRoot) {
    const next = applyMoveWithWinner(rootState, vcdtRoot.move);
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
        weights,
        deadline,
        true,
      );
      searchedDepth = 1 + remainDepth;
    } else {
      score = evaluateState(next, rootPlayer, weights);
    }

    lastSearchDepth = searchedDepth;

    return {
      move: vcdtRoot.move,
      score,
      debugInfo: {
        engine: 'pvs+vcdt+zorp',
        mode: 'vcdt_root',
        reason: vcdtRoot.reason,
        depth: searchedDepth,
        nodes: lastSearchNodeCount,
        ttSize: transpositionTable.size,
      },
    };
  }

  // 1）RZOP 生成根候选
  const candidates = generateRZOPCandidates(rootState);
  let moveCombos = generateTwoStoneMoves(rootState, candidates, rootPlayer);

  if (moveCombos.length === 0) {
    const fallback = findFallbackTwoStoneMove(rootState, rootPlayer);
    return {
      move: fallback,
      score: evaluateState(rootState, rootPlayer, weights),
      debugInfo: {
        engine: 'pvs+vcdt+zorp',
        mode: 'no_candidate_fallback',
        depth: 0,
        nodes: 0,
        ttSize: transpositionTable.size,
      },
    };
  }

  if (moveCombos.length > MAX_ROOT_MOVE_COMBOS) {
    const scored = moveCombos.map(move => {
      const next = applyMoveWithWinner(rootState, move);
      const base = evaluateState(next, rootPlayer, weights);
      const myWins = detectVCDT(next, rootPlayer).filter(
        t => t.isWinning && t.threatLevel === 0,
      ).length;
      return { move, score: base + myWins * 100_000 };
    });
    scored.sort((a, b) => b.score - a.score);
    moveCombos = scored.slice(0, MAX_ROOT_MOVE_COMBOS).map(s => s.move);
  }

  // 2）迭代加深 PVS
  let bestMove = moveCombos[0];
  let bestScore = -Infinity;
  let searchedDepth = 0;

  for (let d = 1; d <= maxDepth; d++) {
    const timeLeft = deadline - getCurrentTime();
    if (timeLeft < 100) break;

    let alpha = d === 1 ? -Infinity : bestScore - ASPIRATION_WINDOW;
    let beta = d === 1 ? Infinity : bestScore + ASPIRATION_WINDOW;
    let iterBestMove = bestMove;
    let iterBestScore = -Infinity;
    let failed = false;

    const sorted = orderMoves(
      moveCombos,
      rootState,
      rootPlayer,
      rootPlayer,
      weights,
      d,
    );

    for (let i = 0; i < sorted.length; i++) {
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
          weights,
          deadline,
          true,
        );
      } else {
        score = -pvs(
          next,
          rootPlayer,
          opp,
          -alpha - 1,
          -alpha,
          d - 1,
          weights,
          deadline,
          false,
        );
        if (score > alpha && score < beta) {
          score = -pvs(
            next,
            rootPlayer,
            opp,
            -beta,
            -alpha,
            d - 1,
            weights,
            deadline,
            true,
          );
        }
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

    if (!failed || d === 1) {
      bestMove = iterBestMove;
      bestScore = iterBestScore;
      searchedDepth = d;
    }
  }

  lastSearchDepth = searchedDepth;

  return {
    move: bestMove,
    score: bestScore,
    debugInfo: {
      engine: 'pvs+vcdt+zorp',
      mode: 'normal',
      depth: searchedDepth,
      nodes: lastSearchNodeCount,
      ttSize: transpositionTable.size,
    },
  };
}
