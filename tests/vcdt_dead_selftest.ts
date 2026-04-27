import { createEmptyBoard } from '../src/core/game_state';
import { evaluateState } from '../src/core/evaluation';
import { detectVCDT } from '../src/core/vcdt';
import type { EvaluationWeights, GameState, Player, Position } from '../src/types';

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

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

function assertDeadThreatsNotCritical(
  label: string,
  state: GameState,
  kind: 'DEAD4' | 'DEAD5',
) {
  const threats = detectVCDT(state, 'BLACK');
  const dead = threats.filter(t => t.kind === kind);
  if (dead.length === 0) {
    throw new Error(`${label}: missing ${kind} threat`);
  }
  for (const t of dead) {
    if (t.isWinning || t.threatLevel <= 2) {
      throw new Error(
        `${label}: ${kind} misclassified as must-win/defend`,
      );
    }
  }
}

function assertLowScore(label: string, state: GameState) {
  const score = evaluateState(state, 'BLACK', weights);
  if (Math.abs(score) > 5_000) {
    throw new Error(`${label}: score too high: ${score}`);
  }
}

function assertDeadNotNearLive(
  label: string,
  deadState: GameState,
  liveState: GameState,
) {
  const deadScore = evaluateState(deadState, 'BLACK', weights);
  const liveScore = evaluateState(liveState, 'BLACK', weights);
  if (liveScore <= 0) {
    throw new Error(`${label}: live score not positive: ${liveScore}`);
  }
  if (Math.abs(deadScore) > liveScore * 0.2) {
    throw new Error(
      `${label}: dead score too close to live (dead=${deadScore}, live=${liveScore})`,
    );
  }
}

// DEAD4: #XXXX#
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 6, y: 9 },
    { x: 7, y: 9 },
    { x: 8, y: 9 },
    { x: 9, y: 9 },
  ]);
  place(state, 'WHITE', [
    { x: 5, y: 9 },
    { x: 10, y: 9 },
  ]);
  const live = makeState();
  place(live, 'BLACK', [
    { x: 6, y: 9 },
    { x: 7, y: 9 },
    { x: 8, y: 9 },
    { x: 9, y: 9 },
  ]);
  assertDeadThreatsNotCritical('DEAD4', state, 'DEAD4');
  assertLowScore('DEAD4', state);
  assertDeadNotNearLive('DEAD4', state, live);
}

// DEAD5: #XXXXX#
{
  const state = makeState();
  place(state, 'BLACK', [
    { x: 5, y: 8 },
    { x: 6, y: 8 },
    { x: 7, y: 8 },
    { x: 8, y: 8 },
    { x: 9, y: 8 },
  ]);
  place(state, 'WHITE', [
    { x: 4, y: 8 },
    { x: 10, y: 8 },
  ]);
  const live = makeState();
  place(live, 'BLACK', [
    { x: 5, y: 8 },
    { x: 6, y: 8 },
    { x: 7, y: 8 },
    { x: 8, y: 8 },
    { x: 9, y: 8 },
  ]);
  assertDeadThreatsNotCritical('DEAD5', state, 'DEAD5');
  assertLowScore('DEAD5', state);
  assertDeadNotNearLive('DEAD5', state, live);
}

console.log('vcdt_dead_selftest: OK');
