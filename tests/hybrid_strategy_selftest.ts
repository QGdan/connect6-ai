import type { EvaluationWeights, GameState, Move, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { posIdx } from '../src/core/pos_key.ts';
import { getStonesToPlace, applyMoveWithWinner } from '../src/core/rules.ts';
import { analyzeBothCached } from '../src/core/threat_service.ts';
import { HybridStrategyManager } from '../src/strategy/hybrid_strategy.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function hasPos(list: Position[], target: Position): boolean {
  return list.some(p => p.x === target.x && p.y === target.y);
}

function makeState(
  black: Position[],
  white: Position[],
  currentPlayer: Player,
  moveNumber: number,
): GameState {
  const board = createEmptyBoard();
  for (const p of black) board[p.y][p.x] = 1;
  for (const p of white) board[p.y][p.x] = 2;
  return {
    board,
    currentPlayer,
    moveNumber,
    lastMove: undefined,
    winner: undefined,
    zobristHash: computeZobristHash(board, currentPlayer),
  };
}

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const pvsConfig = {
  maxDepth: 2,
  timeLimitMs: 80,
  useMultithreading: false,
};

async function main(): Promise<void> {
  // White has a single immediate winning point at (9,11). Hybrid must block it.
  const state = makeState(
    [{ x: 3, y: 11 }],
    [
      { x: 4, y: 11 },
      { x: 5, y: 11 },
      { x: 6, y: 11 },
      { x: 7, y: 11 },
      { x: 8, y: 11 },
    ],
    'BLACK',
    2,
  );
  const mustBlock = { x: 9, y: 11 };

  const badMcts = {
    async decideMove(_state: GameState, player: Player): Promise<{ move: Move; score: number; debugInfo: Record<string, unknown> }> {
      return {
        move: { player, positions: [{ x: 0, y: 0 }, { x: 0, y: 1 }] },
        score: 0.99,
        debugInfo: { engine: 'mcts', strategy: 'deep' },
      };
    },
  };

  const manager = new HybridStrategyManager(
    badMcts as unknown as never,
    {} as never,
    { pvsConfig, weights },
  );
  // Force the hybrid branch to validate cross-engine arbitration behavior.
  (manager as unknown as { selectStrategy: (step: number, complexity: number) => string }).selectStrategy =
    () => 'hybrid';

  const decision = await manager.decideMove(state, 'BLACK');
  assert(hasPos(decision.move.positions, mustBlock), 'hybrid should block opp winIn1');
  assert(
    decision.debugInfo?.decisionStage === 'hybrid_final',
    'hybrid should expose decisionStage=hybrid_final',
  );
  assert(
    decision.debugInfo?.engine === 'pvs+threat+zorp',
    'hybrid should reject unsafe high-score mcts suggestion',
  );

  const next = applyMoveWithWinner(state, decision.move);
  const opp = 'WHITE';
  const oppNeed = getStonesToPlace(next.moveNumber, opp);
  const { my: oppReport } = analyzeBothCached(next, opp);
  const oppHasImmediate =
    oppReport.winIn1.length > 0 ||
    (oppNeed >= 2 && oppReport.winIn2.length > 0);
  assert(!oppHasImmediate, 'hybrid result should not leave immediate loss');

  // Keep one lightweight sanity check for legal two-stone move shape.
  const uniq = new Set(decision.move.positions.map(p => posIdx(p.x, p.y)));
  assert(uniq.size === decision.move.positions.length, 'hybrid move contains duplicate stones');

  // Non-urgent midgame should go through hybrid arbitration path instead of
  // selector-dormant traditional fallback.
  const midgameState = makeState(
    [
      { x: 3, y: 3 },
      { x: 6, y: 6 },
      { x: 10, y: 10 },
      { x: 13, y: 5 },
    ],
    [
      { x: 15, y: 15 },
      { x: 12, y: 8 },
      { x: 5, y: 12 },
      { x: 8, y: 14 },
    ],
    'BLACK',
    16,
  );

  const safeMcts = {
    async decideMove(_state: GameState, player: Player): Promise<{ move: Move; score: number; debugInfo: Record<string, unknown> }> {
      return {
        move: { player, positions: [{ x: 9, y: 9 }, { x: 9, y: 8 }] },
        score: 0.52,
        debugInfo: { engine: 'mcts', strategy: 'deep' },
      };
    },
  };
  const autoManager = new HybridStrategyManager(
    safeMcts as unknown as never,
    {} as never,
    { pvsConfig, weights },
  );
  const autoDecision = await autoManager.decideMove(midgameState, 'BLACK');
  assert(
    autoDecision.debugInfo?.decisionStage === 'hybrid_final',
    'non-urgent midgame should enter hybrid_final decision stage',
  );

  console.log('hybrid_strategy_selftest: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
