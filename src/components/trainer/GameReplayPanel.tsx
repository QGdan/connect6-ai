import { useEffect, useMemo, useState } from 'react';

import type { GameSample } from '../../types/trainer';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

const BOARD_SIZE = 19;

type Stone = { x: number; y: number; color: 'BLACK' | 'WHITE' };

const buildBoard = (moves: GameSample['moves'], ply: number) => {
  const stones: Stone[] = [];
  for (let i = 0; i < ply; i += 1) {
    stones.push(...moves[i].stones);
  }
  return stones;
};

export function GameReplayPanel({ samples }: { samples: GameSample[] }) {
  const [activeId, setActiveId] = useState(samples[0]?.id ?? '');
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const active = samples.find(sample => sample.id === activeId) ?? samples[0];
  const sourceLabel = active
    ? active.source === 'selfplay'
      ? '自对弈'
      : '评测'
    : '未知';
  const resultLabel = active
    ? active.result === 'BLACK'
      ? '黑胜'
      : active.result === 'WHITE'
      ? '白胜'
      : '和局'
    : '未知';

  useEffect(() => {
    setPly(0);
  }, [activeId]);

  useEffect(() => {
    if (samples.length === 0) {
      setActiveId('');
      return;
    }
    if (!samples.find(sample => sample.id === activeId)) {
      setActiveId(samples[0].id);
    }
  }, [samples, activeId]);

  useEffect(() => {
    if (!playing || !active) return;
    const timer = setInterval(() => {
      setPly(prev => {
        const next = Math.min(active.moves.length, prev + 1);
        if (next >= active.moves.length) {
          setPlaying(false);
        }
        return next;
      });
    }, 600);
    return () => clearInterval(timer);
  }, [playing, active]);

  const stones = useMemo(() => (active ? buildBoard(active.moves, ply) : []), [active, ply]);
  const heatmap = active?.policyHeatmaps?.[Math.max(0, ply - 1)];

  if (!active) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>对局回放</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无对局样本。
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <CardTitle>对局回放</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={activeId} onValueChange={setActiveId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="选择对局" />
            </SelectTrigger>
            <SelectContent>
              {samples.map(sample => (
                <SelectItem key={sample.id} value={sample.id}>
                  {sample.id} | {sample.source === 'selfplay' ? '自对弈' : '评测'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {resultLabel} · {sourceLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[auto,1fr]">
        <div className="flex flex-col items-center gap-3">
          <div
            className="grid rounded-lg border bg-amber-100 p-2 shadow-sm"
            style={{
              gridTemplateColumns: `repeat(${BOARD_SIZE}, minmax(0, 1fr))`,
              gap: '2px',
            }}
          >
            {Array.from({ length: BOARD_SIZE * BOARD_SIZE }).map((_, index) => {
              const x = index % BOARD_SIZE;
              const y = Math.floor(index / BOARD_SIZE);
              const stone = stones.find(item => item.x === x && item.y === y);
              const heat = heatmap?.[y]?.[x] ?? 0;
              return (
                <div
                  key={`${x}-${y}`}
                  className="relative h-5 w-5 rounded-sm bg-amber-300"
                >
                  {heat > 0 && (
                    <div
                      className="absolute inset-0 rounded-sm"
                      style={{
                        background: `hsla(var(--chart-5), ${heat * 0.45})`,
                      }}
                    />
                  )}
                  {stone && (
                    <div
                      className={[
                        'absolute inset-0 m-auto h-3.5 w-3.5 rounded-full shadow',
                        stone.color === 'BLACK'
                          ? 'bg-slate-900'
                          : 'border border-slate-300 bg-slate-50',
                      ].join(' ')}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <div className="text-xs text-muted-foreground">
            手数 {ply} / {active?.moves.length ?? 0}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setPly(Math.max(0, ply - 1))}>
              上一步
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPly(Math.min(active.moves.length, ply + 1))}>
              下一步
            </Button>
            <Button size="sm" onClick={() => setPlaying(prev => !prev)}>
              {playing ? '暂停' : '自动播放'}
            </Button>
            <Input
              className="w-24"
              type="number"
              min={0}
              max={active?.moves.length ?? 0}
              value={ply}
              onChange={event => setPly(Number(event.target.value))}
            />
          </div>

          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="text-muted-foreground">元数据</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>开局</div>
              <div className="font-medium">{active?.meta.openingId}</div>
              <div>随机种子</div>
              <div className="font-medium">{active?.meta.seed}</div>
              <div>来源</div>
              <div className="font-medium">{sourceLabel}</div>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="text-muted-foreground">关键节点</div>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>第 4 手形成关键分叉。</li>
              <li>第 7 手对手超时。</li>
              <li>热力叠加显示策略偏好。</li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
