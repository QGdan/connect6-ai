import { createEmptyBoard } from '../src/core/game_state';
import { computeZobristHash } from '../src/core/zobrist';
import { analyzeBothSidesCached, clearThreatCache } from '../src/core/threat_service';
import { pvsSearchBestMove } from '../src/core/pvs_search';
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

function hasPos(movePositions: Position[], target: Position): boolean {
  return movePositions.some(p => p.x === target.x && p.y === target.y);
}

function assertBlockSingleWin2(
  label: string,
  state: GameState,
  oppPairs: [Position, Position][],
) {
  const res = pvsSearchBestMove(state, state.currentPlayer, weights, {
    maxDepth: 1,
    timeLimitMs: 200,
    useMultithreading: false,
  });
  const move = res.move;
  let blocksAny = false;
  for (const [a, b] of oppPairs) {
    const aHit = hasPos(move.positions, a);
    const bHit = hasPos(move.positions, b);
    if (aHit || bHit) blocksAny = true;
    if (aHit && bHit) {
      throw new Error(`${label}: blocked both points of a win2 pair`);
    }
  }
  if (!blocksAny) {
    throw new Error(`${label}: did not block any win2 pair point`);
  }
  if (oppPairs.length === 1) {
    const [a, b] = oppPairs[0];
    const count =
      (hasPos(move.positions, a) ? 1 : 0) +
      (hasPos(move.positions, b) ? 1 : 0);
    if (count !== 1) {
      throw new Error(`${label}: expected to block exactly one point`);
    }
  }
}

function assertOwnWin1(label: string, state: GameState, myWin1: Position[]) {
  const res = pvsSearchBestMove(state, state.currentPlayer, weights, {
    maxDepth: 1,
    timeLimitMs: 200,
    useMultithreading: false,
  });
  const hit = myWin1.some(p => hasPos(res.move.positions, p));
  if (!hit) {
    throw new Error(`${label}: did not play a winning point`);
  }
}

function assertOwnWin2(label: string, state: GameState, myPairs: [Position, Position][]) {
  const res = pvsSearchBestMove(state, state.currentPlayer, weights, {
    maxDepth: 1,
    timeLimitMs: 200,
    useMultithreading: false,
  });
  const move = res.move;
  const matched = myPairs.some(pair => {
    const hasFirst = hasPos(move.positions, pair[0]);
    const hasSecond = hasPos(move.positions, pair[1]);
    return hasFirst && hasSecond;
  });
  if (!matched) {
    throw new Error(`${label}: did not play the win2 pair`);
  }
}

// Opponent WIN_IN_2: 6-window with 4 stones non-contiguous.
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'WHITE',
        positions: [
          { x: 4, y: 9 },
          { x: 5, y: 9 },
          { x: 7, y: 9 },
          { x: 8, y: 9 },
        ],
      },
    ],
    'BLACK',
    1,
  );
  const { opp } = analyzeBothSidesCached(state, 'BLACK');
  if (opp.winIn2.length === 0) {
    throw new Error('setup failed: no opponent win2 pairs');
  }
  assertBlockSingleWin2('opp_win2', state, opp.winIn2);
}

// Own WIN_IN_1: five in a row with open end.
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'BLACK',
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
  const { my } = analyzeBothSidesCached(state, 'BLACK');
  if (my.winIn1.length === 0) {
    throw new Error('setup failed: no own win1 points');
  }
  assertOwnWin1('own_win1', state, my.winIn1);
}

// Own WIN_IN_2: 6-window with 4 stones and 2 empties.
{
  clearThreatCache();
  const state = makeState(
    [
      {
        player: 'BLACK',
        positions: [
          { x: 4, y: 12 },
          { x: 5, y: 12 },
          { x: 7, y: 12 },
          { x: 8, y: 12 },
        ],
      },
    ],
    'BLACK',
    1,
  );
  const { my } = analyzeBothSidesCached(state, 'BLACK');
  if (my.winIn2.length === 0) {
    throw new Error('setup failed: no own win2 pairs');
  }
  assertOwnWin2('own_win2', state, my.winIn2);
}

console.log('selfcheck_pvs_root: OK');
