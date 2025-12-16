import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { GameBoard } from './ui/GameBoard';
import { Roadmap } from './ui/Roadmap';
import { ReportGenerator } from './ui/ReportGenerator';
import { AIAnalysisPanel } from './ui/AIAnalysisPanel';
import type { AIHistoryItem } from './ui/AIAnalysisPanel';

import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  Player,
  SearchConfig,
} from './types';

import { createInitialState } from './core/game_state';
import { applyMoveWithWinner, getStonesToPlace } from './core/rules';
import { DummyResNetEvaluator } from './core/resnet_ai';
import { MCTSConnect6AI } from './core/mcts_ai_engine';
import { HybridStrategyManager } from './strategy/hybrid_strategy';
import { PerformanceMonitor } from './strategy/performance_monitor';
import { getOpeningMove } from './core/opening_book';
import {
  pvsSearchBestMove,
  getLastSearchStats,
} from './core/pvs_search';
import { SelfPlayOptimizer, type SelfPlayProgress } from './core/self_play_optimizer';

// 估值权重
const defaultWeights: EvaluationWeights = {
  road_3_score: 100,
  road_4_score: 350,
  live4_score: 3000,
  live5_score: 9000,
  vcdt_bonus: 1500,
};

// 控制思考时间
const basePvsConfig: SearchConfig = {
  maxDepth: 3,
  timeLimitMs: 3000,
  useMultithreading: false,
};

// MCTS 配置（deep 模式用）
const mctsConfig = {
  simulationCount: 80,
  simulationSteps: 8,
  expandNodes: 12,
  minWinRateThreshold: 0.3,
};

type GameMode = 'PVP' | 'PVE' | 'AIVSAI';
type StrategyMode = 'auto' | 'traditional' | 'deep';

// 控制台的 3 个 Tab 类型
type ConsoleTab = 'evolve' | 'deep' | 'export';
const LOCAL_STORAGE_KEY = 'connect6-ai-console';

