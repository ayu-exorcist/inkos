import { join } from "node:path";
import { readdir, writeFile } from "node:fs/promises";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { ReviserAgent, ReviseMode } from "../agents/reviser.js";
import { DEFAULT_REVISE_MODE } from "../agents/reviser.js";
import type { AgentContext, BaseAgent } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { StateManager } from "../state/manager.js";
import type { EventBus } from "../events/bus.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AuditService } from "./audit.js";
import type { DraftService } from "./draft.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { countChapterLength, buildLengthSpec } from "../utils/length-metrics.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { Logger } from "../utils/logger.js";
import { buildLengthWarnings, buildLengthTelemetry, logLengthWarnings } from "../pipeline/runner-helpers.js";

export interface RevisionServiceDeps {
  readonly state: StateManager;
  readonly resolveAgent: <T extends BaseAgent>(name: string, bookId?: string) => Promise<T>;
  readonly audit: AuditService;
  readonly draft: DraftService;
  readonly logger?: Logger;
  readonly eventBus?: EventBus;
  readonly inputGovernanceMode?: "legacy" | "v2";
  readonly externalContext?: string;
  localize(language: LengthLanguage, messages: { zh: string; en: string }): string;
  logStage(language: LengthLanguage, message: { zh: string; en: string }): void;
  logWarn(language: LengthLanguage, message: { zh: string; en: string }): void;
  readChapterContent(bookDir: string, chapterNumber: number): Promise<string>;
  resolveBookLanguage(book: Pick<BookConfig, "genre" | "language">): Promise<LengthLanguage>;
  resolveBookLanguageById(bookId: string): Promise<LengthLanguage>;
  loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }>;
  persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void>;
  emitWebhook(event: WebhookEvent, bookId: string, chapterNumber?: number, data?: Record<string, unknown>): Promise<void>;
  emitEvent<T>(eventType: string, payload: T): Promise<void>;
}

/**
 * RevisionService handles chapter revision based on audit feedback.
 *
 * Extracted from PipelineRunner to decouple revision lifecycle
 * from draft orchestration.
 */
export class RevisionService {
  constructor(private readonly deps: RevisionServiceDeps) {}

  async reviseDraft(
    bookId: string,
    chapterNumber?: number,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
  ): Promise<{
    chapterNumber: number;
    wordCount: number;
    fixedIssues: ReadonlyArray<string>;
    applied: boolean;
    status: "ready-for-review" | "audit-failed" | "unchanged";
    skippedReason?: string;
    lengthWarnings?: ReadonlyArray<string>;
    lengthTelemetry?: LengthTelemetry;
  }> {
    const releaseLock = await this.deps.state.acquireBookLock(bookId);
    try {
      const book = await this.deps.state.loadBookConfig(bookId);
      const bookDir = this.deps.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.deps.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }

      const stageLanguage = await this.deps.resolveBookLanguage(book);
      this.deps.logStage(stageLanguage, {
        zh: `加载第${targetChapter}章修订上下文`,
        en: `loading revision context for chapter ${targetChapter}`,
      });
      const index = await this.deps.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }

