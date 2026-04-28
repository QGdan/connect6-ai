# 任务：审计并修复六子棋 AI 棋力下降问题

你现在接手一个比较大的六子棋 AI 项目。当前问题是：项目最近的棋力疑似下降，但原因未知。请你像资深 AI 棋类项目工程师、代码审计专家和测试工程师一样，精读整个项目，系统性找出潜在问题、隐藏 bug、退化原因，并设计自动化工作流逐步定位和修复。

重要背景：

- 项目类型：六子棋 / Connect6 AI。
- 目标：找出导致棋力下降的潜在问题，包括但不限于搜索、评估函数、开局库、剪枝、时间管理、神经网络/模型加载、自博弈训练、数据处理、并发、缓存、随机性、回归测试缺失等。
- 不要急着改代码。先理解项目结构、运行方式、核心算法和最近可能影响棋力的模块。
- 遇到拿不准的地方，可以先在代码中寻找证据；如果仍不确定，请列出需要我确认的问题。
- 如果需要查询资料，可以查询 Connect6 / 六子棋 AI、MCTS、Alpha-Beta、Threat Space Search、棋型评估、Zobrist Hash、transposition table、time control、self-play training、Elo evaluation 等相关资料。
- 所有修改都必须可验证，优先补充自动化测试、回归评估和诊断脚本。

---

## 阶段 1：项目全局精读与地图绘制

请先不要修改代码。请完成以下事情：

1. 扫描项目目录结构，识别：

   - 主程序入口
   - AI 决策入口
   - 搜索模块
   - 局面表示 / 棋盘表示
   - 合法着生成模块
   - 评估函数
   - 胜负判断
   - 开局库 / 定式 / policy 模块
   - MCTS / Alpha-Beta / Minimax / 神经网络模块
   - 训练、自博弈、数据生成、模型加载模块
   - 测试目录
   - 配置文件
   - 日志和 benchmark 工具

2. 输出一份「项目地图」，格式如下：

```markdown
# Project Map

## Entry Points

- ...

## Core AI Decision Flow

1. ...
2. ...
3. ...

## Board / Rules

- ...

## Search

- ...

## Evaluation

- ...

## Training / Model

- ...

## Tests / Benchmarks

- ...

## Suspicious Areas

- ...
```

3. 找出当前项目中最可能影响棋力的关键路径。

请按调用链描述，例如：

```text
main -> game_loop -> ai_move -> search -> move_generator -> evaluator -> choose_best_move
```

---

## 阶段 2：建立棋力下降问题清单

请基于代码阅读，列出「可能导致棋力下降的问题」，并按优先级排序。

每个问题请使用以下格式：

```markdown
## P0 / P1 / P2 / P3: 问题标题

### 现象

这个问题可能如何表现为棋力下降。

### 代码位置

相关文件、函数、类、配置项。

### 怀疑原因

为什么这里可能有 bug 或退化。

### 证据

从代码、测试、日志、配置、提交历史或运行结果中找到的证据。

### 验证方法

如何写测试、脚本或实验验证它。

### 修复建议

如果验证成立，应该如何修。
```

优先关注以下高风险类别：

### A. 规则与局面合法性

- 六子棋第一手是否只下一子，之后每回合是否下两子。
- 合法着生成是否遗漏或重复。
- 是否允许非法落子、越界落子、已占位置落子。
- 胜负判断是否准确，尤其是六连、长连、双向连线、边界情况。
- 终局、平局、禁手规则是否和项目预期一致。
- 坐标系是否存在 x/y、row/col 混淆。

### B. 搜索算法退化

- Alpha-Beta / Minimax / MCTS 是否存在符号反转错误。
- max/min 层是否错位。
- 当前玩家、落子方、评估视角是否一致。
- 剪枝条件是否过度激进。
- move ordering 是否被破坏。
- 搜索深度是否意外降低。
- 时间控制是否提前终止。
- transposition table 是否错误复用。
- Zobrist Hash 是否冲突处理不当或 side-to-move 未编码。
- undo / make move 是否破坏棋盘状态。
- 多线程搜索是否存在竞态或非确定性 bug。

### C. 评估函数问题

- 评估分数是否从当前 player 视角返回。
- 黑白 / 先后手符号是否反了。
- 活三、活四、眠四、连五、连六等棋型权重是否异常。
- 六子棋特有的双落子威胁是否被错误评估。
- 进攻和防守权重是否失衡。
- 终局分数是否足够大，是否被普通评估覆盖。
- 归一化、截断、溢出、浮点精度问题。
- 最近配置是否把关键权重改坏。

### D. 模型 / 神经网络 / 训练管线

- 模型文件是否加载错版本。
- checkpoint 路径是否 fallback 到旧模型或随机模型。
- 推理模式是否没有关闭 dropout / batchnorm training mode。
- 输入特征平面是否顺序错乱。
- board transform / symmetry augmentation 是否反了。
- policy head 输出到棋盘坐标的映射是否错误。
- value head 视角是否与搜索要求不一致。
- 温度、Dirichlet noise、exploration 参数是否用于正式对局。
- 训练数据标签是否从错误玩家视角生成。
- 新模型是否未经 Elo 验证直接替换。

### E. 配置和工程问题

- 默认配置是否改变。
- debug flag 是否影响正式棋力。
- 随机种子是否导致不可复现。
- release / debug 性能差异。
- cache 是否污染。
- 并发和异步是否引入状态错乱。
- 日志、异常处理是否吞掉关键错误。
- 单元测试覆盖不足。

---

## 阶段 3：建立自动化诊断工作流

请创建或改进自动化工作流，不要只靠人工猜测。优先新增脚本和测试。

