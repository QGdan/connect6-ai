import type{ PerformanceStats } from '../types';

export class PerformanceMonitor {
  private stats: PerformanceStats = {
    avgThinkTimeMs: 0,
    maxThinkTimeMs: 0,
    threatDetectionAccuracy: 0,
    searchDepthAvg: 0,
  };
  private samples = 0;

  recordThinkTime(ms: number, depth: number) {
    this.samples++;
    this.stats.avgThinkTimeMs =
      (this.stats.avgThinkTimeMs * (this.samples - 1) + ms) / this.samples;
    if (ms > this.stats.maxThinkTimeMs) this.stats.maxThinkTimeMs = ms;

    this.stats.searchDepthAvg =
      (this.stats.searchDepthAvg * (this.samples - 1) + depth) / this.samples;
  }

  recordThreatDetection(acc: number) {
    this.stats.threatDetectionAccuracy =
      (this.stats.threatDetectionAccuracy * this.samples + acc) /
      (this.samples + 1);
  }

  getStats(): PerformanceStats {
    return this.stats;
  }
}
