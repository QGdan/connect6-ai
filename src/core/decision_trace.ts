export type DecisionTraceEvent = {
  atMs: number;
  fn: string;
  phase: string;
  data?: Record<string, unknown>;
};

export type DecisionTraceRecord = {
  id: number;
  root: string;
  context?: Record<string, unknown>;
  startedAtMs: number;
  endedAtMs?: number;
  summary?: Record<string, unknown>;
  events: DecisionTraceEvent[];
};

let forceEnabled = false;
let nextTraceId = 1;
const active = new Map<number, DecisionTraceRecord>();
const finished: DecisionTraceRecord[] = [];
const MAX_FINISHED_TRACES = 10000;

function nowMs(): number {
  if (typeof performance !== 'undefined' && performance.now) {
    return performance.now();
  }
  return Date.now();
}

function readEnvFlag(): boolean {
  const env = (
    typeof process !== 'undefined' &&
    typeof process.env === 'object' &&
    process.env
  ) as Record<string, string | undefined> | undefined;
  if (!env) return false;
  return env.C6_DECISION_TRACE === '1' || env.C6_DECISION_TRACE === 'true';
}

export function isDecisionTraceEnabled(): boolean {
  return forceEnabled || readEnvFlag();
}

export function setDecisionTraceEnabled(enabled: boolean): void {
  forceEnabled = enabled;
}

export function beginDecisionTrace(
  root: string,
  context?: Record<string, unknown>,
): number | null {
  if (!isDecisionTraceEnabled()) return null;
  const id = nextTraceId++;
  const record: DecisionTraceRecord = {
    id,
    root,
    context,
    startedAtMs: nowMs(),
    events: [],
  };
  active.set(id, record);
  return id;
}

export function traceDecisionEvent(
  traceId: number | null,
  fn: string,
  phase: string,
  data?: Record<string, unknown>,
): void {
  if (traceId === null) return;
  const record = active.get(traceId);
  if (!record) return;
  record.events.push({
    atMs: nowMs(),
    fn,
    phase,
    data,
  });
}

export function endDecisionTrace(
  traceId: number | null,
  summary?: Record<string, unknown>,
): void {
  if (traceId === null) return;
  const record = active.get(traceId);
  if (!record) return;
  record.endedAtMs = nowMs();
  record.summary = summary;
  active.delete(traceId);
  finished.push(record);
  if (finished.length > MAX_FINISHED_TRACES) {
    finished.splice(0, finished.length - MAX_FINISHED_TRACES);
  }
}

export function drainDecisionTraces(): DecisionTraceRecord[] {
  if (finished.length === 0) return [];
  const out = finished.slice();
  finished.length = 0;
  return out;
}

export function clearDecisionTraces(): void {
  active.clear();
  finished.length = 0;
}
