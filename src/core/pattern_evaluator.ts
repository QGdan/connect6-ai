import type { Cell, Move, Player, Position } from '../types';
import { posIdx } from './pos_key';

// Basic feature names we track.
export type FeatureName =
  | 'six'
  | 'five'
  | 'live_four'
  | 'blocked_four'
  | 'live_three'
  | 'blocked_three'
  | 'live_two'
  | 'blocked_two'
  | 'double_three'
  | 'double_four'
  | 'four_three'
  | 'initiative'
  | 'connectivity'
  | 'shape_balance';

export type FeatureVector = Record<FeatureName, number>;

export type PatternWeights = Partial<Record<FeatureName, number>>;

export interface EvalResult {
  score: number;
  features: FeatureVector;
}

const DEFAULT_WEIGHTS: FeatureVector = {
  six: 1_000_000,
  five: 200_000,
  live_four: 10_000,
  blocked_four: 5_000,
  live_three: 500,
  blocked_three: 250,
  live_two: 50,
  blocked_two: 20,
  double_three: 8_000,
  double_four: 30_000,
  four_three: 18_000,
  initiative: 600,
  connectivity: 120,
  shape_balance: 180,
};

interface LineInfo {
  id: number;
  cells: Position[];
}

interface LineCacheEntry {
  self: FeatureVector;
  opp: FeatureVector;
}

type FeatureStore = Record<Player, FeatureVector>;

/**
 * EvaluationFunction:
 *  - Full evaluation via evaluate()
 *  - Incremental update via updateIncremental() using only the lines that changed
 *  - getFeatureVector() returns the current differential feature vector
 *
 * All scores are from the perspective of rootPlayer (positive is good for rootPlayer).
 */
export class EvaluationFunction {
  private readonly size = 19;
  private readonly lines: LineInfo[];
  private readonly cellToLines: Map<number, number[]>;
  private readonly weights: FeatureVector;
  private readonly rootPlayer: Player;

  private totals: FeatureStore = {
    BLACK: this.zeroFeatures(),
    WHITE: this.zeroFeatures(),
  };
  private lineCache = new Map<number, LineCacheEntry>();
  private initialized = false;

  constructor(rootPlayer: Player, weights?: PatternWeights) {
    this.rootPlayer = rootPlayer;
    this.lines = this.buildLines();
    this.cellToLines = this.buildCellToLines();
    this.weights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  }

  /**
   * Full evaluation from scratch.
   */
  evaluate(board: Cell[][]): EvalResult {
    this.resetTotals();
    this.lineCache.clear();

    const selfKey = this.rootPlayer;
    const oppKey = this.otherPlayer(this.rootPlayer);

    for (const line of this.lines) {
      const encodedSelf = this.encodeLine(board, line.cells, this.rootPlayer);
      const encodedOpp = this.encodeLine(
        board,
        line.cells,
        this.otherPlayer(this.rootPlayer),
      );

      const selfVec = this.extractFeatures(encodedSelf);
      const oppVec = this.extractFeatures(encodedOpp);

      this.addToTotals(selfKey, selfVec);
      this.addToTotals(oppKey, oppVec);
      this.lineCache.set(line.id, { self: selfVec, opp: oppVec });
    }

    this.applyDerivedTotals();
    this.applyBoardGlobals(board);
    this.initialized = true;
    return {
      score: this.computeScore(),
      features: this.getFeatureVector(board),
    };
  }

  /**
   * Incremental update: only recompute lines that include last_move positions.
   * Falls back to full evaluation if not initialized.
   */
  updateIncremental(board: Cell[][], lastMove: Move): EvalResult {
    if (!this.initialized) {
      return this.evaluate(board);
    }

    const selfKey = this.rootPlayer;
    const oppKey = this.otherPlayer(this.rootPlayer);
    const touchedLines = new Set<number>();
    for (const p of lastMove.positions) {
      const key = posIdx(p.x, p.y);
      const ids = this.cellToLines.get(key);
      if (!ids) continue;
      ids.forEach(id => touchedLines.add(id));
    }

    for (const id of touchedLines) {
      const line = this.lines[id];
      const prev = this.lineCache.get(id);

      if (prev) {
        this.subFromTotals(selfKey, prev.self);
        this.subFromTotals(oppKey, prev.opp);
      }

      const encodedSelf = this.encodeLine(board, line.cells, this.rootPlayer);
      const encodedOpp = this.encodeLine(
        board,
        line.cells,
        this.otherPlayer(this.rootPlayer),
      );

      const selfVec = this.extractFeatures(encodedSelf);
      const oppVec = this.extractFeatures(encodedOpp);

      this.addToTotals(selfKey, selfVec);
      this.addToTotals(oppKey, oppVec);
      this.lineCache.set(id, { self: selfVec, opp: oppVec });
    }

    this.applyDerivedTotals();
    this.applyBoardGlobals(board);
    return {
      score: this.computeScore(),
      features: this.getFeatureVector(board),
    };
  }

