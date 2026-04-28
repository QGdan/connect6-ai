# Traditional + Hybrid Decision Chain TODOs

## P0

- [x] Fix stale threat-cache propagation in PVS child recursion (`src/core/pvs_search.ts`).
- [x] Replace hybrid direct `mcts.score` vs `pvs.score` comparison with same-judge arbitration (`src/strategy/hybrid_strategy.ts`).
- [x] Add immediate-loss filter in hybrid arbitration (`winIn1` / `winIn2` next-turn checks).

## P1

- [x] Gate opening-book short-circuit by urgency + opening-phase checks (`src/App.tsx`).
- [x] Normalize final decision observability fields:
  - `debugInfo.decisionStage`
  - `debugInfo.decisionReason`

## P2

- [x] Add hybrid regression self-test (`tests/hybrid_strategy_selftest.ts`).
- [x] Add decision-chain selfcheck script (`scripts/selfcheck_decision.ts`).
- [x] Add npm script `selfcheck:decision` and include in `selfcheck`.
- [x] Add CI decision regression gate (`.github/workflows/ci.yml`).
- [x] Add decision-chain trace collector (`src/core/decision_trace.ts`).
- [x] Add automated diagnostic replay script (`scripts/diagnose_decision_chain.ts`).
- [x] Add diagnostic workflow with artifact upload (`.github/workflows/decision-diagnostics.yml`).
- [x] Fix hybrid selector dormant branch by urgent-first routing + non-urgent midgame hybrid activation (`src/strategy/hybrid_strategy.ts`).
- [x] Add dormant-selector regression checks:
  - `tests/hybrid_strategy_selftest.ts`
  - `scripts/selfcheck_decision.ts`
  - `scripts/diagnose_decision_chain.ts`
  - `.github/workflows/decision-diagnostics.yml`
- [x] Export hybrid decision casebook from diagnostics (`outputs/decision_diagnostics/hybrid_casebook.json`).
- [x] Add deterministic casebook regression selftest (`tests/decision_chain_casebook_selftest.ts` + `tests/fixtures/decision_chain_casebook.json`).
- [x] Add deterministic MCTS replay mode for diagnostics/tests via optional `randomSeed` in `MCTSConfig` (default unchanged).
- [x] Tighten casebook to hard assertions with fixed-seed baseline (`disagreements=3`).

## Verification

- [x] `npm run test:unit`
- [x] `npm run selfcheck`
- [x] `npm run selfcheck:decision`
- [x] `npm run diagnose:decision:ci`
- [x] `npm run build`

## Continuous Repair Loop

- [x] Investigate `hybrid_branch_dormant` from `decision_trace_summary.json` and fix dead/misleading selector branch logic.
- [ ] Review `outputs/decision_diagnostics/decision_trace_report.md` after each major strategy change.
- [x] Convert key hybrid-final/disagreement turn patterns into deterministic selfcheck cases.
- [ ] Remove dead or misleading branches only after new regression guard is added first.
