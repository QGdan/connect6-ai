import React from 'react';
import type{ PerformanceStats } from '../types';

interface ReportProps {
  stats: PerformanceStats;
}

export const ReportGenerator: React.FC<ReportProps> = ({ stats }) => {
  return (
    <div style={{ padding: 8 }}>
      <h3>AI 性能 / 体验指标</h3>
      <ul>
        <li>平均思考时间：{stats.avgThinkTimeMs.toFixed(1)} ms</li>
        <li>最大思考时间：{stats.maxThinkTimeMs.toFixed(1)} ms</li>
        <li>平均搜索深度：{stats.searchDepthAvg.toFixed(1)} 层</li>
        <li>
          威胁识别准确度（自测）：
          {(stats.threatDetectionAccuracy * 100).toFixed(1)}%
        </li>
      </ul>
    </div>
  );
};
