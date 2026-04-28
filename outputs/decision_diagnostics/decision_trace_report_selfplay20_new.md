# Decision Chain Diagnostic Report

- input: `outputs/decision_diagnostics/selfplay20_new.txt`
- games: 20
- sampled turns: 496
- urgent turns: 371

## Metrics

- traditional.immediateBlunder: 4
- traditional.openingInUrgent: 0
- traditional.traceMissing: 0
- hybrid.immediateBlunder: 4
- hybrid.unsafeFallback: 0
- hybrid.disagreeWithTraditional: 7
- hybrid.hybridFinal: 46
- hybrid.nonHybridFinal: 450
- hybrid.selectedTraditional: 450
- hybrid.selectedHybrid: 46
- hybrid.selectedDeep: 0

## Diagnostic Flags

- none

## Stage Counts

- hybrid:hybrid_final: 46
- hybrid:pvs: 450
- traditional:normal: 27
- traditional:threat_root: 346
- traditional:vcdt_root: 81
- traditional:vcf_root: 8
- traditional:vct_root: 34

## Top Suspicious Turns

- g15 t25 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(5,8) (6,11)
- g15 t25 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(5,8) (6,11)
- g16 t51 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(6,15) (12,15)
- g16 t51 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(6,15) (12,15)
- g19 t59 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(7,11) (8,13)
- g19 t59 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(7,11) (8,13)
- g20 t29 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(8,5) (9,3)
- g20 t29 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(8,5) (9,3)