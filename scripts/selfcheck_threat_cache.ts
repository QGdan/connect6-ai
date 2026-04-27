import { createEmptyBoard } from '../src/core/game_state';
import {
  analyzeCached,
  clearThreatCache,
  getThreatServiceStats,
} from '../src/core/threat_service';
import type { GameState } from '../src/types';

function makeState(): GameState {
  return {
    board: createEmptyBoard(),
    currentPlayer: 'BLACK',
    moveNumber: 0,
    lastMove: undefined,
    winner: undefined,
    zobristHash: 0n,
  };
}

clearThreatCache();
const state = makeState();

for (let i = 0; i < 100; i += 1) {
  analyzeCached(state, 'BLACK');
}

const stats = getThreatServiceStats();
if (stats.analyzeCalls !== 1) {
  throw new Error(
    `expected 1 analyze call after 100 cached runs, got ${stats.analyzeCalls}`,
  );
}

console.log('selfcheck_threat_cache: OK');
