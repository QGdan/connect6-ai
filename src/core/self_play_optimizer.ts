import type { EvaluationWeights, GameState, Player } from '../types';
import { createInitialState } from './game_state';
import { pvsSearchBestMove } from './pvs_search';
import { evaluateState } from './evaluation';
import { applyMoveWithWinner } from './rules';

interface GAConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
}

export class SelfPlayOptimizer {
  // ★ 显式字段
  private gaConfig: GAConfig;
  private lastReport: { generation: number; bestFitness: number } | null = null;
  private bestWeights: EvaluationWeights | null = null;
  private bestFitness = -Infinity;

  constructor(gaConfig: GAConfig) {
    this.gaConfig = gaConfig;
  }

  async optimize(): Promise<EvaluationWeights> {
    let population = this.initPopulation();

    let fitness: number[] = [];

    for (let gen = 0; gen < this.gaConfig.generations; gen++) {
      fitness = await this.evaluatePopulation(population, gen);
      this.lastReport = { generation: gen, bestFitness: Math.max(...fitness) };
      this.trackBest(population, fitness);
      population = this.nextGeneration(population, fitness);
    }

    fitness = await this.evaluatePopulation(population, this.gaConfig.generations);
    this.trackBest(population, fitness);

    return this.bestWeights ?? population[0];
  }

  private initPopulation(): EvaluationWeights[] {
    const pop: EvaluationWeights[] = [];
    for (let i = 0; i < this.gaConfig.populationSize; i++) {
      pop.push({
        road_3_score: randIn(80, 120),
        road_4_score: randIn(300, 400),
        live4_score: randIn(2500, 3500),
        live5_score: randIn(8000, 12000),
        vcdt_bonus: randIn(1000, 2000),
      });
    }
    return pop;
  }

  getLatestReport() {
    return this.lastReport;
  }

  getBestWeights(): EvaluationWeights | null {
    return this.bestWeights;
  }

  private async evaluatePopulation(
    population: EvaluationWeights[],
    generation: number,
  ): Promise<number[]> {
    const fitness: number[] = [];
    for (const weights of population) {
      const score = await this.selfPlay(weights, generation);
      fitness.push(score);
    }
    return fitness;
  }

  private async selfPlay(
    weights: EvaluationWeights,
    generation: number,
  ): Promise<number> {
    let state: GameState = createInitialState();
    let player: Player = generation % 2 === 0 ? 'BLACK' : 'WHITE';
    let steps = 0;

    const matchCount = 4;
    let totalScore = 0;

    for (let match = 0; match < matchCount; match++) {
      state = createInitialState();
      player = match % 2 === 0 ? 'BLACK' : 'WHITE';
      steps = 0;

      while (!state.winner && steps < 36) {
        const dynamicDepth = steps < 10 ? 2 : 3;
        const moveDecision = pvsSearchBestMove(state, player, weights, {
          maxDepth: dynamicDepth,
          timeLimitMs: 120,
          useMultithreading: false,
        });
        state = applyMoveWithWinner(state, moveDecision.move);
        player = player === 'BLACK' ? 'WHITE' : 'BLACK';
        steps++;
      }

      const winnerScore =
        state.winner === 'BLACK' ? 1 : state.winner === 'WHITE' ? 0 : 0.5;
      const longevityBonus = Math.min(steps / 40, 1) * 0.1;
      const stability = evaluateState(state, 'BLACK', weights) / 50_000;

      totalScore += winnerScore + longevityBonus + stability * 0.05;
    }

    return totalScore / matchCount;
  }

  private nextGeneration(
    population: EvaluationWeights[],
    fitness: number[],
  ): EvaluationWeights[] {
    const newPop: EvaluationWeights[] = [];
    const totalFit = fitness.reduce((a, b) => a + b, 0) || 1;

    const selectParent = (): EvaluationWeights => {
      let r = Math.random() * totalFit;
      for (let i = 0; i < population.length; i++) {
        r -= fitness[i];
        if (r <= 0) return population[i];
      }
      return population[population.length - 1];
    };

    while (newPop.length < population.length) {
      const p1 = selectParent();
      const p2 = selectParent();
      const child = crossover(p1, p2);
      mutate(child, this.gaConfig.mutationRate);
      newPop.push(child);
    }

    return newPop;
  }

  private trackBest(population: EvaluationWeights[], fitness: number[]) {
    fitness.forEach((f, idx) => {
      if (f > this.bestFitness) {
        this.bestFitness = f;
        this.bestWeights = { ...population[idx] };
      }
    });
  }
}

function randIn(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function crossover(a: EvaluationWeights, b: EvaluationWeights): EvaluationWeights {
  return {
    road_3_score: (a.road_3_score + b.road_3_score) / 2,
    road_4_score: (a.road_4_score + b.road_4_score) / 2,
    live4_score: (a.live4_score + b.live4_score) / 2,
    live5_score: (a.live5_score + b.live5_score) / 2,
    vcdt_bonus: (a.vcdt_bonus + b.vcdt_bonus) / 2,
  };
}

function mutate(w: EvaluationWeights, rate: number) {
  const props: (keyof EvaluationWeights)[] = [
    'road_3_score',
    'road_4_score',
    'live4_score',
    'live5_score',
    'vcdt_bonus',
  ];
  for (const key of props) {
    if (Math.random() < rate) {
      (w as any)[key] *= 1 + (Math.random() - 0.5) * 0.15;
      (w as any)[key] = clamp((w as any)[key], 50, 20_000);
    }
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
