import React from 'react';
import { BOARD_SIZE } from '../types';  // 导入常量 BOARD_SIZE
import type { Player, Move, GameState } from '../types';  // 导入类型 Player, Move, GameState

interface Props {
  state: GameState;
  onHumanMove: (move: { player: Player; positions: { x: number; y: number }[] }) => void;
  lastAIMove?: Move;
  currentPlayerIsHuman: boolean;
  stonesToPlace: number;  // 新增字段：当前玩家应该下的棋子数
}

export const GameBoard: React.FC<Props> = ({
  state,
  onHumanMove,
  lastAIMove: _lastAIMove, // 保留接口供未来AI落子高亮
  currentPlayerIsHuman,
  stonesToPlace,
}) => {
  const [pendingPositions, setPendingPositions] = React.useState<{ x: number; y: number }[]>([]);

  const handleClick = (x: number, y: number) => {
    if (!currentPlayerIsHuman) return; // 不是你的回合，不能下
    if (state.board[y][x] !== 0) return; // 非空位不能下
    if (state.winner) return; // 已分出胜负

    const next = [...pendingPositions, { x, y }];
    
    // 获取当前回合玩家应该下几个子
    if (next.length < stonesToPlace) {
      // 还没选够这一手的棋子数
      setPendingPositions(next);
    } else {
      // 完成了当前回合的棋子选择，创建 move
      const move: Move = {
        player: state.currentPlayer,
        positions: next, // 当前位置数组
      };
      setPendingPositions([]); // 清空选中的位置
      onHumanMove(move); // 传递给上层组件
    }
  };

  const isPending = (x: number, y: number): boolean =>
    pendingPositions.some(p => p.x === x && p.y === y);

  const renderCell = (x: number, y: number) => {
    const val = state.board[y][x];
    const key = `${x}-${y}`;
    const pending = isPending(x, y);
    // isLastAIStone 可用于高亮AI最后落子，暂未使用

    const borderTop = y === 0 ? 'none' : '1px solid #b88946';
    const borderLeft = x === 0 ? 'none' : '1px solid #b88946';
    const borderRight = x === BOARD_SIZE - 1 ? 'none' : '1px solid #b88946';
    const borderBottom = y === BOARD_SIZE - 1 ? 'none' : '1px solid #b88946';

    let stone: React.ReactNode = null;
    if (val === 1) {
      // 黑子
      stone = (
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            boxShadow: '0 1px 4px rgba(0,0,0,0.9)',
            background:
              'radial-gradient(circle at 30% 30%, #555, #050505 70%, #000 100%)',
          }}
        />
      );
    } else if (val === 2) {
      // 白子
      stone = (
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            background:
              'radial-gradient(circle at 30% 30%, #ffffff, #e5e5e5 70%, #d0d0d0 100%)',
          }}
        />
      );
    } else if (pending) {
      // 当前临时选择的位置（蓝色小点）
      stone = (
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#2563eb',
            opacity: 0.75,
          }}
        />
      );
    }

    return (
      <div
        key={key}
        onClick={() => handleClick(x, y)}
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          borderTop,
          borderLeft,
          borderRight,
          borderBottom,
          cursor: currentPlayerIsHuman && !state.winner ? 'pointer' : 'default',
        }}
      >
        {stone}
      </div>
    );
  };

  return (
    <div
      style={{
        position: 'relative',
        padding: 10,
        background:
          'radial-gradient(circle at 20% 20%, #fce3b0, #e1b97f 50%, #c89b5d 100%)',
        borderRadius: 16,
        boxShadow: 'inset 0 0 4px rgba(0,0,0,0.35)',
      }}
    >
      <div
        style={{
          borderRadius: 12,
          overflow: 'hidden',
          border: '2px solid #7c5a2b',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${BOARD_SIZE}, 28px)`,
            gridTemplateRows: `repeat(${BOARD_SIZE}, 28px)`,
          }}
        >
          {Array.from({ length: BOARD_SIZE }).map((_, y) =>
            Array.from({ length: BOARD_SIZE }).map((_, x) =>
              renderCell(x, y),
            ),
          )}
        </div>
      </div>
    </div>
  );
};
