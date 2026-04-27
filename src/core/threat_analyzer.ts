import type { GameState, Player, Position } from '../types';
import { getAllLines, getAllRoads, getLinesForCell } from './road_encoding';
import { BOARD_SIZE } from './game_state';
import { posIdx } from './pos_key';
import {
  makeEmptyReport,
  stableKey,
  type PatternHit,
  type PatternType,
  type ThreatReport,
} from './pattern_library';

type EndInfo = { open: boolean; pos?: Position };

function inBounds(board: number[][], x: number, y: number): boolean {
  return y >= 0 && y < board.length && x >= 0 && x < board[y].length;
}

function getEndInfo(
  board: number[][],
  line: Position[],
  idx: number,
  dir: Position,
  side: 'left' | 'right',
): EndInfo {
  if (idx >= 0 && idx < line.length) {
    const p = line[idx];
    if (board[p.y][p.x] === 0) return { open: true, pos: p };
    return { open: false };
  }
  const ref = side === 'left' ? line[0] : line[line.length - 1];
  const x = ref.x + dir.x * (side === 'left' ? -1 : 1);
  const y = ref.y + dir.y * (side === 'left' ? -1 : 1);
  if (!inBounds(board, x, y)) return { open: false };
  return board[y][x] === 0 ? { open: true, pos: { x, y } } : { open: false };
}

function pushPattern(report: ThreatReport, hit: PatternHit, seen: Set<string>) {
  const key = stableKey(hit);
  if (seen.has(key)) return;
  seen.add(key);
  report.patterns.push(hit);
  report.byType[hit.type].push(hit);
}

function addPoints(dst: Map<number, Position>, pts: Position[]) {
  for (const p of pts) dst.set(posIdx(p.x, p.y), p);
}

function idxOf(pos: Position): number {
  return posIdx(pos.x, pos.y);
}

function pairKey(a: Position, b: Position): number {
  const base = BOARD_SIZE * BOARD_SIZE;
  const aIdx = posIdx(a.x, a.y);
  const bIdx = posIdx(b.x, b.y);
  return aIdx < bIdx ? aIdx * base + bIdx : bIdx * base + aIdx;
}

function unionPoints(...lists: Position[][]): Position[] {
  const out = new Map<number, Position>();
  for (const list of lists) {
    for (const p of list) {
      const idx = idxOf(p);
      if (!out.has(idx)) out.set(idx, p);
    }
  }
  return [...out.values()];
}

function flattenWin2Pairs(pairs: [Position, Position][]): Position[] {
  const out: Position[] = [];
  for (const [a, b] of pairs) {
    out.push(a, b);
  }
  return out;
}

function computeSpanLen(
  vals: number[],
  start: number,
  end: number,
  oppVal: number,
): number {
  let spanLeft = start;
  while (spanLeft - 1 >= 0 && vals[spanLeft - 1] !== oppVal) spanLeft -= 1;
  let spanRight = end;
  while (spanRight + 1 < vals.length && vals[spanRight + 1] !== oppVal) spanRight += 1;
  return spanRight - spanLeft + 1;
}

function hasSplitLive3InLine(
  vals: number[],
  idx: number,
  myVal: number,
  oppVal: number,
): boolean {
  const startMin = Math.max(0, idx - 5);
  const startMax = Math.min(idx, vals.length - 6);
  for (let start = startMin; start <= startMax; start++) {
    if (vals[start] !== 0 || vals[start + 5] !== 0) continue;
    const v1 = vals[start + 1];
    const v2 = vals[start + 2];
    const v3 = vals[start + 3];
    const v4 = vals[start + 4];
    const patternA = v1 === myVal && v2 === myVal && v3 === 0 && v4 === myVal;
    const patternB = v1 === myVal && v2 === 0 && v3 === myVal && v4 === myVal;
    if (!patternA && !patternB) continue;
    const stoneHit = patternA
      ? idx === start + 1 || idx === start + 2 || idx === start + 4
      : idx === start + 1 || idx === start + 3 || idx === start + 4;
    if (!stoneHit) continue;
    const spanLen = computeSpanLen(vals, start + 1, start + 4, oppVal);
    if (spanLen < 6) continue;
    return true;
  }
  return false;
}

