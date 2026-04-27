import { createInitialState } from '../src/core/game_state';
import { analyzeCached, clearThreatCache, getThreatServiceStats } from '../src/core/threat_service';

clearThreatCache();
const state = createInitialState();

analyzeCached(state, 'BLACK');
const afterMiss = getThreatServiceStats();

analyzeCached(state, 'BLACK');
const afterHit = getThreatServiceStats();

if (afterHit.cacheHits <= afterMiss.cacheHits) {
  throw new Error('Expected cacheHits to increase on repeated calls');
}

console.log('threat cache hits ok');
