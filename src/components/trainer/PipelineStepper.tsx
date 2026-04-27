import { useMemo, useState } from 'react';

import type { Run } from '../../types/trainer';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Progress } from '../ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';
import { StatusBadge } from './StatusBadge';

type StepData = {
  key: string;
  title: string;
  status: string;
  progress: number;
  detail: string;
  output: string;
};

export function PipelineStepper({ run }: { run: Run | null }) {
  const [activeStep, setActiveStep] = useState<StepData | null>(null);

  const steps = useMemo<StepData[]>(() => {
    if (!run) return [];
    const datasetProgress =
      run.datasetJob.gamesTarget === 0
        ? 0
        : Math.round((run.datasetJob.gamesDone / run.datasetJob.gamesTarget) * 100);
    const trainProgress =
      run.trainJob.totalSteps === 0
        ? 0
        : Math.round((run.trainJob.step / run.trainJob.totalSteps) * 100);
    const evalProgress =
      run.evalJob.games === 0
        ? 0
        : Math.min(
            100,
            Math.round(
              ((run.evalJob.wins + run.evalJob.losses + run.evalJob.draws) /
                run.evalJob.games) *
                100,
            ),
          );
    const snapshotProgress = run.checkpoints.length > 0 ? 100 : 0;

    const parseStatus =
      run.datasetJob.status === 'idle'
        ? 'idle'
        : run.datasetJob.status === 'running'
        ? 'running'
        : 'done';

    return [
      {
        key: 'generate',
        title: '生成',
        status: run.datasetJob.status,
        progress: datasetProgress,
        detail: `对局 ${run.datasetJob.gamesDone}/${run.datasetJob.gamesTarget}，种子 ${run.datasetJob.seed}`,
        output: `${run.datasetJob.gamesDone} 局`,
      },
      {
        key: 'parse',
        title: '解析/校验',
        status: parseStatus,
        progress: Math.min(100, Math.round(datasetProgress * 0.8)),
        detail: `有效局面 ${run.datasetJob.stats.uniquePositions.toLocaleString()}，解析失败 ${run.datasetJob.stats.parseFailed}`,
        output: `${run.datasetJob.stats.uniquePositions.toLocaleString()} 局面`,
      },
      {
        key: 'train',
        title: '训练',
        status: run.trainJob.status,
        progress: trainProgress,
        detail: `轮次 ${run.trainJob.epochs}，学习率 ${run.trainJob.lr}，L2 ${run.trainJob.l2}`,
        output: `${run.trainJob.step}/${run.trainJob.totalSteps} 步`,
      },
      {
        key: 'eval',
        title: '评测',
        status: run.evalJob.status,
        progress: evalProgress,
        detail: `胜率 ${(run.evalJob.winRate * 100).toFixed(1)}%`,
        output: `${run.evalJob.games} 局`,
      },
      {
        key: 'snapshot',
        title: '快照',
        status: run.checkpoints.length > 0 ? 'done' : 'idle',
        progress: snapshotProgress,
        detail: `最新 ${run.checkpoints[0]?.id ?? '暂无'}`,
        output: `${run.checkpoints.length} 个快照`,
      },
    ];
  }, [run]);

  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>训练流水线</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无流水线数据。
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>训练流水线</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {steps.map(step => (
          <div key={step.key} className="rounded-lg border bg-muted/40 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">{step.title}</div>
                <div className="text-xs text-muted-foreground">{step.output}</div>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={step.status as 'idle'} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActiveStep(step)}
                >
                  详情
                </Button>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              <Progress value={step.progress} />
              <div className="text-xs text-muted-foreground">
                {step.progress}% - {step.detail}
              </div>
            </div>
          </div>
        ))}
      </CardContent>

      <Sheet open={!!activeStep} onOpenChange={open => !open && setActiveStep(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{activeStep?.title}</SheetTitle>
            <SheetDescription>{activeStep?.detail}</SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4 text-sm">
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="font-medium">产出</div>
              <div className="text-muted-foreground">{activeStep?.output}</div>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="font-medium">操作建议</div>
              <div className="text-muted-foreground">
                可重试、查看日志或在控制面板中调整参数。
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
