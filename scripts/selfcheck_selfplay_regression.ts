import fs from 'node:fs';
import path from 'node:path';
import { createInitialState } from '../src/core/game_state.ts';
import { applyMoveWithWinner, getStonesToPlace } from '../src/core/rules.ts';
import { analyzeBothSidesCached, clearThreatCache } from '../src/core/threat_service.ts';
import { BOARD_SIZE } from '../src/types.ts';
import type { Move, Player, Position } from '../src/types.ts';
import {
  collectOpenThreeThreats,
  countOpenThreeLines,
} from '../src/core/threat_utils.ts';
import { posIdx } from '../src/core/pos_key.ts';
import type { ThreatReport } from '../src/core/threat_service.ts';

type CoordMode = 'auto' | 'top' | 'bottom';
type DebugOptions = { enabled: boolean; gameIndex: number };

type GameMetrics = {
  coordMode: Exclude<CoordMode, 'auto'>;
  moves: number;
  stones: number;
  illegalMoves: number;
  wrongPlayer: number;
  wrongStoneCount: number;
  deadLinePlacements: number;
  ignoredWin1: number;
  ignoredWin2: number;
  missDoubleLive3: number;
  overBlockSingleLive3: number;
};

function parseCoordMode(argv: string[]): CoordMode {
  for (const arg of argv) {
    if (!arg.startsWith('--coord=')) continue;
    const v = arg.slice('--coord='.length).trim();
    if (v === 'auto' || v === 'top' || v === 'bottom') return v;
  }
  return 'auto';
}

