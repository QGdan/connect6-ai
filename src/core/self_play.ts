import { createInitialState } from './game_state';
import type { Cell, GameState, Move, Player } from '../types';
import { Connect6AI } from './connect6_ai';
import { createEvaluatorFromSnapshot } from './resnet_ai';
import type { ValueModelSnapshot } from './value_model_snapshot';
import { applyMoveWithWinner, getStonesToPlace } from './rules';
import { generateRZOPCandidates } from './rzop';
import { posIdx } from './pos_key';
import { SYMMETRIES, transformBoard, transformMove } from './symmetry';

export interface SelfPlayOptions {
  games: number;
  timeMs: number;
  mode?: 'fast' | 'normal' | 'deep';
  randomOpeningPlies?: number;
  seed?: number;
  recordSamples?: boolean;
  augmentSamples?: boolean;
  onSample?: (sample: TrainingSample) => void;
  modelSnapshot?: ValueModelSnapshot | null;
  modelSnapshotBlack?: ValueModelSnapshot | null;
  modelSnapshotWhite?: ValueModelSnapshot | null;
}

export interface TrainingSampleState {
  board: Cell[][];
  currentPlayer: Player;
  moveNumber: number;
}

export interface TrainingSample {
  state: TrainingSampleState;
  move: Move;
}

export interface GameRecord {
  winner: Player | 'DRAW' | undefined;
  moves: Move[];
  samples?: TrainingSample[];
  stats: {
    elapsedMs: number;
  };
}

export class SelfPlay {
  private readonly opts: SelfPlayOptions;
  private readonly rng: () => number;

  constructor(opts: SelfPlayOptions) {
    this.opts = opts;
    const seed =
      typeof opts.seed === 'number' && Number.isFinite(opts.seed)
        ? opts.seed
        : Date.now();
    this.rng = mulberry32(seed);
  }

  async run(): Promise<GameRecord[]> {
    const records: GameRecord[] = [];
    for (let i = 0; i < this.opts.games; i++) {
      records.push(await this.playOne());
    }
    return records;
  }

  async runStream(
    onGame: (record: GameRecord, index: number) => Promise<void> | void,
  ): Promise<void> {
    for (let i = 0; i < this.opts.games; i++) {
      const record = await this.playOne();
      await onGame(record, i);
    }
  }

  private async playOne(): Promise<GameRecord> {
    let state: GameState = createInitialState();
    const evaluatorBlack = createEvaluatorFromSnapshot(
      this.opts.modelSnapshotBlack ?? this.opts.modelSnapshot,
    );
    const evaluatorWhite = createEvaluatorFromSnapshot(
      this.opts.modelSnapshotWhite ?? this.opts.modelSnapshot,
    );
    const aiBlack = new Connect6AI(this.opts.mode ?? 'normal', evaluatorBlack);
    const aiWhite = new Connect6AI(this.opts.mode ?? 'normal', evaluatorWhite);

    const moves: Move[] = [];
    const recordSamples = Boolean(this.opts.recordSamples || this.opts.augmentSamples);
    const samples = recordSamples ? [] as TrainingSample[] : null;
    const start = Date.now();
    const openingPlies = this.opts.randomOpeningPlies ?? 3;

    // randomize first few plies to diversify data
    for (let i = 0; i < openingPlies && !state.winner; i++) {
      const rMove = this.randomMove(state);
      this.recordSample(state, rMove, samples);
      state = applyMoveWithWinner(state, rMove);
      moves.push(rMove);
    }

    while (!state.winner) {
      const ai = state.currentPlayer === 'BLACK' ? aiBlack : aiWhite;
      const mv = await ai.get_best_move(state, this.opts.timeMs);
      this.recordSample(state, mv, samples);
      state = applyMoveWithWinner(state, mv);
      moves.push(mv);
      if (moves.length > 120) break; // safety to avoid endless games
    }

    return {
      winner: state.winner,
      moves,
      samples: samples ?? undefined,
      stats: { elapsedMs: Date.now() - start },
    };
  }

  private randomMove(state: GameState): Move {
    const candidates = generateRZOPCandidates(state);
    const empties: Move['positions'] = [];
    for (let y = 0; y < state.board.length; y++) {
      for (let x = 0; x < state.board[y].length; x++) {
        if (state.board[y][x] === 0) empties.push({ x, y });
      }
    }
    const need = getStonesToPlace(state.moveNumber, state.currentPlayer);
    const picks: Move['positions'] = [];
    const pool = candidates.length > 0 ? [...candidates] : [];
    const seen = new Set<number>();

    while (picks.length < need && pool.length > 0) {
      const idx = Math.floor(this.rng() * pool.length);
      const pick = pool.splice(idx, 1)[0];
      picks.push(pick);
      seen.add(posIdx(pick.x, pick.y));
    }

    if (picks.length < need) {
      const fallback = empties.filter(p => !seen.has(posIdx(p.x, p.y)));
      while (picks.length < need && fallback.length > 0) {
        const idx = Math.floor(this.rng() * fallback.length);
        const pick = fallback.splice(idx, 1)[0];
        picks.push(pick);
        seen.add(posIdx(pick.x, pick.y));
      }
    }
    return { player: state.currentPlayer, positions: picks };
  }

  private recordSample(
    state: GameState,
    move: Move,
    samples: TrainingSample[] | null,
  ): void {
    const shouldRecord = Boolean(this.opts.recordSamples || this.opts.augmentSamples);
    const shouldEmit = Boolean(this.opts.onSample);
    if (!shouldRecord && !shouldEmit) return;

    const snapshot: TrainingSampleState = {
      board: state.board.map(row => [...row]),
      currentPlayer: state.currentPlayer,
      moveNumber: state.moveNumber,
    };

    if (this.opts.augmentSamples) {
      for (const sym of SYMMETRIES) {
        const sample: TrainingSample = {
          state: {
            board: transformBoard(snapshot.board, sym),
            currentPlayer: snapshot.currentPlayer,
            moveNumber: snapshot.moveNumber,
          },
          move: transformMove(move, snapshot.board.length, sym),
        };
        if (shouldRecord && samples) samples.push(sample);
        if (this.opts.onSample) this.opts.onSample(sample);
      }
      return;
    }

    const sample: TrainingSample = { state: snapshot, move };
    if (shouldRecord && samples) samples.push(sample);
    if (this.opts.onSample) this.opts.onSample(sample);
  }
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
