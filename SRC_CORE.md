# src 核心架构/策略速览（含关键代码片段）

## 0) 分层与职责（按目录）

- `src/core/`：规则、状态、哈希、威胁分析、评估、搜索（PVS/MCTS）、自对弈与训练
- `src/workers/`：将重计算搬到 WebWorker（PVS/MCTS/自对弈&训练）
- `src/strategy/`：高层策略选择与复杂度评估（hybrid/auto）
- `src/ui/` + `src/components/`：对局界面、分析面板、训练控制台与 UI 组件库
- `src/models/`：默认 value model 参数（线性）
- `src/utils/`：棋谱导出、编码等辅助
- `src/types/` & `src/types.ts`：核心 TypeScript 契约（跨模块边界的“协议”）

---

## 1) 核心契约（贯穿整个系统）

- `src/types.ts`：游戏状态、落子、评估权重、搜索配置等基础契约

```ts
export interface GameState {
  board: Cell[][];
  currentPlayer: Player;
  moveNumber: number;
  lastMove?: Move;
  winner?: Player | 'DRAW';
  zobristHash: bigint;
}
```

- `src/core/pattern_library.ts`：ThreatReport 统一威胁分析输出（PVS/RZOP/ResNet policy/可视化共享）

```ts
export interface ThreatReport {
  player: Player;
  patterns: PatternHit[];
  byType: Record<PatternType, PatternHit[]>;
  oppPatterns?: PatternHit[];
  oppByType?: Record<PatternType, PatternHit[]>;
  winIn1: Position[];
  winIn2: [Position, Position][];
  myWin1Points: Position[];
  myWin2Pairs: [Position, Position][];
  oppWin1Points: Position[];
  oppWin2Pairs: [Position, Position][];
  winningPoints: Position[];
  winPairs: [Position, Position][];
  forcingPoints: Position[];
  mustDefendPoints: Position[];
  candidatePoints: Position[];
  defensePoints: Position[];
  attackPoints: Position[];
}
```

---

## 2) 状态与哈希：可增量、可缓存（为搜索/Worker/训练打基础）

- `src/core/zobrist.ts`：SplitMix64 生成 64-bit Zobrist 表 + side-to-move bit

```ts
export const ZOBRIST_TABLE: ZobristTable = (() => {
  const table: ZobristTable = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    table[y] = [];
    for (let x = 0; x < BOARD_SIZE; x++) {
      table[y][x] = [nextRand64(), nextRand64()];
    }
  }
  return table;
})();

export function toggleSideHash(hash: bigint): bigint {
  return hash ^ ZOBRIST_SIDE_TO_MOVE;
}
```

- `src/core/game_state.ts`：行级 copy-on-write + 增量更新 `zobristHash`（显著降低 clone 成本）

```ts
function cloneBoardForPositions(
  board: Cell[][],
  positions: Position[],
): Cell[][] {
  const copy = board.slice();
  const copiedRows = new Set<number>();
  for (const pos of positions) {
    const y = pos.y;
    if (y < 0 || y >= board.length) continue;
    if (copiedRows.has(y)) continue;
    copy[y] = board[y].slice();
    copiedRows.add(y);
  }
  return copy;
}

export function applyMove(state: GameState, move: Move): GameState {
  const next = cloneState(state, move.positions);
  const value: Cell = move.player === 'BLACK' ? 1 : 2;

  const seen = new Set<number>();

  for (const pos of move.positions) {
    const key = posIdx(pos.x, pos.y);
    if (seen.has(key)) continue;
    seen.add(key);
    next.board[pos.y][pos.x] = value;
    next.zobristHash ^= ZOBRIST_TABLE[pos.y][pos.x][value === 1 ? 0 : 1];
  }

  next.lastMove = move;
  next.currentPlayer = move.player === 'BLACK' ? 'WHITE' : 'BLACK';
  next.moveNumber += 1;
  next.zobristHash = toggleSideHash(next.zobristHash);
  return next;
}
```

