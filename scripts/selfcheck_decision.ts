import type { EvaluationWeights, GameState, Move, Player, Position } from '../src/types.ts';
import { createEmptyBoard } from '../src/core/game_state.ts';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
import { HybridStrategyManager } from '../src/strategy/hybrid_strategy.ts';
import { analyzeBothCached } from '../src/core/threat_service.ts';
import { applyMoveWithWinner, getStonesToPlace } from '../src/core/rules.ts';
import { posIdx } from '../src/core/pos_key.ts';

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const pvsConfig = {
  maxDepth: 2,
  timeLimitMs: 120,
  useMultithreading: false,
};

type MetricKeys =
  | 'blockWin1Failures'
  | 'blockWin2Failures'
  | 'overBlockSingleLive3'
  | 'immediateBlunder'
  | 'hybridUnsafeChoice'
  | 'hybridSelectorDormant';

const metrics: Record<MetricKeys, number> = {
  blockWin1Failures: 0,
  blockWin2Failures: 0,
  overBlockSingleLive3: 0,
  immediateBlunder: 0,
  hybridUnsafeChoice: 0,
  hybridSelectorDormant: 0,
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function hasPos(list: Position[], target: Position): boolean {
  return list.some(p => p.x === target.x && p.y === target.y);
}

function moveHits(list: Position[], points: Position[]): number {
  const set = new Set(list.map(p => posIdx(p.x, p.y)));
  return points.reduce((acc, p) => acc + (set.has(posIdx(p.x, p.y)) ? 1 : 0), 0);
}

function switchPlayer(player: Player): Player {
  return player === 'BLACK' ? 'WHITE' : 'BLACK';
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

function opponentHasImmediate(state: GameState, playerWhoJustMoved: Player): boolean {
  const opp = switchPlayer(playerWhoJustMoved);
  const need = getStonesToPlace(state.moveNumber, opp);
  const { my: oppReport } = analyzeBothCached(state, opp);
  return oppReport.winIn1.length > 0 || (need >= 2 && oppReport.winIn2.length > 0);
}

async function caseTraditionalBlockWin1(): Promise<void> {
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
  const decision = pvsSearchBestMove(state, 'BLACK', weights, pvsConfig);
  if (!hasPos(decision.move.positions, mustBlock)) {
    metrics.blockWin1Failures += 1;
    throw new Error('traditional failed to block opponent winIn1');
  }
}

async function caseTraditionalBlockWin2(): Promise<void> {
  const state = makeState(
    [],
    [
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 5, y: 2 },
    ],
    'BLACK',
    1,
  );
  const pair = [{ x: 3, y: 2 }, { x: 4, y: 2 }];
  const decision = pvsSearchBestMove(state, 'BLACK', weights, pvsConfig);
  const hits = moveHits(decision.move.positions, pair);
  if (hits !== 1) {
    metrics.blockWin2Failures += 1;
    throw new Error('traditional should block exactly one point of opp winIn2 pair');
  }
}

async function caseTraditionalNoOverBlockSingleLive3(): Promise<void> {
  const state = makeState(
    [{ x: 9, y: 9 }, { x: 11, y: 9 }],
    [{ x: 9, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 }],
    'BLACK',
    2,
  );
  const singleLive3Ends = [{ x: 8, y: 10 }, { x: 12, y: 10 }];
  const decision = pvsSearchBestMove(state, 'BLACK', weights, pvsConfig);
  const hits = moveHits(decision.move.positions, singleLive3Ends);
  if (hits >= 2) {
    metrics.overBlockSingleLive3 += 1;
    throw new Error('traditional over-blocked a single live3 by filling both ends');
  }
}

async function caseTraditionalNoImmediateBlunder(): Promise<void> {
  const state = makeState(
    [{ x: 9, y: 9 }, { x: 10, y: 9 }, { x: 8, y: 10 }, { x: 11, y: 11 }],
    [{ x: 9, y: 10 }, { x: 10, y: 10 }, { x: 8, y: 9 }, { x: 11, y: 10 }],
    'BLACK',
    2,
  );
  const { my, opp } = analyzeBothCached(state, 'BLACK');
  assert(my.winIn1.length === 0 && my.winIn2.length === 0, 'setup invalid: own immediate win exists');
  assert(opp.winIn1.length === 0 && opp.winIn2.length === 0, 'setup invalid: opponent immediate threat exists');

  const decision = pvsSearchBestMove(state, 'BLACK', weights, pvsConfig);
  const next = applyMoveWithWinner(state, decision.move);
  if (opponentHasImmediate(next, 'BLACK')) {
    metrics.immediateBlunder += 1;
    throw new Error('traditional produced immediate blunder in non-forced state');
  }
}

async function caseHybridRejectsUnsafeHighScore(): Promise<void> {
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
  (manager as unknown as { selectStrategy: () => string }).selectStrategy = () => 'hybrid';

  const decision = await manager.decideMove(state, 'BLACK');
  const unsafe = !hasPos(decision.move.positions, mustBlock) || opponentHasImmediate(applyMoveWithWinner(state, decision.move), 'BLACK');
  if (unsafe) {
    metrics.hybridUnsafeChoice += 1;
    throw new Error('hybrid accepted unsafe move from cross-engine arbitration');
  }
}

async function caseHybridSelectorNotDormant(): Promise<void> {
  const state = makeState(
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
  const manager = new HybridStrategyManager(
    safeMcts as unknown as never,
    {} as never,
    { pvsConfig, weights },
  );
  const decision = await manager.decideMove(state, 'BLACK');
  if (decision.debugInfo?.decisionStage !== 'hybrid_final') {
    metrics.hybridSelectorDormant += 1;
    throw new Error('hybrid selector stayed dormant on non-urgent midgame state');
  }
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function main(): Promise<void> {
  await runCase('traditional_block_win1', caseTraditionalBlockWin1);
  await runCase('traditional_block_win2', caseTraditionalBlockWin2);
  await runCase('traditional_single_live3_no_double_block', caseTraditionalNoOverBlockSingleLive3);
  await runCase('traditional_non_forced_no_immediate_blunder', caseTraditionalNoImmediateBlunder);
  await runCase('hybrid_rejects_unsafe_high_score', caseHybridRejectsUnsafeHighScore);
  await runCase('hybrid_selector_not_dormant', caseHybridSelectorNotDormant);

  console.log('selfcheck_decision: summary');
  for (const [k, v] of Object.entries(metrics)) {
    console.log(`  ${k}=${v}`);
  }
  const failures = Object.values(metrics).reduce((sum, x) => sum + x, 0);
  if (failures > 0) {
    throw new Error(`selfcheck_decision: failures=${failures}`);
  }
  console.log('selfcheck_decision: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
