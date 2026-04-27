import { performance } from 'node:perf_hooks';
import { applyMove, createInitialState } from '../src/core/game_state.ts';
import { analyzeThreats } from '../src/core/threat_analyzer.ts';
import {
  stableKey,
  type PatternHit,
  type PatternType,
  type ThreatReport,
} from '../src/core/pattern_library.ts';
import { posIdx } from '../src/core/pos_key.ts';
import type { VCDTKind, VCDTThreat } from '../src/core/vcdt.ts';
import { BOARD_SIZE } from '../src/types.ts';
import type { GameState, Move, Player, Position } from '../src/types.ts';

const VCDT_SCAN_TYPES: VCDTKind[] = [
  'WIN_IN_1',
  'WIN_IN_2',
  'LIVE5',
  'CHARGE5',
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
  'LIVE3',
  'SLEEP3',
  'DEAD4',
  'DEAD5',
];

const isThreatKind = (type: PatternType): type is VCDTKind =>
  type !== 'CONNECT6';

function threatLevelFor(kind: VCDTKind, isWinning: boolean): number {
  if (isWinning) return 0;
  switch (kind) {
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
    case 'CHARGE5':
    case 'LIVE4':
    case 'CHARGE4':
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'DEAD4':
    case 'DEAD5':
    case 'LIVE3':
    case 'SLEEP3':
      return 3;
    case 'WIN_IN_1':
    default:
      return 3;
  }
}

function defenseCostFor(kind: VCDTKind): number {
  switch (kind) {
    case 'WIN_IN_1':
      return 1;
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
      return 2;
    case 'CHARGE5':
      return 1;
    case 'LIVE4':
      return 2;
    case 'CHARGE4':
      return 1;
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'LIVE3':
    case 'SLEEP3':
      return 1;
    case 'DEAD4':
    case 'DEAD5':
      return 1;
    default:
      return 1;
  }
}

function pairKey(a: Position, b: Position): number {
  const base = BOARD_SIZE * BOARD_SIZE;
  const aIdx = posIdx(a.x, a.y);
  const bIdx = posIdx(b.x, b.y);
  return aIdx < bIdx ? aIdx * base + bIdx : bIdx * base + aIdx;
}

function hitToThreat(
  hit: PatternHit,
  seen: Set<string>,
  win2Pairs: Set<number>,
): VCDTThreat[] {
  if (!isThreatKind(hit.type)) return [];

  if (hit.type === 'WIN_IN_2') {
    if (hit.keyPoints.length < 2) return [];
    const [p1, p2] = hit.keyPoints;
    const key = pairKey(p1, p2);
    if (win2Pairs.has(key)) return [];
    win2Pairs.add(key);
    return [
      {
        positions: [p1, p2],
        isWinning: true,
        threatLevel: 1,
        kind: 'WIN_IN_2',
        defenseCost: defenseCostFor('WIN_IN_2'),
      },
    ];
  }

  const key = stableKey(hit);
  if (seen.has(key)) return [];
  seen.add(key);

  const positions = hit.keyPoints.length > 0 ? hit.keyPoints : hit.stones;
  const isWinning = hit.type === 'WIN_IN_1';
  return [
    {
      positions,
      isWinning,
      threatLevel: threatLevelFor(hit.type, isWinning),
      kind: hit.type,
      defenseCost: defenseCostFor(hit.type),
    },
  ];
}

function detectByPatterns(report: ThreatReport): VCDTThreat[] {
  const threats: VCDTThreat[] = [];
  const seen = new Set<string>();
  const win2Pairs = new Set<number>();
  for (const hit of report.patterns) {
    threats.push(...hitToThreat(hit, seen, win2Pairs));
  }
  return threats;
}

function detectByTypes(report: ThreatReport): VCDTThreat[] {
  const threats: VCDTThreat[] = [];
  const seen = new Set<string>();
  const win2Pairs = new Set<number>();
  for (const type of VCDT_SCAN_TYPES) {
    const hits = report.byType[type];
    for (const hit of hits) {
      threats.push(...hitToThreat(hit, seen, win2Pairs));
    }
  }
  return threats;
}

function threatKey(threat: VCDTThreat): string {
  const posKeys = threat.positions
    .map(p => posIdx(p.x, p.y))
    .sort((a, b) => a - b)
    .join(',');
  return [
    threat.kind,
    threat.isWinning ? 1 : 0,
    threat.threatLevel,
    threat.defenseCost ?? 0,
    posKeys,
  ].join('|');
}

