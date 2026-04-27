import {
  Area,
  Brush,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Run, TimeseriesPoint } from '../../types/trainer';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

const toChartData = (series: TimeseriesPoint[]) =>
  series.map(point => ({
    step: point.step,
    totalLoss: point.totalLoss,
    valueLoss: point.valueLoss,
    policyLoss: point.policyLoss,
    l2Loss: point.l2Loss,
    lr: point.lr,
    gradNorm: point.gradNorm,
    weightNorm: point.weightNorm,
    updateRatio: point.updateRatio,
  }));

export function LossChartTabs({ run }: { run: Run | null }) {
  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>损失与指标</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          暂无训练数据。
        </CardContent>
      </Card>
    );
  }

  const data = toChartData(run.trainJob.metricsTimeseries);
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>损失与指标</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          正在等待指标数据流。
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>损失与指标</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="loss">
          <TabsList>
            <TabsTrigger value="loss">损失</TabsTrigger>
            <TabsTrigger value="regularization">正则</TabsTrigger>
            <TabsTrigger value="gradient">梯度</TabsTrigger>
            <TabsTrigger value="lr">学习率</TabsTrigger>
          </TabsList>

          <TabsContent value="loss">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <XAxis dataKey="step" tickLine={false} axisLine={false} />
                  <YAxis width={40} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="totalLoss"
                    name="总损失"
                    stroke="hsl(var(--chart-5))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="valueLoss"
                    name="价值损失"
                    stroke="hsl(var(--chart-1))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="policyLoss"
                    name="策略损失"
                    stroke="hsl(var(--chart-3))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="l2Loss"
                    name="L2损失"
                    stroke="hsl(var(--chart-4))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Brush dataKey="step" height={20} stroke="#94a3b8" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="regularization">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <XAxis dataKey="step" tickLine={false} axisLine={false} />
                  <YAxis width={40} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="l2Loss"
                    name="L2损失"
                    stroke="hsl(var(--chart-4))"
                    fill="hsl(var(--chart-4))"
                    fillOpacity={0.2}
                  />
                  <Line
                    type="monotone"
                    dataKey="l2Loss"
                    name="L2损失"
                    stroke="hsl(var(--chart-4))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Brush dataKey="step" height={20} stroke="#94a3b8" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="gradient">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <XAxis dataKey="step" tickLine={false} axisLine={false} />
                  <YAxis width={40} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="gradNorm"
                    name="梯度范数"
                    stroke="hsl(var(--chart-5))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="weightNorm"
                    name="权重范数"
                    stroke="hsl(var(--chart-1))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="updateRatio"
                    name="更新比例"
                    stroke="hsl(var(--chart-2))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Brush dataKey="step" height={20} stroke="#94a3b8" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="lr">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data}>
                  <XAxis dataKey="step" tickLine={false} axisLine={false} />
                  <YAxis width={40} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="lr"
                    name="学习率"
                    stroke="hsl(var(--chart-5))"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Brush dataKey="step" height={20} stroke="#94a3b8" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
