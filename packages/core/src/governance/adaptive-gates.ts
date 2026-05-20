/**
 * Adaptive Quality Gates — dynamically adjusts quality thresholds based on
 * per-book historical performance.
 *
 * Strategy:
 *   1. Baseline mode (first N chapters): relaxed thresholds to establish
 *      baseline metrics without excessive retry/pause.
 *   2. Steady-state mode: tighten thresholds; adapt retry count and
 *      temperature step based on recent success rate.
 *   3. Dimension-aware escalation: if failures cluster in a specific
 *      dimension (e.g. "Pacing Monotony"), increase targeted retries
 *      and emit early diagnostic alerts.
 */

import type { QualityGates } from "../models/project.js";

export interface AdaptiveGateOptions {
  readonly base: QualityGates;
  /** Number of initial chapters to run in baseline (relaxed) mode. */
  readonly baselineChapterCount?: number;
  /** Sliding window size for success-rate calculation. */
  readonly windowSize?: number;
  /** Success-rate threshold below which we tighten gates. */
  readonly lowSuccessThreshold?: number;
  /** Success-rate threshold above which we relax gates slightly. */
  readonly highSuccessThreshold?: number;
  /** Maximum extra retries added by adaptation. */
  readonly maxAdaptiveRetries?: number;
}

export interface ChapterOutcome {
  readonly chapterNumber: number;
  readonly success: boolean;
  readonly issueCategories: ReadonlyArray<string>;
}

export interface AdaptiveGateSnapshot {
  readonly maxAuditRetries: number;
  readonly pauseAfterConsecutiveFailures: number;
  readonly retryTemperatureStep: number;
  readonly mode: "baseline" | "tightened" | "relaxed" | "normal";
  readonly recentSuccessRate: number;
  readonly totalChapters: number;
  readonly consecutiveFailures: number;
}

export class AdaptiveQualityGate {
  private readonly base: QualityGates;
  private readonly baselineChapterCount: number;
  private readonly windowSize: number;
  private readonly lowSuccessThreshold: number;
  private readonly highSuccessThreshold: number;
  private readonly maxAdaptiveRetries: number;

  private history = new Map<string, ChapterOutcome[]>();
  private consecutiveFailures = new Map<string, number>();

  constructor(options: AdaptiveGateOptions) {
    this.base = options.base;
    this.baselineChapterCount = options.baselineChapterCount ?? 5;
    this.windowSize = options.windowSize ?? 10;
    this.lowSuccessThreshold = options.lowSuccessThreshold ?? 0.5;
    this.highSuccessThreshold = options.highSuccessThreshold ?? 0.85;
    this.maxAdaptiveRetries = options.maxAdaptiveRetries ?? 2;
  }

  /** Record an outcome for a book. */
  record(bookId: string, outcome: ChapterOutcome): void {
    const list = this.history.get(bookId) ?? [];
    list.push(outcome);
    // Trim to window size to prevent unbounded growth
    if (list.length > this.windowSize * 2) {
      this.history.set(bookId, list.slice(-this.windowSize * 2));
    } else {
      this.history.set(bookId, list);
    }

    const cf = this.consecutiveFailures.get(bookId) ?? 0;
    if (outcome.success) {
      this.consecutiveFailures.set(bookId, 0);
    } else {
      this.consecutiveFailures.set(bookId, cf + 1);
    }
  }

  /** Compute current effective gates for a book. */
  snapshot(bookId: string): AdaptiveGateSnapshot {
    const outcomes = this.history.get(bookId) ?? [];
    const total = outcomes.length;
    const recent = outcomes.slice(-this.windowSize);
    const successes = recent.filter((o) => o.success).length;
    const recentSuccessRate = recent.length > 0 ? successes / recent.length : 1;
    const cf = this.consecutiveFailures.get(bookId) ?? 0;

    // Baseline mode: first chapters are more forgiving
    if (total < this.baselineChapterCount) {
      return {
        maxAuditRetries: this.base.maxAuditRetries + 1,
        pauseAfterConsecutiveFailures: this.base.pauseAfterConsecutiveFailures + 2,
        retryTemperatureStep: this.base.retryTemperatureStep,
        mode: "baseline",
        recentSuccessRate,
        totalChapters: total,
        consecutiveFailures: cf,
      };
    }

    // Dimension clustering check
    const dimCounts = new Map<string, number>();
    for (const o of recent) {
      for (const cat of o.issueCategories) {
        dimCounts.set(cat, (dimCounts.get(cat) ?? 0) + 1);
      }
    }
    const maxDimCount = Math.max(0, ...dimCounts.values());
    const hasClustering = maxDimCount >= 3;

    if (recentSuccessRate < this.lowSuccessThreshold || hasClustering) {
      // Tighten: fewer retries, pause sooner, bigger temperature steps
      return {
        maxAuditRetries: Math.max(0, this.base.maxAuditRetries - 1),
        pauseAfterConsecutiveFailures: Math.max(2, this.base.pauseAfterConsecutiveFailures - 1),
        retryTemperatureStep: Math.min(0.5, this.base.retryTemperatureStep * 2),
        mode: hasClustering ? "tightened" : "tightened",
        recentSuccessRate,
        totalChapters: total,
        consecutiveFailures: cf,
      };
    }

    if (recentSuccessRate > this.highSuccessThreshold) {
      // Relax slightly: more retries, but keep pause threshold
      return {
        maxAuditRetries: this.base.maxAuditRetries + 1,
        pauseAfterConsecutiveFailures: this.base.pauseAfterConsecutiveFailures,
        retryTemperatureStep: this.base.retryTemperatureStep,
        mode: "relaxed",
        recentSuccessRate,
        totalChapters: total,
        consecutiveFailures: cf,
      };
    }

    // Normal mode: use base settings
    return {
      maxAuditRetries: this.base.maxAuditRetries,
      pauseAfterConsecutiveFailures: this.base.pauseAfterConsecutiveFailures,
      retryTemperatureStep: this.base.retryTemperatureStep,
      mode: "normal",
      recentSuccessRate,
      totalChapters: total,
      consecutiveFailures: cf,
    };
  }

  /** Reset history for a book (e.g. after manual resume). */
  reset(bookId: string): void {
    this.history.delete(bookId);
    this.consecutiveFailures.delete(bookId);
  }

  /** Check if a book should be paused based on adaptive gates. */
  shouldPause(bookId: string): { paused: boolean; reason?: string } {
    const snap = this.snapshot(bookId);
    if (snap.consecutiveFailures >= snap.pauseAfterConsecutiveFailures) {
      return {
        paused: true,
        reason: `${snap.consecutiveFailures} consecutive audit failures (adaptive threshold: ${snap.pauseAfterConsecutiveFailures}, mode: ${snap.mode})`,
      };
    }
    return { paused: false };
  }
}
