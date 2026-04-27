import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Run } from '../../types/trainer';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

export function DatasetQualityPanel({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>数据集质量</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无数据集。
        </CardContent>
      </Card>
    );
  }

  const stats = run.datasetJob.stats;
  const winData = [
    { name: '胜', value: stats.winLoseDraw.win },
    { name: '负', value: stats.winLoseDraw.loss },
    { name: '和', value: stats.winLoseDraw.draw },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>数据集质量</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-48">
            <div className="text-sm font-medium">结果分布</div>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip />
                <Pie
                  data={winData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={40}
                  outerRadius={70}
                  paddingAngle={4}
                />
                {winData.map((_, idx) => (
                  <Cell key={`cell-${idx}`} fill={`hsl(var(--chart-${idx + 1}))`} />
                ))}
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="h-48">
            <div className="text-sm font-medium">对局长度</div>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.lengthHist}>
                <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="h-48">
            <div className="text-sm font-medium">开局覆盖</div>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.openingsTop}>
                <XAxis dataKey="id" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">唯一局面</div>
            <div className="text-lg font-semibold">
              {stats.uniquePositions.toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">重复率</div>
            <div className="text-lg font-semibold">
              {Math.round(stats.duplicateRate * 100)}%
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">策略熵</div>
            <div className="text-lg font-semibold">{stats.policyEntropy.toFixed(2)}</div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">Top-1 频率</div>
            <div className="text-lg font-semibold">{Math.round(stats.top1Rate * 100)}%</div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">Top-k 频率</div>
            <div className="text-lg font-semibold">{Math.round(stats.topKRate * 100)}%</div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-muted-foreground">异常样本</div>
            <div className="text-lg font-semibold">
              {stats.illegalCount + stats.parseFailed + stats.nanSamples}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