- `src/core/threat_service.ts`：以 `zobristHash` 为 key 的 ThreatReport LRU 缓存（减少威胁扫描开销）

```ts
const THREAT_CACHE_LIMIT = 50_000;
const THREAT_CACHE_EVICT_BATCH = Math.max(1000, Math.floor(THREAT_CACHE_LIMIT * 0.05));
const threatCacheBlack = new Map<bigint, ThreatReport>();
const threatCacheWhite = new Map<bigint, ThreatReport>();

function getCachedReport(state: GameState, player: Player): ThreatReport {
  const cache = cacheFor(player);
  const hash = state.zobristHash;
  const hit = cache.get(hash);
  if (hit) {
    cacheHits += 1;
    touchCache(cache, hash, hit);
    return hit;
  }

  cacheMisses += 1;
  const report = analyzeThreats(state, player);
  analyzeCalls += 1;
  cache.set(hash, report);

  trimCache(cache);

  return report;
}
```

---

## 3) 规则与合法性：同时服务 UI 与引擎（含协作模式特殊需求）

- `src/core/rules.ts`：Connect6 的 1/2 子规则；`allowIncomplete` 支持“协作模式”下 AI 第一子即胜时提前结束

```ts
export function getStonesToPlace(moveNumber: number, _player: Player): number {
  if (moveNumber === 0) {
    return 1;
  }
  return 2;
}

export function applyMoveWithWinner(
  state: GameState,
  move: Move,
  opts?: { allowIncomplete?: boolean },
): GameState {
  const next = cloneState(state, move.positions);
  const allowIncomplete = opts?.allowIncomplete === true;

  const required = getStonesToPlace(state.moveNumber, move.player);
  if (!allowIncomplete) {
    if (move.positions.length !== required) {
      throw new Error(
        `本手应下 ${required} 子，但实际下了${move.positions.length} 子`,
      );
    }
  } else if (move.positions.length > required) {
    throw new Error(
      `本手最多下 ${required} 子，但实际下了${move.positions.length} 子`,
    );
  }

  // ...（省略：越界/重复/占用校验 + 胜负判定）
  return next;
}
```

---

## 4) 走子生成：RZOP（Relevant Zone + Objective Pruning）与预计算道路

- `src/core/rzop.ts`：阶段（early/mid/late）决定 topK 与近邻半径；优先“必须防守点”，再补充进攻/邻域

```ts
export function generateRZOPCandidates(state: GameState): Position[] {
  const player = state.currentPlayer;
  const { my: myReport, opp: oppReport } = analyzeBothCached(state, player);
  const topK = computeTopK(state);
  const nearRadius = computeNearRadius(state);

  const urgent: Position[] = [];
  const seen = new Set<number>();

  uniqueEmptyPoints(state, oppReport.winIn1, seen, urgent);
  for (const [a, b] of oppReport.winIn2) {
    uniqueEmptyPoints(state, [a, b], seen, urgent);
  }

  const compositeDefense = collectKeyPointsByType(oppReport, [
    'DOUBLE_FOUR',
    'FOUR_THREE',
    'DOUBLE_THREE',
    'LIVE4',
  ]);
  uniqueEmptyPoints(state, compositeDefense, seen, urgent);

  // ...（省略：严格双活三 ends、防守/进攻/邻域补齐）
  return sortByScore([...urgent, ...nonUrgent], scorePosition);
}
```

- `src/core/road_encoding.ts`：预计算“长度=6 的 road”与整条 line，并建立 cell->roads/lines 索引（威胁/roadmap/复杂度共用）

