import React from 'react';
import type{ GameState, Player } from '../types';
import { getAllRoads } from '../core/road_encoding';

interface RoadmapProps {
  state: GameState;
  focusPlayer: Player;
}

export const Roadmap: React.FC<RoadmapProps> = ({ state, focusPlayer }) => {
  const roads = getAllRoads();
  const myVal = focusPlayer === 'BLACK' ? 1 : 2;

  const roadScores = roads.map(road => {
    let count = 0;
    for (const p of road.cells) {
      if (state.board[p.y][p.x] === myVal) count++;
    }
    return { road, count };
  });

  roadScores.sort((a, b) => b.count - a.count);
  const top = roadScores.slice(0, 8).filter(r => r.count > 0);

  return (
    <div style={{ padding: 8 }}>
      <h3>当前局面关键“路”概览</h3>
      {top.length === 0 && <div>当前还没有明显的成型“路”。</div>}
      {top.map((r, idx) => (
        <div key={idx} style={{ marginBottom: 4 }}>
          <div>
            路 {idx + 1}：已有 {r.count} 子
          </div>
          <div style={{ fontSize: 12, color: '#666' }}>
            {r.road.cells.map(c => `(${c.x},${c.y})`).join(' - ')}
          </div>
        </div>
      ))}
    </div>
  );
};
