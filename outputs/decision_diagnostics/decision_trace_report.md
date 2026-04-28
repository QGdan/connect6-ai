# Decision Chain Diagnostic Report

- input: `outputs/decision_diagnostics/selfplay20_new_patch.txt`
- games: 20
- sampled turns: 494
- urgent turns: 366

## Metrics

- traditional.immediateBlunder: 4
- traditional.openingInUrgent: 0
- traditional.traceMissing: 0
- hybrid.immediateBlunder: 4
- hybrid.unsafeFallback: 0
- hybrid.disagreeWithTraditional: 7
- hybrid.hybridFinal: 45
- hybrid.nonHybridFinal: 449
- hybrid.selectedTraditional: 449
- hybrid.selectedHybrid: 45
- hybrid.selectedDeep: 0

## Diagnostic Flags

- none

## Stage Counts

- hybrid:hybrid_final: 45
- hybrid:pvs: 449
- traditional:normal: 27
- traditional:threat_root: 344
- traditional:vcdt_root: 83
- traditional:vcf_root: 8
- traditional:vct_root: 32

## Top Suspicious Turns

- g16 t51 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(6,15) (12,15)
- g16 t51 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(6,15) (12,15)
- g17 t25 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(5,8) (6,11)
- g17 t25 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(5,8) (6,11)
- g19 t59 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(8,13) (7,14)
- g19 t59 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(8,13) (7,14)
- g20 t29 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(8,5) (9,3)
- g20 t29 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(8,5) (9,3)