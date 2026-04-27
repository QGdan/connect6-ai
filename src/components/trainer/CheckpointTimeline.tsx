import { useMemo, useState } from 'react';

import type { Checkpoint, Run } from '../../types/trainer';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { CompareDrawer } from './CompareDrawer';

type Props = {
  run: Run | null;
  onApply: (checkpointId: string) => void;
  onRollback: (checkpointId: string) => void;
};

const formatTime = (iso: string) => new Date(iso).toLocaleString();

export function CheckpointTimeline({ run, onApply, onRollback }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const checkpoints = useMemo(() => {
    if (!run) return [];
    return [...run.checkpoints].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [run]);

  const getDelta = (index: number, key: keyof Checkpoint) => {
    if (!checkpoints[index + 1]) return null;
    const current = checkpoints[index][key] as number;
    const prev = checkpoints[index + 1][key] as number;
    const diff = current - prev;
    return Number.isFinite(diff) ? diff : null;
  };

  const selectedCheckpoints = selected
    .map(id => checkpoints.find(cp => cp.id === id))
    .filter(Boolean) as Checkpoint[];

  return (
    <Card>
      <CardHeader>
        <CardTitle>快照时间轴</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {checkpoints.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无快照。</div>
        ) : (
          checkpoints.map((checkpoint, index) => {
            const deltaWin = getDelta(index, 'winRate');
            const deltaLoss = getDelta(index, 'loss');
            return (
              <div key={checkpoint.id} className="rounded-lg border bg-muted/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold">{checkpoint.id}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatTime(checkpoint.createdAt)} | 轮次 {checkpoint.epoch}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      样本 {checkpoint.samples.toLocaleString()} | 损失{' '}
                      {checkpoint.loss.toFixed(2)}{' '}
                      {deltaLoss !== null && (
                        <span className={deltaLoss < 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          ({deltaLoss < 0 ? '' : '+'}
                          {deltaLoss.toFixed(2)})
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      胜率 {Math.round(checkpoint.winRate * 100)}%{' '}
                      {deltaWin !== null && (
                        <span className={deltaWin > 0 ? 'text-emerald-600' : 'text-rose-600'}>
                          ({deltaWin > 0 ? '+' : ''}
                          {Math.round(deltaWin * 100)}%)
                        </span>
                      )}{' '}
                      | Elo {checkpoint.elo}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={checkpoint.isApplied ? 'secondary' : 'default'}
                      onClick={() => onApply(checkpoint.id)}
                      disabled={checkpoint.isApplied}
                    >
                      {checkpoint.isApplied ? '已应用' : '应用'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onRollback(checkpoint.id)}>
                      回滚
                    </Button>
                    <Button size="sm" variant="outline">
                      导出
                    </Button>
                    <Button
                      size="sm"
                      variant={selected.includes(checkpoint.id) ? 'secondary' : 'outline'}
                      onClick={() => {
                        const next = selected.includes(checkpoint.id)
                          ? selected.filter(id => id !== checkpoint.id)
                          : [...selected, checkpoint.id].slice(-2);
                        setSelected(next);
                        if (next.length === 2) setDrawerOpen(true);
                      }}
                    >
                      对比
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </CardContent>

      <CompareDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        left={selectedCheckpoints[0]}
        right={selectedCheckpoints[1]}
      />
    </Card>
  );
}
