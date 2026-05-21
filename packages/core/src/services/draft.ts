import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { WriteChapterInput, WriteChapterOutput } from "../agents/writer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import type { StateManager } from "../state/manager.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import {
  buildLengthSpec,
  countChapterLength,
  isOutsideHardRange,
  type LengthLanguage as LengthLang,
} from "../utils/length-metrics.js";
import { join } from "node:path";
import { writeFile, readdir, rm } from "node:fs/promises";
import type { TokenUsageSummary, DraftResult } from "../pipeline/runner-helpers.js";
import {
  buildLengthWarnings,
  buildLengthTelemetry,
  logLengthWarnings,
  localize,
  languageFromLengthSpec,
} from "../pipeline/runner-helpers.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import type { Logger } from "../utils/logger.js";
import type { EventBus } from "../events/bus.js";
import { INKOS_EVENTS } from "../events/events.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { composeGovernedChapter, type ComposeChapterOutput } from "../agents/composer.js";
import type { PlanChapterOutput } from "../agents/planner.js";
import { MemoryDB, type Fact } from "../state/memory-db.js";
import {
  loadPersistedPlan,
  savePersistedPlan,
} from "../pipeline/persisted-governed-plan.js";

export interface DraftServiceDeps {
  readonly state: StateManager;
  readonly projectRoot: string;
  resolveAgent(name: string, bookId?: string): Promise<unknown>;
  logger?: Logger;
  externalContext?: string;
  inputGovernanceMode?: "legacy" | "v2";
  eventBus?: EventBus;
}

/**
 * DraftService encapsulates chapter drafting, persistence, and state sync.
 *
 * This is the largest service extracted from PipelineRunner.  It handles:
 * - preparing writer inputs (governed artifacts)
 * - calling the WriterAgent
 * - normalizing draft length
 * - persisting chapter files and truth files
 * - syncing structured state and narrative memory
 * - updating the chapter index and snapshots
 */
export class DraftService {
  private memoryIndexFallbackWarned = false;

