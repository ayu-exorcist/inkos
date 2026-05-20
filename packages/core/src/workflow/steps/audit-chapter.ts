import type { WorkflowContext } from "../context.js";
import type { Step } from "../step.js";
import type { AuditResult, AuditIssue } from "../../agents/continuity.js";
import { ContinuityAuditor } from "../../agents/continuity.js";
import { analyzeAITells, type AITellResult } from "../../agents/ai-tells.js";
import { analyzeSensitiveWords, type SensitiveWordResult } from "../../agents/sensitive-words.js";
import type { ChapterMemo } from "../../models/input-governance.js";

export interface AuditChapterInput {
  readonly chapterNumber: number;
  readonly content: string;
  readonly chapterIntentMarkdown?: string;
  readonly chapterMemo?: ChapterMemo;
  readonly contextPackage?: unknown;
  readonly ruleStack?: unknown;
}

export interface AuditChapterOutput {
  readonly auditResult: AuditResult;
  readonly aiTellResult: AITellResult;
  readonly sensitiveResult: SensitiveWordResult;
  readonly mergedBlockingCount: number;
  readonly mergedCriticalCount: number;
}

/**
 * Step: Run continuity audit, AI-tell detection, and sensitive-word scan.
 * Mirrors the merged audit logic currently inlined in PipelineRunner.
 */
export const auditChapterStep: Step<AuditChapterInput, AuditChapterOutput> = {
  name: "audit",
  nameI18n: { zh: "审计草稿", en: "auditing draft" },
  async run(ctx, input) {
    const { chapterNumber, content, chapterIntentMarkdown, chapterMemo, contextPackage, ruleStack } = input;
    const auditor = new ContinuityAuditor(ctx.runner.createAgentContext("auditor", ctx.bookId));

    const auditOptions =
      chapterIntentMarkdown && contextPackage && ruleStack
        ? {
            chapterIntent: chapterIntentMarkdown,
            chapterMemo,
            contextPackage: contextPackage as any,
            ruleStack: ruleStack as any,
          }
        : undefined;

    const auditResult = await auditor.auditChapter(
      ctx.bookDir,
      content,
      chapterNumber,
      ctx.book.genre,
      auditOptions,
    );

    const [aiTellResult, sensitiveResult] = await Promise.all([
      analyzeAITells(content, ctx.language),
      analyzeSensitiveWords(content, undefined, ctx.language),
    ]);

    const aiTellCount = aiTellResult.issues.length;
    const blockingCount = auditResult.issues.filter(
      (i) => i.severity === "warning" || i.severity === "critical",
    ).length;
    const criticalCount = auditResult.issues.filter((i) => i.severity === "critical").length;

    ctx.bag.set("audit:result", auditResult);
    ctx.bag.set("audit:aiTells", aiTellResult);
    ctx.bag.set("audit:sensitive", sensitiveResult);

    return {
      auditResult,
      aiTellResult,
      sensitiveResult,
      mergedBlockingCount: blockingCount + aiTellCount,
      mergedCriticalCount: criticalCount,
    };
  },
};
