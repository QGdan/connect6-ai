import fs from 'node:fs';
import path from 'node:path';
import { SelfPlay } from '../src/core/self_play.ts';
import type { GameRecord, TrainingSample } from '../src/core/self_play.ts';
import type { Move, Player } from '../src/types.ts';
import { formatBoardCoord } from '../src/core/board_coords.ts';

type Mode = 'fast' | 'normal' | 'deep';

type Options = {
  games: number;
  timeMs: number;
  mode: Mode;
  randomOpeningPlies: number;
  seed: number;
  out: string;
  append: boolean;
  augment: boolean;
};

const DEFAULTS: Options = {
  games: 200,
  timeMs: 120,
  mode: 'normal',
  randomOpeningPlies: 3,
  seed: 12345,
  out: path.join('outputs', 'selfplay_samples.jsonl'),
  append: false,
  augment: false,
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
    if (arg === '--append') {
      opts.append = true;
      continue;
    }
    if (arg === '--overwrite' || arg === '--noAppend') {
      opts.append = false;
      continue;
    }
    if (arg === '--augment') {
      opts.augment = true;
      continue;
    }
    if (arg === '--games' || arg.startsWith('--games=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.games = Number(value);
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
    if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.out = value;
      i = next;
      continue;
    }
  }

  if (!Number.isFinite(opts.games) || opts.games <= 0) opts.games = DEFAULTS.games;
  if (!Number.isFinite(opts.timeMs) || opts.timeMs <= 0) opts.timeMs = DEFAULTS.timeMs;
  if (!Number.isFinite(opts.randomOpeningPlies) || opts.randomOpeningPlies < 0) {
    opts.randomOpeningPlies = DEFAULTS.randomOpeningPlies;
  }
  if (!Number.isFinite(opts.seed)) opts.seed = DEFAULTS.seed;

  return opts;
}

function encodeBoard(board: number[][]): string {
  let out = '';
  for (let y = 0; y < board.length; y += 1) {
    const row = board[y];
    for (let x = 0; x < row.length; x += 1) {
      out += String(row[x]);
    }
  }
  return out;
}

function encodeMove(move: Move): string {
  return move.positions.map(formatBoardCoord).join(' ');
}

function resultFor(player: Player, winner?: Player | 'DRAW'): number {
  if (!winner || winner === 'DRAW') return 0.5;
  return winner === player ? 1 : 0;
}

function writeSamples(
  stream: fs.WriteStream,
  record: GameRecord,
  gameIndex: number,
): void {
  const samples = record.samples ?? [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample: TrainingSample = samples[i];
    const payload = {
      game: gameIndex,
      ply: i + 1,
      winner: record.winner ?? 'DRAW',
      result: resultFor(sample.state.currentPlayer, record.winner),
      currentPlayer: sample.state.currentPlayer,
      moveNumber: sample.state.moveNumber,
      board: encodeBoard(sample.state.board),
      move: encodeMove(sample.move),
    };
    stream.write(`${JSON.stringify(payload)}\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.dirname(opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  const stream = fs.createWriteStream(opts.out, {
    flags: opts.append ? 'a' : 'w',
    encoding: 'utf8',
  });

  const selfPlay = new SelfPlay({
    games: opts.games,
    timeMs: opts.timeMs,
    mode: opts.mode,
    randomOpeningPlies: opts.randomOpeningPlies,
    seed: opts.seed,
    recordSamples: true,
    augmentSamples: opts.augment,
  });

  await selfPlay.runStream(async (record, index) => {
    writeSamples(stream, record, index + 1);
    if ((index + 1) % 50 === 0) {
      console.log(`selfplay samples: ${index + 1}/${opts.games}`);
    }
  });

  await new Promise(resolve => stream.end(resolve));
  console.log(`selfplay samples saved to ${opts.out}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
