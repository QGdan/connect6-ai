import { createInitialState } from '../src/core/game_state.ts';
import { generateRZOPCandidates } from '../src/core/rzop.ts';
import { analyzeBothSidesCached } from '../src/core/threat_service.ts';
import { detectVCDT } from '../src/core/vcdt.ts';
import { Connect6AI } from '../src/core/connect6_ai.ts';
import { formatBoardCoordTuple } from '../src/core/board_coords.ts';

function formatMove(positions: Array<{ x: number; y: number }>): string {
  if (positions.length === 0) return '(none)';
  return positions.map(p => `(${formatBoardCoordTuple(p)})`).join(' ');
}

async function main() {
  const state = createInitialState();
  const candidates = generateRZOPCandidates(state);
  const { my, opp } = analyzeBothSidesCached(state, state.currentPlayer);
  const threatPatternsCount = my.patterns.length + opp.patterns.length;
  detectVCDT(state, state.currentPlayer);

  const ai = new Connect6AI('fast');
  const move = await ai.get_best_move(state, 80);

  console.log(`candidates: ${candidates.length}`);
  console.log(`threat patterns: ${threatPatternsCount}`);
  console.log(`chosen move: ${formatMove(move.positions)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
