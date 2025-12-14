import type { Cell, GameState, Move, Player } from '../types';
import { cloneState, BOARD_SIZE } from './game_state';

// 用来找 6 连子的四个方向
const DIRS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

// ✅ 规则函数：当前这一手应该下几子
// 约定：moveNumber 表示“已经下了多少手”
// - 开局：createInitialState() 时 moveNumber = 0，currentPlayer = BLACK
// - BLACK 落完首手（1 子）后：moveNumber = 1，currentPlayer = WHITE
// - 之后每手：moveNumber = 2,3,4,...，每手都 2 子
export function getStonesToPlace(moveNumber: number, _player: Player): number {
  if (moveNumber === 0) {
    // 首手：黑 1 子
    return 1;
  }
  // 之后所有手：2 子
  return 2;
}

// 检查是否有一方已经 6 连（或以上），或平局
export function checkWinner(state: GameState): Player | 'DRAW' | undefined {
  const board = state.board;

  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      const cell = board[y][x];
      if (cell === 0) continue;

      for (const { dx, dy } of DIRS) {
        let count = 1;
        let nx = x + dx;
        let ny = y + dy;
        while (
          nx >= 0 &&
          nx < BOARD_SIZE &&
          ny >= 0 &&
          ny < BOARD_SIZE &&
          board[ny][nx] === cell
        ) {
          count++;
          nx += dx;
          ny += dy;
        }
        if (count >= 6) {
          return cell === 1 ? 'BLACK' : 'WHITE';
        }
      }
    }
  }

  // 检查是否平局：无空位
  let hasEmpty = false;
  for (let y = 0; y < BOARD_SIZE && !hasEmpty; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] === 0) {
        hasEmpty = true;
        break;
      }
    }
  }

  if (!hasEmpty) return 'DRAW';
  return undefined;
}

// 带规则校验 + 胜负判定的落子
export function applyMoveWithWinner(state: GameState, move: Move): GameState {
  const next = cloneState(state);

  // 1. 检查该谁下
  if (move.player !== state.currentPlayer) {
    // 这里用 throw 更严格，如果你不想页面崩，可以改成 console.error 后 return state
    throw new Error(
      `当前应由 ${state.currentPlayer} 落子，但收到 ${move.player} 的落子`,
    );
  }

  // 2. 校验本手应该下几子
  const required = getStonesToPlace(state.moveNumber, move.player);
  if (move.positions.length !== required) {
    throw new Error(
      `本手应下 ${required} 子，但实际下了 ${move.positions.length} 子`,
    );
  }

  // 3. 检查位置是否为空
  const value: Cell = move.player === 'BLACK' ? 1 : 2;
  for (const pos of move.positions) {
    const { x, y } = pos;
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      throw new Error(`落子越界: (${x}, ${y})`);
    }
    if (next.board[y][x] !== 0) {
      throw new Error(`位置 (${x}, ${y}) 已经有棋子，不能重复落子`);
    }
  }

  // 4. 真正落子
  for (const pos of move.positions) {
    next.board[pos.y][pos.x] = value;
  }

  // 5. 更新状态：最近一手、当前玩家、手数
  next.lastMove = move;
  next.currentPlayer = move.player === 'BLACK' ? 'WHITE' : 'BLACK';
  next.moveNumber += 1;

  // 6. 判断胜负
  const winner = checkWinner(next);
  if (winner) {
    next.winner = winner;
  }

  return next;
}
