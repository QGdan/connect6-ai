import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationWeights, GameState, Move, Player, Position } from '../src/types.ts';
import { createInitialState } from '../src/core/game_state.ts';
import { applyMoveWithWinner, getStonesToPlace } from '../src/core/rules.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
import { HybridStrategyManager } from '../src/strategy/hybrid_strategy.ts';
import { MCTSConnect6AI } from '../src/core/mcts_ai_engine.ts';
import { createDefaultEvaluator } from '../src/core/resnet_ai.ts';
import { analyzeBothCached, clearThreatCache } from '../src/core/threat_service.ts';
import {
  clearDecisionTraces,
  drainDecisionTraces,
  setDecisionTraceEnabled,
  type DecisionTraceRecord,
} from '../src/core/decision_trace.ts';

type CoordMode = 'bottom' | 'top';

type TurnRecord = {
  gameIndex: number;
  turnIndex: number;
  player: Player;
  mode: 'traditional' | 'hybrid';
  stage: string;
  engine: string;
  reason: string;
  urgent: boolean;
  immediateBlunder: boolean;
  blunderAvoidable: boolean | null;
  tracePath: string;
  traceEvents: number;
  move: string;
  stateHash: string;
};

type Summary = {
  games: number;
  sampledTurns: number;
  urgentTurns: number;
  traditional: {
    immediateBlunder: number;
    immediateBlunderAvoidable: number;
    immediateBlunderUnavoidable: number;
    openingInUrgent: number;
    traceMissing: number;
  };
  hybrid: {
    immediateBlunder: number;
    immediateBlunderAvoidable: number;
    immediateBlunderUnavoidable: number;
    unsafeFallback: number;
    disagreeWithTraditional: number;
    hybridFinal: number;
    nonHybridFinal: number;
    selectedTraditional: number;
    selectedHybrid: number;
    selectedDeep: number;
  };
  stageCounts: Record<string, number>;
  diagnosticFlags: string[];
  suspiciousTurns: TurnRecord[];
};

type CasebookEntry = {
  id: string;
  gameIndex: number;
  turnIndex: number;
  moveNumber: number;
  player: Player;
  urgent: boolean;
  stateHash: string;
  stage: string;
  strategy: string;
  reason: string;
  sameAsTraditional: boolean;
  traditionalMove: string;
  hybridMove: string;
  traditionalBlunder: boolean;
  hybridBlunder: boolean;
  traditionalBlunderAvoidable: boolean | null;
  hybridBlunderAvoidable: boolean | null;
};

