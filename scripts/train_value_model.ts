import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { computeZobristHash } from '../src/core/zobrist.ts';
import { computeValueFeatures } from '../src/core/value_features.ts';
import {
  trainValueModel,
  type ValueTrainingSample,
} from '../src/core/value_trainer.ts';
import type { ValueModelSnapshot } from '../src/core/value_model_snapshot.ts';
import type { GameState, Player } from '../src/types.ts';
import { BOARD_SIZE } from '../src/types.ts';

type Options = {
  input: string;
  out: string;
  maxSamples: number;
  epochs: number;
  lr: number;
  l2: number;
  seed: number;
};

const DEFAULTS: Options = {
  input: path.join('outputs', 'selfplay_samples.jsonl'),
  out: path.join('src', 'models', 'value_model.ts'),
  maxSamples: 80_000,
  epochs: 4,
  lr: 0.02,
  l2: 0.001,
  seed: 42,
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { ...DEFAULTS };
  const readValue = (arg: string, index: number) => {
    const eq = arg.indexOf('=');
    if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
    if (index + 1 < argv.length) return { value: argv[index + 1], next: index + 1 };
    return { value: undefined, next: index };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg.startsWith('--input=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.input = value;
      i = next;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.out = value;
      i = next;
      continue;
    }
    if (arg === '--maxSamples' || arg.startsWith('--maxSamples=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.maxSamples = Number(value);
      i = next;
      continue;
    }
    if (arg === '--epochs' || arg.startsWith('--epochs=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.epochs = Number(value);
      i = next;
      continue;
    }
    if (arg === '--lr' || arg.startsWith('--lr=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.lr = Number(value);
      i = next;
      continue;
    }
    if (arg === '--l2' || arg.startsWith('--l2=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.l2 = Number(value);
      i = next;
      continue;
    }
    if (arg === '--seed' || arg.startsWith('--seed=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.seed = Number(value);
      i = next;
      continue;
    }
  }

  if (!Number.isFinite(opts.maxSamples) || opts.maxSamples <= 0) {
    opts.maxSamples = DEFAULTS.maxSamples;
  }
  if (!Number.isFinite(opts.epochs) || opts.epochs <= 0) {
    opts.epochs = DEFAULTS.epochs;
  }
  if (!Number.isFinite(opts.lr) || opts.lr <= 0) opts.lr = DEFAULTS.lr;
  if (!Number.isFinite(opts.l2) || opts.l2 < 0) opts.l2 = DEFAULTS.l2;
  if (!Number.isFinite(opts.seed)) opts.seed = DEFAULTS.seed;

  return opts;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function decodeBoard(serialized: string): number[][] {
  if (serialized.length !== BOARD_SIZE * BOARD_SIZE) {
    throw new Error(`Invalid board length ${serialized.length}`);
  }
  const board: number[][] = [];
  let idx = 0;
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      row.push(Number(serialized[idx]) as number);
      idx += 1;
    }
    board.push(row);
  }
  return board;
}

function writeModel(outPath: string, snapshot: ValueModelSnapshot) {
  const body = `export const VALUE_MODEL = {
  enabled: ${snapshot.enabled},
  featureNames: ${JSON.stringify(snapshot.featureNames)},
  weights: ${JSON.stringify(snapshot.weights.map(v => Number(v.toFixed(6))))},
  bias: ${Number(snapshot.bias.toFixed(6))},
  trainedAt: ${JSON.stringify(snapshot.trainedAt)},
  samples: ${snapshot.samples},
  epochs: ${snapshot.epochs},
};\n`;

  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rng = mulberry32(opts.seed);

  const samples: ValueTrainingSample[] = [];
  let seen = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(opts.input, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let data: any;
    try {
      data = JSON.parse(trimmed);
    } catch {
      continue;
    }
    seen += 1;
    let slot = -1;
    if (samples.length < opts.maxSamples) {
      slot = samples.length;
    } else {
      const pick = Math.floor(rng() * seen);
      if (pick < opts.maxSamples) slot = pick;
    }
    if (slot < 0) continue;

    const board = decodeBoard(data.board);
    const currentPlayer = (data.currentPlayer as Player) ?? 'BLACK';
    const moveNumber = Number(data.moveNumber) || 0;
    const result = Number(data.result);
    if (!Number.isFinite(result)) continue;

    const state: GameState = {
      board,
      currentPlayer,
      moveNumber,
      zobristHash: computeZobristHash(board, currentPlayer),
    };

    const { features } = computeValueFeatures(state, currentPlayer);
    const sample: ValueTrainingSample = {
      features,
      result: Math.max(0, Math.min(1, result)),
    };
    if (slot === samples.length) samples.push(sample);
    else samples[slot] = sample;
  }

  if (samples.length === 0) {
    throw new Error('No training samples collected.');
  }

  const result = trainValueModel(samples, {
    epochs: opts.epochs,
    lr: opts.lr,
    l2: opts.l2,
    seed: opts.seed,
  });
  result.losses.forEach((loss, idx) => {
    console.log(
      `epoch ${idx + 1}/${result.losses.length} loss=${loss.toFixed(4)}`,
    );
  });
  writeModel(opts.out, result.snapshot);
  console.log(`value model saved: ${opts.out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