export function analyzeThreats(state: GameState, playerToMove: Player): ThreatReport {
  const board = state.board;
  const myVal = playerToMove === 'BLACK' ? 1 : 2;
  const oppVal = myVal === 1 ? 2 : 1;
  const report = makeEmptyReport(playerToMove);
  const seen = new Set<string>();

  const winIn1Set = new Map<number, Position>();
  const winIn2Set = new Map<number, [Position, Position]>();
  const candidateSet = new Map<number, Position>();
  // Points that force opponent to defend (my forcing points).
  const forcingSet = new Map<number, Position>();
  const defensePointSet = new Map<number, Position>();
  const attackPointSet = new Map<number, Position>();

  // 1) 连续 run：活/冲/死五、四（严格连续）
  for (const line of getAllLines()) {
    const vals = line.cells.map(p => board[p.y][p.x]);
    let i = 0;
    while (i < vals.length) {
      if (vals[i] !== myVal) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < vals.length && vals[i] === myVal) i += 1;
      const end = i - 1;
      const runLen = end - start + 1;
      const spanLen = computeSpanLen(vals, start, end, oppVal);
      const spanBlocked = spanLen < 6;

      const leftInfo = getEndInfo(board, line.cells, start - 1, line.dir, 'left');
      const rightInfo = getEndInfo(board, line.cells, end + 1, line.dir, 'right');
      const openEnds = (leftInfo.open ? 1 : 0) + (rightInfo.open ? 1 : 0);
      const keyPoints = [
        ...(leftInfo.open && leftInfo.pos ? [leftInfo.pos] : []),
        ...(rightInfo.open && rightInfo.pos ? [rightInfo.pos] : []),
      ];
      const stones = line.cells.slice(start, end + 1);

      if (runLen >= 6) {
        pushPattern(
          report,
          {
            type: 'CONNECT6',
            player: playerToMove,
            roadId: line.id,
            dir: line.dir,
            runLen,
            openEnds,
            stones,
            keyPoints: [],
            defensePoints: [],
          },
          seen,
        );
        continue;
      }

      if (runLen === 5) {
        const type: PatternType =
          spanBlocked
            ? 'DEAD5'
            : openEnds === 2
            ? 'LIVE5'
            : openEnds === 1
            ? 'CHARGE5'
            : 'DEAD5';
        pushPattern(
          report,
          {
            type,
            player: playerToMove,
            roadId: line.id,
            dir: line.dir,
            runLen,
            openEnds,
            stones,
            keyPoints,
            defensePoints: keyPoints,
          },
          seen,
        );
        if (!spanBlocked && openEnds >= 1) {
          addPoints(winIn1Set, keyPoints);
          addPoints(candidateSet, keyPoints);
          addPoints(forcingSet, keyPoints);
          addPoints(defensePointSet, keyPoints);
          addPoints(attackPointSet, keyPoints);
          for (const p of keyPoints) {
            pushPattern(
              report,
              {
                type: 'WIN_IN_1',
                player: playerToMove,
                roadId: line.id,
                dir: line.dir,
                runLen: 5,
                openEnds,
                stones: [],
                keyPoints: [p],
                defensePoints: [p],
              },
              seen,
            );
          }
        }
      } else if (runLen === 4) {
        const type: PatternType =
          spanBlocked
            ? 'DEAD4'
            : openEnds === 2
            ? 'LIVE4'
            : openEnds === 1
            ? 'CHARGE4'
            : 'DEAD4';
        pushPattern(
          report,
          {
            type,
            player: playerToMove,
            roadId: line.id,
            dir: line.dir,
            runLen,
            openEnds,
            stones,
            keyPoints,
            defensePoints: keyPoints,
          },
          seen,
        );
        if (!spanBlocked && openEnds >= 1) {
          addPoints(candidateSet, keyPoints);
          addPoints(defensePointSet, keyPoints);
          addPoints(attackPointSet, keyPoints);
        }
      }
    }
  }

  // 2) WIN_IN_2: 6 窗，己方 4 子 + 2 空，对手 0 子（不要求连续）
  for (const road of getAllRoads()) {
    const vals = road.cells.map(p => board[p.y][p.x]);
    let myCount = 0;
    let oppCount = 0;
    const empties: Position[] = [];
    for (let idx = 0; idx < vals.length; idx++) {
      const v = vals[idx];
      if (v === myVal) myCount++;
      else if (v === 0) empties.push(road.cells[idx]);
      else oppCount++;
    }
    if (oppCount !== 0 || myCount !== 4 || empties.length !== 2) continue;
    const [p1, p2] = empties;
    const k = pairKey(p1, p2);
    if (winIn2Set.has(k)) continue;
    winIn2Set.set(k, [p1, p2]);
    pushPattern(
      report,
      {
        type: 'WIN_IN_2',
        player: playerToMove,
        roadId: road.id,
        dir: road.dir,
        runLen: 4,
        openEnds: 2,
        stones: [],
        keyPoints: [p1, p2],
        defensePoints: [p1, p2],
        winPairs: [[p1, p2]],
      },
      seen,
    );
    addPoints(candidateSet, [p1, p2]);
    addPoints(forcingSet, [p1, p2]);
    addPoints(defensePointSet, [p1, p2]);
    addPoints(attackPointSet, [p1, p2]);
  }

  // 3) Neighbor empties: simulate live3/sleep3 and composite threats
  const nearSet = new Map<number, Position>();
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      if (board[y][x] !== myVal) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (!inBounds(board, nx, ny)) continue;
          if (board[ny][nx] !== 0) continue;
          nearSet.set(posIdx(nx, ny), { x: nx, y: ny });
        }
      }
    }
  }

  addPoints(candidateSet, [...nearSet.values()]);
  const candidates = [...candidateSet.values()];

  for (const pos of candidates) {
    const cellIdx = posIdx(pos.x, pos.y);
    const lines = getLinesForCell(pos);
    let live4 = 0;
    let open4 = 0;
    let live3 = 0;
    let sleep3 = 0;
    for (const line of lines) {
      const idx = line.indexOf[cellIdx];
      if (idx < 0) continue;
      const vals = line.cells.map(p => board[p.y][p.x]);
      vals[idx] = myVal;

      let left = idx;
      while (left - 1 >= 0 && vals[left - 1] === myVal) left -= 1;
      let right = idx;
      while (right + 1 < vals.length && vals[right + 1] === myVal) right += 1;
      const runLen = right - left + 1;
      const spanLen = computeSpanLen(vals, left, right, oppVal);
      if (spanLen < 6) continue;
      const leftInfo = getEndInfo(board, line.cells, left - 1, line.dir, 'left');
      const rightInfo = getEndInfo(board, line.cells, right + 1, line.dir, 'right');
      const openEnds = (leftInfo.open ? 1 : 0) + (rightInfo.open ? 1 : 0);

      if (runLen === 4 && openEnds === 2) live4 += 1;
      if (runLen === 4 && openEnds === 1) open4 += 1;
      if (runLen === 3 && openEnds === 2) {
        live3 += 1;
      } else if (runLen === 3 && openEnds === 1) {
        if (hasSplitLive3InLine(vals, idx, myVal, oppVal)) {
          live3 += 1;
        } else {
          sleep3 += 1;
        }
      } else if (runLen < 3) {
        if (hasSplitLive3InLine(vals, idx, myVal, oppVal)) {
          live3 += 1;
        }
      }
    }

    if (live4 > 0) {
      pushPattern(
        report,
        {
          type: 'LIVE4',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 4,
          openEnds: 2,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    } else if (open4 > 0) {
      pushPattern(
        report,
        {
          type: 'CHARGE4',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 4,
          openEnds: 1,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    } else if (live3 > 0) {
      pushPattern(
        report,
        {
          type: 'LIVE3',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 3,
          openEnds: 2,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    } else if (sleep3 > 0) {
      pushPattern(
        report,
        {
          type: 'SLEEP3',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 3,
          openEnds: 1,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    }

    if (live4 + open4 >= 2) {
      pushPattern(
        report,
        {
          type: 'DOUBLE_FOUR',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 0,
          openEnds: 0,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    }
    if (live4 + open4 >= 1 && live3 >= 1) {
      pushPattern(
        report,
        {
          type: 'FOUR_THREE',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 0,
          openEnds: 0,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    }
    if (live3 >= 2) {
      pushPattern(
        report,
        {
          type: 'DOUBLE_THREE',
          player: playerToMove,
          roadId: -1,
          dir: { x: 0, y: 0 },
          runLen: 0,
          openEnds: 0,
          stones: [],
          keyPoints: [pos],
          defensePoints: [pos],
        },
        seen,
      );
      addPoints(defensePointSet, [pos]);
      addPoints(attackPointSet, [pos]);
    }
  }

  report.winIn1 = [...winIn1Set.values()];
  report.winIn2 = [...winIn2Set.values()];
  report.myWin1Points = report.winIn1;
  report.myWin2Pairs = report.winIn2;
  report.oppWin1Points = [];
  report.oppWin2Pairs = [];
  report.winningPoints = report.winIn1;
  report.winPairs = report.winIn2;
  report.forcingPoints = [...forcingSet.values()];
  report.mustDefendPoints = report.forcingPoints; // legacy alias
  report.candidatePoints = [...candidateSet.values()];
  report.defensePoints = [...defensePointSet.values()];
  report.attackPoints = [...attackPointSet.values()];

  return report;
}

export function mergeThreatReports(
  myReport: ThreatReport,
  oppReport: ThreatReport,
): ThreatReport {
  const ENABLE_LEGACY_MERGE = true;

  const myWin1Points = myReport.winIn1;
  const myWin2Pairs = myReport.winIn2;
  const oppWin1Points = oppReport.winIn1;
  const oppWin2Pairs = oppReport.winIn2;

  if (ENABLE_LEGACY_MERGE) {
    const collectSingleDefensePoints = (report: ThreatReport, type: PatternType) => {
      const hits: PatternHit[] = report.byType[type];
      const points: Position[] = [];
      for (const hit of hits) {
        const source =
          hit.defensePoints.length > 0 ? hit.defensePoints : hit.keyPoints;
        if (source.length !== 1) continue;
        points.push(source[0]);
      }
      return points;
    };

    const oppWin2Points = flattenWin2Pairs(oppWin2Pairs);
    const oppChargeDef = unionPoints(
      collectSingleDefensePoints(oppReport, 'CHARGE5'),
      collectSingleDefensePoints(oppReport, 'CHARGE4'),
    );
    const mustDefendPoints = unionPoints(
      oppWin1Points,
      oppWin2Points,
      oppChargeDef,
    );
    const candidatePoints = unionPoints(
      myReport.candidatePoints,
      oppReport.candidatePoints,
      myReport.attackPoints,
      oppReport.defensePoints,
      mustDefendPoints,
    );
    return {
      ...myReport,
      oppPatterns: oppReport.patterns,
      oppByType: oppReport.byType,
      myWin1Points,
      myWin2Pairs,
      oppWin1Points,
      oppWin2Pairs,
      defensePoints: oppReport.defensePoints,
      attackPoints: myReport.attackPoints,
      mustDefendPoints,
      candidatePoints,
    };
  }

  const mustDefendPoints = unionPoints(
    oppWin1Points,
    flattenWin2Pairs(oppWin2Pairs),
  );
  const defensePoints = unionPoints(mustDefendPoints, oppReport.defensePoints);
  const attackPoints = unionPoints(
    myReport.attackPoints,
    myWin1Points,
    flattenWin2Pairs(myWin2Pairs),
  );
  const candidatePoints = unionPoints(
    myReport.candidatePoints,
    oppReport.candidatePoints,
    defensePoints,
    attackPoints,
  );
  return {
    ...myReport,
    oppPatterns: oppReport.patterns,
    oppByType: oppReport.byType,
    myWin1Points,
    myWin2Pairs,
    oppWin1Points,
    oppWin2Pairs,
    winningPoints: myWin1Points,
    winPairs: myWin2Pairs,
    mustDefendPoints,
    defensePoints,
    attackPoints,
    candidatePoints,
  };
}
