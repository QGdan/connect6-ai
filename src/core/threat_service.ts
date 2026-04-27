import type { GameState, Player } from '../types';
import { analyzeThreats, mergeThreatReports } from './threat_analyzer';
import type { ThreatReport } from './pattern_library';

export type { ThreatReport } from './pattern_library';

const THREAT_CACHE_LIMIT = 50_000;
const THREAT_CACHE_EVICT_BATCH = Math.max(1000, Math.floor(THREAT_CACHE_LIMIT * 0.05));
const threatCacheBlack = new Map<bigint, ThreatReport>();
const threatCacheWhite = new Map<bigint, ThreatReport>();

let analyzeCalls = 0;
let cacheHits = 0;
let cacheMisses = 0;

function cacheFor(player: Player): Map<bigint, ThreatReport> {
  return player === 'BLACK' ? threatCacheBlack : threatCacheWhite;
}

function otherPlayer(p: Player): Player {
  return p === 'BLACK' ? 'WHITE' : 'BLACK';
}

function touchCache(cache: Map<bigint, ThreatReport>, hash: bigint, report: ThreatReport): void {
  cache.delete(hash);
  cache.set(hash, report);
}

function trimCache(cache: Map<bigint, ThreatReport>): void {
  if (cache.size <= THREAT_CACHE_LIMIT) return;
  const toDelete = Math.min(
    cache.size - THREAT_CACHE_LIMIT,
    THREAT_CACHE_EVICT_BATCH,
  );
  const it = cache.keys();
  for (let i = 0; i < toDelete; i++) {
    const next = it.next();
    if (next.done) break;
    cache.delete(next.value);
  }
}

function getCachedReport(state: GameState, player: Player): ThreatReport {
  const cache = cacheFor(player);
  const hash = state.zobristHash;
  const hit = cache.get(hash);
  if (hit) {
    cacheHits += 1;
    touchCache(cache, hash, hit);
    return hit;
  }

  cacheMisses += 1;
  const report = analyzeThreats(state, player);
  analyzeCalls += 1;
  cache.set(hash, report);

  trimCache(cache);

  return report;
}

export function analyzeCached(
  state: GameState,
  playerToMove: Player,
): ThreatReport {
  return getCachedReport(state, playerToMove);
}

export function analyzeBothCached(
  state: GameState,
  playerToMove: Player,
): { my: ThreatReport; opp: ThreatReport; merged: ThreatReport } {
  const my = getCachedReport(state, playerToMove);
  const opp = getCachedReport(state, otherPlayer(playerToMove));
  const merged = mergeThreatReports(my, opp);
  return { my, opp, merged };
}

export function analyzeThreatCached(
  state: GameState,
  playerToMove: Player,
): ThreatReport {
  return analyzeCached(state, playerToMove);
}

export function analyzeBothSidesCached(
  state: GameState,
  playerToMove: Player,
): { my: ThreatReport; opp: ThreatReport } {
  const { my, opp } = analyzeBothCached(state, playerToMove);
  return { my, opp };
}

export function clearThreatCache(): void {
  threatCacheBlack.clear();
  threatCacheWhite.clear();
  analyzeCalls = 0;
  cacheHits = 0;
  cacheMisses = 0;
}

export function getThreatServiceStats(): {
  cacheSize: number;
  analyzeCalls: number;
  cacheHits: number;
  cacheMisses: number;
} {
  const cacheSize = threatCacheBlack.size + threatCacheWhite.size;
  return {
    cacheSize,
    analyzeCalls,
    cacheHits,
    cacheMisses,
  };
}