      const content = await this.deps.readChapterContent(bookDir, targetChapter);
      const { profile: gp } = await this.deps.loadGenreProfile(book.genre);
      const language = book.language ?? gp.language;
      const countingMode =
        chapterMeta.lengthTelemetry?.countingMode === "en_words"
          ? "en_words"
          : language === "en"
            ? "en_words"
            : "zh_chars";
      const reviseControlInput =
        (this.deps.inputGovernanceMode ?? "v2") === "legacy"
          ? undefined
          : await this.deps.draft.createGovernedArtifacts(
              book,
              bookDir,
              targetChapter,
              this.deps.externalContext,
              { reuseExistingIntentWhenContextMissing: true },
            );
      const preRevision = await this.deps.audit.evaluateMergedAudit({
        book,
        bookDir,
        chapterContent: content,
        chapterNumber: targetChapter,
        auditOptions: reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
            }
          : undefined,
      });

      if (preRevision.blockingCount === 0 && preRevision.aiTellCount === 0) {
        return {
          chapterNumber: targetChapter,
          wordCount: countChapterLength(content, countingMode),
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: "No warning, critical, or AI-tell issues to fix.",
        };
      }

      const chapterLengthTarget = chapterMeta.lengthTelemetry?.target ?? book.chapterWordCount;
      const lengthLanguage = chapterMeta.lengthTelemetry?.countingMode === "en_words" ? "en" : language;
      const lengthSpec = buildLengthSpec(chapterLengthTarget, lengthLanguage);

      const reviser = await this.deps.resolveAgent<ReviserAgent>("reviser", bookId);
      this.deps.logStage(stageLanguage, {
        zh: `修订第${targetChapter}章`,
        en: `revising chapter ${targetChapter}`,
      });
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        preRevision.auditResult.issues,
        mode,
        book.genre,
        reviseControlInput
          ? {
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              chapterIntentData: reviseControlInput.plan.intent,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              lengthSpec,
            }
          : { lengthSpec },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      const normalizedRevision = await this.deps.draft.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber: targetChapter,
        chapterContent: reviseOutput.revisedContent,
        lengthSpec,
      });
      const postRevision = await this.deps.audit.evaluateMergedAudit({
        book,
        bookDir,
        chapterContent: normalizedRevision.content,
        chapterNumber: targetChapter,
        auditOptions: reviseControlInput
          ? {
              temperature: 0,
              chapterIntent: reviseControlInput.plan.intentMarkdown,
              chapterMemo: reviseControlInput.plan.memo,
              contextPackage: reviseControlInput.composed.contextPackage,
              ruleStack: reviseControlInput.composed.ruleStack,
              truthFileOverrides: {
                currentState:
                  reviseOutput.updatedState !== "(状态卡未更新)"
                    ? reviseOutput.updatedState
                    : undefined,
                ledger:
                  reviseOutput.updatedLedger !== "(账本未更新)"
                    ? reviseOutput.updatedLedger
                    : undefined,
                hooks:
                  reviseOutput.updatedHooks !== "(伏笔池未更新)"
                    ? reviseOutput.updatedHooks
                    : undefined,
              },
            }
          : {
              temperature: 0,
              truthFileOverrides: {
                currentState:
                  reviseOutput.updatedState !== "(状态卡未更新)"
                    ? reviseOutput.updatedState
                    : undefined,
                ledger:
                  reviseOutput.updatedLedger !== "(账本未更新)"
                    ? reviseOutput.updatedLedger
                    : undefined,
                hooks:
                  reviseOutput.updatedHooks !== "(伏笔池未更新)"
                    ? reviseOutput.updatedHooks
                    : undefined,
              },
            },
      });
      const effectivePostRevision = this.restoreActionableAuditIfLost(preRevision, postRevision);
      const revisionBaseCount = countChapterLength(content, lengthSpec.countingMode);
      const lengthWarnings = buildLengthWarnings(targetChapter, normalizedRevision.wordCount, lengthSpec);
      const lengthTelemetry = buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postWriterNormalizeCount: 0,
        postReviseCount: normalizedRevision.wordCount,
        finalCount: normalizedRevision.wordCount,
        normalizeApplied: normalizedRevision.applied,
        lengthWarning: lengthWarnings.length > 0,
      });

      const improvedBlocking = effectivePostRevision.blockingCount < preRevision.blockingCount;
      const improvedAITells = effectivePostRevision.aiTellCount < preRevision.aiTellCount;
      const blockingDidNotWorsen = effectivePostRevision.blockingCount <= preRevision.blockingCount;
      const criticalDidNotWorsen = effectivePostRevision.criticalCount <= preRevision.criticalCount;
      const aiDidNotWorsen = effectivePostRevision.aiTellCount <= preRevision.aiTellCount;
      const shouldApplyRevision =
        blockingDidNotWorsen &&
        criticalDidNotWorsen &&
        aiDidNotWorsen &&
        (improvedBlocking || improvedAITells);

      if (!shouldApplyRevision) {
        return {
          chapterNumber: targetChapter,
          wordCount: revisionBaseCount,
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason:
            "Manual revision did not improve merged audit or AI-tell metrics; kept original chapter.",
        };
      }
      logLengthWarnings(this.deps.logger, lengthWarnings);

      this.deps.logStage(stageLanguage, {
        zh: `落盘第${targetChapter}章修订结果`,
        en: `persisting revision for chapter ${targetChapter}`,
      });
      const chaptersDir = join(bookDir, "chapters");
      const files = await readdir(chaptersDir);
      const paddedNum = String(targetChapter).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(
          `Chapter ${targetChapter} file not found in ${chaptersDir} (expected filename starting with ${paddedNum})`,
        );
      }
      const reviseLang = book.language ?? gp.language;
      const reviseHeading =
        reviseLang === "en"
          ? `# Chapter ${targetChapter}: ${chapterMeta.title}`
          : `# 第${targetChapter}章 ${chapterMeta.title}`;
      await writeFile(
        join(chaptersDir, existingFile),
        `${reviseHeading}\n\n${normalizedRevision.content}`,
        "utf-8",
      );

      const storyDir = join(bookDir, "story");
      if (reviseOutput.updatedState !== "(状态卡未更新)") {
        await writeFile(join(storyDir, "current_state.md"), reviseOutput.updatedState, "utf-8");
      }
      if (
        gp.numericalSystem &&
        reviseOutput.updatedLedger &&
        reviseOutput.updatedLedger !== "(账本未更新)"
      ) {
        await writeFile(join(storyDir, "particle_ledger.md"), reviseOutput.updatedLedger, "utf-8");
      }
      if (reviseOutput.updatedHooks !== "(伏笔池未更新)") {
        await writeFile(join(storyDir, "pending_hooks.md"), reviseOutput.updatedHooks, "utf-8");
      }
      await this.deps.draft.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter);

      const updatedIndex = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: (effectivePostRevision.auditResult.passed
                ? "ready-for-review"
                : "audit-failed") as ChapterMeta["status"],
              wordCount: normalizedRevision.wordCount,
              updatedAt: new Date().toISOString(),
              auditIssues: effectivePostRevision.auditResult.issues.map(
                (i) => `[${i.severity}] ${i.description}`,
              ),
              lengthWarnings,
              lengthTelemetry,
            }
          : ch,
      );
      await this.deps.state.saveChapterIndex(bookId, updatedIndex);
      const latestChapter =
        index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
      if (targetChapter === latestChapter) {
        await this.deps.persistAuditDriftGuidance({
          bookDir,
          chapterNumber: targetChapter,
          issues: effectivePostRevision.auditResult.issues.filter(
            (issue) => issue.severity === "critical" || issue.severity === "warning",
          ),
          language,
        }).catch(() => undefined);
      }

      this.deps.logStage(stageLanguage, {
        zh: `更新第${targetChapter}章索引与快照`,
        en: `updating chapter index and snapshots for chapter ${targetChapter}`,
      });
      await this.deps.state.snapshotState(bookId, targetChapter);
      await this.deps.draft.syncNarrativeMemoryIndex(bookId);
      await this.deps.draft.syncCurrentStateFactHistory(bookId, targetChapter);

      await this.deps.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: normalizedRevision.wordCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      await this.deps.emitEvent("chapter:revised", {
        bookId,
        chapterNumber: targetChapter,
        applied: true,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      return {
        chapterNumber: targetChapter,
        wordCount: normalizedRevision.wordCount,
        fixedIssues: reviseOutput.fixedIssues,
        applied: true,
        status: effectivePostRevision.auditResult.passed ? "ready-for-review" : "audit-failed",
        lengthWarnings,
        lengthTelemetry,
      };
    } finally {
      await releaseLock();
    }
  }

  private restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
    if (next.passed || next.issues.length > 0 || previous.issues.length === 0) {
      return next;
    }

    return {
      ...next,
      issues: previous.issues,
      summary: next.summary || previous.summary,
    };
  }

  private restoreActionableAuditIfLost(
    previous: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
    next: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
  ): {
    auditResult: AuditResult;
    aiTellCount: number;
    blockingCount: number;
    criticalCount: number;
    revisionBlockingIssues: ReadonlyArray<AuditIssue>;
  } {
    const auditResult = this.restoreLostAuditIssues(previous.auditResult, next.auditResult);
    if (auditResult === next.auditResult) {
      return next;
    }

    return {
      ...next,
      auditResult,
      revisionBlockingIssues: previous.revisionBlockingIssues,
      blockingCount: previous.blockingCount,
      criticalCount: previous.criticalCount,
    };
  }
}