```ts
const CELL_ROADS: Road[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const CELL_ROAD_OFFSETS: RoadOffset[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const LINE_CELLS: Line[][] = Array.from(
  { length: BOARD_CELLS },
  () => [],
);
const ALL_ROADS: Road[] = precomputeRoads();
const ALL_LINES: Line[] = precomputeLines();

function precomputeRoads(): Road[] {
  const roads: Road[] = [];
  let id = 0;

  for (const { dir, id: dirId } of DIRS) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        // ...（省略：采样 6 格，inBoard 校验）
        CELL_ROADS[flat].push(road);
        CELL_ROAD_OFFSETS[flat].push({ roadId: road.id, offset: idx });
      }
    }
  }
  return roads;
}
```

---

## 5) 评估：Threat + PatternEvaluator（线正则特征）+ Value Features（训练/推理复用）

- `src/core/pattern_evaluator.ts`：全局线特征评估；支持增量更新（仅重算 lastMove 影响到的 lines）

```ts
updateIncremental(board: Cell[][], lastMove: Move): EvalResult {
  if (!this.initialized) {
    return this.evaluate(board);
  }

  const selfKey = this.rootPlayer;
  const oppKey = this.otherPlayer(this.rootPlayer);
  const touchedLines = new Set<number>();
  for (const p of lastMove.positions) {
    const key = posIdx(p.x, p.y);
    const ids = this.cellToLines.get(key);
    if (!ids) continue;
    ids.forEach(id => touchedLines.add(id));
  }

  for (const id of touchedLines) {
    const line = this.lines[id];
    const prev = this.lineCache.get(id);
    if (prev) {
      this.subFromTotals(selfKey, prev.self);
      this.subFromTotals(oppKey, prev.opp);
    }
    // ...（省略：重算 self/opp 特征并写回 lineCache）
  }

  this.applyDerivedTotals();
  this.applyBoardGlobals(board);
  return {
    score: this.computeScore(),
    features: this.getFeatureVector(board),
  };
}
```

- `src/core/pattern_evaluator.ts`：boundary sentinel + 规范化反转线，regex 捕捉 live/blocked patterns（轻量、可在 Worker 内跑）

```ts
private extractFeatures(line: string): FeatureVector {
  const rev = line.split('').reverse().join('');
  const canonical = line < rev ? line : rev;

  const apply = (name: FeatureName, re: RegExp) => {
    const m = canonical.match(re);
    if (m) counts[name] += m.length;
  };

  apply('live_four', /(?=\.XXXX\.)/g);
  apply('live_three', /(?=\.XX\.X\.)/g);
  apply('blocked_four', /(?=(?:B|O)XXXX\.|\.(?:XXXX(?:B|O)))/g);
  // ...
  return counts;
}
```

- `src/core/value_features.ts`：ThreatReport 计数 + PatternEvaluator 特征 + board 图统计（group/chain/frontier）拼接为线性模型输入

```ts
const features = [
  myCount.win1 - oppCount.win1,
  myCount.win2 - oppCount.win2,
  myCount.live5 - oppCount.live5,
  myCount.charge5 - oppCount.charge5,
  myCount.live4 - oppCount.live4,
  myCount.charge4 - oppCount.charge4,
  myCount.doubleFour - oppCount.doubleFour,
  myCount.fourThree - oppCount.fourThree,
  myCount.doubleThree - oppCount.doubleThree,
  myCount.live3 - oppCount.live3,
  myCount.sleep3 - oppCount.sleep3,
  myCount.attackPoints - oppCount.attackPoints,
  myCount.defensePoints - oppCount.defensePoints,
  patternFeatures.live_two,
  patternFeatures.blocked_two,
  patternFeatures.initiative / patternScale,
  patternFeatures.connectivity / patternScale,
  patternFeatures.shape_balance / patternScale,
  (myStats.stoneCount - oppStats.stoneCount) / boardScale,
  (myStats.centerControl - oppStats.centerControl) / boardScale,
  (myStats.frontier - oppStats.frontier) / boardScale,
  myStats.maxChain - oppStats.maxChain,
  (myStats.groupCount - oppStats.groupCount) / boardScale,
];
```

---

## 6) 搜索（传统）：PVS + 迭代加深 + Aspiration Window + Tactical Hint

