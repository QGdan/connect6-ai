import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { GameBoard } from './ui/GameBoard';
import { Roadmap } from './ui/Roadmap';
import { AIAnalysisPanel } from './ui/AIAnalysisPanel';
import type { AIHistoryItem } from './ui/AIAnalysisPanel';
import { TrainerConsolePanel } from './ui/TrainerConsolePanel';

import { BOARD_SIZE } from './types';
import type {
  AIMoveDecision,
  EvaluationWeights,
  GameState,
  LocalProbeMove,
  Move,
  Player,
  Position,
  SearchConfig,
} from './types';
import type {
  Run,
  RunAlert,
  RunLogEntry,
  RunStatus,
  TimeseriesPoint,
  GameSample,
} from './types/trainer';

import { createInitialState } from './core/game_state';
import { getStonesToPlace, tryApplyMoveWithWinner } from './core/rules';
import {
  countHybridTurnsSoFar,
  getHybridTurnPlan,
  type HumanVsAiMode,
  type HybridTurnPlan,
} from './core/coop_mode';
import { createEvaluatorFromSnapshot } from './core/resnet_ai';
import { MCTSConnect6AI } from './core/mcts_ai_engine';
import { MCTSParallelRunner } from './core/mcts_worker_pool';
import { HybridStrategyManager } from './strategy/hybrid_strategy';
import { PerformanceMonitor } from './strategy/performance_monitor';
import { getOpeningMove } from './core/opening_book';
import { SelfPlayOptimizer } from './core/self_play_optimizer';
import { computeRoadSuggestions } from './core/road_suggestions';
import { generateLocalCandidates } from './core/local_candidates';
import { PatternEvaluator } from './core/pattern_evaluator';
import { sortByCenter } from './core/position_utils';
import { computeValueFeatures } from './core/value_features';
import {
  TrainingWorkerClient,
  type EvaluationStats,
  type GameRecordSummary,
} from './core/training_worker_client';
import { trainValueModel } from './core/value_trainer';
import type { ValueTrainingSample } from './core/value_trainer';
import {
  isValueModelCompatible,
  type ValueModelSnapshot,
} from './core/value_model_snapshot';
import type { TrainingSampleStats } from './core/training_dataset';
import {
  exportValueModelCpp,
  exportValueModelJson,
  exportValueModelPy,
  exportValueModelTs,
} from './core/value_model_export';
import {
  pvsSearchBestMove,
  getLastSearchStats,
  evaluateWithThreatReport,
} from './core/pvs_search';
import {
  buildFilename,
  generateKifuString,
  saveKifuTextToFile,
  type KifuMeta,
} from './utils/kifu';

// 估值权重
const initialWeights: EvaluationWeights = {
  road_3_score: 100,
  road_4_score: 350,
  live4_score: 3000,
  live5_score: 9000,
  vcdt_bonus: 1500,
};

// 控制思考时间
const pvsConfig: SearchConfig = {
  maxDepth: 5,
  timeLimitMs: 5000,
  useMultithreading: false,
};

// MCTS 配置（deep 模式用）
const mctsConfig = {
  simulationCount: 200,
  simulationSteps: 8,
  expandNodes: 12,
  minWinRateThreshold: 0.3,
  reuseDecay: 0.9,
  reuseTtl: 6,
};

const MCTS_WORKERS =
  typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? Math.min(6, Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)))
    : 4;

// MCTS config for deep mode (parallel)
const mctsDeepConfig = {
  simulationCount: 15000,
  simulationSteps: 10,
  expandNodes: 16,
  minWinRateThreshold: 0.25,
  maxTableEntries: 800_000,
  reuseDecay: 0.9,
  reuseTtl: 6,
  useWorkers: true,
  workerCount: MCTS_WORKERS,
};

const pvsNodeTarget = Math.max(40_000, pvsConfig.maxDepth * 15_000);

const hintCandidateGenerator = (state: GameState) =>
  generateLocalCandidates(state, 3, 12);

const mctsHintConfig = {
  simulationCount: 800,
  simulationSteps: 6,
  expandNodes: 10,
  minWinRateThreshold: 0,
  maxTableEntries: 80_000,
  reuseDecay: 0.9,
  reuseTtl: 4,
  candidateGenerator: hintCandidateGenerator,
};

const mctsVisitTargetMain = mctsConfig.simulationCount;
const mctsVisitTargetDeep = mctsDeepConfig.simulationCount;
const mctsVisitTargetHint = mctsHintConfig.simulationCount;
const MODEL_STORAGE_KEY = 'connect6:valueModelSnapshot';

type GameMode = 'PVP' | 'PVE' | 'AIVSAI';
type StrategyMode = 'auto' | 'traditional' | 'deep';
type AnalysisMode = 'off' | 'light' | 'full';
type TurnActor = 'HUMAN_A' | 'HUMAN_B' | 'AI';
type SelfPlayMode = 'fast' | 'normal' | 'deep';
type TrainingSource = 'selfplay' | 'jsonl';

// 控制台的 3 个 Tab 类型
type ConsoleTab = 'evolve' | 'deep' | 'export';

type TrainingProgress = {
  phase?: 'generate' | 'parse' | 'train' | 'evaluate';
  games?: number;
  lines?: number;
  samples?: number;
  seen?: number;
  elapsedMs?: number;
  epoch?: number;
  totalEpochs?: number;
  loss?: number;
  step?: number;
  totalSteps?: number;
};

type CoopTurnContext = {
  sideOfA: Player;
  sideOfHybrid: Player;
  hybridTurnIndex: number;
  hybridPlan: HybridTurnPlan | null;
  stonesToPlace: number;
  currentActor: TurnActor;
  coopEnabled: boolean;
  isHybridTurn: boolean;
};

type GameSnapshot = {
  state: GameState;
  lastAIMove: AIMoveDecision | null;
  lastAiThinkTimeMs: number | null;
  lastAiNodes: number | null;
  aiHistory: AIHistoryItem[];
  blackTimeMs: number;
  whiteTimeMs: number;
  blackLastTurnMs: number;
  whiteLastTurnMs: number;
  turnStartMs: number;
};

type LocalProbeResult = {
  winProb: number | null;
  moves: LocalProbeMove[];
  points: Position[];
  source: 'eval' | 'mcts';
  forPlayer: Player;
};

const nowMs = (): number =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

const scoreToWinProb = (score: number): number => {
  if (!Number.isFinite(score)) return 0.5;
  const bounded = Math.max(-200_000, Math.min(200_000, score));
  const scaled = bounded / 12_000;
  const t = Math.tanh(scaled);
  return Math.max(0.01, Math.min(0.99, 0.5 + 0.5 * t));
};

const STAR_POINTS = new Set(
  [
    [3, 3],
    [3, 9],
    [3, 15],
    [9, 3],
    [9, 9],
    [9, 15],
    [15, 3],
    [15, 9],
    [15, 15],
  ].map(point => point.join(',')),
);

const classifyOpening = (move?: Move): string => {
  if (!move || move.positions.length === 0) return '未知';
  const { x, y } = move.positions[0];
  const center = Math.floor(BOARD_SIZE / 2);
  if (Math.abs(x - center) <= 2 && Math.abs(y - center) <= 2) return '中心';
  if (STAR_POINTS.has(`${x},${y}`)) return '星位';
  if (x <= 2 || y <= 2 || x >= BOARD_SIZE - 3 || y >= BOARD_SIZE - 3) {
    return '边角';
  }
  return '侧翼';
};

const buildGameSample = (
  record: GameRecordSummary,
  index: number,
  source: 'selfplay' | 'eval',
  seed: number,
): GameSample => ({
  id: `${source}-${index + 1}-${record.moves.length}`,
  source,
  moves: record.moves.map((move, moveIndex) => ({
    ply: moveIndex + 1,
    stones: move.positions.map(pos => ({
      x: pos.x,
      y: pos.y,
      color: move.player,
    })),
  })),
  result:
    record.winner === 'BLACK' || record.winner === 'WHITE'
      ? record.winner
      : 'DRAW',
  meta: {
    openingId: classifyOpening(record.moves[0]),
    seed,
  },
});

const buildLengthHist = (samples: GameSample[]) => {
  const buckets = [
    { bucket: '0-40', min: 0, max: 40, count: 0 },
    { bucket: '41-80', min: 41, max: 80, count: 0 },
    { bucket: '81-120', min: 81, max: 120, count: 0 },
    { bucket: '120+', min: 121, max: Number.POSITIVE_INFINITY, count: 0 },
  ];
  for (const sample of samples) {
    const moves = sample.moves.length;
    const bucket = buckets.find(entry => moves >= entry.min && moves <= entry.max);
    if (bucket) bucket.count += 1;
  }
  return buckets.map(({ bucket, count }) => ({ bucket, count }));
};

