import { computeZobristHash } from '../src/core/zobrist.ts';
import { analyzeThreats } from '../src/core/threat_analyzer.ts';
import { detectVCDT } from '../src/core/vcdt.ts';
import type { Cell, GameState, Position } from '../src/types.ts';

function makeEmptyBoard(): Cell[][] {
  return Array.from({ length: 19 }, () => Array<Cell>(19).fill(0));
}

function makeState(stones: Array<{ pos: Position; player: 1 | 2 }>): GameState {
  const board = makeEmptyBoard();
  for (const { pos, player } of stones) {
    board[pos.y][pos.x] = player;
  }
  return {
    board,
    currentPlayer: 'BLACK',
    moveNumber: 0,
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, 'BLACK'),
  };
}

function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const black = (x: number, y: number) => ({ pos: { x, y }, player: 1 as const });
const white = (x: number, y: number) => ({ pos: { x, y }, player: 2 as const });

function posEq(a: Position, b: Position) {
  return a.x === b.x && a.y === b.y;
}

// 活/冲/死 五
{
  const state = makeState([
    black(3, 0),
    black(4, 0),
    black(5, 0),
    black(6, 0),
    black(7, 0),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.LIVE5.length === 1, 'LIVE5 not detected');
  expect(
    report.winningPoints.some(p => posEq(p, { x: 2, y: 0 })) &&
      report.winningPoints.some(p => posEq(p, { x: 8, y: 0 })),
    'LIVE5 winning points incorrect',
  );
}
{
  const state = makeState([
    black(3, 1),
    black(4, 1),
    black(5, 1),
    black(6, 1),
    black(7, 1),
    white(8, 1),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.CHARGE5.length === 1, 'CHARGE5 not detected');
  expect(
    report.winningPoints.some(p => posEq(p, { x: 2, y: 1 })),
    'CHARGE5 winning point missing',
  );
}
{
  const state = makeState([
    white(2, 2),
    black(3, 2),
    black(4, 2),
    black(5, 2),
    black(6, 2),
    black(7, 2),
    white(8, 2),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.DEAD5.length === 1, 'DEAD5 not detected');
}

// 活/冲/死 四
{
  const state = makeState([black(3, 3), black(4, 3), black(5, 3), black(6, 3)]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.LIVE4.length === 1, 'LIVE4 not detected');
}
{
  const state = makeState([
    black(3, 4),
    black(4, 4),
    black(5, 4),
    black(6, 4),
    white(7, 4),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.CHARGE4.length === 1, 'CHARGE4 not detected');
}
{
  const state = makeState([
    white(2, 5),
    black(3, 5),
    black(4, 5),
    black(5, 5),
    black(6, 5),
    white(7, 5),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.byType.DEAD4.length === 1, 'DEAD4 not detected');
}

// WIN_IN_2 连续四+两空（允许非连续 4 子）
{
  const state = makeState([
    black(0, 6),
    black(1, 6),
    black(2, 6),
    black(5, 6),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.winPairs.length >= 1, 'WIN_IN_2 pair missing (case1)');
  const pair = report.winPairs[0];
  expect(pair.some(p => posEq(p, { x: 3, y: 6 })) && pair.some(p => posEq(p, { x: 4, y: 6 })), 'WIN_IN_2 pair incorrect (case1)');
}
{
  const state = makeState([
    black(10, 7),
    black(12, 7),
    black(14, 7),
    black(15, 7),
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expect(report.winPairs.length >= 1, 'WIN_IN_2 pair missing (case2)');
  const hit = report.winPairs.some(
    ([a, b]) =>
      (posEq(a, { x: 11, y: 7 }) && posEq(b, { x: 13, y: 7 })) ||
      (posEq(a, { x: 13, y: 7 }) && posEq(b, { x: 11, y: 7 })),
  );
  expect(hit, 'WIN_IN_2 pair incorrect (case2)');
}

// 防守策略：win_in_2 只需堵一端（defenseCost=1）
{
  const state = makeState([
    black(0, 10),
    black(1, 10),
    black(3, 10),
    black(5, 10),
  ]);
  const threats = detectVCDT(state, 'BLACK');
  const win2 = threats.find(t => t.kind === 'WIN_IN_2');
  expect(win2 !== undefined, 'VCDT WIN_IN_2 missing');
  expect(win2?.defenseCost === 1, 'WIN_IN_2 defenseCost should be 1');
  expect(win2?.positions.length === 2, 'WIN_IN_2 should expose two points');
}

console.log('threat_patterns_selftest: OK');