- `src/core/pvs_search.ts`：root 层迭代加深，并用 null-window PVS + aspiration 重试

```ts
for (let d = startDepth; d <= maxDepth; d++) {
  const timeLeft = deadline - getCurrentTime();
  if (timeLeft < 100) break;

  let window = ASPIRATION_WINDOW;
  const useAspiration = Number.isFinite(bestScore) && d > startDepth;
  let baseAlpha = useAspiration ? bestScore - window : -Infinity;
  let baseBeta = useAspiration ? bestScore + window : Infinity;

  const sorted = orderMoves(
    moveCombos,
    rootState,
    rootPlayer,
    rootPlayer,
    searchWeights,
    d,
    undefined,
    true,
    patternEval,
    tacticalHintSet,
  );

  for (let retry = 0; retry <= MAX_ASP_RETRY; retry++) {
    // ...（省略：normalizeWindow、记录 window）
    for (let i = 0; i < sorted.length; i++) {
      const move = sorted[i];
      const next = applyMoveWithWinner(rootState, move);
      const opp = switchPlayer(rootPlayer);

      let score: number;
      if (i === 0 || failed) {
        score = -pvs(next, rootPlayer, opp, -beta, -alpha, d - 1, searchWeights, deadline, true, MAX_LOCAL_EXTENSION, undefined, patternEval);
      } else {
        score = -pvs(next, rootPlayer, opp, -alpha - 1, -alpha, d - 1, searchWeights, deadline, false, MAX_LOCAL_EXTENSION, undefined, patternEval);
        if (score > alpha && score < beta) {
          score = -pvs(next, rootPlayer, opp, -beta, -alpha, d - 1, searchWeights, deadline, true, MAX_LOCAL_EXTENSION, undefined, patternEval);
        }
      }
    }
  }
}
```

- `src/core/vcf_vct_solver.ts`：战术线求解（节点/时间/深度/分支上限），基于 ThreatReport 的 forcing moves 递归验证

```ts
function solveForcedLine(
  state: GameState,
  attacker: Player,
  types: PatternType[],
  ctx: SolverContext,
  depth: number,
): Move[] | null {
  if (ctx.nodes++ >= ctx.maxNodes) return null;
  if (Date.now() >= ctx.deadline) return null;
  if (state.winner) {
    return state.winner === attacker ? [] : null;
  }
  if (depth <= 0) return null;

  const toMove = state.currentPlayer;
  if (toMove === attacker) {
    const report = analyzeThreatCached(state, attacker);
    if (!hasForcingThreat(report, types)) return null;
    // ...（省略：枚举 attackMoves，递归验证）
    return null;
  }

  const attackReport = analyzeThreatCached(state, attacker);
  if (!hasForcingThreat(attackReport, types)) return null;
  // ...（省略：枚举 defenseMoves，要求 ALL defense branches 都能挡住）
  return bestLine;
}
```

---

## 7) 搜索（深度）：MCTS + Policy/Value + 可复用树表 + 并行 Worker

- `src/strategy/hybrid_strategy.ts`：按 step/complexity 选择 `traditional/deep/hybrid`，并在 hybrid 下“PVS vs MCTS”择优

```ts
async decideMove(state: GameState, player: Player): Promise<AIMoveDecision> {
  const step = state.moveNumber;
  const complexity = estimateComplexity(state);

  const strategy = this.selectStrategy(step, complexity);

  if (strategy === 'traditional') {
    const result = await pvsSearchBestMoveAsync(state, player, this.config.weights, this.config.pvsConfig);
    result.debugInfo = {
      ...(result.debugInfo ?? {}),
      engine: result.debugInfo?.engine ?? 'pvs+threat+zorp',
      strategy,
    };
    return result;
  }

  if (strategy === 'deep') {
    const result = await this.mctsAI.decideMove(state, player);
    result.debugInfo = {
      ...(result.debugInfo ?? {}),
      engine: result.debugInfo?.engine ?? 'mcts',
      strategy,
    };
    return result;
  }

  const pvsResult = await pvsSearchBestMoveAsync(state, player, this.config.weights, this.config.pvsConfig);
  const mctsResult = await this.mctsAI.decideMove(state, player);

  const final = mctsResult.score > pvsResult.score ? mctsResult : pvsResult;
  final.debugInfo = {
    ...(final.debugInfo ?? {}),
    engine: final.debugInfo?.engine ?? (final === mctsResult ? 'mcts' : 'pvs+threat+zorp'),
    strategy: 'hybrid',
  };
  return final;
}
```

