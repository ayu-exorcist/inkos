/**
 * GovernancePolicy — externalize audit/planning strategies without code changes.
 *
 * Supports YAML and JSON manifests under:
 *   ~/.inkos/policies/      (global)
 *   <projectRoot>/.inkos/policies/  (project-local)
 *
 * Project-local policies override global ones.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { load } from "js-yaml";

export interface DimensionPolicy {
  readonly id: number;
  readonly enabled?: boolean;
  readonly weight?: number;
  readonly severityThresholds?: {
    readonly warning?: number;
    readonly critical?: number;
  };
  /** Optional note override injected into the auditor prompt. */
  readonly noteOverride?: string;
}

export interface SeverityWeights {
  readonly info?: number;
  readonly warning?: number;
  readonly critical?: number;
}

export interface ScoringPolicy {
  readonly minPassScore?: number;
  readonly scoreBands?: ReadonlyArray<{
    readonly min: number;
    readonly max: number;
    readonly label: string;
  }>;
}

export interface AuditPolicy {
  readonly version?: number;
  readonly name?: string;
  /** Dimension overrides — omitted dimensions keep their hardcoded defaults. */
  readonly dimensions?: ReadonlyArray<DimensionPolicy>;
  /** Severity-to-score weights used when computing overall score from issues. */
  readonly severityWeights?: SeverityWeights;
  /** Scoring calibration. */
  readonly scoring?: ScoringPolicy;
  /** Extra dimensions to always activate (by numeric id or name). */
  readonly extraDimensions?: ReadonlyArray<number | string>;
  /** Dimensions to explicitly deactivate (by numeric id or name). */
  readonly deactivatedDimensions?: ReadonlyArray<number | string>;
}

export interface GovernancePolicy {
  readonly audit?: AuditPolicy;
}

interface PolicySource {
  readonly path: string;
  readonly policy: GovernancePolicy;
  readonly mtimeMs: number;
}

/** Merged policy with all overrides applied. */
export class ResolvedPolicy {
  constructor(private readonly sources: PolicySource[]) {}

  private get audit(): AuditPolicy | undefined {
    // Last source wins for top-level fields; dimensions merge additively.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const merged = {} as Record<string, unknown>;
    const dimMap = new Map<number, DimensionPolicy>();
    let extraDims: Array<number | string> = [];
    let deactivatedDims: Array<number | string> = [];

    for (const src of this.sources) {
      const a = src.policy.audit;
      if (!a) continue;
      if (a.name !== undefined) merged.name = a.name;
      if (a.version !== undefined) merged.version = a.version;
      if (a.severityWeights !== undefined) merged.severityWeights = a.severityWeights;
      if (a.scoring !== undefined) merged.scoring = a.scoring;
      if (a.extraDimensions) extraDims = [...extraDims, ...a.extraDimensions];
      if (a.deactivatedDimensions) deactivatedDims = [...deactivatedDims, ...a.deactivatedDimensions];

      for (const d of a.dimensions ?? []) {
        const existing = dimMap.get(d.id);
        dimMap.set(d.id, { ...existing, ...d });
      }
    }

    if (dimMap.size > 0) merged.dimensions = [...dimMap.values()];
    if (extraDims.length > 0) merged.extraDimensions = extraDims;
    if (deactivatedDims.length > 0) merged.deactivatedDimensions = deactivatedDims;

    return Object.keys(merged).length > 0 ? (merged as AuditPolicy) : undefined;
  }

  /** Check if a dimension is explicitly disabled by policy. */
  isDimensionDisabled(id: number): boolean {
    const a = this.audit;
    if (!a) return false;
    // Check deactivatedDimensions list first
    for (const d of a.deactivatedDimensions ?? []) {
      if (typeof d === "number" && d === id) return true;
    }
    // Check dimension entry
    for (const d of a.dimensions ?? []) {
      if (d.id === id && d.enabled === false) return true;
    }
    return false;
  }

  /** Check if a dimension is explicitly enabled or added by policy. */
  isDimensionEnabled(id: number): boolean {
    const a = this.audit;
    if (!a) return false;
    for (const d of a.extraDimensions ?? []) {
      if (typeof d === "number" && d === id) return true;
    }
    for (const d of a.dimensions ?? []) {
      if (d.id === id && d.enabled === true) return true;
    }
    return false;
  }

  /** Get note override for a dimension, if any. */
  dimensionNoteOverride(id: number): string | undefined {
    const a = this.audit;
    if (!a) return undefined;
    for (const d of a.dimensions ?? []) {
      if (d.id === id && d.noteOverride !== undefined) return d.noteOverride;
    }
    return undefined;
  }

