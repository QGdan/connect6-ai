import { analyzeThreats } from '../src/core/threat_analyzer';
import { createEmptyBoard } from '../src/core/game_state';
import type { GameState, Player, Position } from '../src/types';

type PatternKey = keyof ReturnType<typeof analyzeThreats>['byType'];

function makeState(): GameState {
  return {
    board: createEmptyBoard(),
    currentPlayer: 'BLACK',
    moveNumber: 0,
    lastMove: undefined,
    winner: undefined,
    zobristHash: 0n,
  };
}

function place(state: GameState, player: Player, positions: Position[]) {
  const v = player === 'BLACK' ? 1 : 2;
  for (const p of positions) {
    state.board[p.y][p.x] = v;
  }
}

function key(p: Position): string {
  return `${p.x},${p.y}`;
}

function hasKeyPoints(hitPoints: Position[], expected: Position[]): boolean {
  const set = new Set(hitPoints.map(key));
  return expected.every(p => set.has(key(p))) && set.size === expected.length;
}

function expectPattern(
  report: ReturnType<typeof analyzeThreats>,
  type: PatternKey,
  openEnds: number,
  keyPoints: Position[],
) {
  const found = report.byType[type].some(
    hit => hit.openEnds === openEnds && hasKeyPoints(hit.keyPoints, keyPoints),
  );
  if (!found) {
    throw new Error(
      `Missing ${type} openEnds=${openEnds} keyPoints=${keyPoints
        .map(key)
        .join('|')}`,
    );
  }
}

function expectWinIn2(
  report: ReturnType<typeof analyzeThreats>,
  a: Position,
  b: Position,
) {
  const aKey = key(a);
  const bKey = key(b);
  const found = report.winIn2.some(pair => {
    const k1 = key(pair[0]);
    const k2 = key(pair[1]);
    return (k1 === aKey && k2 === bKey) || (k1 === bKey && k2 === aKey);
  });
  if (!found) {
    throw new Error(`Missing WIN_IN_2 pair ${aKey}|${bKey}`);
  }
}

// LIVE5: .XXXXX.
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 5, y: 9 },
    { x: 6, y: 9 },
    { x: 7, y: 9 },
    { x: 8, y: 9 },
    { x: 9, y: 9 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'LIVE5', 2, [
    { x: 4, y: 9 },
    { x: 10, y: 9 },
  ]);
}

// CHARGE5: #XXXXX.
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 5, y: 8 },
    { x: 6, y: 8 },
    { x: 7, y: 8 },
    { x: 8, y: 8 },
    { x: 9, y: 8 },
  ]);
  place(state, 'WHITE', [{ x: 10, y: 8 }]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'CHARGE5', 1, [{ x: 4, y: 8 }]);
}

// DEAD5: #XXXXX#
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 5, y: 7 },
    { x: 6, y: 7 },
    { x: 7, y: 7 },
    { x: 8, y: 7 },
    { x: 9, y: 7 },
  ]);
  place(state, 'WHITE', [
    { x: 4, y: 7 },
    { x: 10, y: 7 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'DEAD5', 0, []);
}

// LIVE4: .XXXX.
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 6, y: 6 },
    { x: 7, y: 6 },
    { x: 8, y: 6 },
    { x: 9, y: 6 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'LIVE4', 2, [
    { x: 5, y: 6 },
    { x: 10, y: 6 },
  ]);
}

// CHARGE4: #XXXX.
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 6, y: 5 },
    { x: 7, y: 5 },
    { x: 8, y: 5 },
    { x: 9, y: 5 },
  ]);
  place(state, 'WHITE', [{ x: 10, y: 5 }]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'CHARGE4', 1, [{ x: 5, y: 5 }]);
}

// DEAD4: #XXXX#
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 6, y: 4 },
    { x: 7, y: 4 },
    { x: 8, y: 4 },
    { x: 9, y: 4 },
  ]);
  place(state, 'WHITE', [
    { x: 5, y: 4 },
    { x: 10, y: 4 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectPattern(report, 'DEAD4', 0, []);
}

// WIN_IN_2: non-consecutive 4-in-6
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 0, y: 3 },
    { x: 1, y: 3 },
    { x: 3, y: 3 },
    { x: 5, y: 3 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectWinIn2(report, { x: 2, y: 3 }, { x: 4, y: 3 });
}

// WIN_IN_2: consecutive 4-in-6
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 10, y: 2 },
    { x: 11, y: 2 },
    { x: 12, y: 2 },
    { x: 13, y: 2 },
  ]);
  const report = analyzeThreats(state, 'BLACK');
  expectWinIn2(report, { x: 14, y: 2 }, { x: 15, y: 2 });
}

console.log('threat_analyzer_selftest: OK');
