import type { EvaluationWeights, GameState, Player } from '../types';
import { createInitialState } from './game_state';
import { pvsSearchBestMove } from './pvs_search';
import { applyMoveWithWinner } from './rules';

interface GAConfig {
  populationSize: number;
  generations: number;
  mutationRate: number;
}

export interface SelfPlayProgress {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  champion: EvaluationWeights;
}

export class SelfPlayOptimizer {
  // ★ 显式字段
  private gaConfig: GAConfig;

  constructor(gaConfig: GAConfig) {
    this.gaConfig = gaConfig;
  }

  async optimize(
    onGeneration?: (progress: SelfPlayProgress) => void,
  ): Promise<EvaluationWeights> {
    let population = this.initPopulation();

    for (let gen = 0; gen < this.gaConfig.generations; gen++) {
      const fitness = await this.evaluatePopulation(population);

      if (onGeneration) {
        const { bestFitness, bestIdx, avg } = summarizeFitness(fitness);
        onGeneration({
          generation: gen,
          bestFitness,
          avgFitness: avg,
          champion: population[bestIdx],
        });
      }

      population = this.nextGeneration(population, fitness);
    }

    const fitness = await this.evaluatePopulation(population);
    const { bestIdx } = summarizeFitness(fitness);

    return population[bestIdx];
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

  private async evaluatePopulation(
    population: EvaluationWeights[],
  ): Promise<number[]> {
    const fitness: number[] = [];
    for (const weights of population) {
      const score = await this.selfPlay(weights);
      fitness.push(score);
    }
    return fitness;
  }

  private async selfPlay(weights: EvaluationWeights): Promise<number> {
    let state: GameState = createInitialState();
    let player: Player = 'BLACK';
    let steps = 0;

    while (!state.winner && steps < 30) {
      const moveDecision = pvsSearchBestMove(
        state,
        player,
        weights,
        { maxDepth: 3, timeLimitMs: 100, useMultithreading: false },
      );
      state = applyMoveWithWinner(state, moveDecision.move);
      player = player === 'BLACK' ? 'WHITE' : 'BLACK';
      steps++;
    }

    if (state.winner === 'BLACK') return 1;
    if (state.winner === 'WHITE') return 0;
    return 0.5;
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
      (w as any)[key] *= 1 + (Math.random() - 0.5) * 0.2;
    }
  }
}

function summarizeFitness(fitness: number[]) {
  let bestFit = -Infinity;
  let bestIdx = 0;
  let sum = 0;

  fitness.forEach((f, i) => {
    sum += f;
    if (f > bestFit) {
      bestFit = f;
      bestIdx = i;
    }
  });

  const avg = fitness.length === 0 ? 0 : sum / fitness.length;
  return { bestFitness: bestFit, bestIdx, avg };
}
