import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Checkpoint } from '../../types/trainer';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet';

type CompareDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  left?: Checkpoint | null;
  right?: Checkpoint | null;
};

export function CompareDrawer({ open, onOpenChange, left, right }: CompareDrawerProps) {
  if (!left || !right) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>快照对比</SheetTitle>
          </SheetHeader>
          <div className="mt-6 text-sm text-muted-foreground">
            请选择两个快照进行对比。
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const data = [
    {
      name: left.id,
      loss: left.loss,
      winRate: Math.round(left.winRate * 100),
    },
    {
      name: right.id,
      loss: right.loss,
      winRate: Math.round(right.winRate * 100),
    },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>快照对比</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-6">
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="font-medium">{left.id}</div>
            <div className="text-muted-foreground">
              损失 {left.loss.toFixed(2)} | 胜率 {Math.round(left.winRate * 100)}% | Elo{' '}
              {left.elo}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-4 text-sm">
            <div className="font-medium">{right.id}</div>
            <div className="text-muted-foreground">
              损失 {right.loss.toFixed(2)} | 胜率 {Math.round(right.winRate * 100)}% | Elo{' '}
              {right.elo}
            </div>
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <XAxis dataKey="name" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="loss"
                  name="损失"
                  stroke="hsl(var(--chart-4))"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="winRate"
                  name="胜率"
                  stroke="hsl(var(--chart-5))"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
