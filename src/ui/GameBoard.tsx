import React from 'react';
import { BOARD_SIZE } from '../types';
import type { Player, Move, GameState, Position } from '../types';
import { colFromX, rowFromY } from '../core/board_coords';

interface Props {
  state: GameState;
  onHumanMove: (move: { player: Player; positions: { x: number; y: number }[] }) => void;
  lastAIMove?: Move;
  currentPlayerIsHuman: boolean;
  stonesToPlace: number;  // 新增字段：当前玩家应该下的棋子数
  suggestedPoints?: Position[];
  mctsSuggestedPoints?: Position[];
}

export const GameBoard: React.FC<Props> = ({
  state,
  onHumanMove,
  lastAIMove,
  currentPlayerIsHuman,
  stonesToPlace,
  suggestedPoints,
  mctsSuggestedPoints,
}) => {
  const [pendingPositions, setPendingPositions] = React.useState<{ x: number; y: number }[]>([]);
  const lastAIMoveSet = React.useMemo(() => {
    if (!lastAIMove) return new Set<number>();
    return new Set(lastAIMove.positions.map(p => p.y * BOARD_SIZE + p.x));
  }, [lastAIMove]);
  const suggestedSet = React.useMemo(() => {
    if (!suggestedPoints || suggestedPoints.length === 0) return new Set<number>();
    return new Set(suggestedPoints.map(p => p.y * BOARD_SIZE + p.x));
  }, [suggestedPoints]);
  const mctsSuggestedSet = React.useMemo(() => {
    if (!mctsSuggestedPoints || mctsSuggestedPoints.length === 0) return new Set<number>();
    return new Set(mctsSuggestedPoints.map(p => p.y * BOARD_SIZE + p.x));
  }, [mctsSuggestedPoints]);

  React.useEffect(() => {
    setPendingPositions([]);
  }, [state.moveNumber, state.currentPlayer, state.winner, currentPlayerIsHuman]);

  const handleClick = (x: number, y: number) => {
    if (!currentPlayerIsHuman) return; // 不是你的回合，不能下
    if (state.board[y][x] !== 0) return; // 非空位不能下
    if (state.winner) return; // 已分出胜负
    if (pendingPositions.some(p => p.x === x && p.y === y)) return; // 同一位置只能选一次

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

  const isLastAIStone = (x: number, y: number): boolean =>
    lastAIMoveSet.has(y * BOARD_SIZE + x);

  const isSuggested = (x: number, y: number): boolean =>
    suggestedSet.has(y * BOARD_SIZE + x);
  const isMctsSuggested = (x: number, y: number): boolean =>
    mctsSuggestedSet.has(y * BOARD_SIZE + x);

  const colLabel = (x: number): string => {
    return colFromX(x);
  };

  const renderCell = (x: number, y: number) => {
    const val = state.board[y][x];
    const key = `${x}-${y}`;
    const pending = isPending(x, y);
    const lastAIStone = isLastAIStone(x, y);
    const mctsSuggested = isMctsSuggested(x, y) && val === 0 && !pending;
    const suggested =
      !mctsSuggested && isSuggested(x, y) && val === 0 && !pending;

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
        {mctsSuggested && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: 20,
              height: 20,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
            }}
          >
            <div className="c6-mcts-pulse" />
            <div className="c6-mcts-dot" />
          </div>
        )}
        {suggested && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: 18,
              height: 18,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
            }}
          >
            <div className="c6-suggest-pulse" />
            <div className="c6-suggest-dot" />
          </div>
        )}
        {lastAIStone && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: 24,
              height: 24,
              borderRadius: '50%',
              border: '2px solid #ef4444',
              boxShadow: '0 0 6px rgba(239,68,68,0.6)',
              boxSizing: 'border-box',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    );
  };

  const labelStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    color: '#5a3b14',
    fontWeight: 600,
    userSelect: 'none',
    pointerEvents: 'none',
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
      <style>
        {`
        @keyframes c6SuggestPulse {
          0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.55; }
          70% { transform: translate(-50%, -50%) scale(1.7); opacity: 0; }
          100% { opacity: 0; }
        }
        .c6-suggest-pulse {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 2px solid rgba(245, 158, 11, 0.7);
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.35);
          animation: c6SuggestPulse 1.6s ease-out infinite;
        }
        .c6-suggest-dot {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(245, 158, 11, 0.6);
          box-shadow: 0 0 8px rgba(245, 158, 11, 0.75);
          transform: translate(-50%, -50%);
        }
        @keyframes c6MctsPulse {
          0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.6; }
          70% { transform: translate(-50%, -50%) scale(1.8); opacity: 0; }
          100% { opacity: 0; }
        }
        .c6-mcts-pulse {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 20px;
          height: 20px;
          border-radius: 50%;
          border: 2px solid rgba(56, 189, 248, 0.7);
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.45);
          animation: c6MctsPulse 1.8s ease-out infinite;
        }
        .c6-mcts-dot {
          position: absolute;
          top: 50%;
          left: 50%;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: rgba(56, 189, 248, 0.6);
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.75);
          transform: translate(-50%, -50%);
        }
      `}
      </style>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `28px repeat(${BOARD_SIZE}, 28px)`,
          gridTemplateRows: `repeat(${BOARD_SIZE}, 28px) 28px`,
          alignItems: 'center',
        }}
      >
        {Array.from({ length: BOARD_SIZE }).map((_, x) => (
          <div
            key={`label-col-${x}`}
            style={{
              ...labelStyle,
              gridRow: BOARD_SIZE + 1,
              gridColumn: x + 2,
            }}
          >
            {colLabel(x)}
          </div>
        ))}
        {Array.from({ length: BOARD_SIZE }).map((_, y) => (
          <div
            key={`label-row-${y}`}
            style={{ ...labelStyle, gridRow: y + 1, gridColumn: 1 }}
          >
            {rowFromY(y)}
          </div>
        ))}
        <div
          style={{
            gridRow: `1 / ${BOARD_SIZE + 1}`,
            gridColumn: `2 / ${BOARD_SIZE + 2}`,
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
    </div>
  );
};
