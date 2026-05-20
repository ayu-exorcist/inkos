import { describe, it, expect } from "vitest";
import {
  AdaptiveQualityGate,
  type ChapterOutcome,
} from "../governance/adaptive-gates.js";

const base = {
  maxAuditRetries: 2,
  pauseAfterConsecutiveFailures: 3,
  retryTemperatureStep: 0.1,
};

function outcomes(count: number, success: boolean, categories: string[] = []): ChapterOutcome[] {
  return Array.from({ length: count }, (_, i) => ({
    chapterNumber: i + 1,
    success,
    issueCategories: success ? [] : categories,
  }));
}

describe("AdaptiveQualityGate", () => {
  it("starts in baseline mode for first N chapters", () => {
    const gate = new AdaptiveQualityGate({ base, baselineChapterCount: 5 });
    gate.record("book-a", { chapterNumber: 1, success: true, issueCategories: [] });
    const snap = gate.snapshot("book-a");
    expect(snap.mode).toBe("baseline");
    expect(snap.maxAuditRetries).toBe(3); // base + 1
    expect(snap.pauseAfterConsecutiveFailures).toBe(5); // base + 2
  });

  it("transitions to normal mode after baseline", () => {
    const gate = new AdaptiveQualityGate({ base, baselineChapterCount: 3, windowSize: 5 });
    for (const o of outcomes(3, true)) gate.record("book-a", o);
    const snap = gate.snapshot("book-a");
    expect(snap.mode).toBe("relaxed"); // 100% success in window → relaxed
    expect(snap.totalChapters).toBe(3);
  });

  it("tightens when success rate is low", () => {
    const gate = new AdaptiveQualityGate({
      base,
      baselineChapterCount: 0,
      windowSize: 4,
      lowSuccessThreshold: 0.5,
    });
    // 1 success + 3 failures = 25% success rate
    gate.record("book-b", { chapterNumber: 1, success: true, issueCategories: [] });
    gate.record("book-b", { chapterNumber: 2, success: false, issueCategories: ["pacing"] });
    gate.record("book-b", { chapterNumber: 3, success: false, issueCategories: ["pacing"] });
    gate.record("book-b", { chapterNumber: 4, success: false, issueCategories: ["pacing"] });

    const snap = gate.snapshot("book-b");
    expect(snap.mode).toBe("tightened");
    expect(snap.maxAuditRetries).toBe(1); // 2 - 1
    expect(snap.pauseAfterConsecutiveFailures).toBe(2); // 3 - 1
    expect(snap.retryTemperatureStep).toBe(0.2); // 0.1 * 2
  });

  it("tightens when a dimension clusters", () => {
    const gate = new AdaptiveQualityGate({
      base,
      baselineChapterCount: 0,
      windowSize: 5,
    });
    // High success rate but one dimension clusters
    gate.record("book-c", { chapterNumber: 1, success: true, issueCategories: [] });
    gate.record("book-c", { chapterNumber: 2, success: false, issueCategories: ["monotony"] });
    gate.record("book-c", { chapterNumber: 3, success: false, issueCategories: ["monotony"] });
    gate.record("book-c", { chapterNumber: 4, success: false, issueCategories: ["monotony"] });

    const snap = gate.snapshot("book-c");
    expect(snap.mode).toBe("tightened");
  });

  it("relaxes when success rate is high", () => {
    const gate = new AdaptiveQualityGate({
      base,
      baselineChapterCount: 0,
      windowSize: 4,
      highSuccessThreshold: 0.8,
    });
    for (const o of outcomes(4, true)) gate.record("book-d", o);

    const snap = gate.snapshot("book-d");
    expect(snap.mode).toBe("relaxed");
    expect(snap.maxAuditRetries).toBe(3); // 2 + 1
  });

  it("tracks consecutive failures correctly", () => {
    const gate = new AdaptiveQualityGate({ base });
    gate.record("book-e", { chapterNumber: 1, success: false, issueCategories: [] });
    gate.record("book-e", { chapterNumber: 2, success: false, issueCategories: [] });
    expect(gate.snapshot("book-e").consecutiveFailures).toBe(2);
    gate.record("book-e", { chapterNumber: 3, success: true, issueCategories: [] });
    expect(gate.snapshot("book-e").consecutiveFailures).toBe(0);
  });

  it("pauses when consecutive failures exceed adaptive threshold", () => {
    const gate = new AdaptiveQualityGate({
      base,
      baselineChapterCount: 0,
      windowSize: 5,
      lowSuccessThreshold: 0.5,
    });
    // Tightened mode: pauseAfterConsecutiveFailures = 2
    gate.record("book-f", { chapterNumber: 1, success: false, issueCategories: ["x"] });
    gate.record("book-f", { chapterNumber: 2, success: false, issueCategories: ["x"] });

    const decision = gate.shouldPause("book-f");
    expect(decision.paused).toBe(true);
    expect(decision.reason).toContain("2 consecutive audit failures");
  });

  it("reset clears history", () => {
    const gate = new AdaptiveQualityGate({ base });
    gate.record("book-g", { chapterNumber: 1, success: false, issueCategories: [] });
    gate.reset("book-g");
    const snap = gate.snapshot("book-g");
    expect(snap.totalChapters).toBe(0);
    expect(snap.consecutiveFailures).toBe(0);
  });

  it("trims old history to prevent unbounded growth", () => {
    const gate = new AdaptiveQualityGate({ base, windowSize: 3 });
    for (let i = 0; i < 20; i++) {
      gate.record("book-h", { chapterNumber: i + 1, success: true, issueCategories: [] });
    }
    // Should keep at most windowSize * 2 = 6 entries
    const snap = gate.snapshot("book-h");
    expect(snap.totalChapters).toBe(6);
  });
});
