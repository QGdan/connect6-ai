# Decision Chain Diagnostic Report

- input: `outputs/decision_diagnostics/selfplay20_old.txt`
- games: 20
- sampled turns: 443
- urgent turns: 333

## Metrics

- traditional.immediateBlunder: 4
- traditional.openingInUrgent: 0
- traditional.traceMissing: 0
- hybrid.immediateBlunder: 4
- hybrid.unsafeFallback: 0
- hybrid.disagreeWithTraditional: 6
- hybrid.hybridFinal: 40
- hybrid.nonHybridFinal: 403
- hybrid.selectedTraditional: 403
- hybrid.selectedHybrid: 40
- hybrid.selectedDeep: 0

## Diagnostic Flags

- none

## Stage Counts

- hybrid:hybrid_final: 40
- hybrid:pvs: 403
- traditional:normal: 23
- traditional:threat_root: 305
- traditional:vcdt_root: 60
- traditional:vcf_root: 12
- traditional:vct_root: 43

## Top Suspicious Turns

- g14 t25 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(5,8) (6,11)
- g14 t25 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(5,8) (6,11)
- g17 t59 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(7,11) (8,13)
- g17 t59 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(7,11) (8,13)
- g19 t29 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(13,11) (13,6)
- g19 t29 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(13,11) (13,6)
- g20 t29 traditional stage=threat_root engine=pvs+threat+zorp urgent=true blunder=true traceEvents=3 move=(8,5) (9,3)
- g20 t29 hybrid stage=pvs engine=pvs+threat+zorp urgent=true blunder=true traceEvents=5 move=(8,5) (9,3)