  getFeatureVector(_board: Cell[][]): FeatureVector {
    // Differential feature vector (rootPlayer - opponent)
    const self = this.totals[this.rootPlayer];
    const opp = this.totals[this.otherPlayer(this.rootPlayer)];
    const diff = this.zeroFeatures();
    for (const k of Object.keys(diff) as FeatureName[]) {
      diff[k] = self[k] - opp[k];
    }
    return diff;
  }

  // ---- internals ----

  private computeScore(): number {
    let s = 0;
    const diff = this.getFeatureVector([]);
    for (const key of Object.keys(diff) as FeatureName[]) {
      s += (this.weights[key] ?? 0) * diff[key];
    }
    return s;
  }

  private resetTotals() {
    this.totals = {
      BLACK: this.zeroFeatures(),
      WHITE: this.zeroFeatures(),
    };
  }

  private zeroFeatures(): FeatureVector {
    return {
      six: 0,
      five: 0,
      live_four: 0,
      blocked_four: 0,
      live_three: 0,
      blocked_three: 0,
      live_two: 0,
      blocked_two: 0,
      double_three: 0,
      double_four: 0,
      four_three: 0,
      initiative: 0,
      connectivity: 0,
      shape_balance: 0,
    };
  }

  private addToTotals(player: Player, v: FeatureVector) {
    const t = this.totals[player];
    for (const k of Object.keys(v) as FeatureName[]) {
      t[k] += v[k];
    }
  }

  private subFromTotals(player: Player, v: FeatureVector) {
    const t = this.totals[player];
    for (const k of Object.keys(v) as FeatureName[]) {
      t[k] -= v[k];
    }
  }

  private otherPlayer(p: Player): Player {
    return p === 'BLACK' ? 'WHITE' : 'BLACK';
  }

  private buildLines(): LineInfo[] {
    const lines: LineInfo[] = [];
    let id = 0;
    const n = this.size;

    // rows
    for (let y = 0; y < n; y++) {
      const cells: Position[] = [];
      for (let x = 0; x < n; x++) cells.push({ x, y });
      lines.push({ id: id++, cells });
    }

    // cols
    for (let x = 0; x < n; x++) {
      const cells: Position[] = [];
      for (let y = 0; y < n; y++) cells.push({ x, y });
      lines.push({ id: id++, cells });
    }

    // diag down-right
    for (let k = -n + 1; k < n; k++) {
      const cells: Position[] = [];
      for (let y = 0; y < n; y++) {
        const x = y + k;
        if (x < 0 || x >= n) continue;
        cells.push({ x, y });
      }
      if (cells.length >= 6) lines.push({ id: id++, cells });
    }

    // diag up-right
    for (let k = 0; k < 2 * n - 1; k++) {
      const cells: Position[] = [];
      for (let y = 0; y < n; y++) {
        const x = k - y;
        if (x < 0 || x >= n) continue;
        cells.push({ x, y });
      }
      if (cells.length >= 6) lines.push({ id: id++, cells });
    }

    return lines;
  }

