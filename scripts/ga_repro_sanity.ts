import type { EvaluationWeights } from '../src/types.ts';
import { GeneticAlgorithmOptimizer } from '../src/core/genetic_optimizer.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function nearlyEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function weightsEqual(a: EvaluationWeights, b: EvaluationWeights): boolean {
  const keys = Object.keys(a) as (keyof EvaluationWeights)[];
  return keys.every(k => nearlyEqual(a[k], b[k]));
}

async function runOnce(seed: number): Promise<{ fitness: number; weights: EvaluationWeights }> {
  const baseline: EvaluationWeights = {
    road_3_score: 12_000,
    road_4_score: 45_000,
    live4_score: 80_000,
    live5_score: 150_000,
    vcdt_bonus: 6_000,
  };

  const ga = new GeneticAlgorithmOptimizer(baseline, {
    seed,
    populationSize: 10,
    generations: 3,
    gamesPerEval: 2,
    searchDepth: 1,
    timeLimitMs: 5,
    eliteCount: 2,
    tournamentK: 3,
  });

  const best = await ga.run();
  const logs = ga.get_logs();
  const fitness = logs.length > 0 ? logs[logs.length - 1] : 0;
  assert(best !== null, 'Expected GA to produce a best weight set');
  return { fitness, weights: best! };
}

async function main() {
  const seed = 424242;
  const first = await runOnce(seed);
  const second = await runOnce(seed);

  console.log('fitness 1:', first.fitness);
  console.log('fitness 2:', second.fitness);
  console.log('weights 1:', first.weights);
  console.log('weights 2:', second.weights);

  assert(
    nearlyEqual(first.fitness, second.fitness),
    'Expected identical best fitness for same seed',
  );
  assert(
    weightsEqual(first.weights, second.weights),
    'Expected identical best weights for same seed',
  );
  console.log('ga_repro_sanity: OK');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
