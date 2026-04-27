# Connect6 AI 优化/完善清单

该清单用于后续迭代：按优先级（P0→P2）给出可落地的优化点与建议落点文件。

## 已完成（本轮已修）

- [x] PVS/Quiescence 统一为“当前轮到谁走”的视角返回分数，修复 negamax 视角不一致导致的剪枝/TT 风险（`src/core/pvs_search.ts:410`）
- [x] PVS 搜索强制使用零和对称评估（`threat_defense_weight=1`），避免非对称评估破坏 negamax 假设（`src/core/pvs_search.ts:2020`）
- [x] AlphaBeta 的 null-move 正确切换 side-to-move 哈希，避免 TT/缓存污染（`src/core/alpha_beta.ts:288`）
- [x] 旧 MCTS：修复扩展状态/回传路径遗漏，并统一 DRAW 回报（`src/core/mcts.ts:59`）
- [x] 修复 TS 构建告警/报错（`src/App.tsx:152`, `src/core/connect6_ai.ts:141`）
- [x] 静态搜索补充战术性 quiescence 候选，降低地平线效应（`src/core/pvs_search.ts:756`）
- [x] Dummy 评估器下禁用 MCTS 覆盖，并用静态评估仲裁 PVS/MCTS（`src/core/connect6_ai.ts:827`）
- [x] PVS 局部延伸分级处理（强战术局面延伸 2 层），提高读杀稳定性（`src/core/pvs_search.ts:669`）
- [x] 走法排序对单子也计算威胁覆盖分，提升关键防守/制胜点的排序优先级（`src/core/pvs_search.ts:1380`）
- [x] 关键形状延伸（双活三/四三/双四）并设置硬上限（`src/core/pvs_search.ts:688`）
- [x] 过滤“局部死路”补点，优先保留可造势/威胁点（`src/core/pvs_search.ts:1188`）

- [x] VCF/VCT tactical solver root hint integration (`src/core/vcf_vct_solver.ts`, `src/core/pvs_search.ts`)
- [x] 回归门禁（P2）：基于 selfplay 日志的战术回归检测（`scripts/selfcheck_selfplay_regression.ts`, `tests/fixtures/selfplay_regression_sample.txt`, `package.json:8`）
- [x] 统一 dead-line 判定并用于所有“补第二子/兜底选点”，避免死区填子（`src/core/line_potential.ts`, `src/core/pvs_search.ts`, `src/core/connect6_ai.ts`, `src/core/smart_defense.ts`）
- [x] 冷静局面双活三构筑：过滤 dead-line 候选，并用双子间距做 tie-break（更偏两路推进）（`src/core/pvs_search.ts`）
- [x] 候选生成：RZOP 仅把“严格双活三”作为紧急点，避免单活三触发“二子两头都堵”（`src/core/rzop.ts`）
- [x] 走法排序：对“无硬威胁时两子同时堵同一条 LIVE3/SLEEP3”的走法加重惩罚，并在根节点插入“挡一头+反击”提示候选（`src/core/pvs_search.ts`）
## P0（正确性/一致性/可用性）

- [x] 配置字段不一致：`config.yaml` 使用 `tssDepth`，但代码读取 `quickDepth`，导致配置静默失效（`config.yaml:9`, `src/core/connect6_ai.ts:31`）
- [x] 配置合并为浅合并：`budgets/weights` 只要 YAML 提供部分字段就会覆盖整段，建议改成深合并并校验范围（`src/core/connect6_ai.ts:635`）
- [x] 棋谱导出历史走子依赖隐式字段：`generateKifuString` 通过 `(state as { moves?: Move[] }).moves` 读取历史，建议显式建模或强制参数传入（`src/utils/kifu.ts:23`）
- [x] 棋谱保存依赖的本地服务缺失：补齐本地保存脚本与 npm 命令（`scripts/kifu_server.js:1`, `package.json:9`）
- [x] UI 路径异常处理：`applyMoveWithWinner` 会 throw，App 里多处需要 try/catch；建议提供 `tryApplyMoveWithWinner`（Result 风格）降低 UI 崩溃概率（`src/core/rules.ts:85`）
- [x] 未实现配置开关：`SearchConfig.useMultithreading` 只定义未生效，建议要么实现 worker 搜索，要么移除该字段避免误导（`src/types.ts:52`, `src/App.tsx:62`）

