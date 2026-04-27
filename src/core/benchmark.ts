/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import type { GameState, Move, Player } from '../types';
import { Connect6AI } from './connect6_ai';
import { cloneState } from './game_state';
import { applyMoveWithWinner } from './rules';

interface BenchmarkCase {
  id: string;
  state: GameState;
  expectedWinner?: Player;
}

export interface BenchmarkResult {
  id: string;
  success: boolean;
  move?: Move;
  timeMs: number;
}

export class Benchmark {
  private readonly ai: Connect6AI;
  private readonly timeMs: number;

  constructor(ai: Connect6AI, timeMs: number) {
    this.ai = ai;
    this.timeMs = timeMs;
  }

  async runCases(cases: BenchmarkCase[]): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];
    for (const c of cases) {
      const start = Date.now();
      const move = await this.ai.get_best_move(cloneState(c.state), this.timeMs);
      const elapsed = Date.now() - start;
      const next = applyMoveWithWinner(cloneState(c.state), move);
      const success =
        c.expectedWinner === undefined || next.winner === c.expectedWinner;
      results.push({ id: c.id, success, move, timeMs: elapsed });
    }
    return results;
  }

  static loadDataset(file: string): BenchmarkCase[] {
    const p = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as BenchmarkCase[];
  }
}
