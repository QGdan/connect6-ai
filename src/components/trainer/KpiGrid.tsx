import { Line, LineChart, ResponsiveContainer, Tooltip } from 'recharts';

import type { Run } from '../../types/trainer';
import { Card } from '../ui/card';
import { cn } from '../../lib/utils';

type SparkPoint = { idx: number; value: number };

type KpiCardProps = {
  title: string;
  value: string;
  subtitle: string;
  delta?: string;
  status?: 'ok' | 'warn' | 'bad';
  data: SparkPoint[];
};

const statusColor = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-rose-500',
};

function KpiCard({ title, value, subtitle, delta, status = 'ok', data }: KpiCardProps) {
  return (
    <Card className="relative overflow-hidden">
      <div className="flex h-full flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {title}
          </div>
          <span className={cn('h-2.5 w-2.5 rounded-full', statusColor[status])} />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground">
              {subtitle} {delta ? <span className="text-foreground">({delta})</span> : null}
            </div>
          </div>
          <div className="h-10 w-20">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <Tooltip wrapperStyle={{ display: 'none' }} content={() => null} />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function KpiGrid({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, idx) => (
          <Card key={idx} className="h-24 animate-pulse bg-muted/50" />
        ))}
      </div>
    );
  }

  const series = run.trainJob.metricsTimeseries.slice(-12);
  const spark = (map: (p: typeof series[number]) => number): SparkPoint[] =>
    series.map((point, idx) => ({ idx, value: map(point) }));

  const lossSpark = spark(point => point.totalLoss);
  const throughputSpark = spark(point => point.throughput);
  const cpuSpark = spark(point => point.cpu);
  const winSpark = spark(point => point.gradNorm);
  const eloSpark = spark(point => point.weightNorm);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <KpiCard
        title="数据集样本"
        value={run.kpis.samples.total.toLocaleString()}
        subtitle={`已过滤 ${run.kpis.samples.delta.toLocaleString()}`}
        delta={`去重后 ${run.kpis.samples.unique.toLocaleString()}`}
        status={run.kpis.samples.delta > 0 ? 'ok' : 'warn'}
        data={throughputSpark}
      />
      <KpiCard
        title="最新损失"
        value={run.kpis.latestLoss.total.toFixed(2)}
        subtitle="总损失 / 价值 / 策略"
        delta={`${run.kpis.latestLoss.value.toFixed(2)} / ${run.kpis.latestLoss.policy.toFixed(2)}`}
        status={run.kpis.latestLoss.total < 1.2 ? 'ok' : 'warn'}
        data={lossSpark}
      />
      <KpiCard
        title="评测胜率"
        value={`${Math.round(run.kpis.evalWinRate.value * 100)}%`}
        subtitle={`95% CI ±${Math.round(run.kpis.evalWinRate.ci95 * 100)}%`}
        delta={`变化 ${(run.kpis.evalWinRate.delta * 100).toFixed(1)}%`}
        status={run.kpis.evalWinRate.value >= 0.55 ? 'ok' : 'warn'}
        data={winSpark}
      />
      <KpiCard
        title="估算 Elo"
        value={run.kpis.elo.value.toString()}
        subtitle={`置信区间 ${run.kpis.elo.sigma}`}
        delta={`变化 ${Math.round(run.kpis.elo.delta)}`}
        status={run.kpis.elo.delta >= 0 ? 'ok' : 'warn'}
        data={eloSpark}
      />
      <KpiCard
        title="吞吐"
        value={`${run.kpis.throughput.value}`}
        subtitle={run.kpis.throughput.unit}
        delta="稳定"
        status={run.kpis.throughput.value > 900 ? 'ok' : 'warn'}
        data={throughputSpark}
      />
      <KpiCard
        title="系统"
        value={`${run.kpis.system.cpu}% CPU`}
        subtitle={`${run.kpis.system.gpu}% GPU`}
        delta={`内存 ${run.kpis.system.ram}%`}
        status={run.kpis.system.cpu > 80 ? 'warn' : 'ok'}
        data={cpuSpark}
      />
    </div>
  );
}
