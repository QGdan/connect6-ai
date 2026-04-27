import type { ChangeEvent } from 'react';

import type { Run, RunAlert, RunLogEntry } from '../types/trainer';
import type { ValueModelSnapshot } from '../core/value_model_snapshot';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { Switch } from '../components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CheckpointTimeline } from '../components/trainer/CheckpointTimeline';
import { DatasetQualityPanel } from '../components/trainer/DatasetQualityPanel';
import { EvalPanel } from '../components/trainer/EvalPanel';
import { GameReplayPanel } from '../components/trainer/GameReplayPanel';
import { KpiGrid } from '../components/trainer/KpiGrid';
import { LossChartTabs } from '../components/trainer/LossChartTabs';
import { PipelineStepper } from '../components/trainer/PipelineStepper';
import { ResourceMonitor } from '../components/trainer/ResourceMonitor';
import { RunHeader } from '../components/trainer/RunHeader';
import { StatusBadge } from '../components/trainer/StatusBadge';

type TrainingSource = 'selfplay' | 'jsonl';
type SelfPlayMode = 'fast' | 'normal' | 'deep';

type SelfPlayConfig = {
  games: number;
  timeMs: number;
  mode: SelfPlayMode;
  randomOpeningPlies: number;
  seed: number;
  maxSamples: number;
  augment: boolean;
};

type ImportConfig = {
  maxSamples: number;
  seed: number;
};

type TrainingConfig = {
  epochs: number;
  lr: number;
  l2: number;
  seed: number;
};

type EvalConfig = {
  games: number;
  timeMs: number;
  mode: SelfPlayMode;
  randomOpeningPlies: number;
  seed: number;
};