  /** Compute overall score from a list of issue severities. */
  computeScore(issueCounts: { critical: number; warning: number; info: number }): number {
    const a = this.audit;
    const weights = a?.severityWeights ?? { critical: 3, warning: 1, info: 0 };
    const base = 100;
    const penalty =
      (issueCounts.critical * (weights.critical ?? 3)) +
      (issueCounts.warning * (weights.warning ?? 1)) +
      (issueCounts.info * (weights.info ?? 0));
    return Math.max(0, base - penalty);
  }

  /** Minimum score to pass audit. */
  get minPassScore(): number {
    return this.audit?.scoring?.minPassScore ?? 65;
  }

  /** Score band labels for prompt injection. */
  get scoreBands(): ReadonlyArray<{ min: number; max: number; label: string }> {
    return (
      this.audit?.scoring?.scoreBands ?? [
        { min: 95, max: 100, label: "可直接发布，无明显问题" },
        { min: 85, max: 94, label: "有小瑕疵但整体流畅可读，读者不会出戏" },
        { min: 75, max: 84, label: "有明显问题但故事主干完整，需要修但不紧急" },
        { min: 65, max: 74, label: "多处影响阅读体验的问题，节奏或连续性有断裂" },
        { min: 0, max: 64, label: "结构性问题，需要大幅重写" },
      ]
    );
  }

  /** Build the score-calibration paragraph for the auditor system prompt. */
  buildScoreCalibration(language: "zh" | "en"): string {
    const bands = this.scoreBands;
    const lines = bands
      .map((b) => `- ${b.min}-${b.max}: ${b.label}`)
      .join("\n");
    if (language === "en") {
      return `overall_score calibration:\n${lines}\nScore holistically — do not let a single minor issue tank the score.`;
    }
    return `overall_score 评分校准：\n${lines}\n综合评分，不要因为单一小问题大幅拉低分数。`;
  }
}

export class PolicyLoader {
  private readonly projectRoot?: string;
  private sources: PolicySource[] = [];
  private resolved?: ResolvedPolicy;
  private lastCheck = 0;
  private checkIntervalMs = 5_000;

  constructor(options?: { projectRoot?: string; checkIntervalMs?: number }) {
    this.projectRoot = options?.projectRoot;
    this.checkIntervalMs = options?.checkIntervalMs ?? 5_000;
  }

  /** Load policies from disk. Idempotent — safe to call multiple times. */
  async load(): Promise<ResolvedPolicy> {
    const globalDir = join(homedir(), ".inkos", "policies");
    const projectDir = this.projectRoot
      ? join(this.projectRoot, ".inkos", "policies")
      : undefined;

    const newSources: PolicySource[] = [];
    for (const dir of [globalDir, projectDir].filter(Boolean)) {
      const src = await this.tryLoadFromDir(dir!);
      if (src) newSources.push(src);
    }

    this.sources = newSources;
    this.resolved = new ResolvedPolicy(this.sources);
    this.lastCheck = Date.now();
    return this.resolved;
  }

  /** Get current policy, reloading from disk if files changed. */
  async getPolicy(): Promise<ResolvedPolicy> {
    const now = Date.now();
    if (now - this.lastCheck > this.checkIntervalMs) {
      const changed = await this.detectChange();
      if (changed) {
        return this.load();
      }
      this.lastCheck = now;
    }
    if (!this.resolved) {
      return this.load();
    }
    return this.resolved;
  }

  private async detectChange(): Promise<boolean> {
    for (const src of this.sources) {
      try {
        const s = await stat(src.path);
        if (s.mtimeMs !== src.mtimeMs) return true;
      } catch {
        return true; // file removed
      }
    }
    // Also check if new files appeared
    const globalDir = join(homedir(), ".inkos", "policies");
    const projectDir = this.projectRoot
      ? join(this.projectRoot, ".inkos", "policies")
      : undefined;
    for (const dir of [globalDir, projectDir].filter(Boolean)) {
      const src = await this.tryLoadFromDir(dir!);
      const existing = this.sources.find((s) => s.path === src?.path);
      if (!existing && src) return true;
      if (existing && src && existing.mtimeMs !== src.mtimeMs) return true;
    }
    return false;
  }

  private async tryLoadFromDir(dir: string): Promise<PolicySource | null> {
    const candidates = [
      join(dir, "audit.yaml"),
      join(dir, "audit.json"),
      join(dir, "policy.yaml"),
      join(dir, "policy.json"),
    ];
    for (const path of candidates) {
      try {
        const s = await stat(path);
        if (!s.isFile()) continue;
        const raw = await readFile(path, "utf-8");
        const parsed = path.endsWith(".yaml") || path.endsWith(".yml")
          ? (load(raw) as GovernancePolicy)
          : (JSON.parse(raw) as GovernancePolicy);
        return { path, policy: parsed, mtimeMs: s.mtimeMs };
      } catch {
        // try next candidate
      }
    }
    return null;
  }
}
