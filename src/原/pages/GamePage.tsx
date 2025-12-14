// src/pages/GamePage.tsx
import React from 'react';
import { useGameController } from '../hooks/useGameController';
import { Player } from '../game/types';
import { GameBoard } from '../components/GameBoard';
import { AIAnalysisPanel } from '../components/AIAnalysisPanel';
import { ReportGenerator } from '../components/ReportGenerator';
import { Roadmap } from '../components/Roadmap';

export const GamePage: React.FC = () => {
  // 这些可以做成 state + 配置面板，这里先写死
  const humanPlayer: Player = 'BLACK';
  const aiPlayer: Player = 'WHITE';

  const {
    state,
    resetGame,
    handleHumanMove,
    isAIThinking,
    lastAIMove,
  } = useGameController({ humanPlayer, aiPlayer });

  return (
    <div className="game-layout">
      {/* 左侧：棋盘区域 */}
      <section className="game-layout__left">
        {/* 顶部可以放简单状态提示/按钮 */}
        <div className="game-header">
          <span>当前轮到：{state.currentPlayer === humanPlayer ? '你' : 'AI'}</span>
          <button onClick={resetGame}>重新开局</button>
        </div>

        <GameBoard
          state={state}
          onHumanMove={move => handleHumanMove(move.positions)}
          lastAIMove={lastAIMove}
          currentPlayerIsHuman={state.currentPlayer === humanPlayer}
          stonesToPlace={state.stonesToPlace}
        />
      </section>

      {/* 中间：AI 计划 / Roadmap */}
      <section className="game-layout__center">
        <Roadmap /* 传入你已有的 roadmap 数据 */ />
      </section>

      {/* 右侧：分析 & 报告 */}
      <section className="game-layout__right">
        <AIAnalysisPanel /* 传入 state / ai 分析结果等 */ />
        <ReportGenerator /* 传入性能统计 */ />
      </section>
    </div>
  );
};