请设计以下工作流：

### 1. 规则正确性测试

新增或完善测试，覆盖：

- 第一手只能下一子。
- 后续回合必须下两子。
- 已占位置不能落子。
- 横、竖、两条斜线六连胜利检测。
- 边界六连检测。
- 长连是否按项目规则判胜。
- near-win 和 block-win 场景。
- make_move / undo_move 后局面完全恢复。
- 坐标映射 round-trip 测试。

### 2. 搜索稳定性测试

构造小棋盘或固定局面，测试：

- AI 能发现一步必胜。
- AI 能阻挡对方一步必胜。
- 搜索深度增加时结果不应明显变差。
- 开关 transposition table 结果应一致或可解释。
- 固定随机种子后结果可复现。
- search 不应修改输入 board。
- time limit 不应导致空着或非法着。
- 同一局面重复搜索结果一致。

### 3. 评估函数 sanity tests

构造若干局面，断言：

- 必胜局面分数极高。
- 必败局面分数极低。
- 活五 / 活四 / 活三评分单调递增。
- 当前玩家视角翻转时分数符号应合理变化。
- 增加己方强威胁不应降低评分。
- 增加对方强威胁应降低评分。
- 对称局面评分一致。

### 4. 模型与数据管线测试，如果项目包含 ML

检查并测试：

- checkpoint 是否存在且版本正确。
- 模型加载失败时不能静默 fallback。
- eval/inference 模式是否正确。
- 输入 tensor shape、通道顺序、坐标映射。
- policy 输出 top-k 是否映射到合法棋盘点。
- value 视角是否与搜索一致。
- augmentation 后标签是否正确变换。
- self-play 生成数据是否合法。

### 5. Elo / 回归评估脚本

如果项目已有历史版本、baseline AI、旧 checkpoint 或 rule-based AI，请创建一个自动对战脚本：

- current vs baseline
- current vs previous checkpoint
- current with/without TT
- current with different configs
- fixed seed matches
- alternating first player
- 输出 win/loss/draw、平均步数、非法着次数、超时次数、崩溃次数。
- 保存 SGF / JSON / log，方便复盘。
- 给出粗略 Elo 或胜率置信区间。

输出格式示例：

```text
engine_a, engine_b, games, wins_a, wins_b, draws, illegal_moves, crashes, avg_moves
current, baseline, 100, 42, 55, 3, 0, 0, 87.2
```

---

## 阶段 4：运行现有测试和新增诊断

请先找出项目的实际运行命令，例如：

- pytest
- unittest
- cargo test
- npm test
- make test
- cmake / ctest
- go test
- 自定义脚本

然后运行：

1. 现有测试。
2. 静态检查 / lint / type check，如果项目支持。
3. 新增规则测试。
4. 新增搜索测试。
5. 新增评估函数测试。
6. 小规模 AI 对战回归测试。

请记录所有失败项，并将失败项映射到潜在根因。

---

## 阶段 5：按优先级修复

不要一次性大改。请按以下策略修复：

1. 先修 P0：

   - 非法着
   - 胜负判断错误
   - 搜索视角反转
   - 模型加载错误
   - undo/make_move 状态污染
   - 明显导致 AI 下坏棋的配置错误

2. 每修一个问题，都要：

   - 写或更新测试。
   - 运行相关最小测试。
   - 运行全量测试。
   - 记录修复前后的行为差异。

3. 对于不确定的修复：

   - 不要盲改。
   - 先写诊断脚本。
   - 用具体局面证明问题存在。
   - 必要时向我提问。

4. 每个修复请输出：

```markdown
## Fix: 标题

### Root Cause

...

### Change

...

### Tests Added

...

### Verification

...

### Remaining Risk

...
```

---

## 阶段 6：输出最终审计报告

完成上述工作后，请输出一份最终报告：

```markdown
# Connect6 AI Strength Regression Audit Report

## Executive Summary

- 最可能导致棋力下降的原因：
- 已验证的问题：
- 已修复的问题：
- 尚未确认的问题：
- 推荐下一步：

## Project Map

...

## Prioritized Issues

| Priority | Issue | Evidence | Status | Fix |
|---|---|---|---|---|

## Tests / Workflows Added

...

## Benchmark Results

...

## Code Changes

...

## Remaining Questions For User

...

## Recommended Long-Term Guardrails

...
```

长期 guardrails 至少包括：

- 每次合并前跑规则测试。
- 每次改搜索 / 评估 / 模型后跑固定局面测试。
- 定期 current vs baseline 自动对战。
- 每个 checkpoint 替换前必须通过胜率阈值。
- 保存代表性战局用于回归。
- 固定随机种子，确保诊断可复现。
- 明确配置版本管理。
- CI 中加入非法着检测和棋力 smoke test。

---

## 工作方式要求

请严格遵守：

1. 不要只给泛泛建议，要基于当前项目代码给出具体文件、函数、调用链和证据。
2. 不要一开始就大规模重构。
3. 不要删除功能或降低搜索深度来掩盖问题。
4. 不要把失败测试简单改成通过，必须解释规则依据。
5. 不确定时优先写测试和诊断脚本。
6. 所有结论必须有证据：代码、测试结果、日志或实验。
7. 每一步都尽量保持可回滚的小改动。
8. 每完成一个阶段，请先总结阶段产出，再进入下一阶段。
9. 如果项目很大，请优先分析最可能影响棋力的核心路径，而不是平均用力。
10. 如果需要我补充信息，请明确列出问题，并说明这些信息会影响哪些判断。

现在请开始执行阶段 1：扫描项目、绘制项目地图、找出 AI 决策核心调用链。不要先改代码。