export const App: React.FC = () => {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [aiThinking, setAiThinking] = useState(false);
  const [lastAIMove, setLastAIMove] = useState<AIMoveDecision | null>(null);

  const [gameMode, setGameMode] = useState<GameMode>('PVE');
  const [strategyMode, setStrategyMode] =
    useState<StrategyMode>('traditional'); // 默认传统搜索
  const [humanPlayer, setHumanPlayer] = useState<Player>('BLACK');
  const [weights, setWeights] = useState<EvaluationWeights>(defaultWeights);

  // 搜索参数（可在控制台调优）
  const [searchDepth, setSearchDepth] = useState(basePvsConfig.maxDepth);
  const [searchTimeMs, setSearchTimeMs] = useState(basePvsConfig.timeLimitMs);

  // 自进化训练状态
  const [gaConfig, setGaConfig] = useState({
    populationSize: 6,
    generations: 5,
    mutationRate: 0.12,
  });
  const [gaProgress, setGaProgress] = useState<SelfPlayProgress[]>([]);
  const [gaRunning, setGaRunning] = useState(false);
  const [bestWeights, setBestWeights] = useState<EvaluationWeights | null>(null);
  const [modelProfile, setModelProfile] = useState<{
    name: string;
    source: 'builtin' | 'imported';
    updatedAt: string;
  }>({ name: 'Dummy ResNet（默认）', source: 'builtin', updatedAt: '' });
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const bestProgressFitness = useMemo(
    () =>
      gaProgress.length === 0
        ? 1
        : Math.max(...gaProgress.map(p => Math.max(p.bestFitness, 1))),
    [gaProgress],
  );

  // AI 性能数据
  const [lastAiThinkTimeMs, setLastAiThinkTimeMs] =
    useState<number | null>(null);
  const [lastAiNodes, setLastAiNodes] = useState<number | null>(null);

  // AI 历史记录，用于实时分析图
  const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);

  // 是否进入控制台 & 当前控制台 tab
  const [showConsole, setShowConsole] = useState(false);
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('evolve');
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);

  const perfMonitor = useMemo(() => new PerformanceMonitor(), []);

  const adaptivePvsConfig = useMemo<SearchConfig>(
    () => {
      const lateGameBonusDepth = state.moveNumber > 24 ? 1 : 0;
      const timeBonus = state.moveNumber > 16 ? 400 : 0;

      return {
        maxDepth: Math.min(searchDepth + lateGameBonusDepth, 6),
        timeLimitMs: searchTimeMs + timeBonus,
        useMultithreading: basePvsConfig.useMultithreading,
      };
    },
    [searchDepth, searchTimeMs, state.moveNumber],
  );

  const { strategyManager, mcts } = useMemo(() => {
    const resnet = new DummyResNetEvaluator();
    const mctsAI = new MCTSConnect6AI(resnet, mctsConfig);
    const manager = new HybridStrategyManager(mctsAI, resnet, {
      pvsConfig: basePvsConfig,
      weights: defaultWeights,
    });
    return { strategyManager: manager, mcts: mctsAI };
  }, []);

  useEffect(() => {
    strategyManager.updateConfig({ weights, pvsConfig: adaptivePvsConfig });
  }, [strategyManager, weights, adaptivePvsConfig]);

  // 响应式布局，兼容宿主站点的不同宽度
  useEffect(() => {
    const handleResize = () => {
      setIsNarrowLayout(window.innerWidth < 1280);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 从本地缓存恢复控制台/搜索配置，便于在站点内嵌时保持一致体验
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.weights) {
        setWeights(parsed.weights);
      }
      if (typeof parsed.searchDepth === 'number') {
        setSearchDepth(parsed.searchDepth);
      }
      if (typeof parsed.searchTimeMs === 'number') {
        setSearchTimeMs(parsed.searchTimeMs);
      }
      if (parsed.modelProfile) {
        setModelProfile(parsed.modelProfile);
      }
      if (parsed.importMessage) {
        setImportMessage(parsed.importMessage);
      }
    } catch (e) {
      console.warn('恢复控制台配置失败：', e);
    }
  }, []);

  // 持久化关键配置，方便在网站内刷新或切换路由后继续使用
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const payload = {
      weights,
      searchDepth,
      searchTimeMs,
      modelProfile,
      importMessage,
    };
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
  }, [weights, searchDepth, searchTimeMs, modelProfile, importMessage]);

  // 当前这个 player 是否由 AI 控制？
  const isAIPlayer = useCallback(
    (player: Player): boolean => {
      if (gameMode === 'PVP') return false;
      if (gameMode === 'PVE') {
        return player !== humanPlayer;
      }
      // AIVSAI
      return true;
    },
    [gameMode, humanPlayer],
  );

  const hardReset = useCallback(() => {
    setState(createInitialState());
    setLastAIMove(null);
    setAiThinking(false);
    setLastAiThinkTimeMs(null);
    setLastAiNodes(null);
    setAiHistory([]); // 清空历史
  }, []);

  // 根据策略模式，给当前局面选一手 AI 棋
  const decideAIMove = useCallback(
    async (current: GameState, player: Player): Promise<AIMoveDecision> => {
      const requiredStones = getStonesToPlace(current.moveNumber, player);
      console.log('AI 当前应下子数 =', requiredStones);

      // 1) 传统 PVS + VCDT + ZORP 搜索
      if (strategyMode === 'traditional') {
        const r = pvsSearchBestMove(
          current,
          player,
          weights,
          adaptivePvsConfig,
        );
        r.debugInfo = {
          ...(r.debugInfo ?? {}),
          engine: r.debugInfo?.engine ?? 'pvs+vcdt+zorp',
          strategy: 'traditional',
        };
        return r;
      }

      // 2) 深度 MCTS
      if (strategyMode === 'deep') {
        const r = await mcts.decideMove(current, player);
        r.debugInfo = {
          ...(r.debugInfo ?? {}),
          engine: r.debugInfo?.engine ?? 'mcts',
          strategy: 'deep',
        };
        return r;
      }

      // 3) auto 混合策略
      const r = await strategyManager.decideMove(current, player);
      if (!r.debugInfo) r.debugInfo = {};
      r.debugInfo.strategy ??= 'auto';
      r.debugInfo.engine ??= 'hybrid';
      return r;
    },
    [strategyMode, mcts, strategyManager, weights, adaptivePvsConfig],
  );

  // 真正执行 AI 一手棋（假设此时轮到 player）
  const triggerAI = useCallback(
    async (current: GameState, player: Player) => {
      if (!isAIPlayer(player) || current.winner) {
        setAiThinking(false);
        return;
      }

      let workingState = current;

      // 首手开局库：AI 执黑且是首手
      if (workingState.moveNumber === 0 && player === 'BLACK') {
        const opening = getOpeningMove(workingState, player);
        if (opening) {
          try {
            const s = applyMoveWithWinner(workingState, opening);
            setState(s);
            setLastAIMove({
              move: opening,
              score: 0,
              debugInfo: { strategy: 'opening', engine: 'opening_book' },
            });
            setLastAiThinkTimeMs(0);
            setLastAiNodes(0);
          } catch (e) {
            console.error('应用开局库落子时出错：', e);
          }
          setAiThinking(false);
          return;
        }
      }

      try {
        const start = performance.now();
        const decision = await decideAIMove(workingState, player);
        const end = performance.now();

        console.log('AI 决策结果：', decision);

        // 检查 AI 决策是否合法（严格遵守 1/2 子规则）
        const required = getStonesToPlace(workingState.moveNumber, player);
        if (!decision.move || decision.move.positions.length !== required) {
          console.error(
            `AI 决策不合法：本手应下 ${required} 子，但 AI 给了 ${
              decision.move?.positions.length ?? 0
            } 子`,
            decision,
          );
          return;
        }

        const finalState = applyMoveWithWinner(workingState, decision.move);
        setState(finalState);
        setLastAIMove(decision);

        // 记录本手性能
        const thinkTime = end - start;
        setLastAiThinkTimeMs(thinkTime);

        if (strategyMode === 'traditional') {
          const stats = getLastSearchStats();
          const nodesFromStats = stats.nodes;
          const nodesFromDebug = decision.debugInfo?.nodes;
          const nodes = nodesFromDebug ?? nodesFromStats ?? 0;
          setLastAiNodes(nodes > 0 ? nodes : null);
        } else {
          setLastAiNodes(null);
        }

        perfMonitor.recordThinkTime(thinkTime, adaptivePvsConfig.maxDepth);

        // 记录历史，用于右侧分析图（带上引擎 / 深度 / 节点 / VCDT 信息）
        setAiHistory(prev => [
          ...prev,
          {
            moveIndex: finalState.moveNumber,
            player,
            score: decision.score,
            thinkTimeMs: thinkTime,
            engineLabel:
              decision.debugInfo?.engine ??
              decision.debugInfo?.strategy ??
              'unknown',
            searchDepth: decision.debugInfo?.depth,
            nodes:
              decision.debugInfo?.nodes ??
              (strategyMode === 'traditional'
                ? getLastSearchStats().nodes
                : undefined),
            usedVcdt:
              decision.debugInfo?.mode === 'vcdt_root' ||
              (decision.debugInfo as any)?.usedVCDT === true,
          },
        ]);
      } catch (e) {
        console.error('AI 落子流程出错：', e);
      } finally {
        setAiThinking(false);
      }
    },
    [decideAIMove, isAIPlayer, perfMonitor, strategyMode],
  );

  /**
   * 人类在棋盘上完成“一手棋”后触发：
   */
  const handleHumanMove = useCallback(
    (move: { player: Player; positions: { x: number; y: number }[] }) => {
      if (aiThinking || state.winner) return;

      // 现在轮到的必须是人类
      if (isAIPlayer(state.currentPlayer)) return;
      if (move.player !== state.currentPlayer) return;

      // 验证落子数量
      const requiredStones = getStonesToPlace(
        state.moveNumber,
        state.currentPlayer,
      );
      if (move.positions.length !== requiredStones) {
        console.error(
          `应下 ${requiredStones} 子，实际选择了 ${move.positions.length} 子`,
        );
        return;
      }

      try {
        const nextState = applyMoveWithWinner(state, move as any);
        setState(nextState);
      } catch (e) {
        console.error('人类落子应用规则时出错：', e);
      }
    },
    [aiThinking, state, isAIPlayer],
  );

  const handleStartEvolution = useCallback(async () => {
    setGaRunning(true);
    setGaProgress([]);

    try {
      const optimizer = new SelfPlayOptimizer({
        populationSize: gaConfig.populationSize,
        generations: gaConfig.generations,
        mutationRate: gaConfig.mutationRate,
      });

      const best = await optimizer.optimize(progress => {
        setGaProgress(prev => [...prev, progress]);
      });

      setBestWeights(best);
      setWeights(best);
    } catch (e) {
      console.error('自进化训练失败：', e);
    } finally {
      setGaRunning(false);
    }
  }, [gaConfig]);

  const handleApplyBestWeights = useCallback(() => {
    if (bestWeights) {
      setWeights(bestWeights);
      setModelProfile({
        name: '自进化最佳权重',
        source: 'imported',
        updatedAt: new Date().toISOString(),
      });
      setImportMessage('已应用最新 GA 最佳权重到当前对局');
    }
  }, [bestWeights]);

  const handleImportWeightsFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const raw = e.target?.result as string;
          const data = JSON.parse(raw ?? '{}');
          if (!data.weights) {
            throw new Error('缺少 weights 字段');
          }
          const nextWeights = data.weights as EvaluationWeights;
          setWeights(nextWeights);

          if (data.searchConfig?.maxDepth) {
            setSearchDepth(data.searchConfig.maxDepth);
          }
          if (data.searchConfig?.timeLimitMs) {
            setSearchTimeMs(data.searchConfig.timeLimitMs);
          }

          setModelProfile({
            name: data.name ?? file.name ?? '导入模型',
            source: 'imported',
            updatedAt: new Date().toISOString(),
          });
          setImportMessage(
            `已从 ${file.name} 导入权重并更新搜索参数${
              data.searchConfig ? '（包含搜索配置）' : ''
            }`,
          );
        } catch (err: any) {
          console.error('导入权重失败：', err);
          setImportMessage(`导入失败：${err?.message ?? '文件解析错误'}`);
        }
      };
      reader.readAsText(file);
    },
    [],
  );

  const handleExportConfig = useCallback(() => {
    const payload = {
      name: modelProfile.name,
      exportedAt: new Date().toISOString(),
      weights,
      searchConfig: {
        maxDepth: searchDepth,
        timeLimitMs: searchTimeMs,
        useMultithreading: adaptivePvsConfig.useMultithreading,
      },
      note: 'Connect6 AI 控制台导出配置',
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `connect6_ai_config_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setExportMessage('已导出当前权重与搜索配置，保存在下载目录');
  }, [adaptivePvsConfig.useMultithreading, modelProfile.name, searchDepth, searchTimeMs, weights]);

  /**
   * 只要当前轮到的是 AI，就自动触发 AI 一手棋
   */
  useEffect(() => {
    console.log(
      '[effect] currentPlayer =',
      state.currentPlayer,
      'aiThinking =',
      aiThinking,
      'winner =',
      state.winner,
    );

    // 控制台模式下不自动走棋
    if (showConsole) return;

    if (aiThinking) return;
    if (state.winner) return;

    const playerToMove = state.currentPlayer;
    console.log(
      '[effect] 轮到',
      playerToMove,
      '，isAIPlayer =',
      isAIPlayer(playerToMove),
    );

    if (!isAIPlayer(playerToMove)) return;

    setAiThinking(true);
    const snapshot = state;
    setTimeout(() => {
      triggerAI(snapshot, playerToMove);
    }, 0);
  }, [state, aiThinking, isAIPlayer, triggerAI, showConsole]);

  const currentPlayerIsHuman =
    !isAIPlayer(state.currentPlayer) && !aiThinking && !state.winner;

  const latestGaProgress = gaProgress[gaProgress.length - 1];
  const perfStats = perfMonitor.getStats();
  const gaStatusText = latestGaProgress
    ? `最近完成第 ${latestGaProgress.generation} 代，最佳适应度 ${latestGaProgress.bestFitness.toFixed(2)}`
    : '尚未开始 GA 训练，点击右上角进入控制台。';
  const consoleOverlay =
    showConsole && (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15,23,42,0.42)',
          backdropFilter: 'blur(4px)',
          zIndex: 20,
          display: 'flex',
          justifyContent: 'center',
          alignItems: isNarrowLayout ? 'flex-start' : 'center',
          overflow: 'auto',
          padding: isNarrowLayout ? 12 : 20,
        }}
      >
        <div
          style={{
            maxWidth: isNarrowLayout ? 1000 : 1200,
            width: '100%',
            background:
              'linear-gradient(135deg, #eef2ff 0%, #e0f7ff 40%, #fdf2e9 100%)',
            borderRadius: 18,
            boxShadow: '0 16px 40px rgba(0,0,0,0.16)',
            padding: 16,
          }}
        >
          <header
            style={{
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'rgba(37,99,235,0.1)',
                  color: '#1d4ed8',
                  padding: '6px 10px',
                  borderRadius: 999,
                  fontSize: 12,
                  marginBottom: 6,
                }}
              >
                <span style={{ fontWeight: 700 }}>AI 控制台</span>
                <span style={{ color: '#0ea5e9' }}>· 实验室模式</span>
              </div>
              <h1 style={{ margin: 0, fontSize: 22 }}>模型演化 / 深度模型 / 导出</h1>
              <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
                自进化训练可与当前对局共享权重，实时查看性能数据，更快迭代 AI 棋力。
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: '#0f172a' }}>
                当前活跃模型：
                <strong>{modelProfile.name}</strong>
                {modelProfile.updatedAt && (
                  <span style={{ color: '#475569', marginLeft: 6 }}>
                    更新于 {new Date(modelProfile.updatedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div
                style={{
                  padding: '6px 10px',
                  borderRadius: 10,
                  background: 'rgba(34,197,94,0.12)',
                  color: '#15803d',
                  fontSize: 12,
                }}
              >
                {gaRunning
                  ? '自进化训练进行中'
                  : latestGaProgress
                    ? `最近完成第 ${latestGaProgress.generation} 代`
                    : '尚未运行进化训练'}
              </div>
              <button
                onClick={() => setShowConsole(false)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 10,
                  background: '#111827',
                  border: 'none',
                  color: 'white',
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                返回对局
              </button>
            </div>
          </header>

          <div
            style={{
              display: 'flex',
              gap: 16,
              minHeight: 520,
              flexDirection: isNarrowLayout ? 'column' : 'row',
            }}
          >
            {/* 左：训练可视化棋盘（只读） */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  padding: 12,
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.9)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                  minWidth: isNarrowLayout ? '100%' : 480,
                  width: '100%',
                }}
              >
                <div style={{ marginBottom: 8, fontSize: 13 }}>
                  训练可视化棋盘（同步当前局面，暂不支持手动操作）
                </div>
                <GameBoard
                  state={state}
                  onHumanMove={() => {}}
                  lastAIMove={lastAIMove?.move}
                  currentPlayerIsHuman={false}
                  stonesToPlace={getStonesToPlace(
                    state.moveNumber,
                    state.currentPlayer,
                  )}
                />
              </div>
            </div>

            {/* 右：控制台 tabs + 内容 */}
            <div
              style={{
                width: 420,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {/* tab 按钮行 */}
              <div
                style={{
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.95)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                  padding: 12,
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    fontWeight: 'bold',
                    marginBottom: 8,
                    fontSize: 14,
                  }}
                >
                  AI 控制台
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'space-between',
                  }}
                >
                  <button
                    onClick={() => setConsoleTab('evolve')}
                    style={consoleTabBtnStyle(consoleTab === 'evolve')}
                  >
                    自进化训练
                  </button>
                  <button
                    onClick={() => setConsoleTab('deep')}
                    style={consoleTabBtnStyle(consoleTab === 'deep')}
                  >
                    深度模型
                  </button>
                  <button
                    onClick={() => setConsoleTab('export')}
                    style={consoleTabBtnStyle(consoleTab === 'export')}
                  >
                    导出 / 部署
                  </button>
                </div>
              </div>

              {/* tab 内容 */}
              <div
                style={{
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.95)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                  padding: 14,
                  fontSize: 13,
                  flex: 1,
                }}
              >
                {consoleTab === 'evolve' && (
                  <div>
                    <h3 style={{ marginTop: 0 }}>自进化训练</h3>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                      通过 GA + 自对弈优化估值权重。训练结束的最佳权重可一键写入当前对局。
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 12, color: '#555' }}>种群规模</div>
                        <input
                          type="number"
                          value={gaConfig.populationSize}
                          onChange={e =>
                            setGaConfig(cfg => ({
                              ...cfg,
                              populationSize: Number(e.target.value) || cfg.populationSize,
                            }))
                          }
                          style={consoleInputStyle}
                          min={4}
                          max={24}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: '#555' }}>迭代代数</div>
                        <input
                          type="number"
                          value={gaConfig.generations}
                          onChange={e =>
                            setGaConfig(cfg => ({
                              ...cfg,
                              generations: Number(e.target.value) || cfg.generations,
                            }))
                          }
                          style={consoleInputStyle}
                          min={2}
                          max={16}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: '#555' }}>变异率</div>
                        <input
                          type="number"
                          step="0.01"
                          value={gaConfig.mutationRate}
                          onChange={e =>
                            setGaConfig(cfg => ({
                              ...cfg,
                              mutationRate: Number(e.target.value) || cfg.mutationRate,
                            }))
                          }
                          style={consoleInputStyle}
                          min={0.01}
                          max={0.6}
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <button
                        onClick={handleStartEvolution}
                        style={{
                          ...consoleMainBtnStyle,
                          opacity: gaRunning ? 0.6 : 1,
                          cursor: gaRunning ? 'not-allowed' : 'pointer',
                        }}
                        disabled={gaRunning}
                      >
                        {gaRunning ? '训练中…' : '启动自进化训练'}
                      </button>

                      {bestWeights && (
                        <button
                          onClick={handleApplyBestWeights}
                          style={{
                            ...consoleMainBtnStyle,
                            background: '#f59e0b',
                            borderColor: '#f59e0b',
                            marginLeft: 8,
                          }}
                        >
                          应用最佳权重到当前对局
                        </button>
                      )}
                    </div>

                    {gaProgress.length === 0 && (
                      <div style={{ marginTop: 12, color: '#6b7280', fontSize: 12 }}>
                        点击“启动自进化训练”开始。训练过程将实时显示每代最佳适应度。
                      </div>
                    )}

                    {gaProgress.length > 0 && (
                      <div style={{ marginTop: 14 }}>
                        <div style={{ fontSize: 12, color: '#111827', marginBottom: 8 }}>
                          训练进度
                        </div>
                        {gaProgress.map(p => (
                          <div
                            key={p.generation}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              marginBottom: 6,
                            }}
                          >
                            <div style={{ width: 70, color: '#374151' }}>
                              第 {p.generation} 代
                            </div>
                            <div style={{ flex: 1, background: '#e5e7eb', height: 10, borderRadius: 999 }}>
                              <div
                                style={{
                                  width: `${Math.min(
                                    (p.bestFitness / bestProgressFitness) * 100,
                                    100,
                                  )}%`,
                                  height: '100%',
                                  background: 'linear-gradient(90deg, #22c55e, #16a34a)',
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                      当前对局使用的估值权重
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {Object.entries(weights).map(([k, v]) => (
                        <div
                          key={k}
                          style={{
                            padding: '6px 8px',
                            borderRadius: 8,
                            background: 'rgba(37,99,235,0.08)',
                            color: '#1f2937',
                            fontSize: 12,
                          }}
                        >
                          {k}: {v.toFixed(0)}
                        </div>
                      ))}
                    </div>

                    {bestWeights && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#0f172a' }}>
                        最新进化结果：
                        {Object.entries(bestWeights)
                          .map(([k, v]) => `${k} ${v.toFixed(0)}`)
                          .join(' ｜ ')}
                      </div>
                    )}
                  </div>
                )}

                {consoleTab === 'deep' && (
                  <div>
                    <h3 style={{ marginTop: 0 }}>深度学习模型</h3>
                    <p style={{ color: '#555' }}>
                      这里可以挂载 / 切换不同版本的 ResNet / 深度策略模型，
                      并查看其表现、版本号、训练时间等。
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12, color: '#111827' }}>
                          从 JSON 导入估值权重 / 搜索配置
                        </div>
                        <input
                          type="file"
                          accept="application/json"
                          style={consoleInputStyle}
                          onChange={e => {
                            const file = e.target.files?.[0];
                            if (file) {
                              handleImportWeightsFile(file);
                              e.target.value = '';
                            }
                          }}
                        />
                        {importMessage && (
                          <div style={{ marginTop: 6, color: '#0f766e', fontSize: 12 }}>
                            {importMessage}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: '#334155' }}>
                        当前使用模型：{modelProfile.name}
                        {modelProfile.source === 'builtin'
                          ? '（默认 Dummy ResNet）'
                          : '（外部导入）'}
                      </div>
                    </div>
                  </div>
                )}

                {consoleTab === 'export' && (
                  <div>
                    <h3 style={{ marginTop: 0 }}>模型导出</h3>
                    <p style={{ color: '#555' }}>
                      这里将支持导出当前最优参数（权重、配置等）为 JSON /
                      ONNX 等格式，用于部署到服务器或移动端。
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <button style={consoleMainBtnStyle} onClick={handleExportConfig}>
                        导出当前权重 + 搜索配置（JSON）
                      </button>
                      {bestWeights && (
                        <button
                          style={{ ...consoleMainBtnStyle, background: '#0ea5e9', borderColor: '#0ea5e9' }}
                          onClick={handleApplyBestWeights}
                        >
                          一键应用最新 GA 最优权重
                        </button>
                      )}
                      {exportMessage && (
                        <div style={{ fontSize: 12, color: '#0f766e' }}>{exportMessage}</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
// 正常对局界面
  return (
    <div
      style={{
        padding: isNarrowLayout ? 14 : 25,
        minHeight: '100vh',
        background:
          'linear-gradient(135deg, #f5f5f5 0%, #e4f1ff 40%, #fef6e4 100%)',
        fontFamily: '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100%',
        }}
      >
        <header
          style={{
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>智连六子 · 弈境AI</h1>
            <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
              黑先 1 子，白 2 子，此后双方轮流各 2 子 · 支持人vs人/人vs机/机vs机
            </div>
          </div>

          <button
            onClick={() => setShowConsole(true)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: '#2563eb',
              border: 'none',
              color: 'white',
              fontSize: 14,
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
              whiteSpace: 'nowrap',
            }}
          >
            AI 控制台（开发中）
          </button>
        </header>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          <div
            style={{
              flex: '1 1 320px',
              padding: 12,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.92)',
              boxShadow: '0 4px 10px rgba(0,0,0,0.06)',
              minWidth: 280,
            }}
          >
            <div style={{ fontSize: 12, color: '#6b7280' }}>AI 性能概览</div>
            <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
              <div>
                <div style={{ fontSize: 13, color: '#111827' }}>平均思考</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>
                  {perfStats.avgThinkTimeMs.toFixed(0)} ms
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: '#111827' }}>最大思考</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>
                  {perfStats.maxThinkTimeMs.toFixed(0)} ms
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: '#111827' }}>平均深度</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>
                  {perfStats.searchDepthAvg.toFixed(1)}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              flex: '1 1 320px',
              padding: 12,
              borderRadius: 12,
              background: 'rgba(37,99,235,0.08)',
              border: '1px solid rgba(37,99,235,0.18)',
              minWidth: 280,
            }}
          >
            <div style={{ fontSize: 12, color: '#1d4ed8' }}>AI 控制台状态</div>
            <div style={{ marginTop: 6, color: '#0f172a', fontWeight: 700 }}>
              {gaStatusText}
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: '#334155' }}>
              当前模型：{modelProfile.name}
              {modelProfile.source === 'imported' ? '（外部导入）' : '（内置）'}
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              {bestWeights && (
                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: 10,
                    background: 'rgba(16,185,129,0.12)',
                    color: '#0f766e',
                    fontSize: 12,
                  }}
                >
                  已同步最佳权重
                </div>
              )}
              <button
                onClick={() => setShowConsole(true)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 10,
                  border: '1px solid #2563eb',
                  background: '#2563eb',
                  color: '#fff',
                  fontSize: 13,
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
                }}
              >
                打开控制台
              </button>
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 16,
            flex: 1,
            flexWrap: isNarrowLayout ? 'wrap' : 'nowrap',
          }}
        >
          {/* 左侧：棋盘 + 控制面板 */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {/* 控制面板 */}
            <div
              style={{
                padding: 12,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.9)',
                boxShadow: '0 4px 10px rgba(0,0,0,0.06)',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: '#666' }}>对局模式</div>
                <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => {
                      setGameMode('PVP');
                      hardReset();
                    }}
                    style={modeBtnStyle(gameMode === 'PVP')}
                  >
                    人人对战
                  </button>
                  <button
                    onClick={() => {
                      setGameMode('PVE');
                      hardReset();
                    }}
                    style={modeBtnStyle(gameMode === 'PVE')}
                  >
                    人机对战
                  </button>
                  <button
                    onClick={() => {
                      setGameMode('AIVSAI');
                      hardReset();
                    }}
                    style={modeBtnStyle(gameMode === 'AIVSAI')}
                  >
                    机机对战
                  </button>
                </div>
              </div>

              {gameMode === 'PVE' && (
                <div>
                  <div style={{ fontSize: 12, color: '#666' }}>人类执子</div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => {
                        setHumanPlayer('BLACK');
                        hardReset();
                      }}
                      style={modeBtnStyle(humanPlayer === 'BLACK')}
                    >
                      黑先
                    </button>
                    <button
                      onClick={() => {
                        setHumanPlayer('WHITE');
                        hardReset();
                      }}
                      style={modeBtnStyle(humanPlayer === 'WHITE')}
                    >
                      白后
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 12, color: '#666' }}>AI 策略</div>
                <select
                  value={strategyMode}
                  onChange={e =>
                    setStrategyMode(e.target.value as StrategyMode)
                  }
                  style={{
                    marginTop: 4,
                    padding: '4px 8px',
                    borderRadius: 8,
                    border: '1px solid #ccc',
                    fontSize: 13,
                  }}
                >
                  <option value="traditional">传统搜索（推荐，较快）</option>
                  <option value="auto">自动（混合策略）</option>
                  <option value="deep">深度 MCTS（更慢，体验用）</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666' }}>搜索参数</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <label style={{ fontSize: 12, color: '#444' }}>
                    深度
                    <input
                      type="number"
                      min={2}
                      max={5}
                      value={searchDepth}
                      onChange={e => setSearchDepth(Number(e.target.value) || 2)}
                      style={{
                        width: 70,
                        marginLeft: 6,
                        padding: '4px 6px',
                        borderRadius: 8,
                        border: '1px solid #d4d4d4',
                      }}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: '#444' }}>
                    时长 (ms)
                    <input
                      type="number"
                      min={500}
                      max={6000}
                      step={200}
                      value={searchTimeMs}
                      onChange={e =>
                        setSearchTimeMs(Number(e.target.value) || basePvsConfig.timeLimitMs)
                      }
                      style={{
                        width: 90,
                        marginLeft: 6,
                        padding: '4px 6px',
                        borderRadius: 8,
                        border: '1px solid #d4d4d4',
                      }}
                    />
                  </label>
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                  进入中后盘后自动 +1 深度、额外 400ms 思考，提升强度。
                </div>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <div style={{ fontSize: 12, color: '#666' }}>对局控制</div>
                <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                  <button onClick={hardReset} style={modeBtnStyle(false)}>
                    重新开局
                  </button>
                </div>
              </div>
            </div>

            {/* 棋盘区域 */}
            <div
              style={{
                flex: isNarrowLayout ? '1 1 100%' : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: isNarrowLayout ? 360 : 500,
              }}
            >
              <div
                style={{
                  padding: 12,
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.9)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                }}
              >
                <div style={{ marginBottom: 8, fontSize: 13 }}>
                  当前执手：
                  <strong>
                    {state.currentPlayer === 'BLACK' ? '黑' : '白'}
                  </strong>
                  <span style={{ marginLeft: 8, color: '#666' }}>
                    （应下{' '}
                    {getStonesToPlace(
                      state.moveNumber,
                      state.currentPlayer,
                    )}{' '}
                    子）
                  </span>

                  {/* 对局结果 */}
                  {state.winner && (
                    <>
                      {' '}
                      / 结果：
                      <strong>
                        {state.winner === 'DRAW'
                          ? '平局'
                          : state.winner === 'BLACK'
                          ? '黑胜'
                          : '白胜'}
                      </strong>
                    </>
                  )}

                  {/* AI 思考状态 */}
                  {aiThinking &&
                    isAIPlayer(state.currentPlayer) &&
                    !state.winner && (
                      <span style={{ marginLeft: 8, color: '#f97316' }}>
                        AI 正在思考…
                      </span>
                    )}
                </div>

                <GameBoard
                  state={state}
                  onHumanMove={handleHumanMove}
                  lastAIMove={lastAIMove?.move}
                  currentPlayerIsHuman={currentPlayerIsHuman}
                  stonesToPlace={getStonesToPlace(
                    state.moveNumber,
                    state.currentPlayer,
                  )}
                />
              </div>
            </div>
          </div>

          {/* 中列：关键路 & AI 性能 & 最近决策 */}
          <div
            style={{
              width: isNarrowLayout ? '100%' : 340,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flex: isNarrowLayout ? '1 1 100%' : undefined,
            }}
          >
            <div
              style={{
                flex: 1,
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                overflow: 'hidden',
              }}
            >
              <Roadmap state={state} focusPlayer={humanPlayer} />
            </div>

            <div
              style={{
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
              }}
            >
              <ReportGenerator stats={perfMonitor.getStats()} />
            </div>

            <div
              style={{
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                padding: 10,
                fontSize: 13,
              }}
            >
              <h3 style={{ margin: '4px 0 8px' }}>最近一次 AI 决策</h3>
              {lastAIMove ? (
                <>
                  <div>
                    评分：
                    <strong>{lastAIMove.score.toFixed(3)}</strong>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    落子：
                    {lastAIMove.move.positions
                      .map(p => `(${p.x},${p.y})`)
                      .join('，')}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    策略：
                    {lastAIMove.debugInfo?.strategy ?? '未知'}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    引擎：
                    {lastAIMove.debugInfo?.engine ?? '未知'}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    搜索深度：
                    {lastAIMove.debugInfo?.depth ??
                      (lastAiNodes != null ? '（见节点统计）' : '—')}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    搜索时间：
                    {lastAiThinkTimeMs != null
                      ? `${lastAiThinkTimeMs.toFixed(1)} ms`
                      : '—'}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    搜索节点：
                    {lastAiNodes != null ? lastAiNodes : '—'}
                  </div>
                </>
              ) : (
                <div style={{ color: '#666' }}>还没有 AI 落子记录。</div>
              )}
            </div>
          </div>

          {/* 右列：AI 实时分析系统 */}
          <div
            style={{
              //width: 300,
              flex: isNarrowLayout ? '1 1 100%' : 0.8,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                padding: 20,
                fontSize: 13,
                height: isNarrowLayout ? 'auto' : '80vh',
                maxHeight: isNarrowLayout ? undefined : '80vh',
                overflow: 'auto',
              }}
            >
              <AIAnalysisPanel history={aiHistory} />
            </div>
          </div>
        </div>
      </div>
      {consoleOverlay}
    </div>
  );
};

function modeBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 999,
    border: active ? '1px solid #2563eb' : '1px solid #d4d4d4',
    background: active ? '#2563eb' : '#ffffff',
    color: active ? '#ffffff' : '#333',
    fontSize: 13,
    cursor: 'pointer',
    transition: 'all 0.15s',
  };
}

function consoleTabBtnStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '6px 8px',
    borderRadius: 999,
    border: active ? '1px solid #2563eb' : '1px solid #d4d4d4',
    background: active ? '#2563eb' : '#ffffff',
    color: active ? '#ffffff' : '#333',
    fontSize: 13,
    cursor: 'pointer',
    transition: 'all 0.15s',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };
}

const consoleMainBtnStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 999,
  border: '1px solid #2563eb',
  background: '#2563eb',
  color: '#fff',
  fontSize: 13,
  cursor: 'pointer',
  marginTop: 8,
};

const consoleInputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: 4,
  padding: '6px 8px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  fontSize: 13,
  boxSizing: 'border-box',
};
