// Run: npx tsx scripts/weights_audit.ts
import fs from 'fs';
import path from 'path';
import type { EvaluationWeights, GameState, Move, Player } from '../src/types';
import { createInitialState } from '../src/core/game_state';
import { applyMoveWithWinner } from '../src/core/rules';
import {
  DEFAULT_EVALUATION_WEIGHTS,
  EVALUATION_WEIGHT_KEYS,
  evaluateState,
} from '../src/core/evaluation';

type WeightMap = Record<string, number>;

type NamedState = {
  name: string;
  state: GameState;
};

function loadConfigWeights(): WeightMap {
  const file = path.join(process.cwd(), 'config.yaml');
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const out: WeightMap = {};
  let inWeights = false;
  for (const line of lines) {
    const stripped = line.split('#')[0] ?? '';
    if (!inWeights) {
      if (/^\s*weights\s*:\s*$/.test(stripped)) {
        inWeights = true;
      }
      continue;
    }
    if (/^\S/.test(stripped)) break;
    const match = stripped.match(/^\s+([a-zA-Z0-9_]+)\s*:\s*([-+]?\d*\.?\d+)/);
    if (!match) continue;
    const key = match[1];
    const value = Number(match[2]);
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function buildState(moves: Move[]): GameState {
  let state = createInitialState();
  for (const move of moves) {
    state = applyMoveWithWinner(state, move);
  }
  return state;
}

function move(player: Player, positions: Array<[number, number]>): Move {
  return {
    player,
    positions: positions.map(([x, y]) => ({ x, y })),
  };
}

const midgameMoves: Move[] = [
  move('BLACK', [[5, 5]]),
  move('WHITE', [[0, 0], [0, 1]]),
  move('BLACK', [[6, 5], [7, 5]]),
  move('WHITE', [[1, 0], [1, 1]]),
  move('BLACK', [[8, 5], [9, 9]]),
  move('WHITE', [[2, 0], [2, 1]]),
  move('BLACK', [[10, 9], [11, 9]]),
  move('WHITE', [[3, 0], [3, 1]]),
];

const tacticalMoves: Move[] = [
  move('BLACK', [[9, 9]]),
  move('WHITE', [[0, 0], [0, 1]]),
  move('BLACK', [[10, 9], [11, 9]]),
  move('WHITE', [[1, 0], [1, 1]]),
  move('BLACK', [[12, 9], [13, 9]]),
  move('WHITE', [[2, 0], [2, 1]]),
];

const testStates: NamedState[] = [
  { name: 'empty', state: createInitialState() },
  { name: 'midgame', state: buildState(midgameMoves) },
  { name: 'tactical', state: buildState(tacticalMoves) },
];

const configWeights = loadConfigWeights();
const baseWeights: WeightMap = {
  ...DEFAULT_EVALUATION_WEIGHTS,
  ...configWeights,
};
const weightKeys = Array.from(
  new Set([...EVALUATION_WEIGHT_KEYS, ...Object.keys(configWeights)]),
).sort();

const player: Player = 'BLACK';
const baselineScores = testStates.map(t =>
  evaluateState(t.state, player, baseWeights as EvaluationWeights),
);
const epsilon = 1e-6;

console.log('Weights audit (delta after +10% per key)');
console.log(`Base weights source: defaults + config.yaml (if present)`);

for (const key of weightKeys) {
  const baseVal = Number.isFinite(baseWeights[key]) ? baseWeights[key] : 0;
  const bumped = baseVal * 1.1;
  const mutated: WeightMap = { ...baseWeights, [key]: bumped };

  const deltas = testStates.map((t, idx) => {
    const nextScore = evaluateState(
      t.state,
      player,
      mutated as EvaluationWeights,
    );
    return {
      name: t.name,
      delta: nextScore - baselineScores[idx],
    };
  });

  const used = deltas.some(d => Math.abs(d.delta) > epsilon);
  const label = used ? 'USED' : 'UNUSED';
  const detail = deltas
    .map(d => `${d.name}:${d.delta.toFixed(3)}`)
    .join(' ');
  console.log(
    `[${label}] ${key} base=${baseVal} -> ${bumped} | ${detail}`,
  );
}
