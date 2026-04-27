import type { JobStatus, RunStatus } from '../../types/trainer';
import { Badge, type BadgeProps } from '../ui/badge';

const statusMap: Record<
  string,
  { label: string; variant: BadgeProps['variant'] }
> = {
  idle: { label: '空闲', variant: 'secondary' },
  generating: { label: '生成中', variant: 'warning' },
  training: { label: '训练中', variant: 'default' },
  evaluating: { label: '评测中', variant: 'default' },
  running: { label: '运行中', variant: 'default' },
  done: { label: '完成', variant: 'success' },
  paused: { label: '暂停', variant: 'warning' },
  error: { label: '错误', variant: 'danger' },
};

export function StatusBadge({ status }: { status: RunStatus | JobStatus }) {
  const entry = statusMap[status] ?? { label: status, variant: 'secondary' };
  return <Badge variant={entry.variant}>{entry.label}</Badge>;
}
