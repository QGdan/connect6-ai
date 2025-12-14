// src/ui/AIAnalysisPanel.tsx
import React from 'react';
import type { Player } from '../types';

export interface AIHistoryItem {
  moveIndex: number;
  player: Player;
  score: number;
  thinkTimeMs: number;
  // 搜索细节（可选）
  engineLabel?: string;
  searchDepth?: number;
  nodes?: number;
  usedVcdt?: boolean;
}

interface Props {
  history: AIHistoryItem[];
}

export const AIAnalysisPanel: React.FC<Props> = ({ history }) => {
  if (history.length === 0) {
    return (
      <div
        style={{
          borderRadius: 16,
          background: 'rgba(255,255,255,0.95)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
          padding: 10,
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: '4px 0 8px' }}>AI 实时形势评估</h3>
        <div style={{ color: '#666' }}>还没有 AI 落子数据。</div>
      </div>
    );
  }

  const maxAbsScore = Math.max(
    ...history.map(h => Math.abs(h.score) || 1),
  );

  return (
    <div
      style={{
        borderRadius: 16,
        background: 'rgba(255,255,255,0.95)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
        padding: 10,
        fontSize: 13,
      }}
    >
      <h3 style={{ margin: '4px 0 8px' }}>AI 实时形势评估</h3>

      {/* 简易条形图 */}
      <div
        style={{
          height: 120,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 4,
          padding: '4px 0',
          borderBottom: '1px solid #eee',
          marginBottom: 8,
          overflowX: 'auto',
        }}
      >
        {history.map(item => {
          const ratio = Math.min(
            Math.abs(item.score) / maxAbsScore,
            1,
          );
          const height = 20 + ratio * 80; // 20~100 像素
          const isBlack = item.player === 'BLACK';

          const titleParts = [
            `第 ${item.moveIndex} 手（${isBlack ? '黑' : '白'}）`,
            `score=${item.score.toFixed(1)}`,
            `time=${item.thinkTimeMs.toFixed(1)}ms`,
          ];
          if (item.engineLabel) {
            titleParts.push(`engine=${item.engineLabel}`);
          }
          if (item.searchDepth != null) {
            titleParts.push(`depth=${item.searchDepth}`);
          }
          if (item.usedVcdt) {
            titleParts.push('VCDT');
          }

          return (
            <div
              key={item.moveIndex}
              title={titleParts.join(' | ')}
              style={{
                width: 10,
                height,
                borderRadius: 4,
                background: isBlack ? '#111827' : '#e5e7eb',
              }}
            />
          );
        })}
      </div>

      {/* 最近几步列表 */}
      <div style={{ maxHeight: '40vh', overflowY: 'auto' }}>
        {history
          .slice()
          .reverse()
          .slice(0, 10)
          .map(item => (
            <div
              key={item.moveIndex}
              style={{
                padding: '2px 0',
                borderBottom: '1px dashed #eee',
              }}
            >
              <span>
                第 {item.moveIndex} 手（
                {item.player === 'BLACK' ? '黑' : '白'}
                ）：
              </span>
              <span style={{ marginLeft: 4 }}>
                评分 {item.score.toFixed(1)}
              </span>
              <span style={{ marginLeft: 8, color: '#666' }}>
                {item.thinkTimeMs.toFixed(1)} ms
              </span>

              {item.engineLabel && (
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: '#888',
                  }}
                >
                  引擎：{item.engineLabel}
                  {item.searchDepth != null && ` ｜ 深度 ${item.searchDepth}`}
                  {item.nodes != null && ` ｜ 节点 ${item.nodes}`}
                  {item.usedVcdt && ' ｜ VCDT 强制解'}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
};
