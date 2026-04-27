import { createInitialState } from '../src/core/game_state.ts';
import { applyMoveWithWinner, getStonesToPlace } from '../src/core/rules.ts';
import { analyzeBothSidesCached, clearThreatCache } from '../src/core/threat_service.ts';
import { posIdx } from '../src/core/pos_key.ts';
import type { Move, Player, Position } from '../src/types.ts';

type StoneToken = { player: Player; pos: Position };

function parseMoves(raw: string): Move[] {
  const tokens = raw
    .split(';')
    .map(token => token.trim())
    .filter(Boolean);

  const stones: StoneToken[] = [];
  for (const token of tokens) {
    const match = token.match(/^([BW])\(([A-S]),(\d{1,2})\)$/i);
    if (!match) continue;
    const player = match[1].toUpperCase() === 'B' ? 'BLACK' : 'WHITE';
    const x = match[2].toUpperCase().charCodeAt(0) - 65;
    const y = Number(match[3]) - 1;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    stones.push({ player, pos: { x, y } });
  }

  const moves: Move[] = [];
  let current: Move | null = null;
  for (const stone of stones) {
    if (!current || current.player !== stone.player) {
      if (current) moves.push(current);
      current = { player: stone.player, positions: [stone.pos] };
    } else {
      current.positions.push(stone.pos);
    }
  }
  if (current) moves.push(current);
  return moves;
}

function formatPos(pos: Position): string {
  const letter = String.fromCharCode(65 + pos.x);
  return `${letter}${pos.y + 1}`;
}

function formatMove(move: Move): string {
  const p = move.positions.map(formatPos).join(' ');
  return `${move.player === 'BLACK' ? 'B' : 'W'} ${p}`;
}

function analyzeKifu(raw: string): void {
  const moves = parseMoves(raw);
  if (moves.length === 0) {
    console.error('No moves parsed.');
    return;
  }

  let state = createInitialState();
  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    const required = getStonesToPlace(state.moveNumber, state.currentPlayer);
    if (move.player !== state.currentPlayer) {
      console.warn(`Turn ${i + 1}: unexpected player ${move.player}`);
    }
    if (move.positions.length !== required) {
      console.warn(
        `Turn ${i + 1}: expected ${required} stones, got ${move.positions.length}`,
      );
    }

    clearThreatCache();
    const { opp } = analyzeBothSidesCached(state, state.currentPlayer);
    const isWhiteTurn = state.currentPlayer === 'WHITE';
    if (isWhiteTurn) {
      const moveSet = new Set(move.positions.map(p => posIdx(p.x, p.y)));
      const missWin1 = opp.winIn1.filter(
        p => !moveSet.has(posIdx(p.x, p.y)),
      );
      const missWin2 = opp.winIn2.filter(([a, b]) => {
        const aKey = posIdx(a.x, a.y);
        const bKey = posIdx(b.x, b.y);
        return !moveSet.has(aKey) && !moveSet.has(bKey);
      });
      const oppLive4 = opp.byType.LIVE4.length;
      const oppDoubleFour = opp.byType.DOUBLE_FOUR.length;
      const oppFourThree = opp.byType.FOUR_THREE.length;

      if (
        opp.winIn1.length > 0 ||
        opp.winIn2.length > 0 ||
        oppLive4 > 0 ||
        oppDoubleFour > 0 ||
        oppFourThree > 0
      ) {
        console.log(`Turn ${i + 1} (WHITE) pre-threats:`);
        console.log(`  winIn1: ${opp.winIn1.map(formatPos).join(' ') || 'none'}`);
        console.log(
          `  winIn2: ${opp.winIn2
            .map(pair => `${formatPos(pair[0])}/${formatPos(pair[1])}`)
            .join(' ') || 'none'}`,
        );
        console.log(
          `  live4: ${oppLive4} double4: ${oppDoubleFour} four3: ${oppFourThree}`,
        );
        if (missWin1.length > 0 || missWin2.length > 0) {
          console.log(
            `  move ${formatMove(move)} missed win points:`,
            missWin1.map(formatPos).join(' ') || 'none',
            missWin2.length > 0 ? `(win2 pairs left: ${missWin2.length})` : '',
          );
        }
      }
    }

    state = applyMoveWithWinner(state, move);

    clearThreatCache();
    const { my: afterMy } = analyzeBothSidesCached(
      state,
      state.currentPlayer,
    );
    if (move.player === 'WHITE') {
      const oppLive4 = afterMy.byType.LIVE4.length;
      const oppDoubleFour = afterMy.byType.DOUBLE_FOUR.length;
      const oppFourThree = afterMy.byType.FOUR_THREE.length;
      if (
        afterMy.winIn1.length > 0 ||
        afterMy.winIn2.length > 0 ||
        oppLive4 > 0 ||
        oppDoubleFour > 0 ||
        oppFourThree > 0
      ) {
        console.log(`Turn ${i + 1} (WHITE) post-threats:`);
        console.log(
          `  winIn1: ${afterMy.winIn1.map(formatPos).join(' ') || 'none'}`,
        );
        console.log(
          `  winIn2: ${afterMy.winIn2
            .map(pair => `${formatPos(pair[0])}/${formatPos(pair[1])}`)
            .join(' ') || 'none'}`,
        );
        console.log(
          `  live4: ${oppLive4} double4: ${oppDoubleFour} four3: ${oppFourThree}`,
        );
      }
    }

    if (state.winner) {
      console.log(`Winner after turn ${i + 1}: ${state.winner}`);
      break;
    }
  }
}

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  console.error('Usage: tsx scripts/kifu_analysis.ts "B(H,10);W(I,11);..."');
  process.exit(1);
}

analyzeKifu(input);