  constructor(private readonly deps: DraftServiceDeps) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async writeChapter(
    bookId: string,
    context?: string,
    wordCount?: number,
  ): Promise<DraftResult> {
    const releaseLock = await this.deps.state.acquireBookLock(bookId);
    try {
      await this.deps.state.ensureControlDocuments(bookId);
      const book = await this.deps.state.loadBookConfig(bookId);
      const bookDir = this.deps.state.bookDir(bookId);
      const chapterNumber = await this.deps.state.getNextChapterNumber(bookId);
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
      const writeInput = await this.prepareWriteInput(
        book,
        bookDir,
        chapterNumber,
        context ?? this.deps.externalContext,
      );

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const lengthSpec = buildLengthSpec(
        wordCount ?? book.chapterWordCount,
        book.language ?? gp.language,
      );

      const writer = (await this.deps.resolveAgent("writer", bookId)) as WriterAgent;
      this.logStage(stageLanguage, { zh: "撰写章节草稿", en: "writing chapter draft" });
      const output = await writer.writeChapter({
        book,
        bookDir,
        chapterNumber,
        ...writeInput,
        lengthSpec,
        ...(wordCount ? { wordCountOverride: wordCount } : {}),
      });
      const writerCount = countChapterLength(output.content, lengthSpec.countingMode);
      let totalUsage: TokenUsageSummary = output.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      const normalizedDraft = await this.normalizeDraftLengthIfNeeded({
        bookId,
        chapterNumber,
        chapterContent: output.content,
        lengthSpec,
        chapterIntent: writeInput.chapterIntent,
      });
      totalUsage = DraftService.addUsage(totalUsage, normalizedDraft.tokenUsage);
      const draftOutput: WriteChapterOutput = {
        ...output,
        content: normalizedDraft.content,
        wordCount: normalizedDraft.wordCount,
        tokenUsage: totalUsage,
      };
      const lengthWarnings = buildLengthWarnings(chapterNumber, draftOutput.wordCount, lengthSpec);
      const lengthTelemetry = buildLengthTelemetry({
        lengthSpec,
        writerCount,
        postWriterNormalizeCount: normalizedDraft.wordCount,
        postReviseCount: 0,
        finalCount: draftOutput.wordCount,
        normalizeApplied: normalizedDraft.applied,
        lengthWarning: lengthWarnings.length > 0,
      });
      logLengthWarnings(this.deps.logger, lengthWarnings);

      // Save chapter file
      const chaptersDir = join(bookDir, "chapters");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const sanitized = draftOutput.title
        .replace(/[/\\?%*:|"<>]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(chaptersDir, filename);

      const resolvedLang = book.language ?? gp.language;
      const heading =
        resolvedLang === "en"
          ? `# Chapter ${chapterNumber}: ${draftOutput.title}`
          : `# 第${chapterNumber}章 ${draftOutput.title}`;
      await writeFile(filePath, `${heading}\n\n${draftOutput.content}`, "utf-8");

      // Save truth files
      this.logStage(stageLanguage, {
        zh: "落盘草稿与真相文件",
        en: "persisting draft and truth files",
      });
      await writer.saveChapter(bookDir, draftOutput, gp.numericalSystem, resolvedLang);
      await writer.saveNewTruthFiles(bookDir, draftOutput, resolvedLang);
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, draftOutput);
      await this.syncNarrativeMemoryIndex(bookId);

      // Update index
      const existingIndex = await this.deps.state.loadChapterIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: ChapterMeta = {
        number: chapterNumber,
        title: draftOutput.title,
        status: "drafted",
        wordCount: draftOutput.wordCount,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings,
        lengthTelemetry,
        ...(draftOutput.tokenUsage ? { tokenUsage: draftOutput.tokenUsage } : {}),
      };
      const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
      const updatedIndex =
        existingIdx >= 0
          ? existingIndex.map((e, i) => (i === existingIdx ? newEntry : e))
          : [...existingIndex, newEntry];
      await this.deps.state.saveChapterIndex(bookId, updatedIndex);
      await this.markBookActiveIfNeeded(bookId);

      // Snapshot
      this.logStage(stageLanguage, {
        zh: "更新章节索引与快照",
        en: "updating chapter index and snapshots",
      });
      await this.deps.state.snapshotState(bookId, chapterNumber);
      await this.syncCurrentStateFactHistory(bookId, chapterNumber);

      await this.emitEvent(INKOS_EVENTS.CHAPTER_DRAFTED, {
        bookId,
        chapterNumber,
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
        status: "drafted",
      });

      return {
        chapterNumber,
        title: draftOutput.title,
        wordCount: draftOutput.wordCount,
        filePath,
        lengthWarnings,
        lengthTelemetry,
        tokenUsage: draftOutput.tokenUsage,
      };
    } finally {
      await releaseLock();
    }
  }

  async planChapter(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<{ plan: PlanChapterOutput; composed: ComposeChapterOutput }> {
    return this.createGovernedArtifacts(book, bookDir, chapterNumber, externalContext, {
      reuseExistingIntentWhenContextMissing: false,
    });
  }

  async composeChapter(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<{ plan: PlanChapterOutput; composed: ComposeChapterOutput }> {
    return this.createGovernedArtifacts(book, bookDir, chapterNumber, externalContext, {
      reuseExistingIntentWhenContextMissing: true,
    });
  }

  // -------------------------------------------------------------------------
  // State sync (used by Runner._writeNextChapterLocked and others)
  // -------------------------------------------------------------------------

  async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    chapterNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteChapterOutput["runtimeStateDelta"];
      readonly runtimeStateSnapshot?: WriteChapterOutput["runtimeStateSnapshot"];
    },
  ): Promise<void> {
    if (output?.runtimeStateDelta || output?.runtimeStateSnapshot) {
      return;
    }
    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackChapter: chapterNumber,
    });
  }

  async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    const bookDir = this.deps.state.bookDir(bookId);
    try {
      await this.rebuildNarrativeMemoryIndex(bookDir);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildNarrativeMemoryIndex(bookDir);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          console.log("[DEBUG syncNarrativeMemoryIndex] entering fallback, warned=", this.memoryIndexFallbackWarned);
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `叙事记忆同步已跳过：${String(error)}`,
        en: `Narrative memory sync skipped: ${String(error)}`,
      });
    }
  }

  async syncCurrentStateFactHistory(bookId: string, uptoChapter: number): Promise<void> {
    const bookDir = this.deps.state.bookDir(bookId);
    try {
      await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildCurrentStateFactHistory(bookDir, uptoChapter);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `状态事实同步已跳过：${String(error)}`,
        en: `State fact sync skipped: ${String(error)}`,
      });
    }
  }

  async normalizeDraftLengthIfNeeded(params: {
    bookId: string;
    chapterNumber: number;
    chapterContent: string;
    lengthSpec: LengthSpec;
    chapterIntent?: string;
  }): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: TokenUsageSummary;
  }> {
    const writerCount = countChapterLength(params.chapterContent, params.lengthSpec.countingMode);
    if (!isOutsideHardRange(writerCount, params.lengthSpec)) {
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    const normalizer = (await this.deps.resolveAgent(
      "length-normalizer",
      params.bookId,
    )) as LengthNormalizerAgent;
    const normalized = await normalizer.normalizeChapter({
      chapterContent: params.chapterContent,
      lengthSpec: params.lengthSpec,
      chapterIntent: params.chapterIntent,
    });

    if (normalized.finalCount < writerCount * 0.25) {
      this.logWarn(languageFromLengthSpec(params.lengthSpec), {
        zh: `字数归一化被拒绝：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}（砍了${Math.round((1 - normalized.finalCount / writerCount) * 100)}%，超过安全阈值）`,
        en: `Length normalization rejected for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount} (cut ${Math.round((1 - normalized.finalCount / writerCount) * 100)}%, exceeds safety threshold)`,
      });
      return {
        content: params.chapterContent,
        wordCount: writerCount,
        applied: false,
      };
    }

    this.logInfo(languageFromLengthSpec(params.lengthSpec), {
      zh: `审计前字数归一化：第${params.chapterNumber}章 ${writerCount} -> ${normalized.finalCount}`,
      en: `Length normalization before audit for chapter ${params.chapterNumber}: ${writerCount} -> ${normalized.finalCount}`,
    });

    return {
      content: normalized.normalizedContent,
      wordCount: normalized.finalCount,
      applied: normalized.applied,
      tokenUsage: normalized.tokenUsage,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<
    Pick<
      WriteChapterInput,
      | "externalContext"
      | "chapterIntent"
      | "chapterMemo"
      | "chapterIntentData"
      | "contextPackage"
      | "ruleStack"
    >
  > {
    if ((this.deps.inputGovernanceMode ?? "v2") === "legacy") {
      return { externalContext };
    }

    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      externalContext,
      chapterIntent: plan.intentMarkdown,
      chapterMemo: plan.memo,
      chapterIntentData: plan.intent,
      contextPackage: composed.contextPackage,
      ruleStack: composed.ruleStack,
    };
  }

  async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{ plan: PlanChapterOutput; composed: ComposeChapterOutput }> {
    const plan = await this.resolveGovernedPlan(
      book,
      bookDir,
      chapterNumber,
      externalContext,
      options,
    );
    const composed = await composeGovernedChapter({
      book,
      bookDir,
      chapterNumber,
      plan,
    });

    return { plan, composed };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<PlanChapterOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, chapterNumber);
      if (persisted) return persisted;
    }

    const { PlannerAgent } = await import("../agents/planner.js");
    const planner = (await this.deps.resolveAgent("planner", book.id)) as import("../agents/planner.js").PlannerAgent;
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
    await savePersistedPlan(bookDir, plan);

    return plan;
  }

  private async rebuildNarrativeMemoryIndex(bookDir: string): Promise<void> {
    const { loadNarrativeMemorySeed } = await import("../state/runtime-state-store.js");
    const memorySeed = await loadNarrativeMemorySeed(bookDir);

    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        db.replaceSummaries(memorySeed.summaries);
        db.replaceHooks(memorySeed.hooks);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private async rebuildCurrentStateFactHistory(
    bookDir: string,
    uptoChapter: number,
  ): Promise<void> {
    const { loadSnapshotCurrentStateFacts } = await import("../state/runtime-state-store.js");
    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        db.resetFacts();

        const activeFacts = new Map<string, { id: number; object: string }>();

        for (let chapter = 0; chapter <= uptoChapter; chapter++) {
          const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
          if (snapshotFacts.length === 0) continue;
          const nextFacts = new Map<string, Omit<Fact, "id">>();

          for (const fact of snapshotFacts) {
            nextFacts.set(this.factKey(fact), {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              validFromChapter: chapter,
              validUntilChapter: null,
              sourceChapter: chapter,
            });
          }

          for (const [key, previous] of activeFacts.entries()) {
            const next = nextFacts.get(key);
            if (!next || next.object !== previous.object) {
              db.invalidateFact(previous.id, chapter);
              activeFacts.delete(key);
            }
          }

          for (const [key, fact] of nextFacts.entries()) {
            if (activeFacts.has(key)) continue;
            const id = db.addFact(fact);
            activeFacts.set(key, { id, object: fact.object });
          }
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private factKey(fact: { subject: string; predicate: string }): string {
    return `${fact.subject}::${fact.predicate}`;
  }

  private async withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error && error.message.includes("database is locked")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return await operation();
      }
      throw error;
    }
  }

  private isMemoryIndexUnavailableError(error: unknown): boolean {
    if (!error) return false;

    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.trim();

    return (
      /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage) ||
      /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage) ||
      (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage))
    );
  }

  private canOpenMemoryIndex(bookDir: string): boolean {
    let memoryDb: MemoryDB | null = null;
    try {
      memoryDb = new MemoryDB(bookDir);
      return true;
    } catch {
      return false;
    } finally {
      memoryDb?.close();
    }
  }

  private async logMemoryIndexDebugInfo(bookId: string, error: unknown): Promise<void> {
    if (process.env.INKOS_DEBUG_SQLITE_MEMORY !== "1") {
      return;
    }

    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    const message = error instanceof Error ? error.message : String(error);

    this.logWarn(await this.resolveBookLanguageById(bookId), {
      zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
      en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    });
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.deps.projectRoot, genre);
    return { profile: parsed.profile };
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLang> {
    if (book.language) return book.language;
    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLang> {
    try {
      const book = await this.deps.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      return "zh";
    }
  }

  private logStage(language: LengthLang, message: { zh: string; en: string }): void {
    this.deps.logger?.info(
      `${localize(language, { zh: "阶段：", en: "Stage: " })}${localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLang, message: { zh: string; en: string }): void {
    this.deps.logger?.info(localize(language, message));
  }

  private logWarn(language: LengthLang, message: { zh: string; en: string }): void {
    this.deps.logger?.warn(localize(language, message));
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.deps.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;
    await this.deps.state.saveBookConfig(bookId, { ...book, status: "active" });
  }

  private async emitEvent<T>(eventType: string, payload: T): Promise<void> {
    await this.deps.eventBus?.emit(eventType, payload);
  }

  static addUsage(
    a: TokenUsageSummary,
    b?: TokenUsageSummary,
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }
}