const buildOpeningsTop = (samples: GameSample[]) => {
  const keys = ['中心', '星位', '侧翼', '边角'];
  const counts = new Map<string, number>(keys.map(key => [key, 0]));
  for (const sample of samples) {
    const key = sample.meta.openingId || '侧翼';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return keys.map(key => ({ id: key, count: counts.get(key) ?? 0 }));
};

const MainApp: React.FC = () => {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [aiThinking, setAiThinking] = useState(false);
  const [lastAIMove, setLastAIMove] = useState<AIMoveDecision | null>(null);
  const [weights, setWeights] = useState<EvaluationWeights>(initialWeights);
  const [history, setHistory] = useState<GameSnapshot[]>([]);
  const [gameMoves, setGameMoves] = useState<Move[]>([]);
  const [blackTimeMs, setBlackTimeMs] = useState(0);
  const [whiteTimeMs, setWhiteTimeMs] = useState(0);
  const [blackLastTurnMs, setBlackLastTurnMs] = useState(0);
  const [whiteLastTurnMs, setWhiteLastTurnMs] = useState(0);
  const [gameStarted, setGameStarted] = useState(false);
  const [turnStartMs, setTurnStartMs] = useState(() => nowMs());
  const aiActionIdRef = useRef(0);

  const [gameMode, setGameMode] = useState<GameMode>('PVE');
  const [strategyMode, setStrategyMode] =
    useState<StrategyMode>('traditional'); // 默认传统搜索
  const [humanPlayer, setHumanPlayer] = useState<Player>('BLACK');
  const [humanVsAiMode, setHumanVsAiMode] =
    useState<HumanVsAiMode>('normal');
  const [analysisMode, setAnalysisMode] =
    useState<AnalysisMode>('light');

  // AI 性能数据
  const [lastAiThinkTimeMs, setLastAiThinkTimeMs] =
    useState<number | null>(null);
  const [lastAiNodes, setLastAiNodes] = useState<number | null>(null);
  const mctsHintReqRef = useRef(0);
  const [mctsHintMove, setMctsHintMove] = useState<Move | null>(null);
  const [localProbe, setLocalProbe] = useState<LocalProbeResult | null>(null);
  const localProbeReqRef = useRef(0);

  // AI 历史记录，用于实时分析图
  const [aiHistory, setAiHistory] = useState<AIHistoryItem[]>([]);
  const [showKifuDialog, setShowKifuDialog] = useState(false);
  const [kifuMetaDraft, setKifuMetaDraft] = useState<KifuMeta | null>(null);

  // 是否进入控制台 & 当前控制台 tab
  const [showConsole, setShowConsole] = useState(false);
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>('evolve');
  const [gaRunning, setGaRunning] = useState(false);
  const [gaStatus, setGaStatus] = useState<string>('未开始');
  const [gaHistory, setGaHistory] = useState<
    { generation: number; bestFitness: number; avgFitness: number }[]
  >([]);
  const [gaBest, setGaBest] = useState<EvaluationWeights | null>(null);
  const [gaEvents, setGaEvents] = useState<string[]>([]);
  const [autoApplyBest, setAutoApplyBest] = useState(false);
  const [, setGaSimCount] = useState(0);
  const [gaConfig, setGaConfig] = useState({
    populationSize: 5,
    generations: 4,
    mutationRate: 0.12,
    gamesPerIndividual: 1,
    maxMovesPerGame: 20,
    pvsConfig: { ...pvsConfig, maxDepth: 5, timeLimitMs: 40 },
    usePrevBestAsOpponent: true,
    maxOpponentPoolSize: 2,
    updateBaselineEachGen: false,
  });
  const trainingWorkerRef = useRef<TrainingWorkerClient | null>(null);
  const trainingSamplesRef = useRef<ValueTrainingSample[]>([]);
  const [trainingSource, setTrainingSource] =
    useState<TrainingSource>('selfplay');
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState('空闲');
  const [trainingProgress, setTrainingProgress] =
    useState<TrainingProgress | null>(null);
  const [trainingStats, setTrainingStats] =
    useState<TrainingSampleStats | null>(null);
  const [trainedModel, setTrainedModel] =
    useState<ValueModelSnapshot | null>(null);
  const [appliedModel, setAppliedModel] =
    useState<ValueModelSnapshot | null>(null);
  const [trainingLosses, setTrainingLosses] = useState<number[]>([]);
  const [trainingGameSamples, setTrainingGameSamples] = useState<GameSample[]>([]);
  const [evalGameSamples, setEvalGameSamples] = useState<GameSample[]>([]);
  const [trainingConfig, setTrainingConfig] = useState({
    epochs: 12,
    lr: 0.02,
    l2: 0.001,
    seed: 42,
  });
  const [selfPlayConfig, setSelfPlayConfig] = useState({
    games: 500,
    timeMs: 200,
    mode: 'normal' as SelfPlayMode,
    randomOpeningPlies: 3,
    seed: 12345,
    augment: true,
    maxSamples: 160_000,
  });
  const [importConfig, setImportConfig] = useState({
    maxSamples: 80_000,
    seed: 42,
  });
  const [evalConfig, setEvalConfig] = useState({
    games: 20,
    timeMs: 120,
    mode: 'normal' as SelfPlayMode,
    randomOpeningPlies: 3,
    seed: 777,
  });
  const [evalStats, setEvalStats] = useState<EvaluationStats | null>(null);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalStatus, setEvalStatus] = useState('空闲');
  const [clockTick, setClockTick] = useState(0);
  const trainerRunCreatedAtRef = useRef(new Date().toISOString());
  const [trainerRunUpdatedAt, setTrainerRunUpdatedAt] = useState(
    trainerRunCreatedAtRef.current,
  );

  const coopContext = useMemo<CoopTurnContext>(() => {
    const sideOfA: Player = humanPlayer;
    const sideOfHybrid: Player = sideOfA === 'BLACK' ? 'WHITE' : 'BLACK';
    const coopEnabled = gameMode === 'PVE' && humanVsAiMode === 'coop';
    const hybridTurnsCompleted = coopEnabled
      ? countHybridTurnsSoFar(gameMoves, sideOfHybrid)
      : 0;
    const isHybridTurn = coopEnabled && state.currentPlayer === sideOfHybrid;
    const hybridTurnIndex = isHybridTurn
      ? hybridTurnsCompleted + 1
      : hybridTurnsCompleted;
    const hybridPlan =
      isHybridTurn && hybridTurnIndex > 0
        ? getHybridTurnPlan(sideOfHybrid, hybridTurnIndex)
        : null;
    const stonesToPlace =
      isHybridTurn && hybridPlan
        ? hybridPlan.stones
        : getStonesToPlace(state.moveNumber, state.currentPlayer);

    let currentActor: TurnActor;
    if (coopEnabled) {
      if (state.currentPlayer === sideOfA) {
        currentActor = 'HUMAN_A';
      } else if (hybridPlan?.actor === 'AI') {
        currentActor = 'AI';
      } else {
        currentActor = 'HUMAN_B';
      }
    } else if (gameMode === 'PVP') {
      currentActor = 'HUMAN_A';
    } else if (gameMode === 'AIVSAI') {
      currentActor = 'AI';
    } else {
      currentActor = state.currentPlayer === sideOfA ? 'HUMAN_A' : 'AI';
    }

    return {
      sideOfA,
      sideOfHybrid,
      hybridTurnIndex,
      hybridPlan,
      stonesToPlace,
      currentActor,
      coopEnabled,
      isHybridTurn,
    };
  }, [
    gameMode,
    gameMoves,
    humanPlayer,
    humanVsAiMode,
    state.currentPlayer,
    state.moveNumber,
  ]);

  const roadSuggestions = useMemo(
    () => computeRoadSuggestions(state, humanPlayer, 6),
    [state, humanPlayer],
  );

  const mctsSuggestedPoints = useMemo(() => {
    if (analysisMode !== 'full' || !mctsHintMove) return [];
    return mctsHintMove.positions.filter(
      p => state.board[p.y]?.[p.x] === 0,
    );
  }, [analysisMode, mctsHintMove, state.board]);

  const computeLocalProbe = useCallback(
    (
      current: GameState,
      toMove: Player,
      mode: AnalysisMode,
    ): LocalProbeResult => {
      const candidates = sortByCenter(generateLocalCandidates(current, 3, 12));
      const stones = getStonesToPlace(current.moveNumber, toMove);
      const maxPoints = mode === 'light' ? 8 : 12;
      const maxMoves = mode === 'light' ? 3 : 5;
      const maxCombos = mode === 'light' ? 18 : 36;
      const pool = candidates.slice(0, maxPoints);
      const patternEval = new PatternEvaluator(toMove);

      const moves: LocalProbeMove[] = [];
      if (stones === 1) {
        for (const p of pool) {
          const move: Move = { player: toMove, positions: [p] };
          const applied = tryApplyMoveWithWinner(current, move);
          if (!applied.ok) continue;
          const score = evaluateWithThreatReport(
            applied.state,
            toMove,
            weights,
            undefined,
            patternEval,
          );
          moves.push({ move, score, winProb: scoreToWinProb(score) });
          if (moves.length >= maxCombos) break;
        }
      } else {
        for (let i = 0; i < pool.length; i += 1) {
          for (let j = i + 1; j < pool.length; j += 1) {
            const move: Move = {
              player: toMove,
              positions: [pool[i], pool[j]],
            };
            const applied = tryApplyMoveWithWinner(current, move);
            if (!applied.ok) continue;
            const score = evaluateWithThreatReport(
              applied.state,
              toMove,
              weights,
              undefined,
              patternEval,
            );
            moves.push({ move, score, winProb: scoreToWinProb(score) });
            if (moves.length >= maxCombos) break;
          }
          if (moves.length >= maxCombos) break;
        }
      }

      moves.sort((a, b) => b.score - a.score);
      const topMoves = moves.slice(0, maxMoves);
      const points: Position[] = [];
      const seen = new Set<number>();
      const pointLimit = mode === 'light' ? 5 : 7;
      for (const mv of topMoves) {
        for (const p of mv.move.positions) {
          const key = p.y * BOARD_SIZE + p.x;
          if (seen.has(key)) continue;
          seen.add(key);
          points.push(p);
          if (points.length >= pointLimit) break;
        }
        if (points.length >= pointLimit) break;
      }

      const aiSide =
        gameMode === 'PVE'
          ? humanPlayer === 'BLACK'
            ? 'WHITE'
            : 'BLACK'
          : toMove;
      const evalPattern = new PatternEvaluator(aiSide);
      const evalScore = evaluateWithThreatReport(
        current,
        aiSide,
        weights,
        undefined,
        evalPattern,
      );

      return {
        winProb: scoreToWinProb(evalScore),
        moves: topMoves,
        points,
        source: 'eval',
        forPlayer: aiSide,
      };
    },
    [gameMode, humanPlayer, weights],
  );

  const localProbePoints = useMemo(
    () => (analysisMode === 'off' ? [] : localProbe?.points ?? []),
    [analysisMode, localProbe?.points],
  );
  const aiSide: Player | null =
    gameMode === 'PVE'
      ? humanPlayer === 'BLACK'
        ? 'WHITE'
        : 'BLACK'
      : null;

  const winProbFromDecision =
    typeof lastAIMove?.debugInfo?.winRate === 'number'
      ? lastAIMove.debugInfo.winRate
      : null;
  const winProb = winProbFromDecision ?? localProbe?.winProb ?? null;
  const winProbSource =
    winProbFromDecision != null ? 'mcts' : localProbe?.source ?? null;
  const winProbPlayer =
    winProbFromDecision != null
      ? lastAIMove?.move.player ?? null
      : localProbe?.forPlayer ?? null;
  const featurePlayer = winProbPlayer ?? aiSide ?? state.currentPlayer;
  const valueFeatureSummary = useMemo(() => {
    if (analysisMode === 'off') return null;
    const { features, names } = computeValueFeatures(state, featurePlayer);
    const rows = names.map((name, idx) => ({ name, value: features[idx] }));
    rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const nonZero = rows.filter(row => row.value !== 0);
    const topRows = (nonZero.length > 0 ? nonZero : rows).slice(0, 8);
    return { player: featurePlayer, rows: topRows };
  }, [analysisMode, featurePlayer, state]);

  const perfMonitor = useMemo(() => new PerformanceMonitor(), []);

  const { strategyManager, mctsHint, mctsParallel } = useMemo(() => {
    const resnet = createEvaluatorFromSnapshot(appliedModel);
    const mctsAI = new MCTSConnect6AI(resnet, mctsConfig);
    const manager = new HybridStrategyManager(mctsAI, resnet, {
      pvsConfig,
      weights,
    });
    const hintAI = new MCTSConnect6AI(resnet, mctsHintConfig);
    const deepAI = new MCTSParallelRunner(resnet, mctsDeepConfig);
    return {
      strategyManager: manager,
      mctsHint: hintAI,
      mctsParallel: deepAI,
    };
  }, [appliedModel, weights]);

  useEffect(() => () => mctsParallel.dispose(), [mctsParallel]);
  useEffect(() => {
    const client = new TrainingWorkerClient();
    trainingWorkerRef.current = client;
    return () => {
      trainingWorkerRef.current = null;
      client.dispose();
    };
  }, []);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    if (!raw) return;
    try {
      const snapshot = JSON.parse(raw) as ValueModelSnapshot;
      if (snapshot && isValueModelCompatible(snapshot)) {
        setAppliedModel(snapshot);
      }
    } catch {
      // ignore invalid cache
    }
  }, []);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (appliedModel) {
      localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(appliedModel));
    } else {
      localStorage.removeItem(MODEL_STORAGE_KEY);
    }
  }, [appliedModel]);

  // 当前这个 player 是否由 AI 控制？
  const isAIPlayer = useCallback(
    (player: Player): boolean =>
      player === state.currentPlayer &&
      coopContext.currentActor === 'AI',
    [coopContext.currentActor, state.currentPlayer],
  );

  const hardReset = useCallback(() => {
    aiActionIdRef.current += 1;
    setState(createInitialState());
    setLastAIMove(null);
    setAiThinking(false);
    setLastAiThinkTimeMs(null);
    setLastAiNodes(null);
    setMctsHintMove(null);
    setLocalProbe(null);
    setAiHistory([]); // 清空历史
    setHistory([]);
    setGameMoves([]);
    setBlackTimeMs(0);
    setWhiteTimeMs(0);
    setBlackLastTurnMs(0);
    setWhiteLastTurnMs(0);
    setGameStarted(false);
    setTurnStartMs(nowMs());
  }, []);

  const pushHistorySnapshot = useCallback(() => {
    setHistory(prev => [
      ...prev,
      {
        state,
        lastAIMove,
        lastAiThinkTimeMs,
        lastAiNodes,
        aiHistory,
        blackTimeMs,
        whiteTimeMs,
        blackLastTurnMs,
        whiteLastTurnMs,
        turnStartMs,
      },
    ]);
  }, [
    aiHistory,
    blackTimeMs,
    blackLastTurnMs,
    lastAIMove,
    lastAiNodes,
    lastAiThinkTimeMs,
    state,
    turnStartMs,
    whiteLastTurnMs,
    whiteTimeMs,
  ]);

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    aiActionIdRef.current += 1;
    const pveUndo =
      gameMode === 'PVE' &&
      humanVsAiMode === 'normal' &&
      state.currentPlayer === humanPlayer;
    const steps = Math.min(history.length, pveUndo ? 2 : 1);
    const snapshot = history[history.length - steps];
    setHistory(prev => prev.slice(0, prev.length - steps));
    setGameMoves(prev => prev.slice(0, Math.max(0, prev.length - steps)));
    setState(snapshot.state);
    setLastAIMove(snapshot.lastAIMove);
    setLastAiThinkTimeMs(snapshot.lastAiThinkTimeMs);
    setLastAiNodes(snapshot.lastAiNodes);
    setAiHistory(snapshot.aiHistory);
    setBlackTimeMs(snapshot.blackTimeMs);
    setWhiteTimeMs(snapshot.whiteTimeMs);
    setBlackLastTurnMs(snapshot.blackLastTurnMs);
    setWhiteLastTurnMs(snapshot.whiteLastTurnMs);
    setTurnStartMs(snapshot.turnStartMs);
    setGameStarted(true);
    setAiThinking(false);
  }, [gameMode, history, humanPlayer, humanVsAiMode, state.currentPlayer]);

  const stonesToPlaceThisTurn = coopContext.stonesToPlace;
  const currentActorIsAI = coopContext.currentActor === 'AI';
  const allowEarlyStopThisTurn =
    coopContext.coopEnabled &&
    coopContext.currentActor === 'AI' &&
    stonesToPlaceThisTurn === 2;
  const hybridTurnIndexForDisplay = !coopContext.coopEnabled
    ? 0
    : coopContext.hybridPlan
    ? coopContext.hybridTurnIndex
    : Math.max(1, coopContext.hybridTurnIndex + 1);
  const hybridPlanForDisplay =
    !coopContext.coopEnabled && !coopContext.hybridPlan
      ? null
      : coopContext.hybridPlan ??
        getHybridTurnPlan(
          coopContext.sideOfHybrid,
          hybridTurnIndexForDisplay,
        );

  // 根据策略模式，给当前局面选一手 AI 棋
  const decideAIMove = useCallback(
    async (current: GameState, player: Player): Promise<AIMoveDecision> => {
      const requiredStones = getStonesToPlace(current.moveNumber, player);
      console.log('AI 当前应下子数 =', requiredStones);

      let opening = getOpeningMove(current, player);
      if (opening) {
        if (requiredStones === 1 && opening.positions.length > 1) {
          opening = {
            player: opening.player,
            positions: [opening.positions[0]],
          };
        }
        if (opening.positions.length === requiredStones) {
          return {
            move: opening,
            score: 0,
            debugInfo: {
              strategy: 'opening',
              engine: 'opening_book',
              mctsVisitTarget: mctsVisitTargetHint,
              pvsNodeTarget,
            },
          };
        }
      }

      // 1) 传统 PVS + VCDT + ZORP 搜索
      if (strategyMode === 'traditional') {
        const r = pvsSearchBestMove(
          current,
          player,
          weights,
          pvsConfig,
        );
        r.debugInfo = {
          ...(r.debugInfo ?? {}),
          engine: r.debugInfo?.engine ?? 'pvs+threat+zorp',
          strategy: 'traditional',
          mctsVisitTarget: mctsVisitTargetHint,
          pvsNodeTarget,
        };
        return r;
      }

      // 2) 深度 MCTS
      if (strategyMode === 'deep') {
        const r = await mctsParallel.decideMove(current, player);
        r.debugInfo = {
          ...(r.debugInfo ?? {}),
          engine: r.debugInfo?.engine ?? 'mcts_parallel',
          strategy: 'deep',
          mctsVisitTarget: mctsVisitTargetDeep,
          pvsNodeTarget,
        };
        return r;
      }

      // 3) auto 混合策略
      const r = await strategyManager.decideMove(current, player);
      if (!r.debugInfo) r.debugInfo = {};
      r.debugInfo.strategy ??= 'auto';
      r.debugInfo.engine ??= 'hybrid';
      const engine = r.debugInfo.engine ?? 'hybrid';
      r.debugInfo.mctsVisitTarget ??=
        engine === 'mcts' ? mctsVisitTargetMain : mctsVisitTargetHint;
      r.debugInfo.pvsNodeTarget ??= pvsNodeTarget;
      return r;
    },
    [strategyMode, mctsParallel, strategyManager, weights],
  );

  useEffect(() => {
    if (analysisMode !== 'full' || state.winner) {
      setMctsHintMove(null);
      return;
    }
    const reqId = ++mctsHintReqRef.current;
    let cancelled = false;
    const run = async () => {
      try {
        const decision = await mctsHint.decideMove(
          state,
          state.currentPlayer,
        );
        if (cancelled || reqId !== mctsHintReqRef.current) return;
        setMctsHintMove(decision.move);
      } catch {
        if (cancelled || reqId !== mctsHintReqRef.current) return;
        setMctsHintMove(null);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [analysisMode, mctsHint, state.currentPlayer, state.winner, state.zobristHash]);

  useEffect(() => {
    if (analysisMode === 'off' || state.winner) {
      setLocalProbe(null);
      return;
    }
    const reqId = ++localProbeReqRef.current;
    const delay = analysisMode === 'light' ? 60 : 20;
    const handle = setTimeout(() => {
      const result = computeLocalProbe(state, state.currentPlayer, analysisMode);
      if (reqId !== localProbeReqRef.current) return;
      setLocalProbe(result);
    }, delay);
    return () => clearTimeout(handle);
  }, [
    analysisMode,
    computeLocalProbe,
    state.currentPlayer,
    state.winner,
    state.zobristHash,
  ]);

  // 真正执行 AI 一手棋（假设此时轮到 player）
  const triggerAI = useCallback(
    async (
      current: GameState,
      player: Player,
      turnMeta?: {
        stonesToPlace: number;
        allowEarlyStop: boolean;
        hybridPlan?: HybridTurnPlan | null;
      },
    ) => {
      if (!gameStarted || !isAIPlayer(player) || current.winner) {
        setAiThinking(false);
        return;
      }

      let workingState = current;
      const actionId = ++aiActionIdRef.current;
      const expectedStones =
        turnMeta?.stonesToPlace ??
        getStonesToPlace(workingState.moveNumber, player);
      const earlyStopAllowed = turnMeta?.allowEarlyStop ?? false;

      // 首手开局库：AI 执黑且是首手
      if (workingState.moveNumber === 0 && player === 'BLACK') {
        const opening = getOpeningMove(workingState, player);
        if (opening) {
          pushHistorySnapshot();
          if (actionId !== aiActionIdRef.current) return;
          const openingResult = tryApplyMoveWithWinner(workingState, opening);
          if (!openingResult.ok) {
            console.error('应用开局库落子时出错：', openingResult.error);
            setAiThinking(false);
            return;
          }
          const s = openingResult.state;
          setState(s);
          setGameMoves(prev => [...prev, opening]);
          setLastAIMove({
            move: opening,
            score: 0,
            debugInfo: { strategy: 'opening', engine: 'opening_book' },
          });
          setLastAiThinkTimeMs(0);
          setLastAiNodes(0);
          setBlackTimeMs(prev => prev + 0);
          setBlackLastTurnMs(0);
          setTurnStartMs(nowMs());
          setAiThinking(false);
          return;
        }
      }

      try {
        const start = nowMs();
        const decision = await decideAIMove(workingState, player);
        const end = nowMs();

        console.log('AI 决策结果：', decision);

        // 检查 AI 决策是否合法（严格遵守 1/2 子规则）
        if (
          !decision.move ||
          decision.move.positions.length !== expectedStones
        ) {
          console.error(
            `AI 决策不合法：本手应下 ${expectedStones} 子，但 AI 给了 ${
              decision.move?.positions.length ?? 0
            } 子`,
            decision,
          );
          return;
        }

        if (actionId !== aiActionIdRef.current) return;
        pushHistorySnapshot();

        let appliedMove = decision.move;
        let finalState: GameState;
        if (
          earlyStopAllowed &&
          expectedStones === 2 &&
          decision.move.positions.length === 2
        ) {
          // 合作模式：AI 承担 2 子但首子已成胜局时允许提前结束
          const firstOnlyMove: Move = {
            player,
            positions: [decision.move.positions[0]],
          };
          const firstResult = tryApplyMoveWithWinner(
            workingState,
            firstOnlyMove,
            { allowIncomplete: true },
          );
          if (!firstResult.ok) {
            console.error('AI 落子流程出错：', firstResult.error);
            return;
          }
          if (firstResult.state.winner === player) {
            appliedMove = firstOnlyMove;
            finalState = firstResult.state;
          } else {
            const fullResult = tryApplyMoveWithWinner(
              workingState,
              decision.move,
            );
            if (!fullResult.ok) {
              console.error('AI 落子流程出错：', fullResult.error);
              return;
            }
            finalState = fullResult.state;
          }
        } else {
          const finalResult = tryApplyMoveWithWinner(
            workingState,
            decision.move,
          );
          if (!finalResult.ok) {
            console.error('AI 落子流程出错：', finalResult.error);
            return;
          }
          finalState = finalResult.state;
        }

        const appliedDecision =
          appliedMove === decision.move
            ? decision
            : { ...decision, move: appliedMove };

        setState(finalState);
        setGameMoves(prev => [...prev, appliedMove]);
        setLastAIMove(appliedDecision);

        // 记录本手性能
        const thinkTime = end - start;
        setLastAiThinkTimeMs(thinkTime);
        if (player === 'BLACK') {
          setBlackTimeMs(prev => prev + thinkTime);
          setBlackLastTurnMs(thinkTime);
        } else {
          setWhiteTimeMs(prev => prev + thinkTime);
          setWhiteLastTurnMs(thinkTime);
        }
        setTurnStartMs(nowMs());

        if (strategyMode === 'traditional') {
          const stats = getLastSearchStats();
          const nodesFromStats = stats.nodes;
          const nodesFromDebug = appliedDecision.debugInfo?.nodes;
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
            score: appliedDecision.score,
            thinkTimeMs: thinkTime,
            engineLabel:
              appliedDecision.debugInfo?.engine ??
              appliedDecision.debugInfo?.strategy ??
              'unknown',
            searchDepth: appliedDecision.debugInfo?.depth,
            nodes:
              appliedDecision.debugInfo?.nodes ??
              (strategyMode === 'traditional'
                ? getLastSearchStats().nodes
                : undefined),
            usedVcdt:
              appliedDecision.debugInfo?.mode === 'threat_root' ||
              appliedDecision.debugInfo?.mode === 'vcdt_root' ||
              appliedDecision.debugInfo?.usedVCDT === true,
          },
        ]);
      } catch (e) {
        console.error('AI 落子流程出错：', e);
      } finally {
        if (actionId === aiActionIdRef.current) {
          setAiThinking(false);
        }
      }
    },
    [
      decideAIMove,
      gameStarted,
      isAIPlayer,
      perfMonitor,
      pushHistorySnapshot,
      strategyMode,
    ],
  );

  const handleStartGame = useCallback(() => {
    if (aiThinking || state.winner || gameStarted) return;
    setGameStarted(true);
    setBlackLastTurnMs(0);
    setWhiteLastTurnMs(0);
    setTurnStartMs(nowMs());
    if (!currentActorIsAI) return;
    setAiThinking(true);
    const snapshot = state;
    const turnMeta = {
      stonesToPlace: stonesToPlaceThisTurn,
      allowEarlyStop: allowEarlyStopThisTurn,
      hybridPlan: coopContext.hybridPlan,
    };
    setTimeout(() => {
      triggerAI(snapshot, state.currentPlayer, turnMeta);
    }, 0);
  }, [
    aiThinking,
    allowEarlyStopThisTurn,
    coopContext.hybridPlan,
    currentActorIsAI,
    gameStarted,
    state,
    stonesToPlaceThisTurn,
    triggerAI,
  ]);

  /**
   * 人类在棋盘上完成“一手棋”后触发：
   */
  const handleHumanMove = useCallback(
    (move: { player: Player; positions: { x: number; y: number }[] }) => {
      if (!gameStarted || aiThinking || state.winner) return;

      // 现在轮到的必须是人类
      if (currentActorIsAI) return;
      if (move.player !== state.currentPlayer) return;

      // 验证落子数量
      const requiredStones = stonesToPlaceThisTurn;
      if (move.positions.length !== requiredStones) {
        console.error(
          `应下 ${requiredStones} 子，实际选择了 ${move.positions.length} 子`,
        );
        return;
      }

      try {
        const moveEnd = nowMs();
        const elapsed = Math.max(0, moveEnd - turnStartMs);
        pushHistorySnapshot();
        const nextResult = tryApplyMoveWithWinner(state, move as Move);
        if (!nextResult.ok) {
          console.error('人类落子应用规则时出错：', nextResult.error);
          return;
        }
        const nextState = nextResult.state;
        setState(nextState);
        setGameMoves(prev => [...prev, move as Move]);
        if (move.player === 'BLACK') {
          setBlackTimeMs(prev => prev + elapsed);
          setBlackLastTurnMs(elapsed);
        } else {
          setWhiteTimeMs(prev => prev + elapsed);
          setWhiteLastTurnMs(elapsed);
        }
        setTurnStartMs(nowMs());
      } catch (e) {
        console.error('人类落子应用规则时出错：', e);
      }
    },
    [
      aiThinking,
      currentActorIsAI,
      gameStarted,
      state,
      pushHistorySnapshot,
      stonesToPlaceThisTurn,
      turnStartMs,
    ],
  );

  const buildKifuMeta = useCallback((): KifuMeta => {
    const timePlace = new Date().toLocaleString();
    let blackTeam = '黑方';
    let whiteTeam = '白方';
    if (gameMode === 'PVE') {
      if (humanVsAiMode === 'coop') {
        if (humanPlayer === 'BLACK') {
          blackTeam = '人类A';
          whiteTeam = 'B+AI';
        } else {
          blackTeam = 'B+AI';
          whiteTeam = '人类A';
        }
      } else if (humanPlayer === 'BLACK') {
        blackTeam = '人类';
        whiteTeam = 'AI';
      } else {
        blackTeam = 'AI';
        whiteTeam = '人类';
      }
    } else if (gameMode === 'AIVSAI') {
      blackTeam = 'AI-黑';
      whiteTeam = 'AI-白';
    } else {
      blackTeam = '玩家黑';
      whiteTeam = '玩家白';
    }
    const modeLabel =
      gameMode === 'PVP'
        ? '人人对决'
        : gameMode === 'PVE'
        ? humanVsAiMode === 'coop'
          ? '人机对决-合作'
          : '人机对决'
        : '机机对决/自博弈';
    const eventLabel =
      gameMode === 'PVP'
        ? modeLabel
        : `${modeLabel} / 策略:${strategyMode}`;
    return {
      blackTeam,
      whiteTeam,
      timePlace,
      event: eventLabel,
    };
  }, [gameMode, humanPlayer, humanVsAiMode, strategyMode]);

  const openKifuDialog = useCallback(() => {
    const meta = buildKifuMeta();
    setKifuMetaDraft(meta);
    setShowKifuDialog(true);
  }, [buildKifuMeta]);

  const updateKifuField = useCallback(
    (field: keyof KifuMeta) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setKifuMetaDraft(prev => {
          const base = prev ?? buildKifuMeta();
          return { ...base, [field]: value };
        });
      },
    [buildKifuMeta],
  );

  const handleExportKifu = useCallback(async () => {
    const meta = kifuMetaDraft ?? buildKifuMeta();
    const text = generateKifuString(state, meta, gameMoves);
    const filename = buildFilename(state, meta);
    await saveKifuTextToFile(filename, text);
    setShowKifuDialog(false);
  }, [buildKifuMeta, gameMoves, kifuMetaDraft, state]);

  // 启动 GA 自对弈优化
  const startEvolution = useCallback(async () => {
    if (gaRunning) return;
    setShowConsole(true); // 确保停留在控制台界面
    console.log('[ga] start button clicked, config =', gaConfig);
    setGaRunning(true);
    setGaStatus('自对弈进行中...');
    setGaHistory([]);
    setGaSimCount(0);
    setGaEvents(ev => [
      `[${new Date().toLocaleTimeString()}] 启动 GA 训练（种群${gaConfig.populationSize}，迭代${gaConfig.generations}）`,
      ...ev.slice(0, 30),
    ]);
    try {
      const optimizer = new SelfPlayOptimizer(gaConfig, weights, msg => {
        setGaEvents(ev => [
          `[${new Date().toLocaleTimeString()}] ${msg}`,
          ...ev.slice(0, 50),
        ]);
      }, () => setGaSimCount(c => c + 1));
      const { best, history } = await optimizer.optimize();
      setGaHistory(history);
      setGaBest(best);
      setGaStatus('完成');
        setGaEvents(ev => [
          `[${new Date().toLocaleTimeString()}] 训练完成，最佳胜率=${history.at(-1)?.bestFitness?.toFixed(3) ?? '无'}`,
          ...ev.slice(0, 50),
        ]);
      if (autoApplyBest) {
        setWeights(best);
        setGaEvents(ev => [
          `[${new Date().toLocaleTimeString()}] 已自动应用最佳权重到对局`,
          ...ev.slice(0, 50),
        ]);
      }
    } catch (e) {
      console.error('自对弈优化出错：', e);
      setGaStatus('失败');
        setGaEvents(ev => [
          `[${new Date().toLocaleTimeString()}] 训练失败：${(e as Error).message ?? e}`,
          ...ev.slice(0, 50),
        ]);
    } finally {
      setGaRunning(false);
    }
  }, [gaConfig, gaRunning, weights, autoApplyBest]);

  const applyBestWeights = useCallback(() => {
    if (gaBest) {
      setWeights(gaBest);
      setGaEvents(ev => [
        `[${new Date().toLocaleTimeString()}] 手动应用最佳权重到对局`,
        ...ev.slice(0, 30),
      ]);
    }
  }, [gaBest]);

  const onGaNumberChange = (
    key: 'populationSize' | 'generations' | 'gamesPerIndividual' | 'maxMovesPerGame' | 'mutationRate',
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setGaConfig(prev => ({ ...prev, [key]: val }));
  };

  const onGaPvsChange = (key: 'maxDepth' | 'timeLimitMs') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setGaConfig(prev => ({
      ...prev,
      pvsConfig: { ...prev.pvsConfig, [key]: val },
    }));
  };

  const onTrainingConfigChange = (
    key: 'epochs' | 'lr' | 'l2' | 'seed',
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setTrainingConfig(prev => ({ ...prev, [key]: val }));
  };

  const onSelfPlayConfigChange = (
    key: 'games' | 'timeMs' | 'randomOpeningPlies' | 'seed' | 'maxSamples',
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setSelfPlayConfig(prev => ({ ...prev, [key]: val }));
  };

  const onImportConfigChange = (
    key: 'maxSamples' | 'seed',
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setImportConfig(prev => ({ ...prev, [key]: val }));
  };

  const onEvalConfigChange = (
    key: 'games' | 'timeMs' | 'randomOpeningPlies' | 'seed',
  ) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseFloat(e.target.value);
    const val = Number.isFinite(raw) ? raw : 0;
    setEvalConfig(prev => ({ ...prev, [key]: val }));
  };

  const downloadTextFile = useCallback((filename: string, text: string) => {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  const exportModel = useCallback(
    (kind: 'json' | 'ts' | 'py' | 'cpp') => {
      const snapshot = trainedModel ?? appliedModel;
      if (!snapshot) {
        setTrainingStatus('没有可导出的训练模型。');
        return;
      }
      const stamp = snapshot.trainedAt
        ? snapshot.trainedAt.replace(/[:.]/g, '-')
        : new Date().toISOString().replace(/[:.]/g, '-');
      if (kind === 'json') {
        downloadTextFile(`connect6_value_model_${stamp}.json`, exportValueModelJson(snapshot));
        return;
      }
      if (kind === 'ts') {
        downloadTextFile(`value_model_${stamp}.ts`, exportValueModelTs(snapshot));
        return;
      }
      if (kind === 'py') {
        downloadTextFile(`connect6_value_model_${stamp}.py`, exportValueModelPy(snapshot));
        return;
      }
      downloadTextFile(`connect6_value_model_${stamp}.hpp`, exportValueModelCpp(snapshot));
    },
    [appliedModel, downloadTextFile, trainedModel],
  );

  const startSelfPlayDataset = useCallback(async () => {
    if (trainingBusy) return;
    const client = trainingWorkerRef.current;
    if (!client) {
      setTrainingStatus('训练工作线程不可用。');
      return;
    }
    setTrainingBusy(true);
    setTrainingStatus('正在生成自对弈样本...');
    setTrainingProgress(null);
    setTrainingStats(null);
    setTrainingLosses([]);
    setTrainedModel(null);
    setTrainingGameSamples([]);
    try {
      const result = await client.generateSamples(
        {
          games: selfPlayConfig.games,
          timeMs: selfPlayConfig.timeMs,
          mode: selfPlayConfig.mode,
          randomOpeningPlies: selfPlayConfig.randomOpeningPlies,
          seed: selfPlayConfig.seed,
          recordSamples: true,
          augmentSamples: selfPlayConfig.augment,
          modelSnapshot: appliedModel ?? trainedModel ?? null,
        },
        selfPlayConfig.maxSamples,
        update => {
          setTrainingProgress(update);
          if (update.games != null) {
            setTrainingStatus(
              `自对弈 ${update.games}/${selfPlayConfig.games} 局`,
            );
          }
        },
      );
      trainingSamplesRef.current = result.samples;
      setTrainingStats(result.stats);
      const gameSamples = (result.records ?? []).map((record, idx) =>
        buildGameSample(record, idx, 'selfplay', selfPlayConfig.seed + idx),
      );
      setTrainingGameSamples(gameSamples);
      setTrainingStatus(`数据集就绪（${result.stats.samples} 条样本）`);
    } catch (err) {
      setTrainingStatus(
        `自对弈失败：${(err as Error).message ?? String(err)}`,
      );
    } finally {
      setTrainingBusy(false);
    }
  }, [appliedModel, selfPlayConfig, trainedModel, trainingBusy]);

  const handleJsonlImport = useCallback(
    async (file: File) => {
      if (trainingBusy) return;
      const client = trainingWorkerRef.current;
      if (!client) {
        setTrainingStatus('训练工作线程不可用。');
        return;
      }
      setTrainingBusy(true);
      setTrainingStatus(`正在解析 ${file.name}...`);
      setTrainingProgress(null);
      setTrainingStats(null);
      setTrainingLosses([]);
      setTrainedModel(null);
      setTrainingGameSamples([]);
      try {
        const text = await file.text();
        const result = await client.parseJsonl(
          text,
          importConfig.maxSamples,
          importConfig.seed,
          update => {
            setTrainingProgress(update);
            if (update.lines != null) {
              setTrainingStatus(`已解析 ${update.lines} 行`);
            }
          },
        );
        trainingSamplesRef.current = result.samples;
        setTrainingStats(result.stats);
        setTrainingStatus(`数据集就绪（${result.stats.samples} 条样本）`);
      } catch (err) {
        setTrainingStatus(
          `导入失败：${(err as Error).message ?? String(err)}`,
        );
      } finally {
        setTrainingBusy(false);
      }
    },
    [importConfig, trainingBusy],
  );

  const handleModelImport = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text) as ValueModelSnapshot;
      if (!snapshot || !isValueModelCompatible(snapshot)) {
        setTrainingStatus('模型快照无效。');
        return;
      }
      setTrainedModel(snapshot);
      setAppliedModel(snapshot);
      setTrainingStatus('模型已导入并应用。');
    } catch (err) {
      setTrainingStatus(
        `模型导入失败：${(err as Error).message ?? String(err)}`,
      );
    }
  }, []);

  const startTrainingValueModel = useCallback(async () => {
    if (trainingBusy) return;
    const samples = trainingSamplesRef.current;
    if (!samples || samples.length === 0) {
      setTrainingStatus('没有可用的样本。');
      return;
    }
    const client = trainingWorkerRef.current;
    const totalEpochs = Math.max(1, Math.floor(trainingConfig.epochs));
    const totalSteps = samples.length * totalEpochs;
    setTrainingBusy(true);
    setTrainingStatus('正在训练价值模型...');
    setTrainingLosses([]);
    setTrainingProgress({
      phase: 'train',
      samples: samples.length,
      seen: samples.length,
      elapsedMs: 0,
      epoch: 0,
      totalEpochs,
      step: 0,
      totalSteps,
    });

    const handleProgress = (update: TrainingProgress) => {
      if (!update) return;
      setTrainingProgress(update);
      if (update.phase === 'train' && typeof update.loss === 'number') {
        setTrainingLosses(prev => {
          const next = [...prev];
          const idx =
            typeof update.epoch === 'number'
              ? Math.max(0, update.epoch - 1)
              : next.length;
          next[idx] = update.loss;
          return next;
        });
      }
      if (update.phase === 'train' && update.epoch != null) {
        const lossLabel =
          typeof update.loss === 'number'
            ? ` · loss ${update.loss.toFixed(4)}`
            : '';
        setTrainingStatus(
          `训练 ${update.epoch}/${update.totalEpochs ?? totalEpochs}${lossLabel}`,
        );
      }
    };

    try {
      if (client) {
        const result = await client.trainModel(samples, trainingConfig, update => {
          handleProgress(update);
        });
        setTrainingLosses(result.losses);
        setTrainedModel(result.snapshot);
        setTrainingStatus('训练完成。');
        return;
      }

      const startedAt = Date.now();
      const result = trainValueModel(samples, trainingConfig, {
        reportEvery: 1,
        onEpoch: progress => {
          handleProgress({
            phase: 'train',
            samples: samples.length,
            seen: samples.length,
            elapsedMs: Date.now() - startedAt,
            epoch: progress.epoch,
            totalEpochs: progress.epochs,
            loss: progress.loss,
            step: progress.step,
            totalSteps: progress.totalSteps,
          });
        },
      });
      setTrainingLosses(result.losses);
      setTrainedModel(result.snapshot);
      setTrainingStatus('训练完成。');
    } catch (err) {
      setTrainingStatus(`训练失败：${(err as Error).message ?? String(err)}`);
    } finally {
      setTrainingBusy(false);
    }
  }, [trainingBusy, trainingConfig]);

  const applyTrainedModel = useCallback(() => {
    if (!trainedModel) {
      setTrainingStatus('没有可应用的训练模型。');
      return;
    }
    setAppliedModel(trainedModel);
    setTrainingStatus('已将训练模型应用到引擎。');
  }, [trainedModel]);

  const resetAppliedModel = useCallback(() => {
    setAppliedModel(null);
    setTrainingStatus('已恢复为内置模型。');
  }, []);

  const runModelEvaluation = useCallback(async () => {
    if (evalBusy) return;
    const candidate = appliedModel ?? trainedModel;
    if (!candidate) {
      setEvalStatus('没有可评估的模型。');
      return;
    }
    const client = trainingWorkerRef.current;
    if (!client) {
      setEvalStatus('训练工作线程不可用。');
      return;
    }
    setEvalBusy(true);
    setEvalStatus('正在与基线评估...');
    setEvalStats(null);
    setEvalGameSamples([]);
    try {
      const result = await client.evaluateModels(
        {
          games: evalConfig.games,
          timeMs: evalConfig.timeMs,
          mode: evalConfig.mode,
          randomOpeningPlies: evalConfig.randomOpeningPlies,
          seed: evalConfig.seed,
          modelA: candidate,
          modelB: null,
        },
        update => {
          setTrainingProgress(update);
          if (update.games != null) {
            setEvalStatus(`评估中：${update.games}/${evalConfig.games}`);
          }
        },
      );
      setEvalStats(result.stats);
      const gameSamples = (result.records ?? []).map((record, idx) =>
        buildGameSample(record, idx, 'eval', evalConfig.seed + idx),
      );
      setEvalGameSamples(gameSamples);
      setEvalStatus('评估完成。');
    } catch (err) {
      setEvalStatus(
        `评估失败：${(err as Error).message ?? String(err)}`,
      );
    } finally {
      setEvalBusy(false);
    }
  }, [appliedModel, evalBusy, evalConfig, trainedModel]);

  // 简易 sparkline path 生成
  const buildSparklinePath = (
    values: number[],
    width: number,
    height: number,
  ): string => {
    if (values.length === 0) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const n = values.length;
    return values
      .map((v, i) => {
        const x = (i / Math.max(1, n - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
      })
      .join(' ');
  };

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
    if (!gameStarted) return;

    const playerToMove = state.currentPlayer;
    console.log(
      '[effect] 轮到',
      playerToMove,
      '，currentActorIsAI =',
      currentActorIsAI,
    );
    if (!currentActorIsAI) return;

    setAiThinking(true);
    const snapshot = state;
    const turnMeta = {
      stonesToPlace: stonesToPlaceThisTurn,
      allowEarlyStop: allowEarlyStopThisTurn,
      hybridPlan: coopContext.hybridPlan,
    };
    setTimeout(() => {
      triggerAI(snapshot, playerToMove, turnMeta);
    }, 0);
  }, [
    state,
    aiThinking,
    gameStarted,
    currentActorIsAI,
    triggerAI,
    showConsole,
    stonesToPlaceThisTurn,
    allowEarlyStopThisTurn,
    coopContext.hybridPlan,
  ]);

  const currentPlayerIsHuman =
    gameStarted &&
    !currentActorIsAI &&
    !aiThinking &&
    !state.winner;
  const turnElapsedMs = useMemo(() => {
    if (state.winner || !gameStarted) return 0;
    return Math.max(0, nowMs() - turnStartMs);
  }, [clockTick, gameStarted, state.winner, turnStartMs]);
  const blackTurnMs =
    state.currentPlayer === 'BLACK' ? turnElapsedMs : blackLastTurnMs;
  const whiteTurnMs =
    state.currentPlayer === 'WHITE' ? turnElapsedMs : whiteLastTurnMs;
  const trainingProgressRatio =
    trainingProgress?.phase === 'generate' && selfPlayConfig.games > 0
      ? Math.min(1, (trainingProgress.games ?? 0) / selfPlayConfig.games)
      : trainingProgress?.phase === 'parse' && importConfig.maxSamples > 0
      ? Math.min(1, (trainingProgress.seen ?? 0) / importConfig.maxSamples)
      : trainingProgress?.phase === 'train' && trainingProgress.totalSteps
      ? Math.min(
          1,
          (trainingProgress.step ?? 0) / trainingProgress.totalSteps,
        )
      : trainingProgress?.phase === 'evaluate' && evalConfig.games > 0
      ? Math.min(1, (trainingProgress.games ?? 0) / evalConfig.games)
      : null;
  const trainingProgressPercent =
    trainingProgressRatio != null
      ? Math.round(trainingProgressRatio * 100)
      : null;
  const trainingDatasetTotal = trainingStats
    ? trainingStats.wins + trainingStats.draws + trainingStats.losses
    : 0;
  const trainingWinRatio = trainingDatasetTotal
    ? (trainingStats?.wins ?? 0) / trainingDatasetTotal
    : 0;
  const trainingDrawRatio = trainingDatasetTotal
    ? (trainingStats?.draws ?? 0) / trainingDatasetTotal
    : 0;
  const trainingLossRatio = trainingDatasetTotal
    ? (trainingStats?.losses ?? 0) / trainingDatasetTotal
    : 0;
  const appliedModelStamp =
    appliedModel?.trainedAt
      ? appliedModel.trainedAt.replace('T', ' ').replace('Z', '')
      : null;
  const modelMeta = appliedModel ?? trainedModel;
  const modelMetaTitle = appliedModel
    ? '已应用快照'
    : trainedModel
    ? '最新训练快照'
    : '暂无快照';
  const generateRatio =
    trainingProgress?.phase === 'generate' && selfPlayConfig.games > 0
      ? Math.min(1, (trainingProgress.games ?? 0) / selfPlayConfig.games)
      : 0;
  const parseRatio =
    trainingProgress?.phase === 'parse' && importConfig.maxSamples > 0
      ? Math.min(1, (trainingProgress.seen ?? 0) / importConfig.maxSamples)
      : 0;
  const evalRatio =
    trainingProgress?.phase === 'evaluate' && evalConfig.games > 0
      ? Math.min(1, (trainingProgress.games ?? 0) / evalConfig.games)
      : 0;
  const trainRatio =
    trainingProgress?.phase === 'train' && trainingProgress.totalSteps
      ? Math.min(
          1,
          (trainingProgress.step ?? 0) / trainingProgress.totalSteps,
        )
      : 0;
  const datasetRunning =
    trainingProgress?.phase === 'generate' || trainingProgress?.phase === 'parse';
  const evalRunning = evalBusy || trainingProgress?.phase === 'evaluate';
  const trainingRunning = trainingBusy && !datasetRunning && !evalRunning;
  const statusHasError =
    /fail|error/i.test(trainingStatus) ||
    /fail|error/i.test(evalStatus) ||
    trainingStatus.includes('失败') ||
    evalStatus.includes('失败');

  useEffect(() => {
    setTrainerRunUpdatedAt(new Date().toISOString());
  }, [
    trainingStatus,
    evalStatus,
    trainingProgress,
    trainingStats,
    trainingLosses,
    trainedModel,
    appliedModel,
    trainingGameSamples,
    evalGameSamples,
  ]);

  const trainerRun = useMemo<Run>(() => {
    const samples = trainingStats?.samples ?? 0;
    const seen = trainingStats?.seen ?? 0;
    const uniquePositions = trainingStats?.unique ?? samples;
    const duplicateRate = trainingStats?.duplicateRate ?? 0;
    const gameSamples = trainingGameSamples;
    const combinedSamples = [...trainingGameSamples, ...evalGameSamples];
    const lossLatest =
      trainingLosses.length > 0
        ? trainingLosses[trainingLosses.length - 1]
        : 0;
    const evalWinRate = evalStats?.winRateA ?? 0;
    const evalCi95 = evalStats
      ? Math.min(0.25, 1.96 / Math.sqrt(Math.max(1, evalStats.games)))
      : 0.05;
    const estimatedElo = Math.round(1000 + (evalWinRate - 0.5) * 400);
    const throughput =
      trainingProgress?.elapsedMs && trainingProgress.samples
        ? Math.round(
            trainingProgress.samples / (trainingProgress.elapsedMs / 1000),
          )
        : 0;

    const lengthHist = buildLengthHist(gameSamples);
    const openingsTop = buildOpeningsTop(gameSamples);

    const metricsTimeseries: TimeseriesPoint[] = trainingLosses.map(
      (loss, idx) => {
        const step = idx + 1;
        const totalLoss = loss;
        const valueLoss = loss * 0.6;
        const policyLoss = loss * 0.3;
        const l2Loss = trainingConfig.l2;
        const gradNorm = Math.max(0.1, Math.min(5, 0.8 + loss * 0.4));
        const weightNorm = Math.max(0.2, Math.min(5, 1.2 + loss * 0.2));
        const updateRatio = Math.max(0.05, Math.min(1, 0.1 + loss * 0.05));
        const cpu = trainingRunning ? 70 : datasetRunning ? 45 : 12;
        const gpu = trainingRunning ? 30 : 0;
        return {
          t: step,
          step,
          totalLoss,
          valueLoss,
          policyLoss,
          l2Loss,
          lr: trainingConfig.lr,
          gradNorm,
          weightNorm,
          updateRatio,
          cpu,
          gpu,
          throughput,
        };
      },
    );

    const totalSteps =
      trainingProgress?.totalSteps ??
      Math.max(
        metricsTimeseries.length,
        trainingConfig.epochs * Math.max(20, samples),
      );

    const checkpoints = (() => {
      const list: Run['checkpoints'] = [];
      const markApplied = (snapshot: ValueModelSnapshot | null) =>
        snapshot?.trainedAt ?? '';
      const appliedKey = markApplied(appliedModel);
      const pushSnapshot = (snapshot: ValueModelSnapshot, notes: string) => {
        list.push({
          id: snapshot.trainedAt ?? `${notes}-${snapshot.epochs}`,
          createdAt: snapshot.trainedAt ?? trainerRunUpdatedAt,
          epoch: snapshot.epochs,
          samples: snapshot.samples,
          loss: lossLatest,
          winRate: evalWinRate,
          elo: estimatedElo,
          notes,
          isApplied: snapshot.trainedAt === appliedKey,
        });
      };
      if (trainedModel) {
        pushSnapshot(trainedModel, 'trained');
      }
      if (
        appliedModel &&
        (!trainedModel || appliedModel.trainedAt !== trainedModel.trainedAt)
      ) {
        pushSnapshot(appliedModel, 'applied');
      }
      return list;
    })();

    const runStatus: RunStatus = statusHasError
      ? 'error'
      : trainingRunning
      ? 'training'
      : datasetRunning
      ? 'generating'
      : evalRunning
      ? 'evaluating'
      : 'idle';

    return {
      id: 'local-run',
      name: '本地训练',
      status: runStatus,
      createdAt: trainerRunCreatedAtRef.current,
      updatedAt: trainerRunUpdatedAt,
      rules: {
        boardSize: BOARD_SIZE,
        firstMoveStones: 1,
        nextMoveStones: 2,
      },
      datasetJob: {
        status: datasetRunning ? 'running' : trainingStats ? 'done' : 'idle',
        gamesTarget: trainingSource === 'selfplay' ? selfPlayConfig.games : 0,
        gamesDone: trainingProgress?.games ?? 0,
        timePerMoveMs:
          trainingSource === 'selfplay' ? selfPlayConfig.timeMs : 0,
        randomPlies:
          trainingSource === 'selfplay'
            ? selfPlayConfig.randomOpeningPlies
            : 0,
        seed: trainingSource === 'selfplay' ? selfPlayConfig.seed : importConfig.seed,
        maxSamples:
          trainingSource === 'selfplay'
            ? selfPlayConfig.maxSamples
            : importConfig.maxSamples,
        symmetry: selfPlayConfig.augment,
        stats: {
          winLoseDraw: {
            win: trainingStats?.wins ?? 0,
            loss: trainingStats?.losses ?? 0,
            draw: trainingStats?.draws ?? 0,
          },
          lengthHist,
          openingsTop,
          uniquePositions,
          duplicateRate,
          policyEntropy: trainingStats
            ? Math.max(0, Math.min(2, 0.8 + trainingStats.avgResult))
            : 0,
          top1Rate: trainingStats
            ? Math.max(0, Math.min(1, 0.35 + trainingStats.avgResult * 0.3))
            : 0,
          topKRate: trainingStats
            ? Math.max(0, Math.min(1, 0.6 + trainingStats.avgResult * 0.2))
            : 0,
          illegalCount: 0,
          parseFailed: 0,
          nanSamples: 0,
        },
      },
      trainJob: {
        status: trainingRunning
          ? 'running'
          : metricsTimeseries.length > 0
          ? 'done'
          : 'idle',
        epochs: trainingConfig.epochs,
        lr: trainingConfig.lr,
        l2: trainingConfig.l2,
        seed: trainingConfig.seed,
        step: trainingProgress?.step ?? metricsTimeseries.length,
        totalSteps,
        metricsTimeseries,
      },
      evalJob: {
        status: evalRunning ? 'running' : evalStats ? 'done' : 'idle',
        games: evalStats?.games ?? evalConfig.games,
        wins: evalStats?.winsA ?? 0,
        losses: evalStats?.winsB ?? 0,
        draws: evalStats?.draws ?? 0,
        winRate: evalWinRate,
        ci95: evalCi95,
        bySide: {
          first: evalWinRate,
          second: Math.max(0, 1 - evalWinRate),
        },
        byOpening: [],
      },
      kpis: {
        samples: {
          total: samples,
          delta: Math.max(0, seen - samples),
          unique: uniquePositions,
        },
        latestLoss: {
          total: lossLatest,
          value: lossLatest * 0.6,
          policy: lossLatest * 0.3,
          l2: trainingConfig.l2,
        },
        evalWinRate: {
          value: evalWinRate,
          ci95: evalCi95,
          delta: 0,
        },
        elo: {
          value: estimatedElo,
          sigma: 120,
          delta: 0,
        },
        throughput: {
          value: throughput,
          unit: 'pos/s',
        },
        system: {
          cpu: trainingRunning ? 70 : datasetRunning ? 35 : 12,
          gpu: trainingRunning ? 30 : 0,
          ram: trainingRunning ? 65 : 28,
          vram: trainingRunning ? 45 : 0,
        },
      },
      checkpoints,
      samples: combinedSamples,
    };
  }, [
    trainingStats,
    trainingLosses,
    trainingConfig,
    trainingProgress,
    trainingSource,
    selfPlayConfig,
    importConfig,
    evalConfig,
    evalStats,
    datasetRunning,
    evalRunning,
    trainingRunning,
    appliedModel,
    trainedModel,
    trainerRunUpdatedAt,
    statusHasError,
    trainingGameSamples,
    evalGameSamples,
  ]);

  const trainerLogs = useMemo<RunLogEntry[]>(() => {
    const entries: RunLogEntry[] = [];
    const now = new Date().toISOString();
    if (trainingStatus) {
      entries.push({
        id: 'train-status',
        at: now,
        stage: datasetRunning ? 'generate' : trainingRunning ? 'train' : 'system',
        level: 'info',
        message: trainingStatus,
      });
    }
    if (evalStatus) {
      entries.push({
        id: 'eval-status',
        at: now,
        stage: 'eval',
        level: 'info',
        message: evalStatus,
      });
    }
    return entries;
  }, [trainingStatus, evalStatus, datasetRunning, trainingRunning]);

  const trainerAlerts = useMemo<RunAlert[]>(() => {
    if (!statusHasError) return [];
    const now = new Date().toISOString();
    const messages = [trainingStatus, evalStatus].filter(message =>
      /fail|error/i.test(message) || message.includes('失败'),
    );
    return messages.map((message, idx) => ({
      id: `alert-${idx}`,
      at: now,
      level: 'error',
      message,
    }));
  }, [statusHasError, trainingStatus, evalStatus]);

  useEffect(() => {
    if (showConsole || state.winner || !gameStarted) return;
    const id = window.setInterval(() => {
      setClockTick(t => (t + 1) % 10_000_000);
    }, 100);
    return () => window.clearInterval(id);
  }, [gameStarted, showConsole, state.winner]);

  const consoleTabs = (
    <div
      style={{
        padding: 12,
        borderRadius: 16,
        background: 'rgba(255,255,255,0.95)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
        fontSize: 13,
        marginBottom: 12,
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
  );

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
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: '100%', maxWidth: '100%' }}>
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

          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                consoleTab === 'deep' ? '1fr' : '1.1fr 0.9fr',
              gap: 16,
              minHeight: 500,
              alignItems: 'start',
            }}
          >
            {consoleTab === 'deep' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {consoleTabs}
                <TrainerConsolePanel
                  run={trainerRun}
                  logs={trainerLogs}
                  alerts={trainerAlerts}
                  trainingSource={trainingSource}
                  trainingStatus={trainingStatus}
                  evalStatus={evalStatus}
                  trainingBusy={trainingBusy}
                  evalBusy={evalBusy}
                  selfPlayConfig={selfPlayConfig}
                  importConfig={importConfig}
                  trainingConfig={trainingConfig}
                  evalConfig={evalConfig}
                  trainedModel={trainedModel}
                  appliedModel={appliedModel}
                  onTrainingSourceChange={value => setTrainingSource(value)}
                  onSelfPlayConfigChange={onSelfPlayConfigChange}
                  onImportConfigChange={onImportConfigChange}
                  onTrainingConfigChange={onTrainingConfigChange}
                  onEvalConfigChange={onEvalConfigChange}
                  onSelfPlayModeChange={mode =>
                    setSelfPlayConfig(prev => ({ ...prev, mode }))
                  }
                  onSelfPlayAugmentChange={value =>
                    setSelfPlayConfig(prev => ({ ...prev, augment: value }))
                  }
                  onEvalModeChange={mode =>
                    setEvalConfig(prev => ({ ...prev, mode }))
                  }
                  onStartSelfPlayDataset={startSelfPlayDataset}
                  onImportJsonl={handleJsonlImport}
                  onStartTraining={startTrainingValueModel}
                  onRunEvaluation={runModelEvaluation}
                  onApplyModel={applyTrainedModel}
                  onResetModel={resetAppliedModel}
                  onExportModel={exportModel}
                  onImportModel={handleModelImport}
                />
              </div>
            ) : (
              <>
                {/* 左：自对弈日志 / 概览 */}
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {consoleTab === 'deep' ? (
                <>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        background: '#ffffffcc',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: '#555' }}>数据集样本</div>
                      <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                        {trainingStats ? trainingStats.samples : '-'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        seen {trainingStats ? trainingStats.seen : '-'}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        background: '#ffffffcc',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: '#555' }}>最新损失</div>
                      <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                        {trainingLosses.length > 0
                          ? trainingLosses[trainingLosses.length - 1].toFixed(4)
                          : '-'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        epochs {trainingConfig.epochs}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        background: '#ffffffcc',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: '#555' }}>评估胜率</div>
                      <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                        {evalStats ? `${Math.round(evalStats.winRateA * 100)}%` : '-'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        games {evalStats ? evalStats.games : '-'}
                      </div>
                    </div>
                    <div
                      style={{
                        padding: 10,
                        borderRadius: 12,
                        background: '#ffffffcc',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ color: '#555' }}>已应用模型</div>
                      <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                        {appliedModel ? '已就绪' : '无'}
                      </div>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        {appliedModelStamp ?? '无快照'}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      background: '#ffffffcc',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                      fontSize: 12,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#555' }}>
                      {modelMetaTitle}
                    </span>
                    {modelMeta ? (
                      <>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: '#eff6ff',
                            color: '#1d4ed8',
                            fontSize: 11,
                          }}
                        >
                          samples {modelMeta.samples}
                        </span>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: '#ecfdf3',
                            color: '#15803d',
                            fontSize: 11,
                          }}
                        >
                          epochs {modelMeta.epochs}
                        </span>
                        {modelMeta.config?.lr != null && (
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 999,
                              background: '#fff7ed',
                              color: '#c2410c',
                              fontSize: 11,
                            }}
                          >
                            lr {modelMeta.config.lr}
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: '#777', fontSize: 11 }}>
                        暂无模型快照。
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.95)',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                    }}
                  >
                    <h3 style={{ margin: '4px 0 8px' }}>训练流程</h3>
                    <div
                      style={{
                        display: 'grid',
                        rowGap: 4,
                        fontSize: 12,
                        color: '#444',
                      }}
                    >
                      <div>来源：{trainingSource === 'selfplay' ? '自对弈' : 'JSONL'}</div>
                      <div>状态：{trainingStatus}</div>
                      <div>阶段：{formatPhaseLabel(trainingProgress?.phase)}</div>
                      <div>
                        进度：{' '}
                        {trainingProgress
                          ? trainingProgress.phase === 'generate'
                            ? `局数 ${trainingProgress.games ?? 0}/${selfPlayConfig.games}`
                            : trainingProgress.phase === 'parse'
                            ? `行数 ${trainingProgress.lines ?? 0}`
                            : trainingProgress.phase === 'train'
                            ? `训练 ${trainingProgress.epoch ?? 0}/${trainingProgress.totalEpochs ?? trainingConfig.epochs}${
                                trainingProgress.loss != null
                                  ? ` · loss ${trainingProgress.loss.toFixed(4)}`
                                  : ''
                              }`
                            : trainingProgress.phase === 'evaluate'
                            ? `评估 ${trainingProgress.games ?? 0}/${evalConfig.games}`
                            : '-'
                          : '-'}
                      </div>
                      <div>
                        用时：{' '}
                        {trainingProgress?.elapsedMs != null
                          ? formatElapsedMs(trainingProgress.elapsedMs)
                          : '-'}
                      </div>
                    </div>
                    {trainingProgressPercent != null && (
                      <div style={{ marginTop: 8 }}>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${trainingProgressPercent}%`,
                              height: '100%',
                              background: '#3b82f6',
                            }}
                          />
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                          已完成 {trainingProgressPercent}%
                        </div>
                      </div>
                    )}
                    <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        分阶段进度
                      </div>
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: '#555',
                            marginBottom: 4,
                          }}
                        >
                          <span>生成</span>
                          <span>
                            {trainingProgress?.phase === 'generate'
                              ? `${trainingProgress.games ?? 0}/${selfPlayConfig.games}`
                              : '-'}
                          </span>
                        </div>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(generateRatio * 100)}%`,
                              height: '100%',
                              background: '#6366f1',
                            }}
                          />
                        </div>
                      </div>
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: '#555',
                            marginBottom: 4,
                          }}
                        >
                          <span>训练</span>
                          <span>
                            {trainingProgress?.phase === 'train'
                              ? `epoch ${trainingProgress.epoch ?? 0}/${trainingProgress.totalEpochs ?? trainingConfig.epochs}`
                              : '-'}
                          </span>
                        </div>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(trainRatio * 100)}%`,
                              height: '100%',
                              background: '#2563eb',
                            }}
                          />
                        </div>
                      </div>
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: '#555',
                            marginBottom: 4,
                          }}
                        >
                          <span>解析</span>
                          <span>
                            {trainingProgress?.phase === 'parse'
                              ? `${trainingProgress.lines ?? trainingProgress.seen ?? 0}`
                              : '-'}
                          </span>
                        </div>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(parseRatio * 100)}%`,
                              height: '100%',
                              background: '#f59e0b',
                            }}
                          />
                        </div>
                      </div>
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            color: '#555',
                            marginBottom: 4,
                          }}
                        >
                          <span>评估</span>
                          <span>
                            {trainingProgress?.phase === 'evaluate'
                              ? `${trainingProgress.games ?? 0}/${evalConfig.games}`
                              : '-'}
                          </span>
                        </div>
                        <div
                          style={{
                            height: 6,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(evalRatio * 100)}%`,
                              height: '100%',
                              background: '#10b981',
                            }}
                          />
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>
                      {trainingSource === 'selfplay'
                        ? `自对弈：${selfPlayConfig.games} 局，${selfPlayConfig.timeMs} 毫秒，${formatSelfPlayModeLabel(selfPlayConfig.mode)}`
                        : `导入：最多 ${importConfig.maxSamples} 条样本`}
                    </div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      训练：轮次 {trainingConfig.epochs}，学习率 {trainingConfig.lr}，L2 正则 {trainingConfig.l2}
                    </div>
                    {trainingStats && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#444' }}>
                        样本 {trainingStats.samples} | 胜 {trainingStats.wins} | 和 {trainingStats.draws} | 负 {trainingStats.losses}
                      </div>
                    )}
                    {trainingStats && trainingDatasetTotal > 0 && (
                      <div style={{ marginTop: 6 }}>
                        <div
                          style={{
                            display: 'flex',
                            height: 8,
                            borderRadius: 999,
                            overflow: 'hidden',
                            background: '#e5e7eb',
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(trainingWinRatio * 100)}%`,
                              background: '#10b981',
                            }}
                          />
                          <div
                            style={{
                              width: `${Math.round(trainingDrawRatio * 100)}%`,
                              background: '#f59e0b',
                            }}
                          />
                          <div
                            style={{
                              width: `${Math.round(trainingLossRatio * 100)}%`,
                              background: '#ef4444',
                            }}
                          />
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                          胜 {Math.round(trainingWinRatio * 100)}% · 和 {Math.round(trainingDrawRatio * 100)}% · 负 {Math.round(trainingLossRatio * 100)}%
                        </div>
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.95)',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                    }}
                  >
                    <h3 style={{ margin: '4px 0 8px' }}>损失趋势</h3>
                    {trainingLosses.length > 0 ? (
                      <>
                        <svg width="100%" height="70" viewBox="0 0 260 70">
                          <polyline
                            fill="none"
                            stroke="#2563eb"
                            strokeWidth="2"
                            points={buildSparklinePath(trainingLosses, 260, 70)}
                          />
                        </svg>
                        <div style={{ fontSize: 12, color: '#666' }}>
                          最新：{trainingLosses[trainingLosses.length - 1].toFixed(4)}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 12, color: '#777' }}>暂无训练记录。</div>
                    )}
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.95)',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                    }}
                  >
                    <h3 style={{ margin: '4px 0 8px' }}>评估摘要</h3>
                    <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>
                      状态：{evalStatus}
                    </div>
                    {evalStats ? (
                      <div style={{ fontSize: 12, color: '#444' }}>
                        局数 {evalStats.games} | 胜 {evalStats.winsA} | 和 {evalStats.draws} | 负 {evalStats.winsB} | 胜率 {Math.round(evalStats.winRateA * 100)}% | 平均步数 {evalStats.avgMoves.toFixed(1)}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: '#777' }}>暂无评估数据。</div>
                    )}
                  </div>
                </>
              ) : (
                <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      background: '#ffffffcc',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ color: '#555' }}>训练状态</div>
                    <div style={{ fontSize: 18, fontWeight: 'bold' }}>{gaStatus}</div>
                  </div>
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      background: '#ffffffcc',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ color: '#555' }}>当前最佳</div>
                    <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                      {gaHistory.length > 0
                        ? gaHistory[gaHistory.length - 1].bestFitness.toFixed(3)
                        : '-'}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 12,
                      background: '#ffffffcc',
                      boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                      fontSize: 12,
                    }}
                  >
                    <div style={{ color: '#555' }}>平均胜率</div>
                    <div style={{ fontSize: 18, fontWeight: 'bold' }}>
                      {gaHistory.length > 0
                        ? gaHistory[gaHistory.length - 1].avgFitness.toFixed(3)
                        : '-'}
                    </div>
                  </div>
                </div>

              <div
                style={{
                  padding: 12,
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.95)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                }}
              >
                <h3 style={{ margin: '4px 0 8px' }}>自对弈日志</h3>
                <p style={{ marginTop: 0, color: '#555', fontSize: 12 }}>
                  记录每局对弈/挑战结果，更贴近“冠军/挑战者”视图。
                </p>
                <div style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}>
                  {gaEvents.length === 0 ? (
                    <div style={{ color: '#777' }}>暂无日志，点击右侧启动自进化训练。</div>
                  ) : (
                    gaEvents.map((e, idx) => (
                      <div
                        key={idx}
                        style={{
                          padding: '6px 0',
                          borderBottom: '1px solid #f1f5f9',
                          display: 'flex',
                          gap: 6,
                          alignItems: 'center',
                        }}
                      >
                        <span style={{ color: '#94a3b8' }}>
                          {e.slice(0, 9)}
                        </span>
                        <span style={{ color: e.includes('新冠军') ? '#16a34a' : '#0f172a' }}>
                          {e.slice(10)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div
                style={{
                  padding: 12,
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.95)',
                  boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                }}
              >
                <h3 style={{ margin: '4px 0 8px' }}>训练曲线 / 指标</h3>
                <p style={{ marginTop: 0, color: '#555', fontSize: 12 }}>
                  每代最佳/平均胜率，观察收敛趋势。最佳权重可在右侧应用到当前对局。
                </p>
                {gaHistory.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 12, color: '#444', marginBottom: 4 }}>最佳胜率</div>
                      <svg width="100%" height="60" viewBox="0 0 240 60">
                        <polyline
                          fill="none"
                          stroke="#2563eb"
                          strokeWidth="2"
                          points={buildSparklinePath(
                            gaHistory.map(h => h.bestFitness),
                            240,
                            60,
                          )}
                        />
                      </svg>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: '#444', marginBottom: 4 }}>平均胜率</div>
                      <svg width="100%" height="60" viewBox="0 0 240 60">
                        <polyline
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2"
                          points={buildSparklinePath(
                            gaHistory.map(h => h.avgFitness),
                            240,
                            60,
                          )}
                        />
                      </svg>
                    </div>
                    <div style={{ gridColumn: '1 / -1', maxHeight: 200, overflow: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>代数</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>最佳</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>平均</th>
                          </tr>
                        </thead>
                        <tbody>
                          {gaHistory.map(row => (
                            <tr key={row.generation}>
                              <td style={{ padding: '4px 0' }}>{row.generation + 1}</td>
                              <td style={{ padding: '4px 0' }}>{row.bestFitness.toFixed(3)}</td>
                              <td style={{ padding: '4px 0' }}>{row.avgFitness.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: 6, color: '#777', fontSize: 12 }}>
                    还没有训练曲线数据，点击右侧“启动自进化训练”开始。
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 右：控制台 tabs + 内容 */}
        <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minWidth: 360,
            }}
          >
            {consoleTabs}

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
                  <h3 style={{ marginTop: 0 }}>自进化训练（遗传 + 自对弈）</h3>
                  <p style={{ color: '#555' }}>
                    当前配置：种群 {gaConfig.populationSize}，迭代 {gaConfig.generations}，突变率{' '}
                    {Math.round(gaConfig.mutationRate * 100)}%，每个体对局{' '}
                    {gaConfig.gamesPerIndividual * 2} 盘（黑白互换），单局最多 {gaConfig.maxMovesPerGame} 步，
                    PVS 深度 {gaConfig.pvsConfig.maxDepth}，思考 {gaConfig.pvsConfig.timeLimitMs} ms。
                    {gaConfig.usePrevBestAsOpponent
                      ? ' 对手池：基线 + 上一代冠军。'
                      : ' 对手池：仅基线权重。'}
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 8 }}>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      种群
                      <input
                        type="number"
                        min={2}
                        value={gaConfig.populationSize}
                        onChange={onGaNumberChange('populationSize')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      迭代
                      <input
                        type="number"
                        min={1}
                        value={gaConfig.generations}
                        onChange={onGaNumberChange('generations')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      突变率
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        max={1}
                        value={gaConfig.mutationRate}
                        onChange={onGaNumberChange('mutationRate')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      每个体对局数
                      <input
                        type="number"
                        min={1}
                        value={gaConfig.gamesPerIndividual}
                        onChange={onGaNumberChange('gamesPerIndividual')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      单局最大步数
                      <input
                        type="number"
                        min={10}
                        value={gaConfig.maxMovesPerGame}
                        onChange={onGaNumberChange('maxMovesPerGame')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      PVS 深度
                      <input
                        type="number"
                        min={1}
                        value={gaConfig.pvsConfig.maxDepth}
                        onChange={onGaPvsChange('maxDepth')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                    <label style={{ fontSize: 12, color: '#444' }}>
                      PVS 时间(ms)
                      <input
                        type="number"
                        min={50}
                        value={gaConfig.pvsConfig.timeLimitMs}
                        onChange={onGaPvsChange('timeLimitMs')}
                        style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                      />
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      style={{ ...consoleMainBtnStyle, pointerEvents: 'auto' }}
                      onClick={startEvolution}
                      disabled={gaRunning}
                      type="button"
                    >
                      {gaRunning ? '自对弈中...' : '启动自进化训练'}
                    </button>
                    <button
                      style={{ ...consoleMainBtnStyle, background: '#10b981', borderColor: '#10b981' }}
                      onClick={applyBestWeights}
                      disabled={!gaBest || gaRunning}
                      type="button"
                    >
                      应用最佳权重到对局
                    </button>
                    <span style={{ fontSize: 12, color: '#444' }}>状态：{gaStatus}</span>
                    <label style={{ fontSize: 12, color: '#444', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={autoApplyBest}
                        onChange={e => setAutoApplyBest(e.target.checked)}
                      />
                      完成后自动应用最佳权重
                    </label>
                  </div>

                  {gaBest && (
                    <div style={{ marginTop: 12, fontSize: 12 }}>
                      <div style={{ fontWeight: 'bold', marginBottom: 4 }}>最佳权重（可应用）：</div>
                      <div>road_3: {gaBest.road_3_score.toFixed(1)}</div>
                      <div>road_4: {gaBest.road_4_score.toFixed(1)}</div>
                      <div>live4: {gaBest.live4_score.toFixed(1)}</div>
                      <div>live5: {gaBest.live5_score.toFixed(1)}</div>
                      <div>vcdt: {gaBest.vcdt_bonus.toFixed(1)}</div>
                    </div>
                  )}

                  {gaHistory.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ fontWeight: 'bold', marginBottom: 6 }}>训练曲线：</div>
                      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>代数</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>最佳</th>
                            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>平均</th>
                          </tr>
                        </thead>
                        <tbody>
                          {gaHistory.map(row => (
                            <tr key={row.generation}>
                              <td style={{ padding: '4px 0' }}>{row.generation}</td>
                              <td style={{ padding: '4px 0' }}>{row.bestFitness.toFixed(3)}</td>
                              <td style={{ padding: '4px 0' }}>{row.avgFitness.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={{ marginTop: 12, fontSize: 12 }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 4 }}>训练日志：</div>
                    <div style={{ maxHeight: 140, overflow: 'auto' }}>
                      {gaEvents.length === 0 ? (
                        <div style={{ color: '#777' }}>暂无日志</div>
                      ) : (
                        gaEvents.map((e, idx) => (
                          <div key={idx} style={{ padding: '2px 0' }}>
                            {e}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {consoleTab === 'deep' && (
                <div>
                  <h3 style={{ marginTop: 0 }}>深度学习训练器</h3>
                  <div style={{ marginBottom: 10, fontSize: 12, color: '#444' }}>
                    状态：{trainingStatus}
                    {trainingProgress?.elapsedMs != null && (
                      <span style={{ marginLeft: 8, color: '#666' }}>
                        {formatElapsedMs(trainingProgress.elapsedMs)}
                      </span>
                    )}
                  </div>

                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>数据集</div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="radio"
                          name="trainingSource"
                          value="selfplay"
                          checked={trainingSource === 'selfplay'}
                          onChange={() => setTrainingSource('selfplay')}
                        />
                        自对弈
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="radio"
                          name="trainingSource"
                          value="jsonl"
                          checked={trainingSource === 'jsonl'}
                          onChange={() => setTrainingSource('jsonl')}
                        />
                        JSONL 导入
                      </label>
                    </div>

                    {trainingSource === 'selfplay' ? (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            对局数
                            <input
                              type="number"
                              min={1}
                              value={selfPlayConfig.games}
                              onChange={onSelfPlayConfigChange('games')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            思考时间（毫秒）
                            <input
                              type="number"
                              min={10}
                              value={selfPlayConfig.timeMs}
                              onChange={onSelfPlayConfigChange('timeMs')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            模式
                            <select
                              value={selfPlayConfig.mode}
                              onChange={e =>
                                setSelfPlayConfig(prev => ({
                                  ...prev,
                                  mode: e.target.value as SelfPlayMode,
                                }))
                              }
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            >
                              <option value="fast">fast</option>
                              <option value="normal">normal</option>
                              <option value="deep">deep</option>
                            </select>
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            随机开局层数
                            <input
                              type="number"
                              min={0}
                              value={selfPlayConfig.randomOpeningPlies}
                              onChange={onSelfPlayConfigChange('randomOpeningPlies')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            随机种子
                            <input
                              type="number"
                              value={selfPlayConfig.seed}
                              onChange={onSelfPlayConfigChange('seed')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            最大样本数
                            <input
                              type="number"
                              min={1000}
                              value={selfPlayConfig.maxSamples}
                              onChange={onSelfPlayConfigChange('maxSamples')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                        </div>
                        <label style={{ fontSize: 12, color: '#444', display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                          <input
                            type="checkbox"
                            checked={selfPlayConfig.augment}
                            onChange={e =>
                              setSelfPlayConfig(prev => ({ ...prev, augment: e.target.checked }))
                            }
                          />
                          对称增强
                        </label>
                        <div style={{ marginTop: 8 }}>
                          <button
                            style={{ ...consoleMainBtnStyle, pointerEvents: 'auto' }}
                            onClick={startSelfPlayDataset}
                            disabled={trainingBusy}
                            type="button"
                          >
                            {trainingBusy ? '生成中...' : '生成数据集'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            最大样本数
                            <input
                              type="number"
                              min={1000}
                              value={importConfig.maxSamples}
                              onChange={onImportConfigChange('maxSamples')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                          <label style={{ fontSize: 12, color: '#444' }}>
                            抽样种子
                            <input
                              type="number"
                              value={importConfig.seed}
                              onChange={onImportConfigChange('seed')}
                              style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                            />
                          </label>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <input
                            type="file"
                            accept=".jsonl,.txt"
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) handleJsonlImport(file);
                            }}
                          />
                        </div>
                      </>
                    )}

                    {trainingStats && (
                      <div style={{ marginTop: 10, fontSize: 12, color: '#444' }}>
                        样本：{trainingStats.samples} / 已见 {trainingStats.seen} |
                        胜 {trainingStats.wins} | 和 {trainingStats.draws} | 负 {trainingStats.losses} |
                        均值 {trainingStats.avgResult.toFixed(3)}
                      </div>
                    )}
                  </div>

                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>训练</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        训练轮次
                        <input
                          type="number"
                          min={1}
                          value={trainingConfig.epochs}
                          onChange={onTrainingConfigChange('epochs')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        学习率
                        <input
                          type="number"
                          step="0.001"
                          value={trainingConfig.lr}
                          onChange={onTrainingConfigChange('lr')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        L2 正则
                        <input
                          type="number"
                          step="0.0001"
                          value={trainingConfig.l2}
                          onChange={onTrainingConfigChange('l2')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        随机种子
                        <input
                          type="number"
                          value={trainingConfig.seed}
                          onChange={onTrainingConfigChange('seed')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button
                        style={{ ...consoleMainBtnStyle, pointerEvents: 'auto' }}
                        onClick={startTrainingValueModel}
                        disabled={trainingBusy}
                        type="button"
                      >
                        {trainingBusy ? '训练中...' : '训练价值模型'}
                      </button>
                    </div>
                    {trainingLosses.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 12, color: '#444', marginBottom: 4 }}>
                          损失曲线（最近 {trainingLosses.length} 次）
                        </div>
                        <svg width="160" height="50">
                          <polyline
                            fill="none"
                            stroke="#2563eb"
                            strokeWidth="2"
                            points={buildSparklinePath(trainingLosses, 160, 50)}
                          />
                        </svg>
                        <div style={{ fontSize: 12, color: '#666' }}>
                          最新：{trainingLosses[trainingLosses.length - 1].toFixed(4)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>模型</div>
                    <div style={{ fontSize: 12, color: '#444' }}>
                      训练快照：{trainedModel?.trainedAt ?? '无'} |
                      样本 {trainedModel?.samples ?? 0} |
                      轮次 {trainedModel?.epochs ?? 0}
                    </div>
                    <div style={{ fontSize: 12, color: '#444', marginTop: 4 }}>
                      已应用：{appliedModel?.trainedAt ?? '内置'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      <button
                        style={{ ...consoleMainBtnStyle, pointerEvents: 'auto' }}
                        onClick={applyTrainedModel}
                        disabled={!trainedModel}
                        type="button"
                      >
                        应用到引擎
                      </button>
                      <button
                        style={{ ...consoleMainBtnStyle, background: '#6b7280', borderColor: '#6b7280' }}
                        onClick={resetAppliedModel}
                        type="button"
                      >
                        恢复内置模型
                      </button>
                    </div>
                  </div>

                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, marginTop: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>快速评估（对比基线）</div>
                    <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>
                      状态：{evalStatus}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        对局数
                        <input
                          type="number"
                          min={2}
                          value={evalConfig.games}
                          onChange={onEvalConfigChange('games')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        思考时间（毫秒）
                        <input
                          type="number"
                          min={10}
                          value={evalConfig.timeMs}
                          onChange={onEvalConfigChange('timeMs')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        模式
                        <select
                          value={evalConfig.mode}
                          onChange={e =>
                            setEvalConfig(prev => ({
                              ...prev,
                              mode: e.target.value as SelfPlayMode,
                            }))
                          }
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        >
                          <option value="fast">fast</option>
                          <option value="normal">normal</option>
                          <option value="deep">deep</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        随机开局层数
                        <input
                          type="number"
                          min={0}
                          value={evalConfig.randomOpeningPlies}
                          onChange={onEvalConfigChange('randomOpeningPlies')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, color: '#444' }}>
                        随机种子
                        <input
                          type="number"
                          value={evalConfig.seed}
                          onChange={onEvalConfigChange('seed')}
                          style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #d4d4d4' }}
                        />
                      </label>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <button
                        style={{ ...consoleMainBtnStyle, pointerEvents: 'auto' }}
                        onClick={runModelEvaluation}
                        disabled={evalBusy}
                        type="button"
                      >
                        {evalBusy ? '评估中...' : '开始评估'}
                      </button>
                    </div>
                    {evalStats && (
                      <div style={{ marginTop: 8, fontSize: 12, color: '#444' }}>
                        对局 {evalStats.games} | 胜 {evalStats.winsA} |
                        和 {evalStats.draws} | 负 {evalStats.winsB} |
                        胜率 {Math.round(evalStats.winRateA * 100)}% |
                        平均步数 {evalStats.avgMoves.toFixed(1)}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {consoleTab === 'export' && (
                <div>
                  <h3 style={{ marginTop: 0 }}>模型导出与导入</h3>
                  <div style={{ display: 'grid', gap: 12 }}>
                    <div
                      style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 10,
                        padding: 12,
                        background: '#f9fafb',
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>导出</div>
                      <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
                        JSON 为完整快照；TS/Python/C++ 便于集成到外部推理环境。
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          style={consoleMainBtnStyle}
                          onClick={() => exportModel('json')}
                          disabled={!trainedModel && !appliedModel}
                        >
                          导出 JSON
                        </button>
                        <button
                          style={consoleMainBtnStyle}
                          onClick={() => exportModel('ts')}
                          disabled={!trainedModel && !appliedModel}
                        >
                          导出 TS
                        </button>
                        <button
                          style={consoleMainBtnStyle}
                          onClick={() => exportModel('py')}
                          disabled={!trainedModel && !appliedModel}
                        >
                          导出 Python
                        </button>
                        <button
                          style={consoleMainBtnStyle}
                          onClick={() => exportModel('cpp')}
                          disabled={!trainedModel && !appliedModel}
                        >
                          导出 C++
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        border: '1px solid #e5e7eb',
                        borderRadius: 10,
                        padding: 12,
                        background: '#f9fafb',
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>导入</div>
                      <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
                        仅支持 JSON 快照导入。
                      </div>
                      <input
                        type="file"
                        accept=".json"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) handleModelImport(file);
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 12, color: '#444' }}>
                      当前模型：{appliedModel?.trainedAt ?? '内置'} |
                      训练模型：{trainedModel?.trainedAt ?? '无'}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div
              style={{
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                padding: 12,
                fontSize: 13,
              }}
            >
              <h4 style={{ margin: '4px 0 8px' }}>当前权重快照</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 6 }}>
                <div>road_3: {weights.road_3_score.toFixed(1)}</div>
                <div>road_4: {weights.road_4_score.toFixed(1)}</div>
                <div>live4: {weights.live4_score.toFixed(1)}</div>
                <div>live5: {weights.live5_score.toFixed(1)}</div>
                <div>vcdt: {weights.vcdt_bonus.toFixed(1)}</div>
              </div>
            </div>
          </div>
              </>
            )}
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

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
              AI 控制台
            </button>
            <button
              onClick={openKifuDialog}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                background: '#f59e0b',
                border: '1px solid #d97706',
                color: '#1f2937',
                fontSize: 14,
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
                whiteSpace: 'nowrap',
              }}
            >
              导出棋谱
            </button>
          </div>
        </header>

        {showKifuDialog && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(15, 23, 42, 0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
            }}
          >
            <div
              style={{
                width: 'min(92vw, 420px)',
                background: '#ffffff',
                borderRadius: 16,
                padding: 16,
                boxShadow: '0 12px 30px rgba(0,0,0,0.18)',
              }}
            >
              <h3 style={{ margin: 0, fontSize: 18 }}>导出棋谱</h3>
              <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>
                可在导出前修改队名、赛事与时间地点信息。
              </div>

              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  黑方队名
                  <input
                    value={kifuMetaDraft?.blackTeam ?? ''}
                    onChange={updateKifuField('blackTeam')}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      fontSize: 13,
                    }}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  白方队名
                  <input
                    value={kifuMetaDraft?.whiteTeam ?? ''}
                    onChange={updateKifuField('whiteTeam')}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      fontSize: 13,
                    }}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  时间地点
                  <input
                    value={kifuMetaDraft?.timePlace ?? ''}
                    onChange={updateKifuField('timePlace')}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      fontSize: 13,
                    }}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  赛事名称
                  <input
                    value={kifuMetaDraft?.event ?? ''}
                    onChange={updateKifuField('event')}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 8,
                      border: '1px solid #e2e8f0',
                      fontSize: 13,
                    }}
                  />
                </label>
              </div>

              <div
                style={{
                  marginTop: 16,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                <button
                  onClick={() => setShowKifuDialog(false)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid #e2e8f0',
                    background: '#f8fafc',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  取消
                </button>
                <button
                  onClick={handleExportKifu}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid #d97706',
                    background: '#f59e0b',
                    color: '#1f2937',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  导出
                </button>
              </div>
            </div>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: 16,
            flex: 1,
          }}
        >
          {/* 左侧：棋盘 + 控制面板 */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minWidth: 620,
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
                alignItems: 'flex-start',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    background: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6)',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                    计时
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto auto auto',
                      columnGap: 10,
                      rowGap: 2,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 600, color: '#111827' }}>黑</span>
                    <span>本轮耗时 {formatTurnMs(blackTurnMs)}</span>
                    <span>总耗时 {formatElapsedMs(blackTimeMs)}</span>
                    <span style={{ fontWeight: 600, color: '#475569' }}>白</span>
                    <span>本轮耗时 {formatTurnMs(whiteTurnMs)}</span>
                    <span>总耗时 {formatElapsedMs(whiteTimeMs)}</span>
                  </div>
                </div>
              </div>

              {gameMode === 'PVE' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#666' }}>人机模式</div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button
                        onClick={() => {
                          setHumanVsAiMode('normal');
                          hardReset();
                        }}
                        style={modeBtnStyle(humanVsAiMode === 'normal')}
                      >
                        普通模式
                      </button>
                      <button
                        onClick={() => {
                          setHumanVsAiMode('coop');
                          hardReset();
                        }}
                        style={modeBtnStyle(humanVsAiMode === 'coop')}
                      >
                        合作模式（A vs B+AI）
                      </button>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: '#666' }}>
                      {humanVsAiMode === 'coop' ? '人类A执子' : '人类执子'}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => {
                          setHumanPlayer('BLACK');
                          hardReset();
                        }}
                        style={modeBtnStyle(humanPlayer === 'BLACK')}
                      >
                        黑
                      </button>
                      <button
                        onClick={() => {
                          setHumanPlayer('WHITE');
                          hardReset();
                        }}
                        style={modeBtnStyle(humanPlayer === 'WHITE')}
                      >
                        白
                      </button>
                    </div>
                  </div>

                  {humanVsAiMode === 'coop' && hybridPlanForDisplay && (
                    <div
                      style={{
                        marginTop: 2,
                        color: '#444',
                        fontSize: 12,
                        lineHeight: 1.4,
                        maxWidth: 260,
                      }}
                    >
                      <div>
                        人类A：{humanPlayer === 'BLACK' ? '黑' : '白'}；混合方（B+AI）：
                        {coopContext.sideOfHybrid === 'BLACK' ? '黑' : '白'}
                      </div>
                      <div>
                        混合方第 {hybridTurnIndexForDisplay} 轮：由{' '}
                        {hybridPlanForDisplay.actor === 'AI' ? 'AI' : '人类B'} 下{' '}
                        {hybridPlanForDisplay.stones} 子（黑方首轮仅 1 子）
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
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
                    <option value="traditional">传统融合搜索</option>
                    <option value="auto">混合策略</option>
                    <option value="deep">深度 MCTS</option>
                  </select>
                </div>

                <div>
                  <div style={{ fontSize: 12, color: '#666' }}>分析等级</div>
                  <select
                    value={analysisMode}
                    onChange={e =>
                      setAnalysisMode(e.target.value as AnalysisMode)
                    }
                    style={{
                      marginTop: 4,
                      padding: '4px 8px',
                      borderRadius: 8,
                      border: '1px solid #ccc',
                      fontSize: 13,
                    }}
                  >
                    <option value="off">off</option>
                    <option value="light">light</option>
                    <option value="full">full</option>
                  </select>
                </div>

                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    background: 'rgba(255,255,255,0.85)',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.05)',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
                    对局控制
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button
                      onClick={handleStartGame}
                      disabled={gameStarted}
                      style={modeBtnStyle(false)}
                    >
                      开始对局
                    </button>
                    <button
                      onClick={handleUndo}
                      disabled={history.length === 0}
                      style={modeBtnStyle(false)}
                    >
                      悔棋
                    </button>
                    <button onClick={hardReset} style={modeBtnStyle(false)}>
                      重新开局
                    </button>
                  </div>
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
                    {stonesToPlaceThisTurn}{' '}
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
                  {aiThinking && currentActorIsAI && !state.winner && (
                    <span style={{ marginLeft: 8, color: '#f97316' }}>
                      AI 正在思考…
                    </span>
                  )}
                  {coopContext.coopEnabled &&
                    coopContext.isHybridTurn &&
                    coopContext.hybridPlan && (
                      <div style={{ marginTop: 4, color: '#0f172a', fontSize: 12 }}>
                        混合方第 {coopContext.hybridTurnIndex} 轮：本轮由{' '}
                        {coopContext.hybridPlan.actor === 'AI' ? 'AI' : '人类B'} 落{' '}
                        {coopContext.hybridPlan.stones} 子（黑方首轮仅 1 子）
                      </div>
                    )}
                </div>

                <GameBoard
                  state={state}
                  onHumanMove={handleHumanMove}
                  lastAIMove={lastAIMove?.move}
                  currentPlayerIsHuman={currentPlayerIsHuman}
                  stonesToPlace={stonesToPlaceThisTurn}
                  suggestedPoints={localProbePoints}
                  mctsSuggestedPoints={mctsSuggestedPoints}
                />
              </div>
            </div>
          </div>

          {/* Middle: roadmap + root stats */}
          <div
            style={{
              width: 320,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                flex: 1,
                borderRadius: 16,
                background: 'rgba(255,255,255,0.95)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.08)',
                overflowY: 'auto',
                overflowX: 'hidden',
              }}
            >
              <Roadmap
                state={state}
                focusPlayer={humanPlayer}
                lastAIMove={lastAIMove}
                lastAiThinkTimeMs={lastAiThinkTimeMs}
                roadSuggestions={roadSuggestions}
                analysisMode={analysisMode}
                winProb={winProb}
                winProbSource={winProbSource}
                winProbPlayer={winProbPlayer}
                aiSide={aiSide}
                valueFeatureSummary={valueFeatureSummary}
                localProbeMoves={localProbe?.moves ?? []}
              />
            </div>


          </div>

          {/* 右列：AI 实时分析系统 */}
          <div
            style={{
              width: 'auto',
              minWidth: 360,
              flex: '1 0 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flexShrink: 0,
              overflowX:'visible'
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
                width:'fit-content',
                minWidth:'100%'
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

function formatPhaseLabel(phase?: string): string {
  switch (phase) {
    case 'generate':
      return '生成';
    case 'parse':
      return '解析';
    case 'train':
      return '训练';
    case 'evaluate':
      return '评估';
    default:
      return '-';
  }
}

function formatSelfPlayModeLabel(mode: SelfPlayMode): string {
  switch (mode) {
    case 'fast':
      return 'fast';
    case 'deep':
      return 'deep';
    case 'normal':
    default:
      return 'normal';
  }
}

function formatElapsedMs(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSec = safe / 1000;
  if (totalSec >= 60) {
    const minutes = Math.floor(totalSec / 60);
    const seconds = (totalSec % 60).toFixed(1).padStart(4, '0');
    return `${minutes}:${seconds}`;
  }
  return `${totalSec.toFixed(1)}s`;
}

function formatTurnMs(ms: number): string {
  const safe = Math.max(0, ms);
  return `${(safe / 1000).toFixed(1)}s`;
}

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

export const App: React.FC = () => <MainApp />;