function parseMaxGames(argv: string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--maxGames') {
      const next = argv[i + 1];
      if (!next) continue;
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    if (arg.startsWith('--maxGames=')) {
      const n = Number(arg.slice('--maxGames='.length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return 12;
}

function parseInputPath(argv: string[]): string {
  const nonFlags = argv.filter(arg => !arg.startsWith('--'));
  if (nonFlags.length > 0) return nonFlags[0];
  const fixture = path.join('tests', 'fixtures', 'selfplay_regression_sample.txt');
  if (fs.existsSync(fixture)) return fixture;
  return path.join('outputs', 'selfplay_c6.txt');
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function rowFromY(y: number, mode: Exclude<CoordMode, 'auto'>): number {
  return mode === 'bottom' ? BOARD_SIZE - y : y + 1;
}

function formatPos(pos: Position, mode: Exclude<CoordMode, 'auto'>): string {
  const col = String.fromCharCode(65 + pos.x);
  return `${col},${rowFromY(pos.y, mode)}`;
}

function formatMove(move: Move, mode: Exclude<CoordMode, 'auto'>): string {
  const color = move.player === 'BLACK' ? 'B' : 'W';
  return `${color} ${move.positions.map(p => formatPos(p, mode)).join(' ')}`;
}

function isInsideBoard(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

const LINE_DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

function lineSpanWithoutOpponent(
  board: number[][],
  pos: Position,
  oppVal: 1 | 2,
  dx: number,
  dy: number,
): number {
  let count = 1;
  let nx = pos.x + dx;
  let ny = pos.y + dy;
  while (isInsideBoard(nx, ny) && board[ny][nx] !== oppVal) {
    count += 1;
    nx += dx;
    ny += dy;
  }
  nx = pos.x - dx;
  ny = pos.y - dy;
  while (isInsideBoard(nx, ny) && board[ny][nx] !== oppVal) {
    count += 1;
    nx -= dx;
    ny -= dy;
  }
  return count;
}

function hasLinePotential(board: number[][], pos: Position, oppVal: 1 | 2): boolean {
  for (const { dx, dy } of LINE_DIRS) {
    if (lineSpanWithoutOpponent(board, pos, oppVal, dx, dy) >= 6) return true;
  }
  return false;
}

function isDeadLineCell(board: number[][], pos: Position): boolean {
  if (board[pos.y]?.[pos.x] !== 0) return false;
  const blackAlive = hasLinePotential(board, pos, 2);
  if (blackAlive) return false;
  const whiteAlive = hasLinePotential(board, pos, 1);
  return !whiteAlive;
}

function hasUrgentThreat(report: ThreatReport, nextNeed: number): boolean {
  if (report.winIn1.length > 0) return true;
  if (nextNeed >= 2 && report.winIn2.length > 0) return true;
  return (
    report.byType.LIVE5.length > 0 ||
    report.byType.CHARGE5.length > 0 ||
    report.byType.LIVE4.length > 0 ||
    report.byType.CHARGE4.length > 0 ||
    report.byType.DOUBLE_FOUR.length > 0 ||
    report.byType.FOUR_THREE.length > 0 ||
    report.byType.DOUBLE_THREE.length > 0
  );
}

type StoneToken = { player: Player; col: string; row: number };

function parseStoneTokens(raw: string): StoneToken[] {
  const tokens = raw.split(';').map(t => t.trim()).filter(Boolean);
  const stones: StoneToken[] = [];
  for (const token of tokens) {
    const cleaned = token.replace(/^\{+/, '').replace(/\}+$/, '').trim();
    const match = cleaned.match(/^([BW])\(([A-S]),(\d{1,2})\)$/i);
    if (!match) continue;
    const player = match[1].toUpperCase() === 'B' ? 'BLACK' : 'WHITE';
    const col = match[2].toUpperCase();
    const row = Number(match[3]);
    if (!Number.isFinite(row) || row < 1 || row > BOARD_SIZE) continue;
    stones.push({ player, col, row });
  }
  return stones;
}

function toPosition(token: StoneToken, mode: Exclude<CoordMode, 'auto'>): Position {
  const x = token.col.charCodeAt(0) - 65;
  const y = mode === 'bottom' ? BOARD_SIZE - token.row : token.row - 1;
  return { x, y };
}

function buildMovesFromLine(
  line: string,
  coordMode: Exclude<CoordMode, 'auto'>,
): { stones: Array<{ player: Player; pos: Position }>; moves: Move[] } {
  const tokens = parseStoneTokens(line);
  const stones = tokens.map(t => ({
    player: t.player,
    pos: toPosition(t, coordMode),
  }));
  const moves = groupMoves(stones);
  return { stones, moves };
}

function groupMoves(stones: Array<{ player: Player; pos: Position }>): Move[] {
  const moves: Move[] = [];
  let current: Move | null = null;
  for (const stone of stones) {
    if (!current || current.player !== stone.player) {
      if (current) moves.push(current);
      current = { player: stone.player, positions: [stone.pos] };
    } else {
      current.positions.push(stone.pos);
    }
  }
  if (current) moves.push(current);
  return moves;
}

function validateGame(
  line: string,
  coordMode: Exclude<CoordMode, 'auto'>,
): { illegalMoves: number; wrongPlayer: number; wrongStoneCount: number } {
  const { moves } = buildMovesFromLine(line, coordMode);
  let state = createInitialState();
  let illegalMoves = 0;
  let wrongPlayer = 0;
  let wrongStoneCount = 0;

  for (const move of moves) {
    const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
    if (move.player !== state.currentPlayer) wrongPlayer += 1;
    if (move.positions.length !== required) wrongStoneCount += 1;
    try {
      state = applyMoveWithWinner(state, move, {
        allowIncomplete: move.positions.length < required,
      });
    } catch {
      illegalMoves += 1;
      break;
    }
    if (state.winner) break;
  }

  return { illegalMoves, wrongPlayer, wrongStoneCount };
}

function analyzeGame(
  line: string,
  coordMode: Exclude<CoordMode, 'auto'>,
  debug?: DebugOptions,
): GameMetrics {
  const { stones, moves } = buildMovesFromLine(line, coordMode);

  clearThreatCache();
  let state = createInitialState();

  const metrics: GameMetrics = {
    coordMode,
    moves: moves.length,
    stones: stones.length,
    illegalMoves: 0,
    wrongPlayer: 0,
    wrongStoneCount: 0,
    deadLinePlacements: 0,
    ignoredWin1: 0,
    ignoredWin2: 0,
    missDoubleLive3: 0,
    overBlockSingleLive3: 0,
  };

  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
    const board = state.board as unknown as number[][];

    if (move.player !== state.currentPlayer) {
      metrics.wrongPlayer += 1;
    }
    if (move.positions.length !== required) {
      metrics.wrongStoneCount += 1;
    }

    const oppPlayer: Player = state.currentPlayer === 'BLACK' ? 'WHITE' : 'BLACK';
    const oppVal = oppPlayer === 'BLACK' ? 1 : 2;
    const oppNeedNext = getStonesToPlace(state.moveNumber + 1, oppPlayer);
    const { opp: oppReport } = analyzeBothSidesCached(state, state.currentPlayer);

    const oppLive3Threats = collectOpenThreeThreats(state, oppVal);
    const oppLive3LineCount = countOpenThreeLines(oppLive3Threats);

    const lineEnds = new Map<number, Set<number>>();
    for (const t of oppLive3Threats) {
      let set = lineEnds.get(t.lineId);
      if (!set) {
        set = new Set<number>();
        lineEnds.set(t.lineId, set);
      }
      for (const end of t.ends) {
        set.add(posIdx(end.x, end.y));
      }
    }

    const hitLines = new Set<number>();
    const hitPerLine = new Map<number, number>();
    const moveSet = new Set<number>();
    let deadPlacementsInMove = 0;
    const deadPositions: Position[] = [];
    for (const p of move.positions) {
      if (isDeadLineCell(board, p)) {
        deadPlacementsInMove += 1;
        deadPositions.push(p);
      }
      moveSet.add(posIdx(p.x, p.y));
      const k = posIdx(p.x, p.y);
      for (const [lineId, ends] of lineEnds.entries()) {
        if (!ends.has(k)) continue;
        hitLines.add(lineId);
        hitPerLine.set(lineId, (hitPerLine.get(lineId) ?? 0) + 1);
      }
    }

    if (deadPlacementsInMove > 0) {
      let nonDeadEmpty = 0;
      for (let y = 0; y < BOARD_SIZE && nonDeadEmpty < required; y += 1) {
        for (let x = 0; x < BOARD_SIZE && nonDeadEmpty < required; x += 1) {
          if (board[y][x] !== 0) continue;
          if (isDeadLineCell(board, { x, y })) continue;
          nonDeadEmpty += 1;
        }
      }
      if (nonDeadEmpty >= required) {
        metrics.deadLinePlacements += deadPlacementsInMove;
        if (debug?.enabled) {
          console.log(
            `[g${debug.gameIndex + 1} t${i + 1}] deadLinePlacements +${deadPlacementsInMove} (nonDeadEmpty>=${required}) dead=${deadPositions
              .map(p => formatPos(p, coordMode))
              .join(' ')} move=${formatMove(move, coordMode)}`,
          );
        }
      }
    }

    if (required >= 2) {
      const onlyLineId = oppLive3LineCount === 1 ? [...lineEnds.keys()][0] : undefined;
      const wouldMissDoubleLive3 = oppLive3LineCount >= 2 && hitLines.size < 2;
      const wouldOverBlockSingle =
        oppLive3LineCount === 1 &&
        onlyLineId !== undefined &&
        (hitPerLine.get(onlyLineId) ?? 0) >= 2;

      if (wouldMissDoubleLive3 || wouldOverBlockSingle) {
        const oppUrgent = hasUrgentThreat(oppReport, oppNeedNext);
        if (!oppUrgent) {
          if (wouldMissDoubleLive3) metrics.missDoubleLive3 += 1;
          if (wouldOverBlockSingle) metrics.overBlockSingleLive3 += 1;
        }
      }
    }

    let nextState: ReturnType<typeof applyMoveWithWinner>;
    try {
      nextState = applyMoveWithWinner(state, move, {
        allowIncomplete: move.positions.length < required,
      });
    } catch {
      metrics.illegalMoves += 1;
      break;
    }

    const moveWins = nextState.winner === move.player;
    if (!moveWins) {
      const blocksOppWin1 =
        oppReport.winIn1.length > 0 &&
        oppReport.winIn1.some(p => moveSet.has(posIdx(p.x, p.y)));
      if (oppReport.winIn1.length > 0 && !blocksOppWin1) {
        metrics.ignoredWin1 += 1;
      }

      const oppWin2Active = oppNeedNext >= 2 && oppReport.winIn2.length > 0;
      if (oppWin2Active) {
        if (oppReport.winIn2.length === 1) {
          const [a, b] = oppReport.winIn2[0];
          const hitA = moveSet.has(posIdx(a.x, a.y));
          const hitB = moveSet.has(posIdx(b.x, b.y));
          if (!hitA && !hitB) {
            metrics.ignoredWin2 += 1;
            if (debug?.enabled) {
              console.log(
                `[g${debug.gameIndex + 1} t${i + 1}] ignoredWin2 (single pair) move=${formatMove(move, coordMode)}`,
              );
            }
          }
        } else {
          const blocksAnyPair = oppReport.winIn2.some(([a, b]) => {
            const aKey = posIdx(a.x, a.y);
            const bKey = posIdx(b.x, b.y);
            return moveSet.has(aKey) || moveSet.has(bKey);
          });
          if (!blocksAnyPair) {
            metrics.ignoredWin2 += 1;
            if (debug?.enabled) {
              console.log(
                `[g${debug.gameIndex + 1} t${i + 1}] ignoredWin2 (multi pairs) move=${formatMove(move, coordMode)}`,
              );
            }
          }
        }
      }
    }

    state = nextState;
    if (state.winner) break;
  }

  return metrics;
}

function pickBestCoordMode(line: string, mode: CoordMode): Exclude<CoordMode, 'auto'> {
  if (mode === 'top' || mode === 'bottom') return mode;
  const bottom = validateGame(line, 'bottom');
  if (bottom.illegalMoves === 0 && bottom.wrongStoneCount === 0 && bottom.wrongPlayer === 0) {
    return 'bottom';
  }
  const top = validateGame(line, 'top');
  if (top.illegalMoves === 0 && top.wrongStoneCount === 0 && top.wrongPlayer === 0) {
    return 'top';
  }
  // Prefer the one with fewer illegal moves; tie-breaker: bottom.
  if (top.illegalMoves < bottom.illegalMoves) return 'top';
  return 'bottom';
}

function main() {
  const argv = process.argv.slice(2);
  const coordMode = parseCoordMode(argv);
  const maxGames = parseMaxGames(argv);
  const input = parseInputPath(argv);
  const debug = hasFlag(argv, '--debug');

  if (!fs.existsSync(input)) {
    console.log(`selfcheck_selfplay_regression: SKIP (missing ${input})`);
    return;
  }

  const raw = fs.readFileSync(input, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const sample = lines.slice(0, maxGames);
  if (sample.length === 0) {
    console.log('selfcheck_selfplay_regression: SKIP (empty log)');
    return;
  }

  const agg: Omit<GameMetrics, 'coordMode'> & { games: number; coord: Record<string, number> } = {
    games: 0,
    coord: {},
    moves: 0,
    stones: 0,
    illegalMoves: 0,
    wrongPlayer: 0,
    wrongStoneCount: 0,
    deadLinePlacements: 0,
    ignoredWin1: 0,
    ignoredWin2: 0,
    missDoubleLive3: 0,
    overBlockSingleLive3: 0,
  };

  for (const line of sample) {
    const chosen = pickBestCoordMode(line, coordMode);
    const m = analyzeGame(line, chosen, { enabled: debug, gameIndex: agg.games });
    agg.games += 1;
    agg.coord[chosen] = (agg.coord[chosen] ?? 0) + 1;
    agg.moves += m.moves;
    agg.stones += m.stones;
    agg.illegalMoves += m.illegalMoves;
    agg.wrongPlayer += m.wrongPlayer;
    agg.wrongStoneCount += m.wrongStoneCount;
    agg.deadLinePlacements += m.deadLinePlacements;
    agg.ignoredWin1 += m.ignoredWin1;
    agg.ignoredWin2 += m.ignoredWin2;
    agg.missDoubleLive3 += m.missDoubleLive3;
    agg.overBlockSingleLive3 += m.overBlockSingleLive3;
  }

  console.log('selfcheck_selfplay_regression: summary');
  console.log(`  games: ${agg.games} (coord: ${JSON.stringify(agg.coord)})`);
  console.log(`  moves: ${agg.moves}, stones: ${agg.stones}`);
  console.log(
    `  illegalMoves=${agg.illegalMoves} wrongPlayer=${agg.wrongPlayer} wrongStoneCount=${agg.wrongStoneCount}`,
  );
  console.log(
    `  ignoredWin1=${agg.ignoredWin1} ignoredWin2=${agg.ignoredWin2} deadLinePlacements=${agg.deadLinePlacements}`,
  );
  console.log(
    `  missDoubleLive3=${agg.missDoubleLive3} overBlockSingleLive3=${agg.overBlockSingleLive3}`,
  );

  if (agg.illegalMoves > 0) {
    throw new Error(`selfplay regression: illegalMoves=${agg.illegalMoves}`);
  }
  if (agg.ignoredWin1 > 0) {
    throw new Error(`selfplay regression: ignoredWin1=${agg.ignoredWin1}`);
  }
  if (agg.ignoredWin2 > 0) {
    throw new Error(`selfplay regression: ignoredWin2=${agg.ignoredWin2}`);
  }
  if (agg.deadLinePlacements > 0) {
    throw new Error(`selfplay regression: deadLinePlacements=${agg.deadLinePlacements}`);
  }
  if (agg.missDoubleLive3 > 0) {
    throw new Error(`selfplay regression: missDoubleLive3=${agg.missDoubleLive3}`);
  }
  if (agg.overBlockSingleLive3 > 0) {
    throw new Error(
      `selfplay regression: overBlockSingleLive3=${agg.overBlockSingleLive3}`,
    );
  }

  console.log('selfcheck_selfplay_regression: OK');
}

main();