type TrainerConsolePanelProps = {
  run: Run | null;
  logs: RunLogEntry[];
  alerts: RunAlert[];
  trainingSource: TrainingSource;
  trainingStatus: string;
  evalStatus: string;
  trainingBusy: boolean;
  evalBusy: boolean;
  selfPlayConfig: SelfPlayConfig;
  importConfig: ImportConfig;
  trainingConfig: TrainingConfig;
  evalConfig: EvalConfig;
  trainedModel: ValueModelSnapshot | null;
  appliedModel: ValueModelSnapshot | null;
  onTrainingSourceChange: (value: TrainingSource) => void;
  onSelfPlayConfigChange: (
    key: 'games' | 'timeMs' | 'randomOpeningPlies' | 'seed' | 'maxSamples',
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  onImportConfigChange: (
    key: 'maxSamples' | 'seed',
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  onTrainingConfigChange: (
    key: 'epochs' | 'lr' | 'l2' | 'seed',
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  onEvalConfigChange: (
    key: 'games' | 'timeMs' | 'randomOpeningPlies' | 'seed',
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  onSelfPlayModeChange: (mode: SelfPlayMode) => void;
  onSelfPlayAugmentChange: (value: boolean) => void;
  onEvalModeChange: (mode: SelfPlayMode) => void;
  onStartSelfPlayDataset: () => void;
  onImportJsonl: (file: File) => void;
  onStartTraining: () => void;
  onRunEvaluation: () => void;
  onApplyModel: () => void;
  onResetModel: () => void;
  onExportModel: (kind: 'json' | 'ts' | 'py' | 'cpp') => void;
  onImportModel: (file: File) => void;
};

export function TrainerConsolePanel({
  run,
  logs,
  alerts,
  trainingSource,
  trainingStatus,
  evalStatus,
  trainingBusy,
  evalBusy,
  selfPlayConfig,
  importConfig,
  trainingConfig,
  evalConfig,
  trainedModel,
  appliedModel,
  onTrainingSourceChange,
  onSelfPlayConfigChange,
  onImportConfigChange,
  onTrainingConfigChange,
  onEvalConfigChange,
  onSelfPlayModeChange,
  onSelfPlayAugmentChange,
  onEvalModeChange,
  onStartSelfPlayDataset,
  onImportJsonl,
  onStartTraining,
  onRunEvaluation,
  onApplyModel,
  onResetModel,
  onExportModel,
  onImportModel,
}: TrainerConsolePanelProps) {
  const appliedLabel = appliedModel?.trainedAt ?? '内置';
  const trainedLabel = trainedModel?.trainedAt ?? '无';
  const datasetBusy = trainingBusy;
  const logStageLabels: Record<string, string> = {
    generate: '生成',
    train: '训练',
    eval: '评测',
    system: '系统',
  };

  const handleCheckpointApply = () => {
    onApplyModel();
  };

  const handleCheckpointRollback = () => {
    onResetModel();
  };

  const selfplaySamples =
    run?.samples?.filter(sample => sample.source === 'selfplay') ?? [];
  const evalSamples =
    run?.samples?.filter(sample => sample.source === 'eval') ?? [];

  return (
    <div className="space-y-6">
      <RunHeader run={run} />

      <Tabs defaultValue="train">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="train">训练总览</TabsTrigger>
          <TabsTrigger value="data">自对弈数据</TabsTrigger>
          <TabsTrigger value="eval">评测对比</TabsTrigger>
          <TabsTrigger value="models">模型管理</TabsTrigger>
        </TabsList>

        <div className="grid gap-6 xl:grid-cols-12">
          <div className="space-y-6 xl:col-span-8">
            <TabsContent value="train">
              <div className="space-y-6">
                <KpiGrid run={run} />
                <PipelineStepper run={run} />
                <LossChartTabs run={run} />
                <ResourceMonitor run={run} />
              </div>
            </TabsContent>

            <TabsContent value="data">
              <div className="space-y-6">
                <DatasetQualityPanel run={run} />
                <GameReplayPanel samples={selfplaySamples} />
              </div>
            </TabsContent>

            <TabsContent value="eval">
              <div className="space-y-6">
                <EvalPanel run={run} />
                <GameReplayPanel samples={evalSamples} />
              </div>
            </TabsContent>

            <TabsContent value="models">
              <CheckpointTimeline
                run={run}
                onApply={handleCheckpointApply}
                onRollback={handleCheckpointRollback}
              />
            </TabsContent>
          </div>

          <aside className="space-y-4 xl:col-span-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>运行状态</CardTitle>
                <StatusBadge status={run?.status ?? 'idle'} />
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <div>训练：{trainingStatus || '空闲'}</div>
                <div>评测：{evalStatus || '空闲'}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>数据集</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="grid gap-2">
                  <Label>来源</Label>
                  <Select
                    value={trainingSource}
                    onValueChange={value => onTrainingSourceChange(value as TrainingSource)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择来源" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="selfplay">自对弈</SelectItem>
                      <SelectItem value="jsonl">JSONL 导入</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {trainingSource === 'selfplay' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <Label>对局数</Label>
                        <Input
                          type="number"
                          value={selfPlayConfig.games}
                          onChange={onSelfPlayConfigChange('games')}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>思考时间(ms)</Label>
                        <Input
                          type="number"
                          value={selfPlayConfig.timeMs}
                          onChange={onSelfPlayConfigChange('timeMs')}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <Label>模式</Label>
                        <Select
                          value={selfPlayConfig.mode}
                          onValueChange={value => onSelfPlayModeChange(value as SelfPlayMode)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="选择模式" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fast">fast</SelectItem>
                            <SelectItem value="normal">normal</SelectItem>
                            <SelectItem value="deep">deep</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label>随机开局层数</Label>
                        <Input
                          type="number"
                          value={selfPlayConfig.randomOpeningPlies}
                          onChange={onSelfPlayConfigChange('randomOpeningPlies')}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <Label>随机种子</Label>
                        <Input
                          type="number"
                          value={selfPlayConfig.seed}
                          onChange={onSelfPlayConfigChange('seed')}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>最大样本数</Label>
                        <Input
                          type="number"
                          value={selfPlayConfig.maxSamples}
                          onChange={onSelfPlayConfigChange('maxSamples')}
                        />
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
                      <div>
                        <div className="font-medium">对称增强</div>
                        <div className="text-xs text-muted-foreground">
                          旋转与镜像棋盘，提升样本多样性。
                        </div>
                      </div>
                      <Switch
                        checked={selfPlayConfig.augment}
                        onCheckedChange={onSelfPlayAugmentChange}
                      />
                    </div>
                    <Button onClick={onStartSelfPlayDataset} disabled={datasetBusy}>
                      {datasetBusy ? '生成中...' : '生成数据集'}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-2">
                        <Label>最大样本数</Label>
                        <Input
                          type="number"
                          value={importConfig.maxSamples}
                          onChange={onImportConfigChange('maxSamples')}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>随机种子</Label>
                        <Input
                          type="number"
                          value={importConfig.seed}
                          onChange={onImportConfigChange('seed')}
                        />
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <Label>JSONL 文件</Label>
                      <Input
                        type="file"
                        accept=".jsonl,.txt"
                        onChange={event => {
                          const file = event.target.files?.[0];
                          if (file) onImportJsonl(file);
                        }}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>训练</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>轮次</Label>
                    <Input
                      type="number"
                      value={trainingConfig.epochs}
                      onChange={onTrainingConfigChange('epochs')}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>学习率</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={trainingConfig.lr}
                      onChange={onTrainingConfigChange('lr')}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>L2</Label>
                    <Input
                      type="number"
                      step="0.0001"
                      value={trainingConfig.l2}
                      onChange={onTrainingConfigChange('l2')}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>随机种子</Label>
                    <Input
                      type="number"
                      value={trainingConfig.seed}
                      onChange={onTrainingConfigChange('seed')}
                    />
                  </div>
                </div>
                <Button onClick={onStartTraining} disabled={trainingBusy}>
                  {trainingBusy ? '训练中...' : '开始训练'}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>评测</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>对局数</Label>
                    <Input
                      type="number"
                      value={evalConfig.games}
                      onChange={onEvalConfigChange('games')}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>思考时间(ms)</Label>
                    <Input
                      type="number"
                      value={evalConfig.timeMs}
                      onChange={onEvalConfigChange('timeMs')}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>模式</Label>
                    <Select
                      value={evalConfig.mode}
                      onValueChange={value => onEvalModeChange(value as SelfPlayMode)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择模式" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fast">fast</SelectItem>
                        <SelectItem value="normal">normal</SelectItem>
                        <SelectItem value="deep">deep</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>随机开局层数</Label>
                    <Input
                      type="number"
                      value={evalConfig.randomOpeningPlies}
                      onChange={onEvalConfigChange('randomOpeningPlies')}
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>随机种子</Label>
                  <Input
                    type="number"
                    value={evalConfig.seed}
                    onChange={onEvalConfigChange('seed')}
                  />
                </div>
                <Button onClick={onRunEvaluation} disabled={evalBusy || trainingBusy}>
                  {evalBusy ? '评测中...' : '开始评测'}
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>模型与导出</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="text-xs text-muted-foreground">
                  应用训练快照到引擎，或导出为 JSON/TS/Python/C++ 格式。
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <div className="text-muted-foreground">已应用快照</div>
                    <div className="font-medium">{appliedLabel}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <div className="text-muted-foreground">最新训练快照</div>
                    <div className="font-medium">{trainedLabel}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={onApplyModel} disabled={!trainedModel}>
                    应用训练模型
                  </Button>
                  <Button variant="outline" onClick={onResetModel}>
                    恢复内置模型
                  </Button>
                </div>
                <Separator />
                <div className="space-y-2">
                  <div className="font-medium">模型导出</div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => onExportModel('json')}>
                      导出 JSON
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onExportModel('ts')}>
                      导出 TS
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onExportModel('py')}>
                      导出 Python
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onExportModel('cpp')}>
                      导出 C++
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    JSON 为完整快照，TS/Python/C++ 用于外部推理或二次开发。
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="font-medium">模型导入</div>
                  <Input
                    type="file"
                    accept=".json"
                    onChange={event => {
                      const file = event.target.files?.[0];
                      if (file) onImportModel(file);
                    }}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>告警</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {alerts.length === 0 ? (
                  <div className="text-muted-foreground">暂无告警。</div>
                ) : (
                  alerts.map(alert => (
                    <div
                      key={alert.id}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                    >
                      {alert.message}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>运行日志</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {logs.length === 0 ? (
                  <div className="text-muted-foreground">暂无日志。</div>
                ) : (
                  logs.slice(0, 6).map(entry => (
                    <div key={entry.id}>
                      <div className="text-xs text-muted-foreground">
                        {logStageLabels[entry.stage] ?? entry.stage} ·{' '}
                        {new Date(entry.at).toLocaleTimeString()}
                      </div>
                      <div className="font-medium">{entry.message}</div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </aside>
        </div>
      </Tabs>
    </div>
  );
}
