/**
 * Agent Health Monitor — circuit-breaker style protection for LLM agents.
 *
 * Tracks per-agent call latency, success rate, and consecutive failures.
 * When a threshold is breached, the circuit opens and calls are rejected
 * fast until a cooldown period passes.
 */

export interface AgentHealthOptions {
  /** Max consecutive failures before opening circuit. */
  readonly failureThreshold?: number;
  /** Cooldown (ms) before allowing a half-open probe. */
  readonly cooldownMs?: number;
  /** Sliding window size for success-rate calculation. */
  readonly windowSize?: number;
  /** Success-rate threshold below which circuit opens. */
  readonly minSuccessRate?: number;
}

export interface AgentCallMetrics {
  readonly totalCalls: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly consecutiveFailures: number;
  readonly avgLatencyMs: number;
  readonly successRate: number;
  readonly circuitState: "closed" | "open" | "half-open";
}

interface CallRecord {
  readonly success: boolean;
  readonly latencyMs: number;
  readonly timestamp: number;
}

class AgentCircuit {
  private records: CallRecord[] = [];
  private consecutiveFailures = 0;
  private circuitState: "closed" | "open" | "half-open" = "closed";
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly windowSize: number,
    private readonly minSuccessRate: number,
  ) {}

  record(success: boolean, latencyMs: number): void {
    const now = Date.now();
    this.records.push({ success, latencyMs, timestamp: now });
    // Trim window
    const cutoff = now - this.windowSize;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);

    if (success) {
      this.consecutiveFailures = 0;
      if (this.circuitState === "half-open") {
        this.circuitState = "closed";
      }
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.circuitState = "open";
        this.openedAt = now;
      }
    }
  }

  canCall(): boolean {
    if (this.circuitState === "closed") return true;
    if (this.circuitState === "open") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.circuitState = "half-open";
        return true;
      }
      return false;
    }
    // half-open — allow one probe
    return true;
  }

  getMetrics(): AgentCallMetrics {
    const total = this.records.length;
    const successes = this.records.filter((r) => r.success).length;
    const failures = total - successes;
    const avgLatency =
      total > 0 ? this.records.reduce((sum, r) => sum + r.latencyMs, 0) / total : 0;
    return {
      totalCalls: total,
      successCount: successes,
      failureCount: failures,
      consecutiveFailures: this.consecutiveFailures,
      avgLatencyMs: Math.round(avgLatency),
      successRate: total > 0 ? successes / total : 1,
      circuitState: this.circuitState,
    };
  }

  reset(): void {
    this.records = [];
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
    this.openedAt = 0;
  }
}

export class AgentHealthMonitor {
  private circuits = new Map<string, AgentCircuit>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly windowSize: number;
  private readonly minSuccessRate: number;

  constructor(options: AgentHealthOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.windowSize = options.windowSize ?? 300_000; // 5 min
    this.minSuccessRate = options.minSuccessRate ?? 0.5;
  }

  private getCircuit(agentName: string): AgentCircuit {
    let circuit = this.circuits.get(agentName);
    if (!circuit) {
      circuit = new AgentCircuit(
        this.failureThreshold,
        this.cooldownMs,
        this.windowSize,
        this.minSuccessRate,
      );
      this.circuits.set(agentName, circuit);
    }
    return circuit;
  }

  /** Check if the agent is allowed to be called right now. */
  canCall(agentName: string): boolean {
    return this.getCircuit(agentName).canCall();
  }

  /** Record the result of a call. */
  record(agentName: string, success: boolean, latencyMs: number): void {
    this.getCircuit(agentName).record(success, latencyMs);
  }

  /** Get current metrics for an agent. */
  metrics(agentName: string): AgentCallMetrics {
    return this.getCircuit(agentName).getMetrics();
  }

  /** Reset an agent's circuit (e.g. after manual intervention). */
  reset(agentName: string): void {
    this.getCircuit(agentName).reset();
  }

  /** List all tracked agent names. */
  listAgents(): string[] {
    return [...this.circuits.keys()];
  }
}
