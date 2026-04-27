import { createEmptyBoard } from '../src/core/game_state';
import { computeZobristHash } from '../src/core/zobrist';
import { analyzeThreats, mergeThreatReports } from '../src/core/threat_analyzer';
import type { GameState, Player, Position } from '../src/types';

function makeState(
  placements: Array<{ player: Player; positions: Position[] }>,
  currentPlayer: Player,
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
    moveNumber: 1,
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, currentPlayer),
  };
}

function hasPoint(points: Position[], target: Position): boolean {
  return points.some(p => p.x === target.x && p.y === target.y);
}

// candidatePoints union contains both sides' neighbor points.
{
  const state = makeState(
    [
      { player: 'BLACK', positions: [{ x: 5, y: 5 }] },
      { player: 'WHITE', positions: [{ x: 13, y: 13 }] },
    ],
    'BLACK',
  );
  const my = analyzeThreats(state, 'BLACK');
  const opp = analyzeThreats(state, 'WHITE');
  const merged = mergeThreatReports(my, opp);

  const blackNeighbor = { x: 6, y: 5 };
  const whiteNeighbor = { x: 12, y: 13 };

  if (!hasPoint(merged.candidatePoints, blackNeighbor)) {
    throw new Error('candidatePoints missing black neighbor');
  }
  if (!hasPoint(merged.candidatePoints, whiteNeighbor)) {
    throw new Error('candidatePoints missing white neighbor');
  }
}

// Only my LIVE5: merged.mustDefendPoints should be empty.
{
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
  );
  const my = analyzeThreats(state, 'BLACK');
  const opp = analyzeThreats(state, 'WHITE');
  const merged = mergeThreatReports(my, opp);
  if (merged.mustDefendPoints.length !== 0) {
    throw new Error('mustDefendPoints should be empty when only my LIVE5 exists');
  }
}

// Opponent WIN_IN_1 should appear in mustDefendPoints.
{
  const state = makeState(
    [
      {
        player: 'WHITE',
        positions: [
          { x: 5, y: 8 },
          { x: 6, y: 8 },
          { x: 7, y: 8 },
          { x: 8, y: 8 },
          { x: 9, y: 8 },
        ],
      },
    ],
    'BLACK',
  );
  const my = analyzeThreats(state, 'BLACK');
  const opp = analyzeThreats(state, 'WHITE');
  const merged = mergeThreatReports(my, opp);
  if (opp.winIn1.length === 0) {
    throw new Error('setup failed: opp winIn1 missing');
  }
  for (const p of opp.winIn1) {
    if (!hasPoint(merged.mustDefendPoints, p)) {
      throw new Error('mustDefendPoints missing opponent winIn1');
    }
  }
}

console.log('selfcheck_threat_merge: OK');