function assertSameThreats(a: VCDTThreat[], b: VCDTThreat[]) {
  const aKeys = new Set(a.map(threatKey));
  const bKeys = new Set(b.map(threatKey));
  if (aKeys.size !== bKeys.size) {
    throw new Error(
      `threat count mismatch: ${aKeys.size} (patterns) vs ${bKeys.size} (types)`,
    );
  }
  for (const key of aKeys) {
    if (!bKeys.has(key)) {
      throw new Error(`missing threat key: ${key}`);
    }
  }
}

type Scenario = 'fixed' | 'heavy' | 'random';

type ScenarioConfig = {
  scenario: Scenario;
  seed: number;
  turns: number;
  extraTurns: number;
  range: number;
};

const DEFAULT_CONFIG: ScenarioConfig = {
  scenario: 'fixed',
  seed: 0xC0FFEE,
  turns: 24,
  extraTurns: 8,
  range: 6,
};

function parseArgs(): ScenarioConfig {
  const config: ScenarioConfig = { ...DEFAULT_CONFIG };
  const args = process.argv.slice(2);

  const readValue = (arg: string, index: number): { value?: string; next: number } => {
    const eq = arg.indexOf('=');
    if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
    if (index + 1 < args.length) return { value: args[index + 1], next: index + 1 };
    return { value: undefined, next: index };
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--fixed') {
      config.scenario = 'fixed';
      continue;
    }
    if (arg === '--heavy') {
      config.scenario = 'heavy';
      continue;
    }
    if (arg === '--random') {
      config.scenario = 'random';
      continue;
    }
    if (arg === '--seed' || arg.startsWith('--seed=')) {
      const { value, next } = readValue(arg, i);
      if (value) config.seed = Number(value);
      i = next;
      continue;
    }
    if (
      arg === '--turns' ||
      arg === '--moves' ||
      arg.startsWith('--turns=') ||
      arg.startsWith('--moves=')
    ) {
      const { value, next } = readValue(arg, i);
      if (value) config.turns = Number(value);
      i = next;
      continue;
    }
    if (arg === '--extra-turns' || arg.startsWith('--extra-turns=')) {
      const { value, next } = readValue(arg, i);
      if (value) config.extraTurns = Number(value);
      i = next;
      continue;
    }
    if (arg === '--range' || arg.startsWith('--range=')) {
      const { value, next } = readValue(arg, i);
      if (value) config.range = Number(value);
      i = next;
      continue;
    }
  }

  if (!Number.isFinite(config.seed)) config.seed = DEFAULT_CONFIG.seed;
  if (!Number.isFinite(config.turns)) config.turns = DEFAULT_CONFIG.turns;
  if (!Number.isFinite(config.extraTurns)) config.extraTurns = DEFAULT_CONFIG.extraTurns;
  if (!Number.isFinite(config.range)) config.range = DEFAULT_CONFIG.range;

  config.seed = Math.floor(config.seed) >>> 0;
  if (config.seed === 0) config.seed = 1;
  config.turns = Math.max(0, Math.floor(config.turns));
  config.extraTurns = Math.max(0, Math.floor(config.extraTurns));
  config.range = Math.max(1, Math.floor(config.range));

  return config;
}

function makeFixedState(): GameState {
  const moves: Move[] = [
    { player: 'BLACK', positions: [{ x: 9, y: 9 }] },
    { player: 'WHITE', positions: [{ x: 9, y: 10 }, { x: 10, y: 9 }] },
    { player: 'BLACK', positions: [{ x: 8, y: 9 }, { x: 10, y: 10 }] },
    { player: 'WHITE', positions: [{ x: 8, y: 10 }, { x: 11, y: 9 }] },
    { player: 'BLACK', positions: [{ x: 9, y: 8 }, { x: 7, y: 9 }] },
    { player: 'WHITE', positions: [{ x: 10, y: 8 }, { x: 11, y: 10 }] },
    { player: 'BLACK', positions: [{ x: 9, y: 11 }, { x: 12, y: 9 }] },
    { player: 'WHITE', positions: [{ x: 8, y: 8 }, { x: 7, y: 10 }] },
    { player: 'BLACK', positions: [{ x: 10, y: 11 }, { x: 11, y: 11 }] },
    { player: 'WHITE', positions: [{ x: 6, y: 9 }, { x: 12, y: 10 }] },
    { player: 'BLACK', positions: [{ x: 10, y: 12 }, { x: 9, y: 12 }] },
    { player: 'WHITE', positions: [{ x: 13, y: 9 }, { x: 12, y: 11 }] },
    { player: 'BLACK', positions: [{ x: 8, y: 12 }, { x: 7, y: 11 }] },
    { player: 'WHITE', positions: [{ x: 6, y: 10 }, { x: 13, y: 10 }] },
    { player: 'BLACK', positions: [{ x: 9, y: 7 }, { x: 10, y: 7 }] },
    { player: 'WHITE', positions: [{ x: 8, y: 7 }, { x: 11, y: 7 }] },
    { player: 'BLACK', positions: [{ x: 10, y: 13 }, { x: 9, y: 13 }] },
    { player: 'WHITE', positions: [{ x: 7, y: 8 }, { x: 12, y: 8 }] },
  ];

  let state = createInitialState();
  for (const move of moves) {
    state = applyMove(state, move);
  }
  return state;
}

