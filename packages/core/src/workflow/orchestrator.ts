import type { WorkflowContext } from "./context.js";
import { runStep, type Step } from "./step.js";
import { draftChapterStep } from "./steps/draft-chapter.js";
import { auditChapterStep } from "./steps/audit-chapter.js";
import { persistChapterStep } from "./steps/persist-chapter.js";
import type { DraftChapterInput, DraftChapterOutput } from "./steps/draft-chapter.js";
import type { AuditChapterInput, AuditChapterOutput } from "./steps/audit-chapter.js";
import type { PersistChapterInput, PersistChapterOutput } from "./steps/persist-chapter.js";
import type { ChapterReviewCycleResult } from "../pipeline/chapter-review-cycle.js";
import type { WriteChapterInput } from "../agents/writer.js";

/**
 * Orchestrator for the write-next-chapter workflow.
 *
 * This replaces the monolithic PipelineRunner.writeNextChapter() with
 * explicit step composition. Each step is independently testable and
 * swappable (e.g. swap auditChapterStep for a stricter variant).
 */
export interface WriteNextChapterInput {
  readonly chapterNumber: number;
  readonly writeInput: WriteChapterInput;
  readonly temperatureOverride?: number;
}

export interface WriteNextChapterOutput {
  readonly draft: DraftChapterOutput;
  readonly audit: AuditChapterOutput;
  readonly persist: PersistChapterOutput;
}

export class WriteNextChapterWorkflow {
  constructor(
    private readonly draftStep: Step<DraftChapterInput, DraftChapterOutput> = draftChapterStep,
    private readonly auditStep: Step<AuditChapterInput, AuditChapterOutput> = auditChapterStep,
    private readonly persistStep: Step<PersistChapterInput, PersistChapterOutput> = persistChapterStep,
  ) {}

  async run(ctx: WorkflowContext, input: WriteNextChapterInput): Promise<WriteNextChapterOutput> {
    const draft = await runStep(ctx, this.draftStep, {
      chapterNumber: input.chapterNumber,
      writeInput: input.writeInput,
      temperatureOverride: input.temperatureOverride,
    });

    const audit = await runStep(ctx, this.auditStep, {
      chapterNumber: input.chapterNumber,
      content: draft.output.content,
    });

    const persist = await runStep(ctx, this.persistStep, {
      chapterNumber: input.chapterNumber,
      title: draft.output.title,
      content: draft.output.content,
      auditResult: audit.auditResult,
    });

    return { draft, audit, persist };
  }
}

// ---------------------------------------------------------------------------
// Draft-and-Review workflow (no persist)
// Used by PipelineRunner._writeNextChapterLocked to keep the complex
// persist/notification/webhook logic in the runner while delegating
// the core LLM stages to the workflow engine.
// ---------------------------------------------------------------------------

export interface DraftAndReviewInput {
  readonly chapterNumber: number;
  readonly writeInput: Pick<
    WriteChapterInput,
    | "externalContext"
    | "chapterIntent"
    | "chapterMemo"
    | "chapterIntentData"
    | "contextPackage"
    | "ruleStack"
  >;
  readonly lengthSpec: import("../models/length-governance.js").LengthSpec;
  readonly wordCount?: number;
  readonly temperatureOverride?: number;
  /** Review-cycle dependencies injected from PipelineRunner. */
  readonly reviewDeps: {
    readonly reducedControlInput?: import("../pipeline/chapter-review-cycle.js").ChapterReviewCycleControlInput;
    readonly normalizeDraftLengthIfNeeded: (content: string) => Promise<{
      content: string;
      wordCount: number;
      applied: boolean;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }>;
    readonly normalizePostWriteSurface?: (content: string) => string;
    readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
    readonly addUsage: (
      left: { promptTokens: number; completionTokens: number; totalTokens: number },
      right?: { promptTokens: number; completionTokens: number; totalTokens: number },
    ) => { promptTokens: number; completionTokens: number; totalTokens: number };
    readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<import("../agents/continuity.js").AuditIssue> };
    readonly analyzeSensitiveWords: (content: string) => {
      found: ReadonlyArray<{ severity: string }>;
      issues: ReadonlyArray<import("../agents/continuity.js").AuditIssue>;
    };
    readonly runPostWriteChecks?: (content: string) => ReadonlyArray<import("../agents/continuity.js").AuditIssue>;
    readonly maxReviewIterations?: number;
    readonly logWarn: (message: { zh: string; en: string }) => void;
    readonly logStage: (message: { zh: string; en: string }) => void;
  };
}

export interface DraftAndReviewOutput {
  readonly draft: DraftChapterOutput;
  readonly review: ChapterReviewCycleResult;
}

export async function runDraftAndReviewWorkflow(
  ctx: WorkflowContext,
  input: DraftAndReviewInput,
): Promise<DraftAndReviewOutput> {
  const draft = await runStep(ctx, draftChapterStep, {
    chapterNumber: input.chapterNumber,
    writeInput: input.writeInput,
    temperatureOverride: input.temperatureOverride,
  });

  const { runChapterReviewCycle } = await import("../pipeline/chapter-review-cycle.js");
  const [reviser, auditor] = await Promise.all([
    ctx.resolveAgent("reviser"),
    ctx.resolveAgent("auditor"),
  ]);

  const review = await runChapterReviewCycle({
    book: { genre: ctx.book.genre },
    bookDir: ctx.bookDir,
    chapterNumber: input.chapterNumber,
    initialOutput: draft.output,
    reducedControlInput: input.reviewDeps.reducedControlInput,
    lengthSpec: input.lengthSpec,
    initialUsage: draft.output.tokenUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    createReviser: () => reviser as any,
    auditor: auditor as any,
    normalizeDraftLengthIfNeeded: input.reviewDeps.normalizeDraftLengthIfNeeded,
    normalizePostWriteSurface: input.reviewDeps.normalizePostWriteSurface,
    assertChapterContentNotEmpty: input.reviewDeps.assertChapterContentNotEmpty,
    addUsage: input.reviewDeps.addUsage,
    analyzeAITells: input.reviewDeps.analyzeAITells,
    analyzeSensitiveWords: input.reviewDeps.analyzeSensitiveWords,
    runPostWriteChecks: input.reviewDeps.runPostWriteChecks,
    maxReviewIterations: input.reviewDeps.maxReviewIterations,
    logWarn: input.reviewDeps.logWarn,
    logStage: input.reviewDeps.logStage,
  });

  return { draft, review };
}
