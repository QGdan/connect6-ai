import { createEmptyBoard } from '../src/core/game_state';
import { computeZobristHash } from '../src/core/zobrist';
import { analyzeBothSidesCached, clearThreatCache } from '../src/core/threat_service';
import { generateRZOPCandidates } from '../src/core/rzop';
import { evaluateState } from '../src/core/evaluation';
import type { EvaluationWeights, GameState, Player, Position } from '../src/types';

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

function makeState(
  placements: Array<{ player: Player; positions: Position[] }>,
  currentPlayer: Player,
  moveNumber: number,
): GameState {
  const board = createEmptyBoard();
  for (const group of placements) {
    const v = group.player === 'BLACK' ? 1 : 2;
    for (const p of group.positions) {
      board[p.y][p.x] = v;
    }
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

function assertLowEval(label: string, state: GameState) {
  const score = evaluateState(state, 'BLACK', weights);
  if (Math.abs(score) > 5_000) {
    throw new Error(`${label}: eval too high: ${score}`);
  }
}

function assertNoMustDefend(label: string, report: { winIn1: Position[]; winIn2: [Position, Position][]; mustDefendPoints: Position[] }) {
  if (report.winIn1.length > 0 || report.winIn2.length > 0) {
    throw new Error(`${label}: unexpected win points`);
  }
  if (report.mustDefendPoints.length > 0) {
    throw new Error(`${label}: dead pattern treated as must-defend`);
  }
}

function assertUrgentIncludesWin1(label: string, state: GameState, win1: Position[]) {
  const candidates = generateRZOPCandidates(state);
  const hit = win1.some(p =>
    candidates.some(c => c.x === p.x && c.y === p.y),
  );
  if (!hit) {
    throw new Error(`${label}: urgent candidates missing win1 point`);
  }
}

// DEAD4: #XXXX#
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'BLACK',
        positions: [
          { x: 6, y: 9 },
          { x: 7, y: 9 },
          { x: 8, y: 9 },
          { x: 9, y: 9 },
        ],
      },
      {
        player: 'WHITE',
        positions: [
          { x: 5, y: 9 },
          { x: 10, y: 9 },
        ],
      },
    ],
    'BLACK',
    1,
  );
  const { my } = analyzeBothSidesCached(state, 'BLACK');
  assertNoMustDefend('dead4', my);
  assertLowEval('dead4', state);
}

// DEAD5: #XXXXX#
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'BLACK',
        positions: [
          { x: 5, y: 8 },
          { x: 6, y: 8 },
          { x: 7, y: 8 },
          { x: 8, y: 8 },
          { x: 9, y: 8 },
        ],
      },
      {
        player: 'WHITE',
        positions: [
          { x: 4, y: 8 },
          { x: 10, y: 8 },
        ],
      },
    ],
    'BLACK',
    1,
  );
  const { my } = analyzeBothSidesCached(state, 'BLACK');
  assertNoMustDefend('dead5', my);
  assertLowEval('dead5', state);
}

// Opponent WIN_IN_1 included in urgent candidates and mustDefend.
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'WHITE',
        positions: [
          { x: 5, y: 10 },
          { x: 6, y: 10 },
          { x: 7, y: 10 },
          { x: 8, y: 10 },
          { x: 9, y: 10 },
        ],
      },
    ],
    'BLACK',
    1,
  );
  const { opp } = analyzeBothSidesCached(state, 'BLACK');
  if (opp.winIn1.length === 0) {
    throw new Error('win1 setup failed');
  }
  if (opp.mustDefendPoints.length === 0) {
    throw new Error('mustDefend should include win1 points');
  }
  assertUrgentIncludesWin1('opp_win1', state, opp.winIn1);
}

console.log('selfcheck_integration: OK');