- `src/core/mcts_ai_engine.ts`：按 rootPlayer 分 self/opp 两张表复用；支持 ttl 重置、decay 衰减，避免“旧树污染”

```ts
private applyReusePolicy(node: MCTSNode, age: number): void {
  if (age <= 0) return;
  const ttl = this.config.reuseTtl;
  if (Number.isFinite(ttl) && (ttl as number) > 0 && age >= (ttl as number)) {
    this.resetNode(node);
    return;
  }
  const decay = this.config.reuseDecay;
  if (Number.isFinite(decay) && (decay as number) > 0 && (decay as number) < 1) {
    const factor = Math.pow(decay as number, age);
    this.applyDecay(node, factor);
    if (node.children.size > 0) {
      for (const child of node.children.values()) {
        this.applyDecay(child, factor);
        child.lastTouched = this.reuseTick;
      }
    }
  }
}
```

- `src/core/state_serialization.ts`：`Uint8Array` 序列化 board，配合 transferable buffer 提升 Worker 通信效率

```ts
export type SerializedGameState = {
  board: Uint8Array;
  currentPlayer: Player;
  moveNumber: number;
  winner?: Player | 'DRAW';
  zobristHash: bigint;
};
```

- `src/core/mcts_worker_pool.ts`：并行 MCTS（WebWorker），将 `payload.state.board.buffer` 作为 transferable 发送

```ts
const transfer = payload.state.board.buffer;
worker.postMessage(
  { type: 'search', id, ...payload } as WorkerRequest,
  [transfer],
);
```

- `src/core/resnet_ai.ts`：当前实现为 LinearPolicyValueEvaluator（logistic value + heuristic threat policy），带 zobrist LRU cache

```ts
const { features, names } = computeValueFeatures(state, state.currentPlayer);
let sum = this.bias;
for (let i = 0; i < features.length; i += 1) {
  sum += features[i] * this.weights[i];
}
const pred = sigmoid(sum);
const value = pred * 2 - 1;
const policy = buildThreatPolicy(state, state.currentPlayer);
const output = { policy, value };
```

---

## 8) 开局库：哈希索引 + 对称扩增（降低早期分支爆炸）

- `src/core/opening_book.ts`：解析 `OPENING_BOOK_RAW`，按 8 种对称变换生成多份 `hash -> moves` 索引

```ts
for (const sym of SYMMETRIES) {
  const board =
    sym === 0 ? derived.board : transformBoard(derived.board, sym);
  const hash = computeZobristHash(board, derived.currentPlayer);
  let bucket = index.get(hash);
  if (!bucket) {
    bucket = new Map<string, BookMove>();
    index.set(hash, bucket);
  }
  for (const move of moves) {
    const transformed =
      sym === 0
        ? move.positions
        : move.positions.map(p => transformPosition(p, board.length, sym));
    const key = moveKey(transformed);
    const existing = bucket.get(key);
    if (!existing || move.weight > existing.weight) {
      bucket.set(key, { positions: transformed, weight: move.weight });
    }
  }
}
```

---

## 9) 自对弈与训练：Worker 化 + 数据约束 + 轻量模型（可导出）

- `src/core/connect6_ai.ts`（SelfPlay 使用）：多阶段时间预算（L0/L1/L2/L3），复杂局面才启用 MCTS，并用“置信度+再评估”融合