function makeXorShift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildCandidatePositions(range: number): Position[] {
  const center = Math.floor(BOARD_SIZE / 2);
  const out: Position[] = [];
  for (let y = center - range; y <= center + range; y += 1) {
    for (let x = center - range; x <= center + range; x += 1) {
      if (x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) continue;
      out.push({ x, y });
    }
  }
  return out;
}

function collectOccupied(state: GameState): Set<number> {
  const occupied = new Set<number>();
  for (let y = 0; y < state.board.length; y += 1) {
    const row = state.board[y];
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== 0) occupied.add(posIdx(x, y));
    }
  }
  return occupied;
}

function stonesNeeded(startMoveNumber: number, turns: number): number {
  if (turns <= 0) return 0;
  if (startMoveNumber === 0) return 1 + (turns - 1) * 2;
  return turns * 2;
}

function applyTurnsFromPositions(
  state: GameState,
  turns: number,
  positions: Position[],
): GameState {
  let next = state;
  let offset = 0;
  for (let t = 0; t < turns; t += 1) {
    const count = next.moveNumber === 0 && t === 0 ? 1 : 2;
    const slice = positions.slice(offset, offset + count);
    offset += count;
    next = applyMove(next, { player: next.currentPlayer, positions: slice });
  }
  return next;
}

function applyRandomTurns(
  state: GameState,
  turns: number,
  seed: number,
  range: number,
): GameState {
  if (turns <= 0) return state;
  const rng = makeXorShift32(seed);
  const needed = stonesNeeded(state.moveNumber, turns);
  const occupied = collectOccupied(state);
  const candidates = buildCandidatePositions(range).filter(
    p => !occupied.has(posIdx(p.x, p.y)),
  );

  if (needed > candidates.length) {
    throw new Error(
      `not enough empty candidates: need ${needed}, have ${candidates.length}`,
    );
  }

  shuffle(candidates, rng);
  const picked = candidates.slice(0, needed);
  return applyTurnsFromPositions(state, turns, picked);
}

function makeRandomState(config: ScenarioConfig): GameState {
  const base = createInitialState();
  return applyRandomTurns(base, config.turns, config.seed, config.range);
}

function makeHeavyState(config: ScenarioConfig): GameState {
  const base = makeFixedState();
  if (config.extraTurns <= 0) return base;
  return applyRandomTurns(base, config.extraTurns, config.seed, config.range);
}

function makeState(config: ScenarioConfig): GameState {
  if (config.scenario === 'random') return makeRandomState(config);
  if (config.scenario === 'heavy') return makeHeavyState(config);
  return makeFixedState();
}

function bench(
  label: string,
  iterations: number,
  warmup: number,
  fn: () => VCDTThreat[],
): number {
  for (let i = 0; i < warmup; i += 1) fn();

  let sink = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    sink += fn().length;
  }
  const elapsed = performance.now() - start;
  console.log(
    `${label}: ${elapsed.toFixed(2)}ms (avg ${(elapsed / iterations).toFixed(4)}ms)`,
  );
  return sink;
}

function main() {
  const config = parseArgs();
  const state = makeState(config);
  const player: Player = state.currentPlayer;
  const report = analyzeThreats(state, player);

  const before = detectByPatterns(report);
  const after = detectByTypes(report);
  assertSameThreats(before, after);

  console.log(`scenario: ${config.scenario}`);
  if (config.scenario === 'random') {
    console.log(`turns: ${config.turns}, seed: ${config.seed}, range: ${config.range}`);
  } else if (config.scenario === 'heavy') {
    console.log(
      `extra turns: ${config.extraTurns}, seed: ${config.seed}, range: ${config.range}`,
    );
  }
  console.log(`threats: ${after.length}`);

  const iterations = 2000;
  const warmup = 200;
  const sinkPatterns = bench('scan patterns', iterations, warmup, () =>
    detectByPatterns(report),
  );
  const sinkTypes = bench('scan byType', iterations, warmup, () =>
    detectByTypes(report),
  );

  if (sinkPatterns === 0 && sinkTypes === 0) {
    console.log('no threats detected');
  }
}

main();