## P1（性能/内存/可扩展性）

- [x] Evaluation adds initiative/connectivity/shape balance features for quiet scoring (`src/core/pattern_evaluator.ts`)

- [x] Move ordering adds locality bias (last move distance) without overriding threat priorities (`src/core/pvs_search.ts`)

- [x] Candidate ordering uses threat priority + history + locality to improve topK selection (`src/core/pvs_search.ts`)

- [x] 终局检测全盘扫描：`checkWinner` 每次 O(N^2*dirs) 扫描，搜索树里代价极高；改为基于最后落子增量检测（`src/core/rules.ts:29`）
- [x] 搜索状态复制热点：`cloneState` 深拷贝 `Cell[][]`，建议引入 make/unmake、`Uint8Array(361)`、或“写时复制 + 局部回滚”（`src/core/game_state.ts:27`）
- [x] PVS TT/History 淘汰策略：目前 Map + FIFO 淘汰，且 set 不刷新插入顺序；改为 LRU 触碰刷新（`src/core/pvs_search.ts:439`, `src/core/pvs_search.ts:509`）
- [x] threatListCache key 使用 `bigint.toString()` 生成字符串，热点下 GC 压力明显；改为 `Map<bigint, ThreatInfo[]>` 分玩家缓存（`src/core/pvs_search.ts:55`）
- [x] historyKey 使用字符串拼接；改为数值 key（`src/core/pvs_search.ts:541`）
- [x] Worker 传输成本：GA WorkerPool 每次 postMessage 复制整盘 `Cell[][]`；建议改用紧凑棋盘（TypedArray）或 SharedArrayBuffer（`src/core/self_play_optimizer.ts:33`, `src/workers/pvs_worker.ts:1`）

## P2（工程化/可维护性/整洁度）

- [x] 重复工具函数：`sortByCenter/uniqueEmptyPoints/collectOpenThreeThreats` 在多个模块重复，建议抽到 `src/core/*utils.ts` 避免漂移（`src/core/connect6_ai.ts:56`, `src/core/pvs_search.ts:1611`, `src/core/rzop.ts:80`）
- [x] 遗留/未使用模块清理：`src/core/mcts.ts`、`src/core/alpha_beta.ts` 当前未被引用，建议归档或移除并补 README（`src/core/mcts.ts:28`, `src/core/alpha_beta.ts:37`）
- [x] 类型收敛：`debugInfo?: any`、worker ctx `any` 等改为可判别联合类型，减少 `as any`（`src/types.ts:46`, `src/workers/pvs_worker.ts:18`）
- [x] ESLint/TS ignore 路径异常：`src/原`（或乱码路径）在仓库中不存在，建议移除或纠正（`eslint.config.js:9`, `tsconfig.app.json:28`）
- [x] 清理杂项：删除空文件 `src/core/新建 文本文档.txt`（`src/core/新建 文本文档.txt`）
- [x] 自测入口缺失：大量 `tests/*_selftest.ts` 与 `scripts/selfcheck_*.ts` 未挂到 `npm scripts`，建议新增 `npm run selfcheck`（`package.json:5`）

## 下一步（按“棋力/正确性优先”）

- [x] P0：将 VCF/VCT 的 `line` 做成“硬必选/硬必防”（证明存在强迫胜时直接走或强制纳入 PV），避免主搜索错过短杀
- [ ] P1：开局/冷静局面降低 locality 黏连，加入“二路展开”候选与打分（减少中心肉搏导致的和棋倾向）
- [ ] P1：自博弈终局早停：用“无潜在 6 连通路”判和替代 `moves.length>120` 硬 break（`src/core/self_play.ts`）
- [ ] P2：棋谱坐标系统一（`src/utils/kifu.ts` vs `src/core/board_coords.ts`）并让分析脚本自动识别两种格式