```ts
const budget = this.cfg.budgets[this.mode] ?? this.cfg.budgets.normal;
const l0l1Time = Math.max(5, Math.floor(timeMs * budget.l0l1));
const l2Time = Math.max(20, Math.floor(timeMs * budget.l2));
const l3Time = Math.max(0, timeMs - l0l1Time - l2Time);

const quick = pvsSearchBestMove(state, state.currentPlayer, this.cfg.weights, {
  maxDepth: this.cfg.quickDepth,
  timeLimitMs: remL1,
  useMultithreading: false,
});

const pvsRes = pvsSearchBestMove(state, state.currentPlayer, this.cfg.weights, {
  maxDepth: this.cfg.pvsDepth,
  timeLimitMs: remL2,
  useMultithreading: false,
});

if (canUseMcts && remTime > 50 && l3Time > 0 && complexity >= threshold) {
  const mcts = new MCTSConnect6AI(this.evaluator, {
    simulationCount: 200,
    simulationSteps: 30,
    expandNodes: Math.max(10, Math.min(40, this.cfg.mctsBranch)),
    minWinRateThreshold: 0,
  });
  const res = await mcts.decideMove(state, state.currentPlayer);
  mctsMove = res.move;
}
```

- `src/core/self_play.ts`：随机开局 plies + 对称增广样本；对局超长保护避免死循环

```ts
const openingPlies = this.opts.randomOpeningPlies ?? 3;

for (let i = 0; i < openingPlies && !state.winner; i++) {
  const rMove = this.randomMove(state);
  this.recordSample(state, rMove, samples);
  state = applyMoveWithWinner(state, rMove);
  moves.push(rMove);
}

if (this.opts.augmentSamples) {
  for (const sym of SYMMETRIES) {
    const sample: TrainingSample = {
      state: {
        board: transformBoard(snapshot.board, sym),
        currentPlayer: snapshot.currentPlayer,
        moveNumber: snapshot.moveNumber,
      },
      move: transformMove(move, snapshot.board.length, sym),
    };
    if (shouldRecord && samples) samples.push(sample);
    if (this.opts.onSample) this.opts.onSample(sample);
  }
  return;
}
```

- `src/core/training_dataset.ts`：reservoir sampling 控制 maxSamples；同时维护重复率与胜负分布

```ts
const pick = Math.floor(this.rng() * this.seen);
if (pick < this.maxSamples) {
  const prev = this.samples[pick];
  this.applyStats(prev, -1);
  this.samples[pick] = normalized;
  this.applyStats(normalized, 1);
}
```

- `src/core/value_trainer.ts`：在线 logistic 回归（SGD + L2），生成 `ValueModelSnapshot`（可导出 JSON/TS/Py/C++）

```ts
const error = pred - y;
for (let i = 0; i < featureCount; i += 1) {
  weights[i] -= lr * (error * features[i] + l2 * weights[i]);
}
bias -= lr * error;
```

- `src/core/training_worker_client.ts`：统一 Worker RPC（generate/parse/train/evaluate），支持 progress 回调与 cancel

```ts
private runTask<T>(
  payload: Record<string, unknown>,
  onProgress?: (update: ProgressUpdate) => void,
): Promise<T> {
  if (!this.worker) {
    return Promise.reject(new Error('Training worker not available'));
  }
  const id = ++this.seq;
  return new Promise<T>((resolve, reject) => {
    this.pending.set(id, { resolve, reject, onProgress });
    this.worker?.postMessage({ id, ...payload });
  });
}
```

- `src/workers/selfplay_worker.ts`：Worker 侧统一调度（generate/parse/train/evaluate）+ cancel 语义

