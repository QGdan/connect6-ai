import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Run } from '../../types/trainer';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

export function ResourceMonitor({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>系统监控</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无系统指标。
        </CardContent>
      </Card>
    );
  }

  const data = run.trainJob.metricsTimeseries.map(point => ({
    step: point.step,
    cpu: Math.round(point.cpu),
    gpu: Math.round(point.gpu),
    throughput: Math.round(point.throughput),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>系统监控</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <XAxis dataKey="step" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="cpu"
                name="CPU"
                stroke="hsl(var(--chart-5))"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="gpu"
                name="GPU"
                stroke="hsl(var(--chart-1))"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">CPU</div>
            <div className="text-lg font-semibold">{run.kpis.system.cpu}%</div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">GPU</div>
            <div className="text-lg font-semibold">
              {run.kpis.system.gpu > 0 ? `${run.kpis.system.gpu}%` : 'N/A'}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">吞吐</div>
            <div className="text-lg font-semibold">
              {run.kpis.throughput.value} 局面/秒
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
