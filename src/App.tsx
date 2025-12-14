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

// 估值权重
const defaultWeights: EvaluationWeights = {
  road_3_score: 100,
  road_4_score: 350,
  live4_score: 3000,
  live5_score: 9000,
  vcdt_bonus: 1500,
};

// 控制思考时间
const pvsConfig: SearchConfig = {
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

export const App: React.FC = () => {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [aiThinking, setAiThinking] = useState(false);
  const [lastAIMove, setLastAIMove] = useState<AIMoveDecision | null>(null);

  const [gameMode, setGameMode] = useState<GameMode>('PVE');
  const [strategyMode, setStrategyMode] =
    useState<StrategyMode>('traditional'); // 默认传统搜索
  const [humanPlayer, setHumanPlayer] = useState<Player>('BLACK');

  // AI 性能数据
  const [lastAiThinkTimeMs, setLastAiThinkTimeMs] =
    useState<number | null>(null);
  const [lastAiNodes, setLastAiNodes] = useState<number | null>(null);

  // AI 历史记录，用于实时分析图
  const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);

  // 是否进入控制台 & 当前控制台 tab
  const [showConsole, setShowConsole] = useState(false);
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('evolve');

  const perfMonitor = useMemo(() => new PerformanceMonitor(), []);

  const { strategyManager, mcts } = useMemo(() => {
    const resnet = new DummyResNetEvaluator();
    const mctsAI = new MCTSConnect6AI(resnet, mctsConfig);
    const manager = new HybridStrategyManager(mctsAI, resnet, {
      pvsConfig,
      weights: defaultWeights,
    });
    return { strategyManager: manager, mcts: mctsAI };
  }, []);

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
          defaultWeights,
          pvsConfig,
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
    [strategyMode, mcts, strategyManager],
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

        perfMonitor.recordThinkTime(thinkTime, pvsConfig.maxDepth);

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

  // 控制台模式界面
  if (showConsole) {
    return (
      <div
        style={{
          padding: 16,
          minHeight: '100vh',
          background:
            'linear-gradient(135deg, #eef2ff 0%, #e0f7ff 40%, #fdf2e9 100%)',
          fontFamily:
            '"Segoe UI", system-ui, -apple-system, BlinkMacSystemFont',
          boxSizing: 'border-box',
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
            <h1 style={{ margin: 0, fontSize: 22 }}>AI 控制台 · 弈境实验室</h1>
            <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
              在这里可以进行自进化训练、深度模型管理和模型导出（当前为原型界面）
            </div>
          </div>

          <button
            onClick={() => setShowConsole(false)}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              background: '#4b5563',
              border: 'none',
              color: 'white',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            返回对局
          </button>
        </header>

        <div style={{ display: 'flex', gap: 16, minHeight: 500 }}>
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
                minWidth: 480,
              }}
            >
              <div style={{ marginBottom: 8, fontSize: 13 }}>
                训练可视化棋盘（当前展示最新局面，暂不支持手动操作）
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
              width: 380,
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
                  深度学习模型
                </button>
                <button
                  onClick={() => setConsoleTab('export')}
                  style={consoleTabBtnStyle(consoleTab === 'export')}
                >
                  模型导出
                </button>
              </div>
            </div>

            {/* tab 对应内容 */}
            <div
              style={{
                flex: 1,
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                padding: 12,
                fontSize: 13,
                overflow: 'auto',
              }}
            >
              {consoleTab === 'evolve' && (
                <div>
                  <h3 style={{ marginTop: 0 }}>自进化训练（遗传算法）</h3>
                  <p style={{ color: '#555' }}>
                    这里将来会接入基于遗传算法的自对弈训练系统：
                    <br />
                    · 随机初始化一批参数个体（权重向量）
                    <br />
                    · 让它们两两对弈，计算胜率/评分作为适应度
                    <br />
                    · 选择 &amp; 交叉 &amp; 变异，生成下一代
                    <br />
                    · 把最优个体同步给前端 AI 进行对弈展示
                  </p>
                  <button style={consoleMainBtnStyle}>
                    启动自进化训练（占位）
                  </button>
                </div>
              )}

              {consoleTab === 'deep' && (
                <div>
                  <h3 style={{ marginTop: 0 }}>深度学习模型</h3>
                  <p style={{ color: '#555' }}>
                    这里可以挂载 / 切换不同版本的 ResNet / 深度策略模型，
                    并查看其表现、版本号、训练时间等。
                  </p>
                  <button style={consoleMainBtnStyle}>
                    加载模型（占位）
                  </button>
                </div>
              )}

              {consoleTab === 'export' && (
                <div>
                  <h3 style={{ marginTop: 0 }}>模型导出</h3>
                  <p style={{ color: '#555' }}>
                    这里将支持导出当前最优参数（权重、配置等）为 JSON /
                    ONNX 等格式，用于部署到服务器或移动端。
                  </p>
                  <button style={consoleMainBtnStyle}>
                    导出当前模型参数（占位）
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 正常对局界面
  return (
    <div
      style={{
        padding: 25,
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

        <div style={{ display: 'flex', gap: 16, flex: 1 }}>
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
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 500,
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
              width: 340,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
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
              flex: 0.8,
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
                height: '80vh',
                overflow: 'auto',
              }}
            >
              <AIAnalysisPanel history={aiHistory} />
            </div>
          </div>
        </div>
      </div>
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
