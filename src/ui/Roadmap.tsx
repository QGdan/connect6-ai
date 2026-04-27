import React, { useEffect, useMemo, useState } from 'react';
import type {
  AIMoveDecision,
  GameState,
  LocalProbeMove,
  Player,
  Position,
} from '../types';
import {
  computeRoadSuggestions,
  type RoadSuggestion,
} from '../core/road_suggestions';

interface RoadmapProps {
  state: GameState;
  focusPlayer: Player;
  lastAIMove?: AIMoveDecision | null;
  lastAiThinkTimeMs?: number | null;
  roadSuggestions?: RoadSuggestion[];
  analysisMode?: 'off' | 'light' | 'full';
  winProb?: number | null;
  winProbSource?: string | null;
  winProbPlayer?: Player | null;
  aiSide?: Player | null;
  valueFeatureSummary?: {
    player: Player;
    rows: { name: string; value: number }[];
  } | null;
  localProbeMoves?: LocalProbeMove[];
}

function formatPos(pos: Position): string {
  const letter = String.fromCharCode(65 + pos.x);
  return `${letter}${pos.y + 1}`;
}

function formatMs(value?: number | null): string {
  if (!Number.isFinite(value ?? NaN)) return '--';
  const ms = Math.max(0, value as number);
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function formatMoveLabel(move: LocalProbeMove['move']): string {
  return move.positions.map(formatPos).join(' + ');
}

function formatCount(value?: number | null): string {
  if (!Number.isFinite(value ?? NaN)) return '--';
  const safe = Math.max(0, value as number);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}百万`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}千`;
  return `${Math.round(safe)}`;
}

const FEATURE_LABELS: Record<string, string> = {
  win1_diff: '一手必胜',
  win2_diff: '两手必胜',
  live5_diff: '活五',
  charge5_diff: '冲五',
  live4_diff: '活四',
  charge4_diff: '冲四',
  double_four_diff: '双四',
  four_three_diff: '四三',
  double_three_diff: '双三',
  live3_diff: '活三',
  sleep3_diff: '眠三',
  attack_points_diff: '进攻点',
  defense_points_diff: '防守点',
};

function formatAnalysisMode(mode?: 'off' | 'light' | 'full'): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'full':
      return 'Full';
    case 'light':
    default:
      return 'Light';
  }
}

function formatPlayerLabel(player?: Player | null): string {
  if (player === 'BLACK') return '黑方';
  if (player === 'WHITE') return '白方';
  return '--';
}

function formatWinSource(source?: string | null): string {
  if (!source) return '--';
  switch (source) {
    case 'mcts':
      return 'MCTS';
    case 'pvs':
      return 'PVS';
    default:
      return source;
  }
}

function formatDebugModeLabel(label: string): string {
  switch (label) {
    case 'normal':
      return '常规';
    case 'threat_root':
      return '威胁根';
    case 'vcdt_root':
      return 'VCDT 根';
    case 'vcf_root':
      return 'VCF 根';
    case 'vct_root':
      return 'VCT 根';
    case 'vcf_defense':
      return 'VCF 防守';
    case 'vct_defense':
      return 'VCT 防守';
    default:
      return label;
  }
}

function formatStrategyLabel(label: string): string {
  switch (label) {
    case 'traditional':
      return '传统搜索';
    case 'deep':
      return '深度搜索';
    case 'auto':
      return '混合策略';
    case 'mcts_parallel':
      return 'MCTS 并行';
    default:
      return label;
  }
}

function formatReasonLabel(label: string): string {
  switch (label) {
    case 'normal':
      return '常规';
    case 'tactical':
      return '战术';
    case 'win':
      return '必胜';
    default:
      return label;
  }
}

