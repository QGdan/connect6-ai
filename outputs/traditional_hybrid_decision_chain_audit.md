# Connect6 Traditional + Hybrid Decision Chain Audit

Date: 2026-04-28  
Scope: traditional + hybrid decision chain only (no parameter tuning)

## Prioritized Findings

1. P0 - PVS child node threat cache propagation bug
- Symptom: child recursion reused/swapped parent threat lists, risking stale tactical context.
- Fix: recompute threat cache from `next` state before recursive `pvs(...)` calls.
- Files: `src/core/pvs_search.ts`

2. P0 - Hybrid cross-engine score mismatch
- Symptom: `mcts.score` (win-rate space) was directly compared with `pvs.score` (evaluation space).
- Fix: evaluate both candidate moves with the same judge (`evaluateWithThreatReport`), then pick by judge score.
- Safety guard: reject candidates that leave opponent immediate win (`winIn1` / `winIn2` when applicable).
- Files: `src/strategy/hybrid_strategy.ts`

3. P1 - Opening book over-priority in risky states
- Symptom: opening move could short-circuit before tactical urgency checks.
- Fix: opening only enabled when:
  - move number is in opening phase (`<= 10`),
  - no urgent tactical threat is detected.
- Files: `src/App.tsx`

4. P1 - Decision chain observability gap
- Symptom: root cause tracing per move was not consistent across entry points.
- Fix: normalize `debugInfo.decisionStage` / `debugInfo.decisionReason` on final decisions.
- Stage examples: `opening`, `threat_root`, `forced_defense`, `pvs`, `hybrid_final`.
- Files: `src/App.tsx`, `src/strategy/hybrid_strategy.ts`

5. P1 - Hybrid selector dormant branch (dead/misleading routing)
- Symptom: `auto` almost always returned traditional path; hybrid arbitration branch was effectively dormant.
- Root cause: strategy selector threshold used complexity scale mismatch (`complexity > 0.6` was unreachable on sampled real states).
- Fix:
  - selector now routes by decision urgency first,
  - non-urgent midgame enters hybrid arbitration,
  - urgent tactical states keep deterministic traditional chain.
- Files: `src/strategy/hybrid_strategy.ts`

## Regression Coverage Added

- Added `tests/hybrid_strategy_selftest.ts`:
  - verifies hybrid rejects unsafe high-score MCTS candidate,
  - verifies `decisionStage=hybrid_final`,
  - verifies non-urgent midgame no longer keeps selector dormant.

- Added `scripts/selfcheck_decision.ts`:
  - traditional must block `winIn1`,
  - traditional must block `winIn2` without over-spending both stones on one pair,
  - traditional should not double-block a single live3 line,
  - traditional non-forced decisions should avoid immediate blunders,
  - hybrid arbitration should reject unsafe high-score candidate,
  - hybrid selector should not stay dormant in non-urgent midgame.

## Automation Gate

- Added npm script:
  - `selfcheck:decision` -> `tsx scripts/selfcheck_decision.ts`
- Added CI gate step:
  - `.github/workflows/ci.yml` -> `Decision Regression Gate`
- Included in `npm run selfcheck` chain.

## Continuous Diagnostics Workflow

- Added decision trace collector for core decision-entry functions:
  - `src/core/decision_trace.ts`
  - trace points in `pvsSearchBestMove` and `HybridStrategyManager.decideMove`
- Added replay-based diagnostic script:
  - `npm run diagnose:decision`
  - reads fixture games and samples turn states
  - records per-turn decision stage, reason, trace path, and immediate-blunder checks
  - writes:
    - `outputs/decision_diagnostics/decision_trace_summary.json`
    - `outputs/decision_diagnostics/decision_trace_report.md`
    - `outputs/decision_diagnostics/hybrid_casebook.json`
- Added standalone GitHub workflow:
  - `.github/workflows/decision-diagnostics.yml`
  - triggers on schedule + PR + manual dispatch
  - uploads diagnostic artifacts
  - fails on severe regressions (`openingInUrgent` / immediate blunders > 0),
  - fails on dormant-hybrid diagnostic flags.

## Deterministic Casebook Regression

- Added fixture:
  - `tests/fixtures/decision_chain_casebook.json`
  - includes 6 sampled non-urgent midgame cases where hybrid branch should be active.
- Added selftest:
  - `tests/decision_chain_casebook_selftest.ts`
  - validates for each case:
    - `decisionStage=hybrid_final`
    - `strategy=hybrid`
    - no immediate-loss blunder after chosen move
    - expected same/different relation to traditional move
- Added deterministic replay mode for diagnostic/test MCTS:
  - `MCTSConfig.randomSeed` (optional, default-off)
  - diagnosis + casebook selftest enable fixed seed `20260428`
  - repeated casebook runs are stable (`disagreements=3` across reruns).

### Current Diagnostic Signal

- Current baseline run (`npm run diagnose:decision:ci`) reports:
  - `traditional.immediateBlunder = 0`
  - `hybrid.immediateBlunder = 0`
  - `hybrid.selectedHybrid = 6` / `hybrid.selectedTraditional = 102`
  - `diagnosticFlags = []`
- Interpretation:
  - severe tactical blunders are not observed in sampled fixture turns,
  - hybrid path is no longer fully dormant and is now observable in automated diagnostics.

## Notes

- No parameter tuning performed.
- No public API changes required.
