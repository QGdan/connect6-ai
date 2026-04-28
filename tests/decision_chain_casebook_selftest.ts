import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationWeights, GameState, Move, Player, Position } from '../src/types.ts';
import { createInitialState } from '../src/core/game_state.ts';
import { applyMoveWithWinner, getStonesToPlace } from '../src/core/rules.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
import { HybridStrategyManager } from '../src/strategy/hybrid_strategy.ts';
import { MCTSConnect6AI } from '../src/core/mcts_ai_engine.ts';
import { createDefaultEvaluator } from '../src/core/resnet_ai.ts';
import { analyzeBothCached } from '../src/core/threat_service.ts';

type CoordMode = 'bottom' | 'top';

type CaseSpec = {
  id: string;
  gameIndex: number;
  turnIndex: number;
  expectStage: string;
  expectStrategy: string;
  expectedSameAsTraditional: boolean;
};

type Casebook = {
  sourceFixture: string;
  coordMode: CoordMode;
  maxGames: number;
  maxTurnsPerGame: number;
  sampleStride: number;
  cases: CaseSpec[];
};

const weights: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const pvsConfig = {
  maxDepth: 3,
  timeLimitMs: 120,
  useMultithreading: false,
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function switchPlayer(player: Player): Player {
  return player === 'BLACK' ? 'WHITE' : 'BLACK';
}

function moveKey(move: Move): string {
  return move.positions
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
}

function parseCoord(token: string, mode: CoordMode): Position | null {
  const m = token.match(/^([BW])\(([A-S]),(\d{1,2})\)$/i);
  if (!m) return null;
  const x = m[2].toUpperCase().charCodeAt(0) - 65;
  const row = Number(m[3]);
  if (!Number.isFinite(row) || row < 1 || row > 19) return null;
  const y = mode === 'bottom' ? 19 - row : row - 1;
  if (x < 0 || x >= 19 || y < 0 || y >= 19) return null;
  return { x, y };
}

function parseStones(
  line: string,
  mode: CoordMode,
): Array<{ player: Player; pos: Position }> {
  const tokens = line
    .split(';')
    .map(t => t.replace(/^\{+/, '').replace(/\}+$/, '').trim())
    .filter(Boolean);
  const out: Array<{ player: Player; pos: Position }> = [];
  for (const token of tokens) {
    const pos = parseCoord(token, mode);
    if (!pos) continue;
    const player = token[0].toUpperCase() === 'B' ? 'BLACK' : 'WHITE';
    out.push({ player, pos });
  }
  return out;
}

function groupMoves(stones: Array<{ player: Player; pos: Position }>): Move[] {
  const out: Move[] = [];
  let current: Move | null = null;
  for (const s of stones) {
    if (!current || current.player !== s.player) {
      if (current) out.push(current);
      current = { player: s.player, positions: [s.pos] };
    } else {
      current.positions.push(s.pos);
    }
  }
  if (current) out.push(current);
  return out;
}

function buildStateAtTurn(
  line: string,
  mode: CoordMode,
  turnIndex: number,
): GameState {
  const moves = groupMoves(parseStones(line, mode));
  let state = createInitialState();
  for (let i = 0; i < turnIndex; i += 1) {
    const actual = moves[i];
    if (!actual || state.winner) break;
    const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
    state = applyMoveWithWinner(state, actual, {
      allowIncomplete: actual.positions.length < required,
    });
  }
  return state;
}

function opponentHasImmediate(
  state: GameState,
  playerWhoJustMoved: Player,
): boolean {
  const opp = switchPlayer(playerWhoJustMoved);
  const oppNeed = getStonesToPlace(state.moveNumber, opp);
  const { my: oppReport } = analyzeBothCached(state, opp);
  return oppReport.winIn1.length > 0 || (oppNeed >= 2 && oppReport.winIn2.length > 0);
}

async function main(): Promise<void> {
  const casebookPath = path.join('tests', 'fixtures', 'decision_chain_casebook.json');
  const book = JSON.parse(fs.readFileSync(casebookPath, 'utf8')) as Casebook;
  const lines = fs
    .readFileSync(book.sourceFixture, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, book.maxGames);

  let disagreementCount = 0;
  for (const c of book.cases) {
    assert(c.gameIndex < lines.length, `${c.id}: gameIndex out of range`);
    const line = lines[c.gameIndex];
    const state = buildStateAtTurn(line, book.coordMode, c.turnIndex);
    assert(!state.winner, `${c.id}: state should not be terminal`);

    // Recreate manager per case to avoid cross-case cache coupling and keep
    // case-level replay deterministic.
    const evaluator = createDefaultEvaluator();
    const mctsAI = new MCTSConnect6AI(evaluator, {
      simulationCount: 120,
      simulationSteps: 8,
      expandNodes: 12,
      minWinRateThreshold: 0.25,
      reuseDecay: 0.9,
      reuseTtl: 4,
      randomSeed: 20260428,
    });
    const manager = new HybridStrategyManager(
      mctsAI,
      evaluator,
      { pvsConfig, weights },
    );

    const traditional = pvsSearchBestMove(
      state,
      state.currentPlayer,
      weights,
      pvsConfig,
    );
    const hybrid = await manager.decideMove(state, state.currentPlayer);

    const stage = String(hybrid.debugInfo?.decisionStage ?? '');
    const strategy = String(hybrid.debugInfo?.strategy ?? '');
    assert(stage === c.expectStage, `${c.id}: expected stage=${c.expectStage}, got ${stage}`);
    assert(strategy === c.expectStrategy, `${c.id}: expected strategy=${c.expectStrategy}, got ${strategy}`);

    const sameAsTraditional = moveKey(traditional.move) === moveKey(hybrid.move);
    if (!sameAsTraditional) disagreementCount += 1;
    assert(
      sameAsTraditional === c.expectedSameAsTraditional,
      `${c.id}: expectedSameAsTraditional=${c.expectedSameAsTraditional}, got ${sameAsTraditional}`,
    );

    const next = applyMoveWithWinner(state, hybrid.move);
    assert(!opponentHasImmediate(next, state.currentPlayer), `${c.id}: hybrid move leaves immediate loss`);
  }

  console.log(
    `decision_chain_casebook_selftest: OK cases=${book.cases.length} disagreements=${disagreementCount}`,
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
