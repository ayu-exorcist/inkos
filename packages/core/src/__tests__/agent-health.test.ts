import { describe, it, expect, vi } from "vitest";
import { AgentHealthMonitor } from "../governance/agent-health.js";

describe("AgentHealthMonitor", () => {
  it("allows calls when circuit is closed", () => {
    const monitor = new AgentHealthMonitor();
    expect(monitor.canCall("writer")).toBe(true);
  });

  it("opens circuit after consecutive failures", () => {
    const monitor = new AgentHealthMonitor({ failureThreshold: 3, cooldownMs: 60_000 });
    monitor.record("writer", false, 100);
    monitor.record("writer", false, 100);
    expect(monitor.canCall("writer")).toBe(true);
    monitor.record("writer", false, 100);
    expect(monitor.canCall("writer")).toBe(false);
  });

  it("closes circuit again after a successful probe in half-open", () => {
    vi.useFakeTimers();
    const monitor = new AgentHealthMonitor({ failureThreshold: 2, cooldownMs: 5_000 });
    monitor.record("writer", false, 100);
    monitor.record("writer", false, 100);
    expect(monitor.canCall("writer")).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(monitor.canCall("writer")).toBe(true); // half-open

    monitor.record("writer", true, 100);
    expect(monitor.canCall("writer")).toBe(true); // closed again
    vi.useRealTimers();
  });

  it("tracks metrics correctly", () => {
    const monitor = new AgentHealthMonitor();
    monitor.record("auditor", true, 200);
    monitor.record("auditor", true, 300);
    monitor.record("auditor", false, 100);

    const m = monitor.metrics("auditor");
    expect(m.totalCalls).toBe(3);
    expect(m.successCount).toBe(2);
    expect(m.failureCount).toBe(1);
    expect(m.avgLatencyMs).toBe(200);
    expect(m.successRate).toBeCloseTo(2 / 3);
    expect(m.circuitState).toBe("closed");
  });

  it("reset clears all state", () => {
    const monitor = new AgentHealthMonitor();
    monitor.record("reviser", false, 100);
    monitor.record("reviser", false, 100);
    monitor.reset("reviser");
    const m = monitor.metrics("reviser");
    expect(m.totalCalls).toBe(0);
    expect(m.consecutiveFailures).toBe(0);
  });

  it("isolates agents by name", () => {
    const monitor = new AgentHealthMonitor({ failureThreshold: 1 });
    monitor.record("writer", false, 100);
    expect(monitor.canCall("writer")).toBe(false);
    expect(monitor.canCall("auditor")).toBe(true);
  });
});
