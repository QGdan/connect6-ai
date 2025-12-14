import type { GameState, Move, Player, Position } from '../types';
import { BOARD_SIZE } from '../types';

function centerPosition(): Position {
  const c = Math.floor(BOARD_SIZE / 2);
  return { x: c, y: c };
}

export function getOpeningMove(
  state: GameState,
  player: Player,
): Move | null {
  // 只在整盘第一手 && 黑先 时使用
  if (state.moveNumber !== 0) return null;
  if (player !== 'BLACK') return null;

  // 保险起见：检查棋盘是不是空的
  const hasStone = state.board.some(row => row.some(c => c !== 0));
  if (hasStone) return null;

  const pos = centerPosition();
  if (state.board[pos.y][pos.x] !== 0) {
    // 极端情况：中心被写坏了，就放弃开局库
    return null;
  }

  return {
    player: 'BLACK',
    positions: [pos], // ★ 首手 1 子
  };
}
