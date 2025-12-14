import type { GameState, EvaluationWeights, Player } from '../types';
import { getAllRoads, encodeRoad } from './road_encoding';
import { detectVCDT } from './vcdt';
import { BOARD_SIZE } from './game_state';

// 扩展评估权重，加入防守权重
export interface ExtendedEvaluationWeights extends EvaluationWeights {
  threat_defense_weight?: number; // 防守权重，默认为 1.5
}

/*export function evaluateState(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
): number {
  const roadScore = evaluateRoads(state, player, weights);
  const patternScore = evaluatePatterns(state, player, weights);
  const threatScore = evaluateThreatDefense(state, player, weights);
  return roadScore + patternScore + threatScore;
}*/

export function evaluateState(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
): number {
  const roadScore = evaluateRoads(state, player, weights);
  const patternScore = evaluatePatterns(state, player, weights);
  const threatScore = evaluateThreatDefense(state, player, weights);
  const positionalScore = evaluatePositional(state, player);
  return roadScore + patternScore + threatScore + positionalScore;
}


/*function evaluateRoads(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
): number {
  let score = 0;
  const roads = getAllRoads();

  for (const road of roads) {
    const code = encodeRoad(state, road);
    const { myMax, oppMax } = countMaxRun(code, player);
    if (myMax >= 6) return 1000000;
    if (oppMax >= 6) score -= 1000000;

    if (myMax === 4) score += weights.road_4_score;
    if (myMax === 3) score += weights.road_3_score;
    if (oppMax === 4) score -= weights.road_4_score * 0.9;
    if (oppMax === 3) score -= weights.road_3_score * 0.9;
  }

  return score;
}*/
function evaluateRoads(
  state: GameState,
  player: Player,
  _weights: EvaluationWeights,
): number {
  const roads = getAllRoads();
  let score = 0;

  for (const road of roads) {
    const code = encodeRoad(state, road);
    const { myMax, oppMax } = countMaxRun(code, player);

    // 我方已经有 6 连，直接极大正分
    if (myMax >= 6) {
      return 1_000_000;
    }

    // 对方有 6 连，极大负分（注意不能 early return，
    // 以免漏掉我方也有 6 连的离谱局面，但正常对局不会）
    if (oppMax >= 6) {
      score -= 1_000_000;
    }
  }

  // 不再对 3/4 连做任何加分 / 减分，
  // 这些全部交给 evaluatePatterns + evaluateThreatDefense 处理。
  return score;
}


function evaluatePositional(
  state: GameState,
  player: Player,
): number {
  const myVal = player === 'BLACK' ? 1 : 2;
  const oppVal = player === 'BLACK' ? 2 : 1;

  const center = (BOARD_SIZE - 1) / 2;
  const maxDist = center * 2;

  let score = 0;

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const v = state.board[y][x];
      if (v === 0) continue;

      const dist =
        Math.abs(x - center) + Math.abs(y - center);
      const positional = maxDist - dist; // 越靠近中心值越大

      if (v === myVal) {
        score += positional * 2;   // 乘 2 是个温和放大系数
      } else if (v === oppVal) {
        score -= positional * 2;
      }
    }
  }

  return score;
}

function countMaxRun(code: number, player: Player): { myMax: number; oppMax: number } {
  const myBits = player === 'BLACK' ? 0b01 : 0b10;
  const oppBits = player === 'BLACK' ? 0b10 : 0b01;
  let myMax = 0;
  let oppMax = 0;
  let myCur = 0;
  let oppCur = 0;
  for (let i = 0; i < 6; i++) {
    const bits = (code >> (i * 2)) & 0b11;
    if (bits === myBits) {
      myCur++;
      oppCur = 0;
    } else if (bits === oppBits) {
      oppCur++;
      myCur = 0;
    } else {
      myCur = 0;
      oppCur = 0;
    }
    if (myCur > myMax) myMax = myCur;
    if (oppCur > oppMax) oppMax = oppCur;
  }
  return { myMax, oppMax };
}

function evaluatePatterns(
  state: GameState,
  player: Player,
  weights: EvaluationWeights,
): number {
  const roads = getAllRoads();
  let myLive4 = 0;
  let myLive5 = 0;
  let oppLive4 = 0;
  let oppLive5 = 0;

  const myVal = player === 'BLACK' ? 1 : 2;
  const oppVal = player === 'BLACK' ? 2 : 1;

  for (const road of roads) {
    const cells = road.cells.map(p => state.board[p.y][p.x]);
    const myCount = cells.filter(c => c === myVal).length;
    const oppCount = cells.filter(c => c === oppVal).length;
    const emptyCount = cells.filter(c => c === 0).length;

    if (oppCount === 0) {
      if (myCount === 4 && emptyCount === 2) myLive4++;
      if (myCount === 5 && emptyCount === 1) myLive5++;
    }
    if (myCount === 0) {
      if (oppCount === 4 && emptyCount === 2) oppLive4++;
      if (oppCount === 5 && emptyCount === 1) oppLive5++;
    }
  }

  let score =
    myLive4 * weights.live4_score +
    myLive5 * weights.live5_score -
    oppLive4 * weights.live4_score * 0.8 -
    oppLive5 * weights.live5_score * 0.9;

  const myVcdt = detectVCDT(state, player).length;
  const oppVcdt = detectVCDT(state, player === 'BLACK' ? 'WHITE' : 'BLACK').length;
  score += (myVcdt - oppVcdt) * weights.vcdt_bonus;

  return score;
}

// 评估防守威胁的必要性
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function evaluateThreatDefense(
  state: GameState,
  player: Player,
  _weights: EvaluationWeights,
): number {
  let score = 0;
  const opponent = player === 'BLACK' ? 'WHITE' : 'BLACK';

  // 检测对方的威胁
  const oppThreats = detectVCDT(state, opponent);
  
    const oppWinningThreats = oppThreats.filter(
    t => t.isWinning && t.threatLevel === 0,
  );
  const oppDoubleThreats = oppThreats.filter(
    t => t.isWinning && t.threatLevel === 1,
  );
  const oppLive4Threats = oppThreats.filter(
    t => !t.isWinning && t.threatLevel === 2,
  );

  // 对方有赢局点 - 极度危险（必须马上处理）
  if (oppWinningThreats.length > 0) {
    score -= 200_000 * oppWinningThreats.length;
  }

  // 对方有必杀双点 - 非常危险
  if (oppDoubleThreats.length > 0) {
    score -= 120_000 * oppDoubleThreats.length;
  }

  // 对方活四：一手防不住就是输，权重要很高
  if (oppLive4Threats.length >= 2) {
    // 多个活四相当于半个必杀局面
    score -= 80_000 * oppLive4Threats.length;
  } else if (oppLive4Threats.length === 1) {
    score -= 40_000;
  }


  // 我方的威胁加分（主动出击）
  const myThreats = detectVCDT(state, player);
  const myWinningThreats = myThreats.filter(t => t.isWinning && t.threatLevel === 0);
  const myDoubleThreats = myThreats.filter(t => t.isWinning && t.threatLevel === 1);
  const myLive4Threats = myThreats.filter(t => !t.isWinning && t.threatLevel === 2);

  if (myWinningThreats.length > 0) {
    score += 200_000 * myWinningThreats.length;
  }
  if (myDoubleThreats.length > 0) {
    score += 100_000 * myDoubleThreats.length;
  }
    if (myLive4Threats.length >= 2) {
    score += 30_000 * myLive4Threats.length;
  } else if (myLive4Threats.length === 1) {
    score += 10_000;
  }
  return score;
}