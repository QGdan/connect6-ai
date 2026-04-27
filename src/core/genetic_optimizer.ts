/// <reference types="node" />
import fs from 'fs';
import type { EvaluationWeights, Player, GameState } from '../types';
import { pvsSearchBestMove } from './pvs_search';
import { EVALUATION_WEIGHT_KEYS } from './evaluation';
import { createInitialState } from './game_state';
import { applyMoveWithWinner } from './rules';
import { createMulberry32, randInt } from './rng';

interface Individual {
  weights: EvaluationWeights;
  fitness: number;
}

export interface GAConfig {
  populationSize?: number;
  generations?: number;
  eliteCount?: number;
  crossoverProb?: number;
  mutationProb?: number;
  mutationSigma?: number;
  tournamentK?: number;
  gamesPerEval?: number;
  searchDepth?: number;
  timeLimitMs?: number;
  seed?: number;
}

export class GeneticAlgorithmOptimizer {
  private readonly popSize: number;
  private readonly generations: number;
  private readonly elite: number;
  private readonly pc: number;
  private readonly pm: number;
  private readonly sigma: number;
  private readonly k: number;
  private readonly gamesPerEval: number;
  private readonly searchDepth: number;
  private readonly timeLimitMs: number;
  private readonly rng: () => number;

  private log: number[] = [];
  private best: Individual | null = null;

  private readonly baseline: EvaluationWeights;

  constructor(baseline: EvaluationWeights, cfg: GAConfig = {}) {
    this.baseline = baseline;
    this.popSize = cfg.populationSize ?? 30;
    this.generations = cfg.generations ?? 50;
    this.elite = cfg.eliteCount ?? 2;
    this.pc = cfg.crossoverProb ?? 0.7;
    this.pm = cfg.mutationProb ?? 0.05;
    this.sigma = cfg.mutationSigma ?? 0.1;
    this.k = cfg.tournamentK ?? 5;
    this.gamesPerEval = cfg.gamesPerEval ?? 50;
    this.searchDepth = cfg.searchDepth ?? 2;
    this.timeLimitMs = cfg.timeLimitMs ?? 300;
    this.rng = createMulberry32(cfg.seed ?? 123456);
  }

  get_logs(): number[] {
    return this.log;
  }

  get_best(): EvaluationWeights | null {
    return this.best?.weights ?? null;
  }

  save_best(path: string): void {
    if (!this.best) return;
    fs.writeFileSync(path, JSON.stringify(this.best.weights, null, 2), 'utf-8');
  }

  async run(initialPopulation: EvaluationWeights[] = []): Promise<EvaluationWeights | null> {
    let population: Individual[] = this.initPopulation(initialPopulation);
    population = await this.evaluatePopulation(population);
    this.updateBest(population);

    for (let gen = 0; gen < this.generations; gen++) {
      const next: Individual[] = [];
      // elite copy
      const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
      for (let i = 0; i < this.elite; i++) next.push(sorted[i]);

      while (next.length < this.popSize) {
        const p1 = this.tournament(population);
        const p2 = this.tournament(population);
        const [c1, c2] = this.rng() < this.pc
          ? this.crossover(p1.weights, p2.weights)
          : [p1.weights, p2.weights];
        const m1 = this.mutate(c1);
        const m2 = this.mutate(c2);
        next.push({ weights: m1, fitness: 0 });
        if (next.length < this.popSize) next.push({ weights: m2, fitness: 0 });
      }

      population = await this.evaluatePopulation(next);
      this.updateBest(population);
      this.log.push(this.best?.fitness ?? 0);
    }

    return this.best?.weights ?? null;
  }

  // --- population helpers ---
  private initPopulation(seeds: EvaluationWeights[]): Individual[] {
    const pop: Individual[] = [];
    // include provided seeds + baseline
    const seedList = [...seeds, this.baseline];
    for (const w of seedList) {
      pop.push({ weights: { ...w }, fitness: 0 });
    }
    while (pop.length < this.popSize) {
      pop.push({ weights: this.randomWeights(), fitness: 0 });
    }
    return pop;
  }

  private randomWeights(): EvaluationWeights {
    const jitter = () => Math.max(0.01, this.rng() * 2);
    return {
      road_3_score: 5_000 * jitter(),
      road_4_score: 30_000 * jitter(),
      live4_score: 10_000 * jitter(),
      live5_score: 200_000 * jitter(),
      vcdt_bonus: 5_000 * jitter(),
    };
  }

  private tournament(pop: Individual): Individual;
  private tournament(pop: Individual[]): Individual;
  private tournament(pop: Individual[] | Individual): Individual {
    const arr = Array.isArray(pop) ? pop : [pop];
    let best: Individual | null = null;
    for (let i = 0; i < this.k; i++) {
      const cand = arr[randInt(this.rng, arr.length)];
      if (!best || cand.fitness > best.fitness) best = cand;
    }
    return best!;
  }

  private crossover(a: EvaluationWeights, b: EvaluationWeights): [EvaluationWeights, EvaluationWeights] {
    const keys = EVALUATION_WEIGHT_KEYS;
    const c1: EvaluationWeights = { ...a };
    const c2: EvaluationWeights = { ...b };
    for (const k of keys) {
      if (this.rng() < 0.5) {
        c1[k] = b[k];
        c2[k] = a[k];
      }
    }
    return [c1, c2];
  }

  private mutate(w: EvaluationWeights): EvaluationWeights {
    const keys = EVALUATION_WEIGHT_KEYS;
    const out: EvaluationWeights = { ...w };
    for (const k of keys) {
      if (this.rng() < this.pm) {
        out[k] = Math.max(0, out[k] + this.gaussian(0, this.sigma) * out[k]);
      }
    }
    return out;
  }

  private gaussian(mean: number, std: number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  private async evaluatePopulation(pop: Individual[]): Promise<Individual[]> {
    for (const ind of pop) {
      ind.fitness = await this.fitness(ind.weights);
    }
    return pop;
  }

  private async fitness(candidate: EvaluationWeights): Promise<number> {
    // play candidate vs baseline, alternating colors
    let wins = 0;
    const games = this.gamesPerEval;
    for (let i = 0; i < games; i++) {
      const swap = i % 2 === 1;
      const black = swap ? this.baseline : candidate;
      const white = swap ? candidate : this.baseline;
      const res = await this.playGame(black, white);
      if ((!swap && res === 'BLACK') || (swap && res === 'WHITE')) wins++;
    }
    return wins / games;
  }

  private async playGame(blackW: EvaluationWeights, whiteW: EvaluationWeights): Promise<Player | 'DRAW' | undefined> {
    let state: GameState = createInitialState();
    let plies = 0;
    const maxPlies = 80;

    while (!state.winner && plies < maxPlies) {
      const player = state.currentPlayer;
      const weights = player === 'BLACK' ? blackW : whiteW;
      const decision = pvsSearchBestMove(state, player, weights, {
        maxDepth: this.searchDepth,
        timeLimitMs: this.timeLimitMs,
        useMultithreading: false,
      });
      state = applyMoveWithWinner(state, decision.move);
      plies++;
    }
    return state.winner ?? 'DRAW';
  }

  private updateBest(pop: Individual[]): void {
    const best = pop.reduce((acc, cur) => (cur.fitness > acc.fitness ? cur : acc), pop[0]);
    if (!this.best || best.fitness > this.best.fitness) {
      this.best = { ...best, weights: { ...best.weights } };
    }
  }
}
