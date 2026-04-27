import fs from 'node:fs';
import path from 'node:path';
import { formatBoardCoord } from '../src/core/board_coords.ts';
import type { Player, Position } from '../src/types.ts';

type Options = {
  input: string;
  out: string;
  maxPlies: number;
  topK: number;
  minCount: number;
  winWeight: number;
  drawWeight: number;
  lossWeight: number;
};

const DEFAULTS: Options = {
  input: path.join('outputs', 'selfplay_c6.txt'),
  out: path.join('src', 'core', 'opening_book_data.ts'),
  maxPlies: 9,
  topK: 6,
  minCount: 3,
  winWeight: 1,
  drawWeight: 0.5,
  lossWeight: 0.2,
};

type MoveStat = { count: number; weight: number };

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
    if (arg === '--maxPlies' || arg.startsWith('--maxPlies=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.maxPlies = Number(value);
      i = next;
      continue;
    }
    if (arg === '--topK' || arg.startsWith('--topK=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.topK = Number(value);
      i = next;
      continue;
    }
    if (arg === '--minCount' || arg.startsWith('--minCount=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.minCount = Number(value);
      i = next;
      continue;
    }
    if (arg === '--winWeight' || arg.startsWith('--winWeight=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.winWeight = Number(value);
      i = next;
      continue;
    }
    if (arg === '--drawWeight' || arg.startsWith('--drawWeight=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.drawWeight = Number(value);
      i = next;
      continue;
    }
    if (arg === '--lossWeight' || arg.startsWith('--lossWeight=')) {
      const { value, next } = readValue(arg, i);
      if (value) opts.lossWeight = Number(value);
      i = next;
      continue;
    }
  }

  if (!Number.isFinite(opts.maxPlies) || opts.maxPlies <= 0) {
    opts.maxPlies = DEFAULTS.maxPlies;
  }
  if (opts.maxPlies % 2 === 0) opts.maxPlies -= 1;
  if (!Number.isFinite(opts.topK) || opts.topK <= 0) opts.topK = DEFAULTS.topK;
  if (!Number.isFinite(opts.minCount) || opts.minCount <= 0) {
    opts.minCount = DEFAULTS.minCount;
  }
  if (!Number.isFinite(opts.winWeight)) opts.winWeight = DEFAULTS.winWeight;
  if (!Number.isFinite(opts.drawWeight)) opts.drawWeight = DEFAULTS.drawWeight;
  if (!Number.isFinite(opts.lossWeight)) opts.lossWeight = DEFAULTS.lossWeight;

  return opts;
}

function parseWinner(line: string): Player | 'DRAW' | null {
  if (line.includes('[先手胜]')) return 'BLACK';
  if (line.includes('[后手胜]')) return 'WHITE';
  if (line.includes('[和局]')) return 'DRAW';
  return null;
}

function parseMoves(line: string): Position[] {
  const moves: Position[] = [];
  const regex = /[BW]\(([A-S]),(\d{1,2})\)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const x = match[1].toUpperCase().charCodeAt(0) - 65;
    const y = Number(match[2]) - 1;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      moves.push({ x, y });
    }
  }
  return moves;
}

function prefixKey(stones: Position[]): string {
  return stones.map(formatBoardCoord).join(' ');
}

function moveKey(stones: Position[]): string {
  return stones.map(formatBoardCoord).join(' ');
}

function currentPlayerForPrefix(prefixLen: number): Player {
  const k = (prefixLen - 1) / 2;
  return k % 2 === 0 ? 'WHITE' : 'BLACK';
}

function weightFor(
  winner: Player | 'DRAW' | null,
  player: Player,
  opts: Options,
): number {
  if (!winner || winner === 'DRAW') return opts.drawWeight;
  return winner === player ? opts.winWeight : opts.lossWeight;
}

function buildBook(lines: string[], opts: Options): string[] {
  const table = new Map<string, Map<string, MoveStat>>();

  for (const line of lines) {
    if (!line.trim()) continue;
    const winner = parseWinner(line);
    const stones = parseMoves(line);
    if (stones.length < 3) continue;

    const maxPrefix = Math.min(opts.maxPlies, stones.length - 2);
    for (let prefixLen = 1; prefixLen <= maxPrefix; prefixLen += 2) {
      const player = currentPlayerForPrefix(prefixLen);
      const next = stones.slice(prefixLen, prefixLen + 2);
      if (next.length < 2) continue;
      const key = prefixKey(stones.slice(0, prefixLen));
      const move = moveKey(next);
      let bucket = table.get(key);
      if (!bucket) {
        bucket = new Map<string, MoveStat>();
        table.set(key, bucket);
      }
      const prev = bucket.get(move) ?? { count: 0, weight: 0 };
      prev.count += 1;
      prev.weight += weightFor(winner, player, opts);
      bucket.set(move, prev);
    }
  }

  const linesOut: string[] = [];
  for (const [key, bucket] of table.entries()) {
    const items = [...bucket.entries()]
      .filter(([, stat]) => stat.count >= opts.minCount)
      .map(([move, stat]) => ({ move, stat }));
    if (items.length === 0) continue;
    items.sort((a, b) => b.stat.weight - a.stat.weight);
    const top = items.slice(0, opts.topK);
    const total = top.reduce((sum, item) => sum + item.stat.weight, 0);
    if (total <= 0) continue;
    const moves = top
      .map(item => `${item.move} ${(item.stat.weight / total).toFixed(2)}`)
      .join(' ; ');
    linesOut.push(`${key} : ${moves}`);
  }

  linesOut.sort();
  return linesOut;
}

function wrapBook(lines: string[]): string {
  const body = lines.join('\n');
  return `export const OPENING_BOOK_RAW = \`\n${body}\n\`.trim();\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const input = fs.readFileSync(opts.input, 'utf8');
  const lines = input.split(/\r?\n/);
  const bookLines = buildBook(lines, opts);
  if (bookLines.length === 0) {
    throw new Error('No opening book lines generated.');
  }
  const outDir = path.dirname(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(opts.out, wrapBook(bookLines), 'utf8');
  console.log(`opening book saved: ${opts.out} (${bookLines.length} lines)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
