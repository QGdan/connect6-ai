import type { Cell, GameState, Player } from '../types';
import { analyzeBothSidesCached } from './threat_service';
import { PatternEvaluator } from './pattern_evaluator';

export const VALUE_FEATURE_NAMES = [
  'win1_diff',
  'win2_diff',
  'live5_diff',
  'charge5_diff',
  'live4_diff',
  'charge4_diff',
  'double_four_diff',
  'four_three_diff',
  'double_three_diff',
  'live3_diff',
  'sleep3_diff',
  'attack_points_diff',
  'defense_points_diff',
  'live2_diff',
  'sleep2_diff',
  'initiative_diff',
  'connectivity_diff',
  'shape_balance_diff',
  'stone_count_diff',
  'center_control_diff',
  'frontier_diff',
  'max_chain_diff',
  'group_count_diff',
] as const;

type FeatureName = (typeof VALUE_FEATURE_NAMES)[number];

type BoardStats = {
  stoneCount: number;
  centerControl: number;
  frontier: number;
  maxChain: number;
  groupCount: number;
};

const patternEvalBlack = new PatternEvaluator('BLACK');
const patternEvalWhite = new PatternEvaluator('WHITE');

const dirs8 = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
];

const otherPlayer = (player: Player): Player =>
  player === 'BLACK' ? 'WHITE' : 'BLACK';

const initBoardStats = (): BoardStats => ({
  stoneCount: 0,
  centerControl: 0,
  frontier: 0,
  maxChain: 0,
  groupCount: 0,
});

function computeBoardStats(board: Cell[][]): Record<Player, BoardStats> {
  const size = board.length;
  const center = (size - 1) / 2;
  const maxDist = Math.max(1, center * 2);
  const stats: Record<Player, BoardStats> = {
    BLACK: initBoardStats(),
    WHITE: initBoardStats(),
  };
  const frontier: Record<Player, Set<number>> = {
    BLACK: new Set<number>(),
    WHITE: new Set<number>(),
  };
  const visited: Record<Player, Uint8Array> = {
    BLACK: new Uint8Array(size * size),
    WHITE: new Uint8Array(size * size),
  };

  for (let y = 0; y < size; y += 1) {
    const row = board[y];
    for (let x = 0; x < size; x += 1) {
      const v = row[x];
      if (v === 0) continue;
      const player: Player = v === 1 ? 'BLACK' : 'WHITE';
      const idx = y * size + x;
      stats[player].stoneCount += 1;
      const dist = Math.abs(x - center) + Math.abs(y - center);
      stats[player].centerControl += 1 - dist / maxDist;

      for (const { dx, dy } of dirs8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (board[ny][nx] === 0) {
          frontier[player].add(ny * size + nx);
        }
      }

      if (visited[player][idx]) continue;
      stats[player].groupCount += 1;
      let chainSize = 0;
      const stack = [idx];
      visited[player][idx] = 1;
      while (stack.length > 0) {
        const current = stack.pop();
        if (current == null) break;
        chainSize += 1;
        const cx = current % size;
        const cy = Math.floor(current / size);
        for (const { dx, dy } of dirs8) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nextIdx = ny * size + nx;
          if (visited[player][nextIdx]) continue;
          if (board[ny][nx] !== v) continue;
          visited[player][nextIdx] = 1;
          stack.push(nextIdx);
        }
      }
      if (chainSize > stats[player].maxChain) {
        stats[player].maxChain = chainSize;
      }
    }
  }

  stats.BLACK.frontier = frontier.BLACK.size;
  stats.WHITE.frontier = frontier.WHITE.size;
  return stats;
}

function countByType(report: ReturnType<typeof analyzeBothSidesCached>['my']) {
  return {
    win1: report.winIn1.length,
    win2: report.winIn2.length,
    live5: report.byType.LIVE5.length,
    charge5: report.byType.CHARGE5.length,
    live4: report.byType.LIVE4.length,
    charge4: report.byType.CHARGE4.length,
    doubleFour: report.byType.DOUBLE_FOUR.length,
    fourThree: report.byType.FOUR_THREE.length,
    doubleThree: report.byType.DOUBLE_THREE.length,
    live3: report.byType.LIVE3.length,
    sleep3: report.byType.SLEEP3.length,
    attackPoints: report.attackPoints.length,
    defensePoints: report.defensePoints.length,
  };
}

export function computeValueFeatures(
  state: GameState,
  player: Player,
): { features: number[]; names: FeatureName[] } {
  const { my, opp } = analyzeBothSidesCached(state, player);
  const myCount = countByType(my);
  const oppCount = countByType(opp);
  const boardStats = computeBoardStats(state.board);
  const myStats = boardStats[player];
  const oppStats = boardStats[otherPlayer(player)];

  const patternEval =
    player === 'BLACK' ? patternEvalBlack : patternEvalWhite;
  const patternFeatures = patternEval.evaluate(state.board).features;

  const boardScale = 20;
  const patternScale = 10;

  const features = [
    myCount.win1 - oppCount.win1,
    myCount.win2 - oppCount.win2,
    myCount.live5 - oppCount.live5,
    myCount.charge5 - oppCount.charge5,
    myCount.live4 - oppCount.live4,
    myCount.charge4 - oppCount.charge4,
    myCount.doubleFour - oppCount.doubleFour,
    myCount.fourThree - oppCount.fourThree,
    myCount.doubleThree - oppCount.doubleThree,
    myCount.live3 - oppCount.live3,
    myCount.sleep3 - oppCount.sleep3,
    myCount.attackPoints - oppCount.attackPoints,
    myCount.defensePoints - oppCount.defensePoints,
    patternFeatures.live_two,
    patternFeatures.blocked_two,
    patternFeatures.initiative / patternScale,
    patternFeatures.connectivity / patternScale,
    patternFeatures.shape_balance / patternScale,
    (myStats.stoneCount - oppStats.stoneCount) / boardScale,
    (myStats.centerControl - oppStats.centerControl) / boardScale,
    (myStats.frontier - oppStats.frontier) / boardScale,
    myStats.maxChain - oppStats.maxChain,
    (myStats.groupCount - oppStats.groupCount) / boardScale,
  ];

  return { features, names: [...VALUE_FEATURE_NAMES] };
}
