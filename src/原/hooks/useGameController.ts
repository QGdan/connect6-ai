// src/hooks/useGameController.ts
import { useState, useCallback } from 'react';
import { GameState, Player } from '../game/types';
import { createInitialState, applyHumanMove, applyAIMove } from '../game/game_state';
import { useAIController } from './useAIController';

export interface UseGameControllerOptions {
  humanPlayer: Player;
  aiPlayer: Player;
  // 之后可以加：棋盘尺寸、开局方式等
}

export const useGameController = (options: UseGameControllerOptions) => {
  const { humanPlayer, aiPlayer } = options;

  const [state, setState] = useState<GameState>(() =>
    createInitialState({ humanPlayer, aiPlayer })
  );

  const { requestAIMove, isAIThinking, lastAIMove } = useAIController({
    aiPlayer,
  });

  const resetGame = useCallback(() => {
    setState(createInitialState({ humanPlayer, aiPlayer }));
  }, [humanPlayer, aiPlayer]);

  const handleHumanMove = useCallback(
    async (positions: { x: number; y: number }[]) => {
      // 1. 应用人类落子（内部会做规则校验、胜负判定）
      setState(prev => applyHumanMove(prev, positions));

      // 2. 检查是否游戏结束
      setState(prev => {
        if (prev.status === 'FINISHED') return prev;
        return prev;
      });

      // 3. 如果轮到 AI，则请求 AI 行棋
      setState(prev => {
        if (prev.currentPlayer === aiPlayer && prev.status === 'PLAYING') {
          requestAIMove(prev).then(move => {
            setState(s => applyAIMove(s, move));
          });
        }
        return prev;
      });
    },
    [aiPlayer, requestAIMove]
  );

  return {
    state,
    resetGame,
    handleHumanMove,
    isAIThinking,
    lastAIMove,
  };
};
