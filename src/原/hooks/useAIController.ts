// src/hooks/useAIController.ts
import { useEffect, useMemo, useState, useCallback } from 'react';
import { GameState, Move, Player } from '../game/types';
import { AIEngine, AIEngineConfig, createAIEngine } from '../ai/ai_engine';

interface UseAIControllerOptions {
  aiPlayer: Player;
  initialConfig?: AIEngineConfig;
}

export const useAIController = (options: UseAIControllerOptions) => {
  const { aiPlayer, initialConfig } = options;

  const [config, setConfig] = useState<AIEngineConfig>(
    initialConfig ?? { type: 'HYBRID', timeLimitMs: 500 }
  );
  const [isAIThinking, setIsAIThinking] = useState(false);
  const [lastAIMove, setLastAIMove] = useState<Move | undefined>();

  const engine: AIEngine = useMemo(() => {
    return createAIEngine(config);
    // 注意：如果 engine 里有重资源，可以再加 dispose 逻辑
  }, [config]);

  useEffect(() => {
    return () => {
      engine.dispose?.();
    };
  }, [engine]);

  const requestAIMove = useCallback(
    async (state: GameState): Promise<Move> => {
      if (state.currentPlayer !== aiPlayer) {
        throw new Error('Not AI turn');
      }
      setIsAIThinking(true);
      try {
        const move = await engine.getMove(state);
        setLastAIMove(move);
        return move;
      } finally {
        setIsAIThinking(false);
      }
    },
    [engine, aiPlayer]
  );

  return {
    config,
    setConfig,
    requestAIMove,
    isAIThinking,
    lastAIMove,
  };
};
