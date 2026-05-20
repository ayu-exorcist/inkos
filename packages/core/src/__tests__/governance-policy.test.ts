import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyLoader, ResolvedPolicy } from "../governance/policy-loader.js";

describe("PolicyLoader", () => {
  it("returns default policy when no manifest exists", async () => {
    const loader = new PolicyLoader();
    const policy = await loader.load();
    expect(policy.minPassScore).toBe(65);
    expect(policy.scoreBands).toHaveLength(5);
  });

  it("loads audit.yaml from project policies dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkos-policy-test-"));
    await mkdir(join(dir, ".inkos", "policies"), { recursive: true });
    await writeFile(
      join(dir, ".inkos", "policies", "audit.yaml"),
      `audit:
  version: 2
  name: strict
  scoring:
    minPassScore: 80
    scoreBands:
      - min: 90
        max: 100
        label: excellent
  dimensions:
    - id: 1
      enabled: false
    - id: 7
      enabled: true
      noteOverride: custom pacing note
`,
      "utf-8",
    );

    const loader = new PolicyLoader({ projectRoot: dir });
    const policy = await loader.load();

    expect(policy.minPassScore).toBe(80);
    expect(policy.isDimensionDisabled(1)).toBe(true);
    expect(policy.isDimensionEnabled(7)).toBe(true);
    expect(policy.dimensionNoteOverride(7)).toBe("custom pacing note");
    expect(policy.buildScoreCalibration("en")).toContain("excellent");

    await rm(dir, { recursive: true, force: true });
  });

  it("loads audit.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkos-policy-json-"));
    await mkdir(join(dir, ".inkos", "policies"), { recursive: true });
    await writeFile(
      join(dir, ".inkos", "policies", "audit.json"),
      JSON.stringify({
        audit: {
          severityWeights: { critical: 5, warning: 2, info: 0 },
        },
      }),
      "utf-8",
    );

    const loader = new PolicyLoader({ projectRoot: dir });
    const policy = await loader.load();
    expect(policy.computeScore({ critical: 1, warning: 2, info: 0 })).toBe(91);

    await rm(dir, { recursive: true, force: true });
  });

  it("merges dimensions across multiple sources", async () => {
    const global = await mkdtemp(join(tmpdir(), "inkos-policy-global-"));
    const project = await mkdtemp(join(tmpdir(), "inkos-policy-project-"));

    await mkdir(join(global, ".inkos", "policies"), { recursive: true });
    await mkdir(join(project, ".inkos", "policies"), { recursive: true });
    await writeFile(
      join(global, ".inkos", "policies", "audit.yaml"),
      `audit:
  dimensions:
    - id: 10
      enabled: false
`,
      "utf-8",
    );
    await writeFile(
      join(project, ".inkos", "policies", "audit.yaml"),
      `audit:
  dimensions:
    - id: 10
      enabled: true
      noteOverride: overridden
`,
      "utf-8",
    );

    const loader = new PolicyLoader({ projectRoot: project });
    const policy = await loader.load();
    // Project should win
    expect(policy.isDimensionDisabled(10)).toBe(false);
    expect(policy.dimensionNoteOverride(10)).toBe("overridden");

    await rm(global, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
});

describe("ResolvedPolicy", () => {
  it("computes score with default weights", () => {
    const policy = new ResolvedPolicy([]);
    expect(policy.computeScore({ critical: 0, warning: 0, info: 0 })).toBe(100);
    expect(policy.computeScore({ critical: 1, warning: 0, info: 0 })).toBe(97);
    expect(policy.computeScore({ critical: 2, warning: 3, info: 5 })).toBe(91);
  });

  it("builds score calibration in both languages", () => {
    const policy = new ResolvedPolicy([]);
    const en = policy.buildScoreCalibration("en");
    expect(en).toContain("overall_score calibration");
    const zh = policy.buildScoreCalibration("zh");
    expect(zh).toContain("overall_score 评分校准");
  });
});
