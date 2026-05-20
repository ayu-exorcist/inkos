import type { BookConfig } from "../models/book.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import type { AuditResult, AuditIssue, ContinuityAuditor } from "../agents/continuity.js";
import type { ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import type { ResolvedPolicy } from "../governance/policy-loader.js";

export interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export interface AuditServiceDeps {
  resolveAgent(name: string, bookId?: string): Promise<unknown>;
}

export interface AuditOptions {
  readonly temperature?: number;
  readonly chapterIntent?: string;
  readonly chapterMemo?: ChapterMemo;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
  readonly truthFileOverrides?: {
    currentState?: string;
    ledger?: string;
    hooks?: string;
  };
  readonly policy?: ResolvedPolicy;
}

/**
 * AuditService encapsulates chapter auditing and merged evaluation.
 *
 * Combines LLM structural audit with local heuristics (AI-tells, sensitive words,
 * long-span fatigue) into a single merged evaluation.
 */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async auditChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    book: BookConfig,
    options?: AuditOptions,
  ): Promise<AuditResult & { chapterNumber: number }> {
    const auditor = await this.deps.resolveAgent("auditor", book.id) as ContinuityAuditor;
    const language: LengthLanguage = book.language ?? "zh";

    const result = await auditor.auditChapter(
      bookDir,
      chapterContent,
      chapterNumber,
      book.genre,
      {
        temperature: options?.temperature,
        chapterIntent: options?.chapterIntent,
        chapterMemo: options?.chapterMemo,
        contextPackage: options?.contextPackage,
        ruleStack: options?.ruleStack,
        truthFileOverrides: options?.truthFileOverrides,
        policy: options?.policy,
      },
    );

    return { ...result, chapterNumber };
  }

  async evaluateMergedAudit(params: {
    bookDir: string;
    chapterContent: string;
    chapterNumber: number;
    book: BookConfig;
    auditOptions?: AuditOptions;
  }): Promise<MergedAuditEvaluation> {
    const auditor = await this.deps.resolveAgent("auditor", params.book.id) as ContinuityAuditor;
    const language: LengthLanguage = params.book.language ?? "zh";

    const llmAudit = await auditor.auditChapter(
      params.bookDir,
      params.chapterContent,
      params.chapterNumber,
      params.book.genre,
      {
        temperature: params.auditOptions?.temperature,
        chapterIntent: params.auditOptions?.chapterIntent,
        chapterMemo: params.auditOptions?.chapterMemo,
        contextPackage: params.auditOptions?.contextPackage,
        ruleStack: params.auditOptions?.ruleStack,
        truthFileOverrides: params.auditOptions?.truthFileOverrides,
        policy: params.auditOptions?.policy,
      },
    );

    const aiTells = analyzeAITells(params.chapterContent, language);
    const sensitiveResult = analyzeSensitiveWords(params.chapterContent, undefined, language);
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir: params.bookDir,
      chapterNumber: params.chapterNumber,
      chapterContent: params.chapterContent,
      language,
    });

    const hasBlockedWords = sensitiveResult.found.some((f) => f.severity === "block");
    const issues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...longSpanFatigue.issues,
    ];
    const revisionBlockingIssues: ReadonlyArray<AuditIssue> = [
      ...llmAudit.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
    ];

    return {
      auditResult: {
        passed: hasBlockedWords ? false : llmAudit.passed,
        issues,
        summary: llmAudit.summary,
        tokenUsage: llmAudit.tokenUsage,
      },
      aiTellCount: aiTells.issues.length,
      blockingCount: revisionBlockingIssues.filter(
        (issue) => issue.severity === "warning" || issue.severity === "critical",
      ).length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  }
}
