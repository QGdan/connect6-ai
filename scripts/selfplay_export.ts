import fs from 'node:fs';
import path from 'node:path';
import { SelfPlay } from '../src/core/self_play.ts';
import type { GameRecord } from '../src/core/self_play.ts';
import { createInitialState } from '../src/core/game_state.ts';
import { applyMoveWithWinner } from '../src/core/rules.ts';
import { pvsSearchBestMove } from '../src/core/pvs_search.ts';
import { posIdx } from '../src/core/pos_key.ts';
import type { EvaluationWeights, Move, SearchConfig } from '../src/types.ts';
import { formatBoardCoordTuple } from '../src/core/board_coords.ts';

type WinnerFilter = 'BLACK' | 'WHITE' | 'DRAW' | 'ANY';

type Options = {
  games: number;
  targetGames: number;
  timeMs: number;
  mode: 'fast' | 'normal' | 'deep';
  randomOpeningPlies: number;
  seed: number;
  minMoves: number;
  maxMoves: number;
  winner: WinnerFilter;
  analysisEvery: number;
  analysisDepth: number;
  analysisTimeMs: number;
  blackName: string;
  whiteName: string;
  event: string;
  dateLocation: string;
  out: string;
  split: boolean;
  append: boolean;
};

function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

const DEFAULTS: Options = {
  games: 120,
  targetGames: 50,
  timeMs: 150,
  mode: 'deep',
  randomOpeningPlies: 3,
  seed: 12345,
  minMoves: 24,
  maxMoves: Number.POSITIVE_INFINITY,
  winner: 'ANY',
  analysisEvery: 2,
  analysisDepth: 4,
  analysisTimeMs: 60,
  blackName: '先手参赛队B',
  whiteName: '后手参赛队W',
  event: '自博弈',
  dateLocation: `${formatDate(new Date())}线上`,
  out: path.join('outputs', 'selfplay_c6.txt'),
  split: false,
  append: true,
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULTS };
  let dateOverride: string | undefined;
  let locationOverride: string | undefined;
  let dateLocationOverride: string | undefined;
  const readValue = (arg: string, index: number) => {
    const eq = arg.indexOf('=');
    if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
    if (index + 1 < argv.length) return { value: argv[index + 1], next: index + 1 };
    return { value: undefined, next: index };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--split') {
      opts.split = true;
      continue;
    }
    if (arg === '--append') {
      opts.append = true;
      continue;
    }
    if (arg === '--overwrite' || arg === '--noAppend') {
      opts.append = false;
      continue;
    }
    if (arg === '--games' || arg.startsWith('--games=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.games = Number(value);
      i = next;
      continue;
    }
    if (
      arg === '--targetGames' ||
      arg.startsWith('--targetGames=') ||
      arg === '--target' ||
      arg.startsWith('--target=')
    ) {
      const { value, next } = readValue(arg, i);
      if (value) opts.targetGames = Number(value);
      i = next;
      continue;
    }
    if (arg === '--analysisEvery' || arg.startsWith('--analysisEvery=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.analysisEvery = Number(value);
      i = next;
      continue;
    }
    if (arg === '--analysisDepth' || arg.startsWith('--analysisDepth=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.analysisDepth = Number(value);
      i = next;
      continue;
    }
    if (arg === '--analysisTimeMs' || arg.startsWith('--analysisTimeMs=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.analysisTimeMs = Number(value);
      i = next;
      continue;
    }
    if (arg === '--timeMs' || arg.startsWith('--timeMs=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.timeMs = Number(value);
      i = next;
      continue;
    }
    if (arg === '--mode' || arg.startsWith('--mode=')) {
      const { value, next } = readValue(arg, i);
      if (value === 'fast' || value === 'normal' || value === 'deep') {
        opts.mode = value;
      }
      i = next;
      continue;
    }
    if (arg === '--randomOpeningPlies' || arg.startsWith('--randomOpeningPlies=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.randomOpeningPlies = Number(value);
      i = next;
      continue;
    }
    if (arg === '--seed' || arg.startsWith('--seed=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.seed = Number(value);
      i = next;
      continue;
    }
    if (arg === '--minMoves' || arg.startsWith('--minMoves=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.minMoves = Number(value);
      i = next;
      continue;
    }
    if (arg === '--maxMoves' || arg.startsWith('--maxMoves=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.maxMoves = Number(value);
      i = next;
      continue;
    }
    if (arg === '--winner' || arg.startsWith('--winner=')) {
      const { value, next } = readValue(arg, i);
      const upper = value?.toUpperCase();
      if (upper === 'BLACK' || upper === 'WHITE' || upper === 'DRAW' || upper === 'ANY') {
        opts.winner = upper as WinnerFilter;
      }
      i = next;
      continue;
    }
    if (arg === '--blackName' || arg.startsWith('--blackName=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.blackName = value;
      i = next;
      continue;
    }
    if (arg === '--whiteName' || arg.startsWith('--whiteName=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.whiteName = value;
      i = next;
      continue;
    }
    if (arg === '--event' || arg.startsWith('--event=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.event = value;
      i = next;
      continue;
    }
    if (arg === '--dateLocation' || arg.startsWith('--dateLocation=')) {
      const { value, next } = readValue(arg, i);
      if (value) dateLocationOverride = value;
      i = next;
      continue;
    }
    if (arg === '--date' || arg.startsWith('--date=')) {
      const { value, next } = readValue(arg, i);
      if (value) dateOverride = value;
      i = next;
      continue;
    }
    if (arg === '--location' || arg.startsWith('--location=')) {
      const { value, next } = readValue(arg, i);
      if (value) locationOverride = value;
      i = next;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.out = value;
      i = next;
      continue;
    }
  }

  if (!Number.isFinite(opts.games) || opts.games <= 0) opts.games = DEFAULTS.games;
  if (!Number.isFinite(opts.targetGames) || opts.targetGames <= 0) {
    opts.targetGames = DEFAULTS.targetGames;
  }
  if (!Number.isFinite(opts.analysisEvery) || opts.analysisEvery <= 0) {
    opts.analysisEvery = DEFAULTS.analysisEvery;
  }
  if (!Number.isFinite(opts.analysisDepth) || opts.analysisDepth <= 0) {
    opts.analysisDepth = DEFAULTS.analysisDepth;
  }
  if (!Number.isFinite(opts.analysisTimeMs) || opts.analysisTimeMs <= 0) {
    opts.analysisTimeMs = DEFAULTS.analysisTimeMs;
  }
  if (!Number.isFinite(opts.timeMs) || opts.timeMs <= 0) opts.timeMs = DEFAULTS.timeMs;
  if (!Number.isFinite(opts.randomOpeningPlies) || opts.randomOpeningPlies < 0) {
    opts.randomOpeningPlies = DEFAULTS.randomOpeningPlies;
  }
  if (!Number.isFinite(opts.seed)) opts.seed = DEFAULTS.seed;
  if (!Number.isFinite(opts.minMoves) || opts.minMoves < 0) {
    opts.minMoves = DEFAULTS.minMoves;
  }
  if (!Number.isFinite(opts.maxMoves) || opts.maxMoves < 0) {
    opts.maxMoves = Number.POSITIVE_INFINITY;
  }
  if (opts.games < opts.targetGames) opts.games = opts.targetGames;
  if (dateLocationOverride) {
    opts.dateLocation = dateLocationOverride;
  } else if (dateOverride || locationOverride) {
    const datePart = dateOverride ?? formatDate(new Date());
    const locationPart = locationOverride ?? '';
    opts.dateLocation = `${datePart}${locationPart}`;
  }

  return opts;
}

const ANALYSIS_WEIGHTS: EvaluationWeights = {
  road_3_score: 12_000,
  road_4_score: 45_000,
  live4_score: 80_000,
  live5_score: 150_000,
  vcdt_bonus: 6_000,
};

const SCORE_SCALE = 8000;
const SWING_THRESHOLD = 0.3;
const MAX_DROP_LIMIT = -0.75;
const MIN_MATCH_RATE = 0.15;
const MIN_AVG_DEPTH = 2;
const MIN_SAMPLES = 6;

type AnalysisResult = {
  samples: number;
  variance: number;
  maxDrop: number;
  matchRate: number;
  swingCount: number;
  avgDepth: number;
  maxDepth: number;
};

function normalizeEval(score: number): number {
  return Math.tanh(score / SCORE_SCALE);
}

function moveKey(move: Move): string {
  return move.positions
    .map(p => posIdx(p.x, p.y))
    .sort((a, b) => a - b)
    .join(',');
}

function computeVariance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const total = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return total / values.length;
}

function computeMaxDrop(values: number[]): number {
  if (values.length < 2) return 0;
  let minDelta = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta < minDelta) minDelta = delta;
  }
  return minDelta;
}

function countSwings(values: number[], threshold: number): number {
  if (values.length < 2) return 0;
  let swings = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = Math.abs(values[i] - values[i - 1]);
    if (delta >= threshold) swings += 1;
  }
  return swings;
}

function analyzeRecord(record: GameRecord, opts: Options): AnalysisResult {
  const config: SearchConfig = {
    maxDepth: opts.analysisDepth,
    timeLimitMs: opts.analysisTimeMs,
    useMultithreading: false,
  };

  let state = createInitialState();
  const evals: number[] = [];
  let matches = 0;
  let samples = 0;
  let depthSum = 0;
  let maxDepth = 0;

  for (let i = 0; i < record.moves.length; i += 1) {
    if (i % opts.analysisEvery === 0) {
      const decision = pvsSearchBestMove(
        state,
        state.currentPlayer,
        ANALYSIS_WEIGHTS,
        config,
      );
      const depth = decision.debugInfo?.depth ?? 0;
      const sign = state.currentPlayer === 'BLACK' ? 1 : -1;
      evals.push(normalizeEval(decision.score) * sign);
      samples += 1;
      depthSum += depth;
      if (depth > maxDepth) maxDepth = depth;
      if (decision.move && moveKey(decision.move) === moveKey(record.moves[i])) {
        matches += 1;
      }
    }

    state = applyMoveWithWinner(state, record.moves[i]);
    if (state.winner) break;
  }

  return {
    samples,
    variance: computeVariance(evals),
    maxDrop: computeMaxDrop(evals),
    matchRate: samples > 0 ? matches / samples : 0,
    swingCount: countSwings(evals, SWING_THRESHOLD),
    avgDepth: samples > 0 ? depthSum / samples : 0,
    maxDepth,
  };
}

function isHighQuality(
  record: GameRecord,
  analysis: AnalysisResult,
  opts: Options,
): boolean {
  if (record.moves.length < opts.minMoves) return false;
  if (analysis.samples < MIN_SAMPLES) return false;
  if (analysis.maxDrop < MAX_DROP_LIMIT) return false;
  if (analysis.matchRate < MIN_MATCH_RATE) return false;
  if (analysis.avgDepth < MIN_AVG_DEPTH) return false;
  return true;
}

function qualityScore(record: GameRecord, analysis: AnalysisResult): number {
  const dropMagnitude = Math.max(0, -analysis.maxDrop);
  const lengthBonus = Math.min(record.moves.length, 80) * 0.2;
  const winnerBonus = record.winner ? 3 : 0;
  return (
    analysis.matchRate * 100 +
    analysis.swingCount * 4 +
    analysis.avgDepth * 5 +
    lengthBonus +
    winnerBonus -
    analysis.variance * 25 -
    dropMagnitude * 60
  );
}

function formatStone(move: Move, index: number): string {
  const player = move.player === 'BLACK' ? 'B' : 'W';
  const pos = move.positions[index];
  const coord = formatBoardCoordTuple(pos);
  return `${player}(${coord})`;
}

function formatWinnerLabel(record: GameRecord): string {
  if (!record.winner) return '未决';
  if (record.winner === 'BLACK') return '先手胜';
  if (record.winner === 'WHITE') return '后手胜';
  return '平局';
}

function formatGame(record: GameRecord, opts: Options): string {
  const header = [
    'C6',
    opts.blackName,
    opts.whiteName,
    formatWinnerLabel(record),
    opts.dateLocation,
    opts.event,
  ].join(';');

  const stones: string[] = [];
  for (const move of record.moves) {
    for (let i = 0; i < move.positions.length; i += 1) {
      stones.push(formatStone(move, i));
    }
  }

  const moves = stones.join(';');
  return `{${header}${moves ? `;${moves}` : ''}}`;
}

function matchesFilter(record: GameRecord, opts: Options): boolean {
  if (record.moves.length < opts.minMoves) return false;
  if (record.moves.length > opts.maxMoves) return false;
  if (opts.winner === 'ANY') return true;
  if (!record.winner) return false;
  return record.winner === opts.winner;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selfPlay = new SelfPlay({
    games: opts.games,
    timeMs: opts.timeMs,
    mode: opts.mode,
    randomOpeningPlies: opts.randomOpeningPlies,
    seed: opts.seed,
  });

  const records = await selfPlay.run();
  const filtered = records.filter(record => matchesFilter(record, opts));
  const analyzed = filtered.map((record, index) => {
    const analysis = analyzeRecord(record, opts);
    return {
      record,
      analysis,
      eligible: isHighQuality(record, analysis, opts),
      score: qualityScore(record, analysis),
      index,
    };
  });
  const eligible = analyzed.filter(item => item.eligible);
  const pool = eligible.length >= opts.targetGames ? eligible : analyzed;
  const ranked = pool.sort((a, b) =>
    b.score - a.score ||
    b.record.moves.length - a.record.moves.length ||
    a.index - b.index,
  );
  const selected = ranked.slice(0, opts.targetGames).map(item => item.record);

  if (opts.split) {
    const outDir = opts.out;
    fs.mkdirSync(outDir, { recursive: true });
    selected.forEach((record, i) => {
      const file = path.join(outDir, `game_${String(i + 1).padStart(4, '0')}.txt`);
      fs.writeFileSync(file, formatGame(record, opts), 'utf8');
    });
    console.log(`eligible ${eligible.length}/${filtered.length}, wrote ${selected.length} games to ${outDir}`);
    return;
  }

  const outDir = path.dirname(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const body = selected.map(record => formatGame(record, opts)).join('\n');
  const shouldAppend = opts.append && fs.existsSync(opts.out);
  const prefix = shouldAppend && fs.statSync(opts.out).size > 0 ? '\n' : '';
  fs.writeFileSync(
    opts.out,
    `${prefix}${body}`,
    { encoding: 'utf8', flag: opts.append ? 'a' : 'w' },
  );
  console.log(`eligible ${eligible.length}/${filtered.length}, wrote ${selected.length} games to ${opts.out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