```ts
ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    if (msg.id === activeId) cancelled = true;
    return;
  }

  activeId = msg.id;
  cancelled = false;

  const run = async () => {
    try {
      const result =
        msg.type === 'generate'
          ? await runGenerate(msg)
          : msg.type === 'parse'
          ? await runParse(msg)
          : msg.type === 'train'
          ? await runTrain(msg)
          : await runEvaluate(msg);
      if (cancelled) return;
      ctx.postMessage(result);
    } catch (err) {
      ctx.postMessage({
        id: msg.id,
        kind: 'error',
        error: (err as Error).message ?? String(err),
      });
    }
  };
  run();
};
```

---

## 10) 前端编排（App）：模式切换、分析、训练面板与可观测性

- `src/App.tsx`：统一编排“开局库 / PVS / 并行 MCTS / HybridStrategyManager”；并按 `analysisMode` 触发 hint 与 localProbe

```ts
// 1) 传统 PVS + VCDT + ZORP 搜索
if (strategyMode === 'traditional') {
  const r = pvsSearchBestMove(current, player, weights, pvsConfig);
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
```

- `src/App.tsx`：协作模式下允许 AI 第一子直接胜后提前结束（配合 `allowIncomplete`）

```ts
if (
  earlyStopAllowed &&
  expectedStones === 2 &&
  decision.move.positions.length === 2
) {
  const firstOnlyMove: Move = {
    player,
    positions: [decision.move.positions[0]],
  };
  const firstResult = tryApplyMoveWithWinner(
    workingState,
    firstOnlyMove,
    { allowIncomplete: true },
  );
  if (firstResult.state.winner === player) {
    appliedMove = firstOnlyMove;
    finalState = firstResult.state;
  } else {
    const fullResult = tryApplyMoveWithWinner(workingState, decision.move);
    finalState = fullResult.state;
  }
}
```

- `src/App.tsx`：训练 Worker 生命周期管理 + model snapshot 本地持久化（localStorage）

```ts
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
  if (appliedModel) {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(appliedModel));
  } else {
    localStorage.removeItem(MODEL_STORAGE_KEY);
  }
}, [appliedModel]);
```

---

## 11) UI/交互层关键点：Connect6 一手 1/2 子 + 提示系统 + 棋谱导出

- `src/ui/GameBoard.tsx`：支持 Connect6 一手 1/2 子交互（pendingPositions 达到 `stonesToPlace` 才提交）

```ts
const handleClick = (x: number, y: number) => {
  if (!currentPlayerIsHuman) return;
  if (state.board[y][x] !== 0) return;
  if (state.winner) return;
  if (pendingPositions.some(p => p.x === x && p.y === y)) return;
  const next = [...pendingPositions, { x, y }];

  if (next.length < stonesToPlace) {
    setPendingPositions(next);
  } else {
    const move: Move = {
      player: state.currentPlayer,
      positions: next,
    };
    setPendingPositions([]);
    onHumanMove(move);
  }
};
```

- `src/utils/kifu.ts`：棋谱导出采用“本地 helper server 优先，浏览器下载 fallback”，并尝试 iconv-lite 输出 gb2312/gbk

```ts
const serverUrl =
  (window as any).__KIFU_SERVER_URL__ ?? 'http://localhost:3001/save-kifu';
const resp = await fetch(serverUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ filename, text }),
});

const iconvModule = await import('iconv-lite');
const iconv = (iconvModule as any).default ?? iconvModule;
const enc =
  iconv.encodingExists && iconv.encodingExists('gb2312') ? 'gb2312' : 'gbk';
const buf: Uint8Array = iconv.encode(text, enc);
```

---

## 12) 训练仪表盘与组件库（UI 技术栈）

- `src/components/ui/*`：Radix UI + Tailwind（shadcn 风格）封装；`cn()` 合并 class，支持 variant/size（如 Button/Badge）
- `src/ui/TrainerConsolePanel.tsx` + `src/components/trainer/*`：训练流水线（generate/parse/train/eval）可视化、KPI/曲线/回放/对比
- `src/index.css`：通过 CSS variables 定义主题色与 chart 色板（支持 `.dark`）

