import { computeZobristHash } from '../src/core/zobrist.ts';
import { analyzeThreats } from '../src/core/threat_analyzer.ts';
import { generateRZOPCandidates } from '../src/core/rzop.ts';
import { pvsSearchBestMove, getLastSearchStats } from '../src/core/pvs_search.ts';
import { createInitialState } from '../src/core/game_state.ts';
import type { Cell, GameState, Position } from '../src/types.ts';

function makeEmptyBoard(): Cell[][] {
  return Array.from({ length: 19 }, () => Array<Cell>(19).fill(0));
}

function makeState(
  stones: Array<{ pos: Position; player: 1 | 2 }>,
  currentPlayer: 'BLACK' | 'WHITE',
  moveNumber: number,
): GameState {
  const board = makeEmptyBoard();
  for (const { pos, player } of stones) {
    board[pos.y][pos.x] = player;
  }
  return {
    board,
    currentPlayer,
    moveNumber,
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, currentPlayer),
  };
}

function expect(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function addUrgentPoints(report: ReturnType<typeof analyzeThreats>): Set<string> {
  const urgent = new Set<string>();
  const add = (p: Position) => urgent.add(`${p.x},${p.y}`);

  for (const p of report.winIn1) add(p);
  for (const [a, b] of report.winIn2) {
    add(a);
    add(b);
  }
  for (const hit of report.byType.CHARGE5) {
    for (const p of hit.defensePoints.length > 0 ? hit.defensePoints : hit.keyPoints) {
      add(p);
    }
  }
  for (const hit of report.byType.CHARGE4) {
    for (const p of hit.defensePoints.length > 0 ? hit.defensePoints : hit.keyPoints) {
      add(p);
    }
  }

  return urgent;
}

const weights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

// Opponent has DEAD4/DEAD5 only: no urgent points, candidates stay small.
{
  const state = makeState(
    [
      // Opponent dead4 (WHITE=2) blocked by BLACK.
      { pos: { x: 3, y: 5 }, player: 2 },
      { pos: { x: 4, y: 5 }, player: 2 },
      { pos: { x: 5, y: 5 }, player: 2 },
      { pos: { x: 6, y: 5 }, player: 2 },
      { pos: { x: 2, y: 5 }, player: 1 },
      { pos: { x: 7, y: 5 }, player: 1 },
      // Opponent dead5 (WHITE=2) blocked by BLACK.
      { pos: { x: 4, y: 6 }, player: 2 },
      { pos: { x: 5, y: 6 }, player: 2 },
      { pos: { x: 6, y: 6 }, player: 2 },
      { pos: { x: 7, y: 6 }, player: 2 },
      { pos: { x: 8, y: 6 }, player: 2 },
      { pos: { x: 3, y: 6 }, player: 1 },
      { pos: { x: 9, y: 6 }, player: 1 },
      // My stones for some attackPoints.
      { pos: { x: 10, y: 10 }, player: 1 },
      { pos: { x: 11, y: 10 }, player: 1 },
    ],
    'BLACK',
    6,
  );

  const oppReport = analyzeThreats(state, 'WHITE');
  expect(oppReport.byType.DEAD4.length > 0, 'DEAD4 not detected');
  expect(oppReport.byType.DEAD5.length > 0, 'DEAD5 not detected');

  const urgent = addUrgentPoints(oppReport);
  expect(urgent.size === 0, 'DEAD4/DEAD5 should not be urgent');

  const candidates = generateRZOPCandidates(state);
  expect(candidates.length <= 16, 'RZOP candidates exceed topK');

  // candidate noise stays bounded even with dead4/dead5 present
}

// Depth sanity: small candidate pool should allow depth >= 2 on empty board.
{
  const state = createInitialState();
  const decision = pvsSearchBestMove(state, 'BLACK', weights, {
    maxDepth: 2,
    timeLimitMs: 3000,
    useMultithreading: false,
  });
  const depth = decision.debugInfo?.depth ?? getLastSearchStats().depth;
  expect(depth >= 2, 'search depth too shallow on empty board');
}

console.log('rzop_threat_selftest: OK');