type Casebook = {
  sourceFixture: string;
  maxGames: number;
  maxTurnsPerGame: number;
  sampleStride: number;
  cases: CasebookEntry[];
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

const defaultInput = path.join('tests', 'fixtures', 'selfplay_regression_sample.txt');
const outputDir = path.join('outputs', 'decision_diagnostics');

function moveKey(move: Move): string {
  return move.positions
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
}

function parseArgInt(name: string, fallback: number): number {
  const key = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(key));
  if (!hit) return fallback;
  const n = Number(hit.slice(key.length));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseArgString(name: string, fallback: string): string {
  const key = `--${name}=`;
  const hit = process.argv.find(a => a.startsWith(key));
  return hit ? hit.slice(key.length) : fallback;
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

function parseStones(line: string, mode: CoordMode): Array<{ player: Player; pos: Position }> {
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

function switchPlayer(player: Player): Player {
  return player === 'BLACK' ? 'WHITE' : 'BLACK';
}

function hasUrgentThreat(state: GameState, player: Player): boolean {
  const { my, opp } = analyzeBothCached(state, player);
  const myNeed = getStonesToPlace(state.moveNumber, player);
  const oppNeed = getStonesToPlace(state.moveNumber + 1, switchPlayer(player));
  const myImmediate = my.winIn1.length > 0 || (myNeed >= 2 && my.winIn2.length > 0);
  const oppImmediate = opp.winIn1.length > 0 || (oppNeed >= 2 && opp.winIn2.length > 0);
  const oppInitiative =
    opp.byType.LIVE4.length > 0 ||
    opp.byType.CHARGE4.length > 0 ||
    opp.byType.DOUBLE_FOUR.length > 0 ||
    opp.byType.FOUR_THREE.length > 0 ||
    opp.byType.DOUBLE_THREE.length > 0;
  return myImmediate || oppImmediate || oppInitiative;
}

function opponentHasImmediate(state: GameState, playerWhoJustMoved: Player): boolean {
  const opp = switchPlayer(playerWhoJustMoved);
  const oppNeed = getStonesToPlace(state.moveNumber, opp);
  const { my: oppReport } = analyzeBothCached(state, opp);
  return oppReport.winIn1.length > 0 || (oppNeed >= 2 && oppReport.winIn2.length > 0);
}

function hasAnyNonImmediateDefense(
  state: GameState,
  player: Player,
): boolean {
  const stones = getStonesToPlace(state.moveNumber, player);
  const empties: Position[] = [];
  for (let y = 0; y < 19; y += 1) {
    for (let x = 0; x < 19; x += 1) {
      if (state.board[y][x] === 0) empties.push({ x, y });
    }
  }

  if (stones === 1) {
    for (const p of empties) {
      try {
        const next = applyMoveWithWinner(state, { player, positions: [p] });
        if (!opponentHasImmediate(next, player)) return true;
      } catch {
        // ignore illegal
      }
    }
    return false;
  }

  for (let i = 0; i < empties.length; i += 1) {
    for (let j = i + 1; j < empties.length; j += 1) {
      const move: Move = { player, positions: [empties[i], empties[j]] };
      try {
        const next = applyMoveWithWinner(state, move);
        if (!opponentHasImmediate(next, player)) return true;
      } catch {
        // ignore illegal
      }
    }
  }
  return false;
}

function tracePath(traces: DecisionTraceRecord[]): string {
  const phases: string[] = [];
  for (const trace of traces) {
    for (const event of trace.events) {
      phases.push(`${event.fn}:${event.phase}`);
    }
  }
  return phases.join(' -> ');
}

function formatMove(move: Move): string {
  return move.positions.map(p => `(${p.x},${p.y})`).join(' ');
}

async function main(): Promise<void> {
  const input = parseArgString('input', defaultInput);
  const maxGames = parseArgInt('maxGames', 8);
  const maxTurnsPerGame = parseArgInt('maxTurns', 40);
  const sampleStride = parseArgInt('stride', 2);
  const coordMode: CoordMode = parseArgString('coord', 'bottom') === 'top' ? 'top' : 'bottom';

  if (!fs.existsSync(input)) {
    throw new Error(`diagnose_decision_chain: missing input ${input}`);
  }

  const lines = fs
    .readFileSync(input, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, maxGames);

  setDecisionTraceEnabled(true);
  clearDecisionTraces();
  clearThreatCache();

  const evaluator = createDefaultEvaluator();
  const createHybridManager = () =>
    new HybridStrategyManager(
      new MCTSConnect6AI(evaluator, {
        simulationCount: 120,
        simulationSteps: 8,
        expandNodes: 12,
        minWinRateThreshold: 0.25,
        reuseDecay: 0.9,
        reuseTtl: 4,
        randomSeed: 20260428,
      }),
      evaluator,
      { pvsConfig, weights },
    );

  const summary: Summary = {
    games: lines.length,
    sampledTurns: 0,
    urgentTurns: 0,
    traditional: {
      immediateBlunder: 0,
      immediateBlunderAvoidable: 0,
      immediateBlunderUnavoidable: 0,
      openingInUrgent: 0,
      traceMissing: 0,
    },
    hybrid: {
      immediateBlunder: 0,
      immediateBlunderAvoidable: 0,
      immediateBlunderUnavoidable: 0,
      unsafeFallback: 0,
      disagreeWithTraditional: 0,
      hybridFinal: 0,
      nonHybridFinal: 0,
      selectedTraditional: 0,
      selectedHybrid: 0,
      selectedDeep: 0,
    },
    stageCounts: {},
    diagnosticFlags: [],
    suspiciousTurns: [],
  };
  const casebook: Casebook = {
    sourceFixture: input,
    maxGames,
    maxTurnsPerGame,
    sampleStride,
    cases: [],
  };

  for (let gameIndex = 0; gameIndex < lines.length; gameIndex += 1) {
    const stones = parseStones(lines[gameIndex], coordMode);
    const moves = groupMoves(stones);
    let state = createInitialState();

    for (let turnIndex = 0; turnIndex < moves.length; turnIndex += 1) {
      const actual = moves[turnIndex];
      if (state.winner) break;

      const sampled = turnIndex < maxTurnsPerGame && turnIndex % sampleStride === 0;
      if (sampled) {
        summary.sampledTurns += 1;
        const urgent = hasUrgentThreat(state, state.currentPlayer);
        if (urgent) summary.urgentTurns += 1;

        clearDecisionTraces();
        const traditionalDecision = pvsSearchBestMove(
          state,
          state.currentPlayer,
          weights,
          pvsConfig,
        );
        const traditionalTraces = drainDecisionTraces();

        clearDecisionTraces();
        const hybridManager = createHybridManager();
        const hybridDecision = await hybridManager.decideMove(
          state,
          state.currentPlayer,
        );
        const hybridTraces = drainDecisionTraces();

        const traditionalStage =
          (traditionalDecision.debugInfo?.decisionStage as string | undefined) ??
          (traditionalDecision.debugInfo?.mode as string | undefined) ??
          'unknown';
        const hybridStage =
          (hybridDecision.debugInfo?.decisionStage as string | undefined) ??
          (hybridDecision.debugInfo?.mode as string | undefined) ??
          'unknown';
        const hybridSelected =
          (hybridDecision.debugInfo?.strategy as string | undefined) ?? 'unknown';
        if (hybridSelected === 'traditional') {
          summary.hybrid.selectedTraditional += 1;
        } else if (hybridSelected === 'hybrid') {
          summary.hybrid.selectedHybrid += 1;
        } else if (hybridSelected === 'deep') {
          summary.hybrid.selectedDeep += 1;
        }
        summary.stageCounts[`traditional:${traditionalStage}`] =
          (summary.stageCounts[`traditional:${traditionalStage}`] ?? 0) + 1;
        summary.stageCounts[`hybrid:${hybridStage}`] =
          (summary.stageCounts[`hybrid:${hybridStage}`] ?? 0) + 1;
        if (hybridStage === 'hybrid_final') {
          summary.hybrid.hybridFinal += 1;
        } else {
          summary.hybrid.nonHybridFinal += 1;
        }

        if (traditionalStage === 'opening' && urgent) {
          summary.traditional.openingInUrgent += 1;
        }
        if (traditionalTraces.length === 0) {
          summary.traditional.traceMissing += 1;
        }

        const traditionalNext = applyMoveWithWinner(state, traditionalDecision.move);
        const hybridNext = applyMoveWithWinner(state, hybridDecision.move);
        const traditionalBlunder = opponentHasImmediate(traditionalNext, state.currentPlayer);
        const hybridBlunder = opponentHasImmediate(hybridNext, state.currentPlayer);
        let blunderAvoidable: boolean | null = null;
        if (traditionalBlunder || hybridBlunder) {
          blunderAvoidable = hasAnyNonImmediateDefense(state, state.currentPlayer);
        }
        if (traditionalBlunder) {
          summary.traditional.immediateBlunder += 1;
          if (blunderAvoidable) {
            summary.traditional.immediateBlunderAvoidable += 1;
          } else {
            summary.traditional.immediateBlunderUnavoidable += 1;
          }
        }
        if (hybridBlunder) {
          summary.hybrid.immediateBlunder += 1;
          if (blunderAvoidable) {
            summary.hybrid.immediateBlunderAvoidable += 1;
          } else {
            summary.hybrid.immediateBlunderUnavoidable += 1;
          }
        }

        const hybridJudge = hybridDecision.debugInfo?.hybridJudge as
          | { safeCandidates?: number }
          | undefined;
        if ((hybridJudge?.safeCandidates ?? 1) === 0) {
          summary.hybrid.unsafeFallback += 1;
        }

        const sameAsTraditional =
          moveKey(traditionalDecision.move) === moveKey(hybridDecision.move);
        if (!sameAsTraditional) {
          summary.hybrid.disagreeWithTraditional += 1;
        }
        if (hybridStage === 'hybrid_final' || !sameAsTraditional) {
          casebook.cases.push({
            id: `g${gameIndex + 1}_t${turnIndex + 1}`,
            gameIndex,
            turnIndex,
            moveNumber: state.moveNumber,
            player: state.currentPlayer,
            urgent,
            stateHash: state.zobristHash.toString(),
            stage: hybridStage,
            strategy: String(hybridDecision.debugInfo?.strategy ?? ''),
            reason: String(
              hybridDecision.debugInfo?.decisionReason ??
                hybridDecision.debugInfo?.reason ??
                '',
            ),
            sameAsTraditional,
            traditionalMove: formatMove(traditionalDecision.move),
            hybridMove: formatMove(hybridDecision.move),
            traditionalBlunder,
            hybridBlunder,
            traditionalBlunderAvoidable: traditionalBlunder ? blunderAvoidable : null,
            hybridBlunderAvoidable: hybridBlunder ? blunderAvoidable : null,
          });
        }

        const suspicious =
          urgent && traditionalStage === 'opening' ||
          traditionalBlunder ||
          hybridBlunder ||
          traditionalTraces.length === 0 ||
          (hybridJudge?.safeCandidates ?? 1) === 0;
        if (suspicious) {
          summary.suspiciousTurns.push({
            gameIndex,
            turnIndex,
            player: state.currentPlayer,
            mode: 'traditional',
            stage: traditionalStage,
            engine: String(traditionalDecision.debugInfo?.engine ?? 'unknown'),
            reason: String(traditionalDecision.debugInfo?.decisionReason ?? traditionalDecision.debugInfo?.reason ?? ''),
            urgent,
            immediateBlunder: traditionalBlunder,
            blunderAvoidable: traditionalBlunder ? blunderAvoidable : null,
            tracePath: tracePath(traditionalTraces),
            traceEvents: traditionalTraces.reduce((n, t) => n + t.events.length, 0),
            move: formatMove(traditionalDecision.move),
            stateHash: state.zobristHash.toString(),
          });
          summary.suspiciousTurns.push({
            gameIndex,
            turnIndex,
            player: state.currentPlayer,
            mode: 'hybrid',
            stage: hybridStage,
            engine: String(hybridDecision.debugInfo?.engine ?? 'unknown'),
            reason: String(hybridDecision.debugInfo?.decisionReason ?? hybridDecision.debugInfo?.reason ?? ''),
            urgent,
            immediateBlunder: hybridBlunder,
            blunderAvoidable: hybridBlunder ? blunderAvoidable : null,
            tracePath: tracePath(hybridTraces),
            traceEvents: hybridTraces.reduce((n, t) => n + t.events.length, 0),
            move: formatMove(hybridDecision.move),
            stateHash: state.zobristHash.toString(),
          });
        }
      }

      const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
      state = applyMoveWithWinner(state, actual, {
        allowIncomplete: actual.positions.length < required,
      });
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const hybridTotal = summary.hybrid.hybridFinal + summary.hybrid.nonHybridFinal;
  const hybridFinalRate = hybridTotal > 0 ? summary.hybrid.hybridFinal / hybridTotal : 0;
  if (hybridTotal >= 20 && hybridFinalRate < 0.05) {
    summary.diagnosticFlags.push('hybrid_branch_dormant');
  }
  if (summary.sampledTurns >= 20 && summary.hybrid.selectedHybrid === 0) {
    summary.diagnosticFlags.push('hybrid_selector_dormant');
  }
  const summaryPath = path.join(outputDir, 'decision_trace_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  const topSuspicious = summary.suspiciousTurns.slice(0, 30);
  const md = [
    '# Decision Chain Diagnostic Report',
    '',
    `- input: \`${input}\``,
    `- games: ${summary.games}`,
    `- sampled turns: ${summary.sampledTurns}`,
    `- urgent turns: ${summary.urgentTurns}`,
    '',
    '## Metrics',
    '',
    `- traditional.immediateBlunder: ${summary.traditional.immediateBlunder}`,
    `- traditional.immediateBlunderAvoidable: ${summary.traditional.immediateBlunderAvoidable}`,
    `- traditional.immediateBlunderUnavoidable: ${summary.traditional.immediateBlunderUnavoidable}`,
    `- traditional.openingInUrgent: ${summary.traditional.openingInUrgent}`,
    `- traditional.traceMissing: ${summary.traditional.traceMissing}`,
    `- hybrid.immediateBlunder: ${summary.hybrid.immediateBlunder}`,
    `- hybrid.immediateBlunderAvoidable: ${summary.hybrid.immediateBlunderAvoidable}`,
    `- hybrid.immediateBlunderUnavoidable: ${summary.hybrid.immediateBlunderUnavoidable}`,
    `- hybrid.unsafeFallback: ${summary.hybrid.unsafeFallback}`,
    `- hybrid.disagreeWithTraditional: ${summary.hybrid.disagreeWithTraditional}`,
    `- hybrid.hybridFinal: ${summary.hybrid.hybridFinal}`,
    `- hybrid.nonHybridFinal: ${summary.hybrid.nonHybridFinal}`,
    `- hybrid.selectedTraditional: ${summary.hybrid.selectedTraditional}`,
    `- hybrid.selectedHybrid: ${summary.hybrid.selectedHybrid}`,
    `- hybrid.selectedDeep: ${summary.hybrid.selectedDeep}`,
    '',
    '## Diagnostic Flags',
    '',
    ...(summary.diagnosticFlags.length > 0
      ? summary.diagnosticFlags.map(flag => `- ${flag}`)
      : ['- none']),
    '',
    '## Stage Counts',
    '',
    ...Object.entries(summary.stageCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Top Suspicious Turns',
    '',
    ...topSuspicious.map(item =>
      `- g${item.gameIndex + 1} t${item.turnIndex + 1} ${item.mode} stage=${item.stage} ` +
      `engine=${item.engine} urgent=${item.urgent} blunder=${item.immediateBlunder} ` +
      `avoidable=${item.blunderAvoidable} traceEvents=${item.traceEvents} move=${item.move}`,
    ),
  ].join('\n');
  const reportPath = path.join(outputDir, 'decision_trace_report.md');
  fs.writeFileSync(reportPath, md, 'utf8');
  const casebookPath = path.join(outputDir, 'hybrid_casebook.json');
  fs.writeFileSync(casebookPath, JSON.stringify(casebook, null, 2), 'utf8');

  console.log(`diagnose_decision_chain: summary -> ${summaryPath}`);
  console.log(`diagnose_decision_chain: report  -> ${reportPath}`);
  console.log(`diagnose_decision_chain: casebook -> ${casebookPath}`);
  console.log(`diagnose_decision_chain: suspicious_turns=${summary.suspiciousTurns.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
