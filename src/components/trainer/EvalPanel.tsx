import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Run } from '../../types/trainer';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

export function EvalPanel({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>评测</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无评测数据。
        </CardContent>
      </Card>
    );
  }

  const trend = run.checkpoints.map((cp, idx) => ({
    name: `E${cp.epoch}`,
    winRate: Math.round(cp.winRate * 100),
    ciUpper: Math.round((cp.winRate + run.evalJob.ci95) * 100),
    ciLower: Math.round((cp.winRate - run.evalJob.ci95) * 100),
    idx,
  }));

  const sideData = [
    { side: '先手', winRate: Math.round(run.evalJob.bySide.first * 100) },
    { side: '后手', winRate: Math.round(run.evalJob.bySide.second * 100) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>评测与对比</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className="text-sm font-medium">对基线胜率</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend}>
                  <XAxis dataKey="name" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Area
                    dataKey="ciUpper"
                    name="置信上界"
                    fill="hsl(var(--chart-1))"
                    stroke="none"
                    fillOpacity={0.18}
                  />
                  <Area
                    dataKey="ciLower"
                    name="置信下界"
                    fill="hsl(var(--background))"
                    stroke="none"
                    fillOpacity={1}
                  />
                  <Area
                    dataKey="winRate"
                    name="胜率"
                    stroke="hsl(var(--chart-5))"
                    fill="hsl(var(--chart-5))"
                    fillOpacity={0.2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <div className="text-sm font-medium">先后手胜率</div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sideData}>
                  <XAxis dataKey="side" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar
                    dataKey="winRate"
                    name="胜率"
                    fill="hsl(var(--chart-2))"
                    radius={[6, 6, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="text-muted-foreground">对局摘要</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>对局数</div>
              <div className="font-medium">{run.evalJob.games}</div>
              <div>胜</div>
              <div className="font-medium">{run.evalJob.wins}</div>
              <div>负</div>
              <div className="font-medium">{run.evalJob.losses}</div>
              <div>和</div>
              <div className="font-medium">{run.evalJob.draws}</div>
              <div>平均耗时/步</div>
              <div className="font-medium">1.2秒</div>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-4 text-sm lg:col-span-2">
            <div className="text-muted-foreground">开局表现</div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {run.evalJob.byOpening.length === 0 ? (
                <div className="text-sm text-muted-foreground">暂无开局数据。</div>
              ) : (
                run.evalJob.byOpening.map(opening => (
                  <div key={opening.id} className="rounded-md border bg-background px-3 py-2">
                    <div className="text-xs text-muted-foreground">{opening.id}</div>
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">
                        胜率 {Math.round(opening.winRate * 100)}%
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {opening.games} 局
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
