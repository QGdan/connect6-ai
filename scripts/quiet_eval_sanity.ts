import type {
  EvaluationWeights,
  GameState,
  Move,
  Player,
  Position,
} from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { analyzeBothSidesCached } from '../src/core/threat_service.ts';
import { applyMoveWithWinner } from '../src/core/rules.ts';
import { posIdx } from '../src/core/pos_key.ts';
import { PatternEvaluator } from '../src/core/pattern_evaluator.ts';
import { evaluateWithThreatReport } from '../src/core/pvs_search.ts';
import { formatBoardCoordTuple } from '../src/core/board_coords.ts';
import type { PatternType, ThreatReport } from '../src/core/pattern_library.ts';

const DEFAULT_WEIGHTS: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const QUIET_TYPES: PatternType[] = [
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function formatMove(move: Move): string {
  return move.positions.map(p => `(${formatBoardCoordTuple(p)})`).join(' ');
}

function makeState(
  black: Position[],
  white: Position[],
  currentPlayer: Player,
  moveNumber: number,
): GameState {
  const board = createEmptyBoard();
  const seen = new Set<number>();
  for (const p of black) {
    const key = posIdx(p.x, p.y);
    assert(!seen.has(key), 'Duplicate position in black stones');
    seen.add(key);
    board[p.y][p.x] = 1;
  }
  for (const p of white) {
    const key = posIdx(p.x, p.y);
    assert(!seen.has(key), 'Duplicate position in white stones');
    seen.add(key);
    board[p.y][p.x] = 2;
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

function isQuiet(my: ThreatReport, opp: ThreatReport): boolean {
  if (my.winIn1.length > 0 || my.winIn2.length > 0) return false;
  if (opp.winIn1.length > 0 || opp.winIn2.length > 0) return false;
  for (const type of QUIET_TYPES) {
    if (my.byType[type].length > 0) return false;
    if (opp.byType[type].length > 0) return false;
  }
  return true;
}

function scoreMove(
  state: GameState,
  move: Move,
  rootPlayer: Player,
  patternEval: PatternEvaluator,
): number {
  const next = applyMoveWithWinner(state, move);
  const { my, opp } = analyzeBothSidesCached(next, rootPlayer);
  assert(
    isQuiet(my, opp),
    `Expected quiet position after move ${formatMove(move)}`,
  );
  return evaluateWithThreatReport(
    next,
    rootPlayer,
    DEFAULT_WEIGHTS,
    { self: my, opp },
    patternEval,
  );
}

function main() {
  const rootPlayer: Player = 'BLACK';
  const black: Position[] = [
    { x: 9, y: 9 },
    { x: 7, y: 9 },
    { x: 11, y: 8 },
    { x: 6, y: 12 },
    { x: 13, y: 6 },
    { x: 10, y: 12 },
  ];
  const white: Position[] = [
    { x: 9, y: 10 },
    { x: 8, y: 8 },
    { x: 11, y: 10 },
    { x: 6, y: 10 },
    { x: 12, y: 12 },
    { x: 13, y: 8 },
  ];
  const state = makeState(black, white, rootPlayer, 6);

  const patternEval = new PatternEvaluator(rootPlayer);

  const shapeMove: Move = {
    player: rootPlayer,
    positions: [
      { x: 8, y: 9 },
      { x: 9, y: 8 },
    ],
  };
  const randomMove: Move = {
    player: rootPlayer,
    positions: [
      { x: 0, y: 0 },
      { x: 18, y: 18 },
    ],
  };

  const shapeScore = scoreMove(state, shapeMove, rootPlayer, patternEval);
  const randomScore = scoreMove(state, randomMove, rootPlayer, patternEval);

  console.log('shape move:', formatMove(shapeMove), 'score', shapeScore);
  console.log('random move:', formatMove(randomMove), 'score', randomScore);
  assert(shapeScore > randomScore, 'Expected shape move to score higher');
  console.log('quiet_eval_sanity: OK');
}

main();