  private buildCellToLines(): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const line of this.lines) {
      for (const c of line.cells) {
        const key = posIdx(c.x, c.y);
        const arr = map.get(key) ?? [];
        arr.push(line.id);
        map.set(key, arr);
      }
    }
    return map;
  }

  private encodeLine(
    board: Cell[][],
    cells: Position[],
    player: Player,
  ): string {
    const me = player === 'BLACK' ? 1 : 2;
    const opp = player === 'BLACK' ? 2 : 1;
    let s = 'B'; // boundary sentinel
    for (const { x, y } of cells) {
      const v = board[y][x];
      if (v === me) s += 'X';
      else if (v === opp) s += 'O';
      else s += '.';
    }
    s += 'B';
    return s;
  }

  private extractFeatures(line: string): FeatureVector {
    // canonical symmetry to reduce repeated computation across mirrored lines
    const rev = line.split('').reverse().join('');
    const canonical = line < rev ? line : rev;

    // Note: regexes are written for patterns with boundary sentinel B and '.' as empty.
    const counts: FeatureVector = this.zeroFeatures();

    const apply = (name: FeatureName, re: RegExp) => {
      const m = canonical.match(re);
      if (m) counts[name] += m.length;
    };

    apply('six', /XXXXXX/g);

    // Five: allow optional empty at one end, but block by boundary/opponent
    apply('five', /(?=(?:B|O)\.?XXXXX\.?(?:B|O))/g);

    // Open four (live four): .XXXX. with real empties at both sides
    apply('live_four', /(?=\.XXXX\.)/g);
    // Blocked four (rush/half-open four): one end blocked
    apply('blocked_four', /(?=(?:B|O)XXXX\.|\.(?:XXXX(?:B|O)))/g);

    // Live three: .XXX. (open ends), plus split shapes like .XX.X. or .X.XX.
    apply('live_three', /(?=\.XXX\.)/g);
    apply('live_three', /(?=\.XX\.X\.)/g);
    apply('live_three', /(?=\.X\.XX\.)/g);

    // Blocked three (sleeping): patterns with one blocked end or internal gap
    apply('blocked_three', /(?=(?:B|O)XXX\.)/g);
    apply('blocked_three', /(?=\.XXX(?:B|O))/g);
    apply('blocked_three', /(?=\.XX\.X(?:B|O)|(?:B|O)X\.XX\.)/g);

    // Live two: .XX. with open ends
    apply('live_two', /(?=\.XX\.)/g);
    apply('live_two', /(?=\.X\.X\.)/g);

    // Blocked two: one end blocked or short shapes
    apply('blocked_two', /(?=(?:B|O)XX\.)/g);
    apply('blocked_two', /(?=\.XX(?:B|O))/g);
    apply('blocked_two', /(?=\.X\.X(?:B|O)|(?:B|O)X\.X\.)/g);

    return counts;
  }

  private applyDerivedTotals() {
    const self = this.totals[this.rootPlayer];
    const opp = this.totals[this.otherPlayer(this.rootPlayer)];

    const setDerived = (vec: FeatureVector) => {
      vec.double_three = Math.floor(vec.live_three / 2);
      vec.double_four = Math.floor((vec.live_four + vec.blocked_four) / 2);
      vec.four_three = Math.min(
        vec.live_four + vec.blocked_four,
        vec.live_three,
      );
      vec.initiative =
        vec.live_four * 2 +
        vec.blocked_four +
        vec.live_three +
        vec.double_three * 2 +
        vec.double_four * 2 +
        vec.four_three * 2;
    };

    setDerived(self);
    setDerived(opp);
  }

  private applyBoardGlobals(board: Cell[][]) {
    const dirs = [
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
      { dx: 1, dy: -1 },
    ];

    const counts: Record<Player, number[]> = {
      BLACK: [0, 0, 0, 0],
      WHITE: [0, 0, 0, 0],
    };

    for (let y = 0; y < board.length; y++) {
      const row = board[y];
      for (let x = 0; x < row.length; x++) {
        const v = row[x];
        if (v === 0) continue;
        const player: Player = v === 1 ? 'BLACK' : 'WHITE';
        for (let i = 0; i < dirs.length; i++) {
          const { dx, dy } = dirs[i];
          const nx = x + dx;
          const ny = y + dy;
          if (ny < 0 || ny >= board.length) continue;
          if (nx < 0 || nx >= row.length) continue;
          if (board[ny][nx] !== v) continue;
          counts[player][i] += 1;
        }
      }
    }

    for (const player of ['BLACK', 'WHITE'] as Player[]) {
      const perDir = counts[player];
      const sum = perDir.reduce((acc, v) => acc + v, 0);
      const max = perDir.length > 0 ? Math.max(...perDir) : 0;
      this.totals[player].connectivity = sum;
      this.totals[player].shape_balance = Math.max(0, sum - max);
    }
  }
}

export { EvaluationFunction as PatternEvaluator };

export const DEFAULT_PATTERN_WEIGHTS = DEFAULT_WEIGHTS;
