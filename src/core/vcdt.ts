import type { GameState, Player, Position } from '../types';
import { BOARD_SIZE } from '../types';
import { analyzeThreatCached } from './threat_service';
import {
  stableKey,
  type PatternHit,
  type PatternType,
} from './pattern_library';
import { posIdx } from './pos_key';

export type VCDTKind = Exclude<PatternType, 'CONNECT6'>;

export interface VCDTThreat {
  positions: Position[];
  isWinning: boolean;
  threatLevel: number;
  kind: VCDTKind;
  defenseCost?: number;
}

const VCDT_SCAN_TYPES: VCDTKind[] = [
  'WIN_IN_1',
  'WIN_IN_2',
  'LIVE5',
  'CHARGE5',
  'LIVE4',
  'CHARGE4',
  'DOUBLE_FOUR',
  'FOUR_THREE',
  'DOUBLE_THREE',
  'LIVE3',
  'SLEEP3',
  'DEAD4',
  'DEAD5',
];

const isThreatKind = (type: PatternType): type is VCDTKind =>
  type !== 'CONNECT6';

function threatLevelFor(kind: VCDTKind, isWinning: boolean): number {
  if (isWinning) return 0;
  switch (kind) {
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
    case 'CHARGE5':
    case 'LIVE4':
    case 'CHARGE4':
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'DEAD4':
    case 'DEAD5':
    case 'LIVE3':
    case 'SLEEP3':
      return 3;
    case 'WIN_IN_1':
    default:
      return 3;
  }
}

function defenseCostFor(kind: VCDTKind): number {
  switch (kind) {
    case 'WIN_IN_1':
      return 1;
    case 'WIN_IN_2':
      return 1;
    case 'LIVE5':
      return 2;
    case 'CHARGE5':
      return 1;
    case 'LIVE4':
      return 2;
    case 'CHARGE4':
      return 1;
    case 'DOUBLE_FOUR':
    case 'FOUR_THREE':
    case 'DOUBLE_THREE':
      return 2;
    case 'LIVE3':
    case 'SLEEP3':
      return 1;
    case 'DEAD4':
    case 'DEAD5':
      return 1;
    default:
      return 1;
  }
}

function pairKey(a: Position, b: Position): number {
  const base = BOARD_SIZE * BOARD_SIZE;
  const aIdx = posIdx(a.x, a.y);
  const bIdx = posIdx(b.x, b.y);
  return aIdx < bIdx ? aIdx * base + bIdx : bIdx * base + aIdx;
}

function hitToThreat(
  hit: PatternHit,
  seen: Set<string>,
  win2Pairs: Set<number>,
): VCDTThreat[] {
  if (!isThreatKind(hit.type)) return [];

  if (hit.type === 'WIN_IN_2') {
    if (hit.keyPoints.length < 2) return [];
    const [p1, p2] = hit.keyPoints;
    const key = pairKey(p1, p2);
    if (win2Pairs.has(key)) return [];
    win2Pairs.add(key);
    return [
      {
        positions: [p1, p2],
        isWinning: true,
        threatLevel: 1,
        kind: 'WIN_IN_2',
        defenseCost: defenseCostFor('WIN_IN_2'),
      },
    ];
  }

  const key = stableKey(hit);
  if (seen.has(key)) return [];
  seen.add(key);

  const positions = hit.keyPoints.length > 0 ? hit.keyPoints : hit.stones;
  const isWinning = hit.type === 'WIN_IN_1';
  return [
    {
      positions,
      isWinning,
      threatLevel: threatLevelFor(hit.type, isWinning),
      kind: hit.type,
      defenseCost: defenseCostFor(hit.type),
    },
  ];
}

export function detectVCDT(state: GameState, player: Player): VCDTThreat[] {
  const report = analyzeThreatCached(state, player);
  const threats: VCDTThreat[] = [];
  const seen = new Set<string>();
  const win2Pairs = new Set<number>();

  for (const type of VCDT_SCAN_TYPES) {
    const hits = report.byType[type];
    for (const hit of hits) {
      threats.push(...hitToThreat(hit, seen, win2Pairs));
    }
  }

  return threats;
}
