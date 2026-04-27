import type { Player, Position } from '../types';

export type PatternType =
  | 'CONNECT6'
  | 'LIVE5'
  | 'CHARGE5'
  | 'DEAD5'
  | 'LIVE4'
  | 'CHARGE4'
  | 'DEAD4'
  | 'LIVE3'
  | 'SLEEP3'
  | 'WIN_IN_1'
  | 'WIN_IN_2'
  | 'DOUBLE_THREE'
  | 'DOUBLE_FOUR'
  | 'FOUR_THREE';

export interface PatternHit {
  type: PatternType;
  player: Player;
  roadId: number;
  dir: Position;
  runLen: number;
  openEnds: number;
  stones: Position[];
  keyPoints: Position[];
  defensePoints: Position[];
  winPairs?: [Position, Position][];
}

export interface ThreatReport {
  player: Player;
  patterns: PatternHit[];
  byType: Record<PatternType, PatternHit[]>;
  oppPatterns?: PatternHit[];
  oppByType?: Record<PatternType, PatternHit[]>;
  winIn1: Position[];
  winIn2: [Position, Position][];
  myWin1Points: Position[];
  myWin2Pairs: [Position, Position][];
  oppWin1Points: Position[];
  oppWin2Pairs: [Position, Position][];
  winningPoints: Position[];
  winPairs: [Position, Position][];
  // For analyzeThreats: points that force opponent to defend.
  forcingPoints: Position[];
  // For merged report: points current player must defend.
  mustDefendPoints: Position[];
  candidatePoints: Position[];
  defensePoints: Position[];
  attackPoints: Position[];
}

export function stableKey(hit: PatternHit): string {
  const keyPoints = hit.keyPoints
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
  const stones = hit.stones
    .map(p => `${p.x},${p.y}`)
    .sort()
    .join('|');
  return [
    hit.type,
    hit.player,
    hit.dir.x,
    hit.dir.y,
    hit.runLen,
    hit.openEnds,
    keyPoints,
    stones,
  ].join('#');
}

export function makeEmptyReport(player: Player): ThreatReport {
  return {
    player,
    patterns: [],
    byType: {
      CONNECT6: [],
      LIVE5: [],
      CHARGE5: [],
      DEAD5: [],
      LIVE4: [],
      CHARGE4: [],
      DEAD4: [],
      LIVE3: [],
      SLEEP3: [],
      WIN_IN_1: [],
      WIN_IN_2: [],
      DOUBLE_THREE: [],
      DOUBLE_FOUR: [],
      FOUR_THREE: [],
    },
    winIn1: [],
    winIn2: [],
    myWin1Points: [],
    myWin2Pairs: [],
    oppWin1Points: [],
    oppWin2Pairs: [],
    winningPoints: [],
    winPairs: [],
    forcingPoints: [],
    mustDefendPoints: [],
    candidatePoints: [],
    defensePoints: [],
    attackPoints: [],
  };
}
