import { useMemo } from 'react';

import type { Run } from '../../types/trainer';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { StatusBadge } from './StatusBadge';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

const formatElapsed = (startIso: string) => {
  const start = new Date(startIso).getTime();
  const diff = Math.max(0, Date.now() - start);
  const totalSeconds = Math.floor(diff / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 0) return `${hrs}小时${remMins}分`;
  return `${remMins}分${secs}秒`;
};

export function RunHeader({ run }: { run: Run | null }) {
  const elapsed = useMemo(() => (run ? formatElapsed(run.createdAt) : '--'), [run]);
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>运行概览</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          尚未选择运行任务。
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="text-lg">{run.name}</CardTitle>
          <div className="mt-1 text-xs text-muted-foreground">
            创建 {formatTime(run.createdAt)} | 更新 {formatTime(run.updatedAt)}
          </div>
        </div>
        <StatusBadge status={run.status} />
      </CardHeader>
      <CardContent className="grid gap-4 text-sm md:grid-cols-3">
        <div>
          <div className="text-muted-foreground">已运行</div>
          <div className="font-medium">{elapsed}</div>
        </div>
        <div>
          <div className="text-muted-foreground">规则</div>
          <div className="font-medium">
            {run.rules.boardSize}x{run.rules.boardSize} | {run.rules.firstMoveStones} +
            {run.rules.nextMoveStones}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">随机种子</div>
          <div className="font-medium">
            数据集 {run.datasetJob.seed} | 训练 {run.trainJob.seed}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