export const Roadmap: React.FC<RoadmapProps> = ({
  state,
  focusPlayer,
  lastAIMove,
  lastAiThinkTimeMs,
  roadSuggestions,
  analysisMode,
  winProb,
  winProbSource,
  winProbPlayer,
  aiSide,
  valueFeatureSummary,
  localProbeMoves,
}) => {
  const debug = lastAIMove?.debugInfo ?? {};
  const lastMovePositions = lastAIMove?.move.positions ?? [];
  const engineLabel =
    (typeof debug.engine === 'string' && debug.engine) ||
    (typeof debug.strategy === 'string' && debug.strategy) ||
    '未知';
  const modeLabel = typeof debug.mode === 'string' ? debug.mode : 'normal';
  const reasonLabel = typeof debug.reason === 'string' ? debug.reason : 'normal';
  const strategyLabel =
    typeof debug.strategy === 'string' ? debug.strategy : engineLabel;
  const modeLabelDisplay = formatDebugModeLabel(modeLabel);
  const reasonLabelDisplay = formatReasonLabel(reasonLabel);
  const strategyLabelDisplay = formatStrategyLabel(strategyLabel);
  const focusLabel = focusPlayer === 'BLACK' ? '黑方' : '白方';
  const highlightMode =
    modeLabel === 'threat_root' ||
    modeLabel === 'vcdt_root' ||
    modeLabel === 'vcf_root' ||
    modeLabel === 'vct_root' ||
    modeLabel === 'vcf_defense' ||
    modeLabel === 'vct_defense';

  const winRate =
    typeof winProb === 'number'
      ? winProb
      : typeof debug.winRate === 'number'
      ? debug.winRate
      : null;
  const winPct = winRate != null ? Math.round(winRate * 100) : null;
  const winLabel = winPct != null ? `${winPct}%` : '--';
  const winSource = formatWinSource(
    winProbSource ?? (debug.winRate != null ? 'mcts' : null),
  );
  const winBasis = `基于 ${formatPlayerLabel(winProbPlayer)}`;
  const modeTag = formatAnalysisMode(analysisMode);
  const probeMoves = localProbeMoves ?? [];

  const [winView, setWinView] = useState<'bw' | 'ai'>(
    aiSide ? 'ai' : 'bw',
  );
  const [showRoutes, setShowRoutes] = useState(false);

  const top = useMemo(() => {
    if (!showRoutes) return [];
    return roadSuggestions ?? computeRoadSuggestions(state, focusPlayer, 6);
  }, [focusPlayer, roadSuggestions, showRoutes, state]);

  useEffect(() => {
    if (!aiSide && winView === 'ai') setWinView('bw');
  }, [aiSide, winView]);

  const { blackProb, whiteProb } = useMemo(() => {
    if (winRate == null || !winProbPlayer) {
      return { blackProb: null, whiteProb: null };
    }
    const black =
      winProbPlayer === 'BLACK' ? winRate : Math.max(0, 1 - winRate);
    return { blackProb: black, whiteProb: Math.max(0, 1 - black) };
  }, [winProbPlayer, winRate]);

  const aiProb =
    aiSide && blackProb != null && whiteProb != null
      ? aiSide === 'BLACK'
        ? blackProb
        : whiteProb
      : null;
  const oppProb = aiProb != null ? Math.max(0, 1 - aiProb) : null;

  const winRows =
    winView === 'ai' && aiProb != null && oppProb != null
      ? [
          { label: 'AI', value: aiProb },
          { label: '对手', value: oppProb },
        ]
      : [
          { label: '黑方', value: blackProb },
          { label: '白方', value: whiteProb },
        ];

  const mctsVisits =
    typeof debug.visits === 'number' ? debug.visits : null;
  const mctsTotal =
    typeof debug.totalVisits === 'number' ? debug.totalVisits : null;
  const mctsRoot = mctsTotal ?? mctsVisits;
  const mctsTarget =
    typeof debug.mctsVisitTarget === 'number' ? debug.mctsVisitTarget : null;
  const pvsNodes = typeof debug.nodes === 'number' ? debug.nodes : null;
  const pvsTarget =
    typeof debug.pvsNodeTarget === 'number' ? debug.pvsNodeTarget : null;

  const featureRows = valueFeatureSummary?.rows ?? [];
  const featurePlayer = valueFeatureSummary?.player ?? null;

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <h3 style={{ margin: 0 }}>关键路线 · AI 视角</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: focusPlayer === 'BLACK' ? '#111827' : '#e5e7eb',
              color: focusPlayer === 'BLACK' ? '#f8fafc' : '#111827',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {focusLabel}
          </div>
          <div
            style={{
              padding: '4px 10px',
              borderRadius: 999,
              background: '#f1f5f9',
              color: '#0f172a',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            分析：{modeTag}
          </div>
        </div>
      </div>

      <div
        style={{
          borderRadius: 16,
          padding: 14,
          background:
            'linear-gradient(135deg, rgba(15,23,42,0.98) 0%, rgba(30,41,59,0.96) 55%, rgba(30,64,175,0.9) 100%)',
          color: '#f8fafc',
          boxShadow: '0 10px 22px rgba(15,23,42,0.25)',
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: 0.6, color: '#e2e8f0' }}>
          胜率预测
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{winLabel}</div>
          <div style={{ fontSize: 11, color: '#cbd5f5' }}>来源 {winSource}</div>
          <div style={{ fontSize: 11, color: '#cbd5f5' }}>
            思考 {formatMs(lastAiThinkTimeMs)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setWinView('ai')}
            disabled={!aiSide}
            style={{
              padding: '3px 8px',
              borderRadius: 999,
              border: winView === 'ai' ? '1px solid #f59e0b' : '1px solid #334155',
              background: winView === 'ai' ? 'rgba(245,158,11,0.2)' : 'transparent',
              color: aiSide ? '#e2e8f0' : '#64748b',
              fontSize: 11,
              cursor: aiSide ? 'pointer' : 'not-allowed',
            }}
          >
            AI/对手
          </button>
          <button
            type="button"
            onClick={() => setWinView('bw')}
            style={{
              padding: '3px 8px',
              borderRadius: 999,
              border: winView === 'bw' ? '1px solid #f59e0b' : '1px solid #334155',
              background: winView === 'bw' ? 'rgba(245,158,11,0.2)' : 'transparent',
              color: '#e2e8f0',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            黑方/白方
          </button>
          <div style={{ fontSize: 11, color: '#cbd5f5' }}>{winBasis}</div>
        </div>
        <div
          style={{
            marginTop: 8,
            height: 8,
            borderRadius: 999,
            background: 'rgba(148,163,184,0.25)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${winPct ?? 0}%`,
              height: '100%',
              background:
                'linear-gradient(90deg, rgba(251,191,36,0.9) 0%, rgba(249,115,22,0.9) 50%, rgba(239,68,68,0.9) 100%)',
            }}
          />
        </div>
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {winRows.map(row => {
            const pct =
              typeof row.value === 'number' ? Math.round(row.value * 100) : null;
            return (
              <div key={row.label}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: '#e2e8f0',
                  }}
                >
                  <span>{row.label}</span>
                  <span>{pct != null ? `${pct}%` : '--'}</span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'rgba(148,163,184,0.25)',
                    overflow: 'hidden',
                    marginTop: 4,
                  }}
                >
                  <div
                    style={{
                      width: `${pct ?? 0}%`,
                      height: '100%',
                      background:
                        'linear-gradient(90deg, rgba(34,197,94,0.8) 0%, rgba(59,130,246,0.9) 100%)',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          borderRadius: 12,
          padding: '8px 10px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1px solid rgba(148,163,184,0.25)',
          boxShadow: '0 4px 10px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ fontSize: 11, color: '#64748b' }}>搜索统计</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
          <div>
            <div style={{ fontSize: 11, color: '#64748b' }}>MCTS 根节点</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
              {formatCount(mctsRoot)}
              {mctsTarget != null ? ` / ${formatCount(mctsTarget)}` : ''}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              选中次数 {formatCount(mctsVisits)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#64748b' }}>PVS 节点</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
              {formatCount(pvsNodes)}
              {pvsTarget != null ? ` / ${formatCount(pvsTarget)}` : ''}
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              深度 {typeof debug.depth === 'number' ? debug.depth : '--'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 999,
              background: 'rgba(15,23,42,0.06)',
              fontSize: 10,
              color: '#334155',
            }}
          >
            选择 {typeof debug.selection === 'string' ? debug.selection : '--'}
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 999,
              background: 'rgba(15,23,42,0.06)',
              fontSize: 10,
              color: '#334155',
            }}
          >
            阈值 {typeof debug.threshold === 'number' ? debug.threshold.toFixed(2) : '--'}
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 999,
              background: 'rgba(15,23,42,0.06)',
              fontSize: 10,
              color: '#334155',
            }}
          >
            复用 {debug.reuseDecay ?? '--'} / {debug.reuseTtl ?? '--'}
          </span>
        </div>
      </div>

      <div
        style={{
          borderRadius: 12,
          padding: '8px 10px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1px solid rgba(148,163,184,0.25)',
          boxShadow: '0 4px 10px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ fontSize: 11, color: '#64748b' }}>最近 AI 落子</div>
        {lastMovePositions.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {lastMovePositions.map((pos, idx) => (
              <span
                key={`${pos.x}-${pos.y}-${idx}`}
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'rgba(14,116,144,0.12)',
                  color: '#0f172a',
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {formatPos(pos)}
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>--</div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        {[
          {
            label: '策略',
            value: strategyLabelDisplay,
            highlight: false,
          },
          {
            label: '模式',
            value: modeLabelDisplay,
            highlight: highlightMode,
          },
          {
            label: '原因',
            value: reasonLabelDisplay,
            highlight:
              reasonLabel.includes('win') ||
              reasonLabel.includes('vcdt') ||
              reasonLabel.includes('vcf') ||
              reasonLabel.includes('vct') ||
              reasonLabel.includes('tactical'),
          },
        ].map((item, idx) => (
          <div
            key={idx}
            style={{
              padding: '6px 8px',
              borderRadius: 12,
              border: item.highlight
                ? '1px solid rgba(251,191,36,0.6)'
                : '1px solid rgba(148,163,184,0.3)',
              background: item.highlight
                ? 'linear-gradient(135deg, rgba(251,191,36,0.24) 0%, rgba(249,115,22,0.3) 100%)'
                : 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
              boxShadow: item.highlight
                ? '0 6px 12px rgba(249,115,22,0.2)'
                : '0 4px 10px rgba(15,23,42,0.06)',
            }}
          >
            <div style={{ fontSize: 11, color: '#64748b' }}>{item.label}</div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: item.highlight ? '#7c2d12' : '#0f172a',
                wordBreak: 'break-word',
              }}
            >
              {item.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          borderRadius: 12,
          padding: '8px 10px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          border: '1px solid rgba(148,163,184,0.25)',
          boxShadow: '0 4px 10px rgba(15,23,42,0.06)',
        }}
      >
        <div style={{ fontSize: 11, color: '#64748b' }}>
          威胁摘要 {featurePlayer ? `(${formatPlayerLabel(featurePlayer)})` : ''}
        </div>
        {featureRows.length === 0 ? (
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
            暂无特征变化。
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {featureRows.map(row => {
              const label = FEATURE_LABELS[row.name] ?? row.name;
              const value = row.value;
              const tone = value >= 0 ? '#15803d' : '#b91c1c';
              return (
                <span
                  key={row.name}
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(15,23,42,0.06)',
                    fontSize: 11,
                    color: tone,
                    fontWeight: 600,
                  }}
                >
                  {label} {value >= 0 ? '+' : ''}{value}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          局部候选（评估）
        </div>
        {probeMoves.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 12 }}>暂无局部探测数据。</div>
        ) : (
          probeMoves.map((mv, idx) => {
            const pct = Math.round(mv.winProb * 100);
            return (
              <div key={idx} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    color: '#111827',
                  }}
                >
                  <span>#{idx + 1} {formatMoveLabel(mv.move)}</span>
                  <span>{pct}%</span>
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  评分 {mv.score.toFixed(1)}
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: '#e2e8f0',
                    overflow: 'hidden',
                    marginTop: 4,
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: '100%',
                      background:
                        'linear-gradient(90deg, #f59e0b 0%, #ef4444 70%)',
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>关键路线</div>
          <button
            type="button"
            onClick={() => setShowRoutes(prev => !prev)}
            style={{
              padding: '2px 6px',
              borderRadius: 999,
              border: '1px solid #cbd5f5',
              background: showRoutes ? '#e0e7ff' : '#ffffff',
              color: '#1e3a8a',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {showRoutes ? '隐藏' : '显示'}
          </button>
        </div>
        {showRoutes ? (
          <>
            {top.length === 0 && (
              <div style={{ color: '#64748b', fontSize: 12 }}>
                暂无关键路线。
              </div>
            )}
            {top.map((r, idx) => {
              const ratio = Math.min(1, r.count / 6);
              const extensions = r.extensions;
              return (
                <div key={idx} style={{ marginBottom: 8 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                      color: '#111827',
                    }}
                  >
                    <span>#{idx + 1}</span>
                    <span>{r.count}/6</span>
                  </div>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 999,
                      background: '#e2e8f0',
                      overflow: 'hidden',
                      marginTop: 4,
                    }}
                  >
                    <div
                      style={{
                        width: `${ratio * 100}%`,
                        height: '100%',
                        background:
                          'linear-gradient(90deg, #38bdf8 0%, #2563eb 55%, #1e3a8a 100%)',
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    {r.cells.map(formatPos).join(' - ')}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {extensions.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {extensions.map((ext, i) => (
                          <span
                            key={i}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 999,
                              background: 'rgba(37,99,235,0.1)',
                              color: '#1e3a8a',
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            {ext.dir === 'left' ? '<-' : '->'} {formatPos(ext.pos)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        暂无扩展点。
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 6 }}>
            已隐藏（点击查看路线）。
          </div>
        )}
      </div>
    </div>
  );
};
