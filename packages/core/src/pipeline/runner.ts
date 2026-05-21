import type { LLMClient } from "../llm/provider.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { ArchitectOutput } from "../agents/architect.js";
import { ArchitectAgent } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { composeGovernedChapter, ComposerAgent, type ComposeChapterOutput } from "../agents/composer.js";
import { WriterAgent, type WriteChapterInput, type WriteChapterOutput } from "../agents/writer.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { RadarAgent } from "../agents/radar.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { StateManager } from "../state/manager.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext, BaseAgent } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import { ExtensionRegistry, getBuiltInRegistry } from "../extension/registry.js";
import { FoundationService } from "../services/foundation.js";
import { AuditService } from "../services/audit.js";
import { DraftService } from "../services/draft.js";
import { RevisionService } from "../services/revision.js";
import { ImportService } from "../services/import.js";

import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import {
  buildLengthSpec,
  countChapterLength,
  formatLengthCount,
  resolveLengthCountingMode,
  type LengthLanguage,
} from "../utils/length-metrics.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import { buildWritingMethodologySection } from "../utils/writing-methodology.js";
import { readStoryFrame } from "../utils/outline-paths.js";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseStateDegradedReviewNote,
  resolveStateDegradedBaseStatus,
  retrySettlementAfterValidationFailure,
} from "./chapter-state-recovery.js";
import { persistChapterArtifacts } from "./chapter-persistence.js";
import { validateChapterTruthPersistence } from "./chapter-truth-validation.js";
import {
  loadPersistedPlan,
  relativeToBookDir,
  savePersistedPlan,
} from "./persisted-governed-plan.js";

import {
  buildImportFoundationSource,
  buildLengthWarnings,
  buildLengthTelemetry,
  logLengthWarnings,
  type PipelineConfig,
  type TokenUsageSummary,
  type ChapterPipelineResult,
  type DraftResult,
  type PlanChapterResult,
  type ComposeChapterResult,
  type ReviseResult,
  type TruthFiles,
  type BookStatusInfo,
  type ImportChaptersInput,
  type ImportChaptersResult,
  type InitBookOptions,
} from "./runner-helpers.js";

export * from "./runner-helpers.js";


export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private readonly registry: ExtensionRegistry;

  /** Service layer — extracted business logic decoupled from orchestration. */
  readonly foundation: FoundationService;
  readonly audit: AuditService;
  readonly draft: DraftService;
  readonly revision: RevisionService;
  readonly import: ImportService;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
    this.registry = config.registry ?? getBuiltInRegistry();
    this.foundation = new FoundationService({
      state: this.state,
      projectRoot: config.projectRoot,
      resolveAgent: (name, bookId) => this.resolveAgent(name, bookId),
      logger: config.logger,
    });
    this.audit = new AuditService({
      resolveAgent: (name, bookId) => this.resolveAgent(name, bookId),
    });
    this.draft = new DraftService({
      state: this.state,
      projectRoot: config.projectRoot,
      resolveAgent: (name, bookId) => this.resolveAgent(name, bookId),
      logger: config.logger,
      externalContext: config.externalContext,
      inputGovernanceMode: config.inputGovernanceMode,
      eventBus: config.eventBus,
    });
    this.revision = new RevisionService({
      state: this.state,
      resolveAgent: (name, bookId) => this.resolveAgent(name, bookId),
      audit: this.audit,
      draft: this.draft,
      logger: config.logger,
      eventBus: config.eventBus,
      inputGovernanceMode: config.inputGovernanceMode,
      externalContext: config.externalContext,
      localize: (lang, msgs) => this.localize(lang, msgs),
      logStage: (lang, msg) => this.logStage(lang, msg),
      logWarn: (lang, msg) => this.logWarn(lang, msg),
      readChapterContent: (bookDir, chapterNumber) => this.readChapterContent(bookDir, chapterNumber),
      resolveBookLanguage: (book) => this.resolveBookLanguage(book),
      resolveBookLanguageById: (bookId) => this.resolveBookLanguageById(bookId),
      loadGenreProfile: (genre) => this.loadGenreProfile(genre),
      persistAuditDriftGuidance: (params) => this.persistAuditDriftGuidance(params),
      emitWebhook: (event, bookId, chapterNumber, data) => this.emitWebhook(event, bookId, chapterNumber, data),
      emitEvent: (eventType, payload) => this.emitEvent(eventType, payload),
    });
    this.import = new ImportService({
      state: this.state,
      projectRoot: config.projectRoot,
      resolveAgent: (name, bookId) => this.resolveAgent(name, bookId),
      logger: config.logger,
      client: config.client,
      model: config.model,
      telemetry: config.telemetry,
      foundationReviewRetries: config.foundationReviewRetries,
      localize: (lang, msgs) => this.localize(lang, msgs),
      logStage: (lang, msg) => this.logStage(lang, msg),
      logWarn: (lang, msg) => this.logWarn(lang, msg),
      resolveBookLanguage: (book) => this.resolveBookLanguage(book),
      resolveBookLanguageById: (bookId) => this.resolveBookLanguageById(bookId),
      loadGenreProfile: (genre) => this.loadGenreProfile(genre),
      generateAndReviewFoundation: (params) => this.generateAndReviewFoundation(params),
      draft: this.draft,
      importFanficCanon: (bookId, sourceText, sourceName, fanficMode) => this.importFanficCanon(bookId, sourceText, sourceName, fanficMode),
    });
  }

  private withSpan<T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string | number | boolean>): Promise<T> {
    const tracer = this.config.telemetry;
    if (!tracer) return fn();
    tracer.startSpan({ name, attributes: attrs });
    return fn().finally(() => tracer.endSpan());
  }

  private async emitEvent<T>(eventType: string, payload: T): Promise<void> {
    await this.config.eventBus?.emit(eventType, payload);
  }

  /**
   * Resolve an agent from the extension registry.
   * Falls back to built-in instantiation if the agent is not registered.
   */
  private async resolveAgent<T extends BaseAgent>(
    name: string,
    bookId: string | undefined,
  ): Promise<T> {
    const factory = this.registry.resolveAgent(name);
    if (factory) {
      return factory.create(this.agentCtxFor(name, bookId)) as Promise<T>;
    }
    // Fallback: direct import for agents not yet registered in the built-in registry.
    // This branch will be removed once all agents are registered.
    switch (name) {
      case "writer":
        return new WriterAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "auditor":
        return new ContinuityAuditor(this.agentCtxFor(name, bookId)) as unknown as T;
      case "reviser":
        return new ReviserAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "architect":
        return new ArchitectAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "planner":
        return new PlannerAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "composer":
        return new ComposerAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "foundation-reviewer":
        return new FoundationReviewerAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "state-validator":
        return new StateValidatorAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "radar":
        return new RadarAgent(this.agentCtxFor(name, bookId), this.config.radarSources) as unknown as T;
      case "chapter-analyzer":
        return new ChapterAnalyzerAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      case "length-normalizer":
        return new LengthNormalizerAgent(this.agentCtxFor(name, bookId)) as unknown as T;
      default:
        throw new Error(`Unknown agent "${name}" and no registry factory found`);
    }
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      // failure expected, safe to ignore
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    try {
      const book = await this.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      // failure expected, safe to ignore
      return "zh";
    }
  }


  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }


  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }


  private async generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly maxRetries?: number;
  }): Promise<ArchitectOutput> {
    const maxRetries = params.maxRetries ?? this.config.foundationReviewRetries ?? 2;
    let foundation = await params.generate();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.logStage(params.stageLanguage, {
        zh: `审核基础设定（第${attempt + 1}轮）`,
        en: `reviewing foundation (round ${attempt + 1})`,
      });

      const review = await params.reviewer.review({
        foundation,
        mode: params.mode,
        sourceCanon: params.sourceCanon,
        styleGuide: params.styleGuide,
        language: params.language,
      });

      this.config.logger?.info(
        `Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`,
      );
      for (const dim of review.dimensions) {
        this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logWarn(params.stageLanguage, {
        zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
        en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
      });

      foundation = await params.generate(
        this.buildFoundationReviewFeedback(review, params.language),
      );
    }

    // Final review
    const finalReview = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      styleGuide: params.styleGuide,
      language: params.language,
    });
    this.config.logger?.info(
      `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
    );

    return foundation;
  }

  private buildFoundationReviewFeedback(
    review: {
      readonly dimensions: ReadonlyArray<{
        readonly name: string;
        readonly score: number;
        readonly feedback: string;
      }>;
      readonly overallFeedback: string;
    },
    language: "zh" | "en",
  ): string {
    const dimensionLines = review.dimensions
      .map((dimension) =>
        language === "en"
          ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
          : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`,
      )
      .join("\n");

    return language === "en"
      ? [
          "## Overall Feedback",
          review.overallFeedback,
          "",
          "## Dimension Notes",
          dimensionLines || "- none",
        ].join("\n")
      : ["## 总评", review.overallFeedback, "", "## 分项问题", dimensionLines || "- 无"].join("\n");
  }


  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const apiKeySource = override.apiKeyEnv
      ? `env:${override.apiKeyEnv}`
      : `base:${base?.apiKey ?? ""}`;
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      override.baseUrl,
      apiKeySource,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const apiKey = override.apiKeyEnv
        ? (process.env[override.apiKeyEnv] ?? "")
        : (base?.apiKey ?? "");
      client = createLLMClient({
        provider,
        service: base?.service ?? "custom",
        configSource: base?.configSource ?? "env",
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
      contextWindow: this.config.contextWindow,
    };
  }

  public createAgentContext(agent: string, bookId?: string): AgentContext {
    return this.agentCtxFor(agent, bookId);
  }


  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    return this.withSpan("runRadar", async () => {
      const radar = await this.resolveAgent<RadarAgent>("radar", undefined);
      return await radar.scan();
    });
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    return this.foundation.initBook(book, {
      ...options,
      externalContext: options.externalContext ?? this.config.externalContext,
    });
  }

  /**
   * Revise an existing book foundation without touching runtime chapter state.
   *
   * Legacy books read the flat foundation files as source. Phase 5+ books read
   * the authoritative outline/ and roles/ files instead of the compatibility
   * shims, otherwise large role/story details can be lost during rewrite.
   */
  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    return this.foundation.reviseFoundation(bookId, feedback);
  }



  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(bookId: string, sourceText: string, sourceName: string, fanficMode: FanficMode): Promise<string> {
    return this.import.importFanficCanon(bookId, sourceText, sourceName, fanficMode);
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(book: BookConfig, sourceText: string, sourceName: string, fanficMode: FanficMode): Promise<void> {
    return this.import.initFanficBook(book, sourceText, sourceName, fanficMode);
  }

  /** Write a single draft chapter. Saves chapter file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, wordCount?: number): Promise<DraftResult> {
    return this.draft.writeChapter(bookId, context, wordCount);
  }

  async planChapter(bookId: string, context?: string): Promise<PlanChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const { plan } = await this.draft.planChapter(book, bookDir, chapterNumber, context ?? this.config.externalContext);
    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
    };
  }

  async composeChapter(bookId: string, context?: string): Promise<ComposeChapterResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const { plan, composed } = await this.draft.composeChapter(book, bookDir, chapterNumber, context ?? this.config.externalContext);
    return {
      bookId,
      chapterNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
      contextPath: relativeToBookDir(bookDir, composed.contextPath),
      ruleStackPath: relativeToBookDir(bookDir, composed.ruleStackPath),
      tracePath: relativeToBookDir(bookDir, composed.tracePath),
    };
  }

  /** Audit the latest (or specified) chapter. Read-only, no lock needed. */
  async auditDraft(
    bookId: string,
    chapterNumber?: number,
  ): Promise<AuditResult & { readonly chapterNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }

    const content = await this.readChapterContent(bookDir, targetChapter);
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const language = book.language ?? gp.language;
    this.logStage(language, {
      zh: `审计第${targetChapter}章`,
      en: `auditing chapter ${targetChapter}`,
    });
    const evaluation = await this.audit.evaluateMergedAudit({
      book,
      bookDir,
      chapterContent: content,
      chapterNumber: targetChapter,
    });
    const result = evaluation.auditResult;

    // Update index with audit result
    const index = await this.state.loadChapterIndex(bookId);
    const updated = index.map((ch) =>
      ch.number === targetChapter
        ? {
            ...ch,
            status: (result.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
            updatedAt: new Date().toISOString(),
            auditIssues: result.issues.map((i) => `[${i.severity}] ${i.description}`),
          }
        : ch,
    );
    await this.state.saveChapterIndex(bookId, updated);
    const latestChapter =
      index.length > 0 ? Math.max(...index.map((chapter) => chapter.number)) : targetChapter;
    if (targetChapter === latestChapter) {
      await this.persistAuditDriftGuidance({
        bookDir,
        chapterNumber: targetChapter,
        issues: result.issues.filter(
          (issue) => issue.severity === "critical" || issue.severity === "warning",
        ),
        language,
      }).catch(() => undefined);
    }

    await this.emitWebhook(result.passed ? "audit-passed" : "audit-failed", bookId, targetChapter, {
      summary: result.summary,
      issueCount: result.issues.length,
    });

    await this.emitEvent(result.passed ? "chapter:audited" : "audit:failed", {
      bookId,
      chapterNumber: targetChapter,
      passed: result.passed,
      overallScore: result.overallScore,
      issueCount: result.issues.length,
    });

    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE): Promise<ReviseResult> {
    return this.revision.reviseDraft(bookId, chapterNumber, mode);
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        // failure expected, safe to ignore
        return "(文件不存在)";
      }
    };

    // Phase 5: prefer the new prose outline files; fall back to legacy paths.
    const readOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(storyDir, newRel));
      if (preferred.trim() && preferred !== "(文件不存在)") return preferred;
      return readSafe(join(storyDir, legacyRel));
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readOutline("outline/story_frame.md", "story_bible.md"),
        readOutline("outline/volume_map.md", "volume_outline.md"),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
  ): Promise<ChapterPipelineResult> {
    this.config.telemetry?.startSpan({ name: "writeNextChapter", attributes: { bookId } });
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._writeNextChapterLocked(
        bookId,
        wordCount,
        temperatureOverride,
        this.config.externalContext,
      );
    } catch (e) {
      this.config.telemetry?.recordError(String(e));
      await this.emitEvent("pipeline:error", {
        bookId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      await releaseLock();
      this.config.telemetry?.endSpan();
    }
  }

  async repairChapterState(bookId: string, chapterNumber?: number): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._repairChapterStateLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  async resyncChapterArtifacts(
    bookId: string,
    chapterNumber?: number,
  ): Promise<ChapterPipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      return await this._resyncChapterArtifactsLocked(bookId, chapterNumber);
    } finally {
      await releaseLock();
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<ChapterPipelineResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertNoPendingStateRepair(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "准备章节输入", en: "preparing chapter inputs" });
    const writeInput = await this.prepareWriteInput(book, bookDir, chapterNumber, externalContext);
    const reducedControlInput =
      writeInput.chapterIntent && writeInput.contextPackage && writeInput.ruleStack
        ? {
            chapterIntent: writeInput.chapterIntent,
            chapterMemo: writeInput.chapterMemo,
            chapterIntentData: writeInput.chapterIntentData,
            contextPackage: writeInput.contextPackage,
            ruleStack: writeInput.ruleStack,
          }
        : undefined;
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const lengthSpec = buildLengthSpec(wordCount ?? book.chapterWordCount, pipelineLang);
    const { normalizePostWriteSurface, validatePostWrite: postWriteValidate } =
      await import("../agents/post-write-validator.js");
    const { validateHookLedger } = await import("../utils/hook-ledger-validator.js");
    const { readBookRules } = await import("../agents/rules-reader.js");
    const parsedBookRules = (await readBookRules(bookDir))?.rules ?? null;

    // -----------------------------------------------------------------------
    // Core LLM stages delegated to the workflow engine.
    // -----------------------------------------------------------------------
    const { createWorkflowContext, runDraftAndReviewWorkflow } = await import("../workflow/index.js");
    const wfCtx = await createWorkflowContext({
      runner: this,
      state: this.state,
      config: this.config,
      logger: this.config.logger,
      bookId,
    });

    const { draft, review: reviewResult } = await runDraftAndReviewWorkflow(wfCtx, {
      chapterNumber,
      writeInput,
      lengthSpec,
      wordCount,
      temperatureOverride,
      reviewDeps: {
        reducedControlInput,
        normalizeDraftLengthIfNeeded: (chapterContent) =>
          this.normalizeDraftLengthIfNeeded({
            bookId,
            chapterNumber,
            chapterContent,
            lengthSpec,
            chapterIntent: writeInput.chapterIntent,
          }),
        normalizePostWriteSurface: (chapterContent) =>
          normalizePostWriteSurface(chapterContent, pipelineLang),
        assertChapterContentNotEmpty: (content, stage) =>
          this.assertChapterContentNotEmpty(content, chapterNumber, stage),
        addUsage: PipelineRunner.addUsage,
        analyzeAITells: (content) => analyzeAITells(content, pipelineLang),
        analyzeSensitiveWords: (content) => analyzeSensitiveWords(content, undefined, pipelineLang),
        runPostWriteChecks: (content) => {
          const baseIssues = postWriteValidate(content, gp, parsedBookRules, pipelineLang)
            .filter((v) => v.severity === "error")
            .map((v) => ({
              severity: "critical" as const,
              category: v.rule,
              description: v.description,
              suggestion: v.suggestion,
            }));
          const memoBody = writeInput.chapterMemo?.body ?? "";
          const ledgerIssues = memoBody ? validateHookLedger(memoBody, content) : [];
          return [...baseIssues, ...ledgerIssues];
        },
        maxReviewIterations: this.config.writingReviewRetries,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logStage: (message) => this.logStage(stageLanguage, message),
      },
    });

    const output = draft.output;
    const writerCount = draft.writerCount;
    let totalUsage = reviewResult.totalUsage;
    let finalContent = reviewResult.finalContent;
    let finalWordCount = reviewResult.finalWordCount;
    let revised = reviewResult.revised;
    let auditResult = reviewResult.auditResult;
    const postReviseCount = reviewResult.postReviseCount;
    const normalizeApplied = reviewResult.normalizeApplied;

    const writer = await this.resolveAgent<WriterAgent>("writer", bookId);

    // 3b. Lightweight per-chapter promotion pass — check if any hooks should
    // be promoted based on advanced_count derived from chapter_summaries.
    // Runs BEFORE persistence so the reviewer of the NEXT chapter sees the
    // updated ledger. No LLM calls — pure ledger parse + threshold check.
    {
      const { rerunPromotionPass } = await import("../utils/hook-promotion.js");
      const { parsePendingHooksMarkdown, renderHookSnapshot } =
        await import("../utils/story-markdown.js");
      const promotionStoryDir = join(bookDir, "story");
      const ledgerPath = join(promotionStoryDir, "pending_hooks.md");
      const ledgerRaw = await readFile(ledgerPath, "utf-8").catch(() => "");
      if (ledgerRaw.trim()) {
        const hooks = parsePendingHooksMarkdown(ledgerRaw);
        if (hooks.length > 0) {
          const summariesRaw = await readFile(
            join(promotionStoryDir, "chapter_summaries.md"),
            "utf-8",
          ).catch(() => "");
          const promotionResult = rerunPromotionPass(hooks, summariesRaw);
          if (promotionResult.updated) {
            const ledgerLang: "zh" | "en" = /[\u4e00-\u9fff]/.test(ledgerRaw) ? "zh" : "en";
            await writeFile(
              ledgerPath,
              renderHookSnapshot([...promotionResult.hooks], ledgerLang),
              "utf-8",
            );
            this.config.logger?.info(
              `[promotion] ${promotionResult.flippedCount} hook(s) promoted after chapter ${chapterNumber}`,
            );
          }
        }
      }
    }

    // 4. Save the final chapter and truth files from a single persistence source
    this.logStage(stageLanguage, { zh: "落盘最终章节", en: "persisting final chapter" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const chapterIndexBeforePersist = await this.state.loadChapterIndex(bookId);
    const { resolveDuplicateTitle } = await import("../agents/post-write-validator.js");
    const initialTitleResolution = resolveDuplicateTitle(
      output.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    let persistenceOutput = await this.buildPersistenceOutput(
      bookId,
      book,
      bookDir,
      chapterNumber,
      initialTitleResolution.title === output.title
        ? output
        : { ...output, title: initialTitleResolution.title },
      finalContent,
      lengthSpec.countingMode,
      reducedControlInput,
    );
    const finalTitleResolution = resolveDuplicateTitle(
      persistenceOutput.title,
      chapterIndexBeforePersist.map((chapter) => chapter.title),
      pipelineLang,
      { content: finalContent },
    );
    if (finalTitleResolution.title !== persistenceOutput.title) {
      persistenceOutput = {
        ...persistenceOutput,
        title: finalTitleResolution.title,
      };
    }
    if (persistenceOutput.title !== output.title) {
      const description =
        pipelineLang === "en"
          ? `Chapter title "${output.title}" was auto-adjusted to "${persistenceOutput.title}".`
          : `章节标题"${output.title}"已自动调整为"${persistenceOutput.title}"。`;
      this.config.logger?.warn(`[title] ${description}`);
      auditResult = {
        ...auditResult,
        issues: [
          ...auditResult.issues,
          {
            severity: "warning",
            category: "title-dedup",
            description,
            suggestion:
              pipelineLang === "en"
                ? "If the auto-renamed title is weak, revise the chapter title manually."
                : "如果自动改名不理想，可以在后续手动修订章节标题。",
          },
        ],
      };
    }
    const longSpanFatigue = await analyzeLongSpanFatigue({
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterSummary: persistenceOutput.chapterSummary,
      language: pipelineLang,
    });
    auditResult = {
      ...auditResult,
      issues: [
        ...auditResult.issues,
        ...longSpanFatigue.issues,
        ...(persistenceOutput.hookHealthIssues ?? []),
      ],
    };
    finalWordCount = persistenceOutput.wordCount;
    const lengthWarnings = this.buildLengthWarnings(chapterNumber, finalWordCount, lengthSpec);
    const lengthTelemetry = this.buildLengthTelemetry({
      lengthSpec,
      writerCount,
      postWriterNormalizeCount: reviewResult.preAuditNormalizedWordCount,
      postReviseCount,
      finalCount: finalWordCount,
      normalizeApplied,
      lengthWarning: lengthWarnings.length > 0,
    });
    this.logLengthWarnings(lengthWarnings);

    // 4.1 Validate settler output before writing
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const [
      oldState,
      oldHooks,
      oldLedger,
      authorityStoryFrame,
      authorityBookRules,
      authorityChapterSummaries,
    ] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
      readStoryFrame(bookDir).catch(() => ""),
      readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "chapter_summaries.md"), "utf-8").catch(() => ""),
    ]);
    const validator = await this.resolveAgent<StateValidatorAgent>("state-validator", bookId);
    const truthValidation = await validateChapterTruthPersistence({
      writer,
      validator,
      book,
      bookDir,
      chapterNumber,
      title: persistenceOutput.title,
      content: finalContent,
      persistenceOutput,
      auditResult,
      previousTruth: {
        oldState,
        oldHooks,
        oldLedger,
      },
      authorityContext: {
        storyFrame: authorityStoryFrame,
        bookRules: authorityBookRules,
        chapterSummaries: authorityChapterSummaries,
      },
      reducedControlInput,
      language: pipelineLang,
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logger: this.config.logger,
    });
    let chapterStatus: ChapterPipelineResult["status"] | null = truthValidation.chapterStatus;
    let degradedIssues: ReadonlyArray<AuditIssue> = truthValidation.degradedIssues;
    persistenceOutput = truthValidation.persistenceOutput;
    auditResult = truthValidation.auditResult;

    // 4.2 Final paragraph shape check on persisted content (post-normalize, post-revise)
    {
      const { detectParagraphLengthDrift, detectParagraphShapeWarnings } =
        await import("../agents/post-write-validator.js");
      const chapDir = join(bookDir, "chapters");
      const recentFiles = (await readdir(chapDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(-5);
      const recentContent = (
        await Promise.all(
          recentFiles.map((f) => readFile(join(chapDir, f), "utf-8").catch(() => "")),
        )
      ).join("\n\n");
      const paragraphIssues = [
        ...detectParagraphShapeWarnings(finalContent, pipelineLang),
        ...detectParagraphLengthDrift(finalContent, recentContent, pipelineLang),
      ];
      if (paragraphIssues.length > 0) {
        for (const issue of paragraphIssues) {
          this.config.logger?.warn(`[paragraph] ${issue.description}`);
        }
        auditResult = {
          ...auditResult,
          issues: [
            ...auditResult.issues,
            ...paragraphIssues.map((v) => ({
              severity: v.severity as "warning",
              category: "paragraph-shape",
              description: v.description,
              suggestion: v.suggestion,
            })),
          ],
        };
      }
    }

    const resolvedStatus =
      chapterStatus ?? (auditResult.passed ? "ready-for-review" : "audit-failed");
    await persistChapterArtifacts({
      chapterNumber,
      chapterTitle: persistenceOutput.title,
      status: resolvedStatus,
      auditResult,
      finalWordCount,
      lengthWarnings,
      lengthTelemetry,
      degradedIssues,
      tokenUsage: totalUsage,
      loadChapterIndex: () => this.state.loadChapterIndex(bookId),
      saveChapter: () =>
        writer.saveChapter(bookDir, persistenceOutput, gp.numericalSystem, pipelineLang),
      saveTruthFiles: async () => {
        await writer.saveNewTruthFiles(bookDir, persistenceOutput, pipelineLang);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, persistenceOutput);
        this.logStage(stageLanguage, { zh: "同步记忆索引", en: "syncing memory indexes" });
        await this.syncNarrativeMemoryIndex(bookId);
      },
      saveChapterIndex: (index) => this.state.saveChapterIndex(bookId, index),
      markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
      persistAuditDriftGuidance: (issues) =>
        this.persistAuditDriftGuidance({
          bookDir,
          chapterNumber,
          issues,
          language: stageLanguage,
        }).catch(() => undefined),
      snapshotState: () => this.state.snapshotState(bookId, chapterNumber),
      syncCurrentStateFactHistory: () => this.syncCurrentStateFactHistory(bookId, chapterNumber),
      logSnapshotStage: () =>
        this.logStage(stageLanguage, {
          zh: "更新章节索引与快照",
          en: "updating chapter index and snapshots",
        }),
    });

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const statusEmoji =
        resolvedStatus === "state-degraded" ? "🧯" : auditResult.passed ? "✅" : "⚠️";
      const chapterLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${statusEmoji} ${book.title} 第${chapterNumber}章`,
        body: [
          `**${persistenceOutput.title}** | ${chapterLength}`,
          revised ? "📝 已自动修正" : "",
          resolvedStatus === "state-degraded"
            ? "状态结算: 已降级保存，需先修复 state 再继续"
            : `审稿: ${auditResult.passed ? "通过" : "需人工审核"}`,
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      passed: auditResult.passed,
      revised,
      status: resolvedStatus,
    });

    return {
      chapterNumber,
      title: persistenceOutput.title,
      wordCount: finalWordCount,
      auditResult,
      revised,
      status: resolvedStatus,
      lengthWarnings,
      lengthTelemetry,
      tokenUsage: totalUsage,
    };
  }

  private async _repairChapterStateLocked(
    bookId: string,
    chapterNumber?: number,
  ): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to repair.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }
    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetMeta.status !== "state-degraded") {
      throw new Error(`Chapter ${targetChapter} is not state-degraded.`);
    }
    if (targetChapter !== latestChapter) {
      throw new Error(
        `Only the latest state-degraded chapter can be repaired safely (latest is ${latestChapter}).`,
      );
    }

    this.logStage(stageLanguage, {
      zh: "修复章节状态结算",
      en: "repairing chapter state settlement",
    });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const writer = await this.resolveAgent<WriterAgent>("writer", bookId);
    let repairedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      allowReapply: true,
    });
    const validator = await this.resolveAgent<StateValidatorAgent>("state-validator", bookId);
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      repairedOutput.updatedState,
      oldHooks,
      repairedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description ??
            `State repair still failed for chapter ${targetChapter}.`,
        );
      }
      repairedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`State repair still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, repairedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, repairedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, repairedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const baseStatus = resolveStateDegradedBaseStatus(targetMeta);
    const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
    const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
    index[targetIndex] = {
      ...targetMeta,
      status: baseStatus,
      updatedAt: new Date().toISOString(),
      auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
      reviewNote: undefined,
    };
    await this.state.saveChapterIndex(bookId, index);

    const repairedPassesAudit = baseStatus !== "audit-failed";
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: repairedPassesAudit,
        issues: [],
        summary: repairedPassesAudit
          ? "state repaired"
          : "state repaired but chapter still needs review",
      },
      revised: false,
      status: baseStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  private async _resyncChapterArtifactsLocked(
    bookId: string,
    chapterNumber?: number,
  ): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadChapterIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted chapters to sync.`);
    }

    const targetChapter = chapterNumber ?? index[index.length - 1]!.number;
    const targetIndex = index.findIndex((chapter) => chapter.number === targetChapter);
    if (targetIndex < 0) {
      throw new Error(`Chapter ${targetChapter} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (targetChapter !== latestChapter) {
      throw new Error(
        `Only the latest persisted chapter can be synced safely (latest is ${latestChapter}).`,
      );
    }

    this.logStage(stageLanguage, {
      zh: "根据已编辑正文同步真相文件与索引",
      en: "syncing truth files and indexes from edited chapter body",
    });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readChapterContent(bookDir, targetChapter);
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    ]);

    const reducedControlInput =
      (this.config.inputGovernanceMode ?? "v2") === "legacy"
        ? undefined
        : await this.createGovernedArtifacts(
            book,
            bookDir,
            targetChapter,
            this.config.externalContext,
            { reuseExistingIntentWhenContextMissing: true },
          );

    const writer = await this.resolveAgent<WriterAgent>("writer", bookId);
    let syncedOutput = await writer.settleChapterState({
      book,
      bookDir,
      chapterNumber: targetChapter,
      title: targetMeta.title,
      content,
      chapterIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      ruleStack: reducedControlInput?.composed.ruleStack,
      allowReapply: true,
    });
    const validator = await this.resolveAgent<StateValidatorAgent>("state-validator", bookId);
    let validation = await validator.validate(
      content,
      targetChapter,
      oldState,
      syncedOutput.updatedState,
      oldHooks,
      syncedOutput.updatedHooks,
      pipelineLang,
    );

    if (!validation.passed) {
      const recovery = await retrySettlementAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        chapterNumber: targetChapter,
        title: targetMeta.title,
        content,
        reducedControlInput: reducedControlInput
          ? {
              chapterIntent: reducedControlInput.plan.intentMarkdown,
              contextPackage: reducedControlInput.composed.contextPackage,
              ruleStack: reducedControlInput.composed.ruleStack,
            }
          : undefined,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        throw new Error(
          recovery.issues[0]?.description ??
            `Chapter sync still failed for chapter ${targetChapter}.`,
        );
      }
      syncedOutput = recovery.output;
      validation = recovery.validation;
    }

    if (!validation.passed) {
      throw new Error(`Chapter sync still failed for chapter ${targetChapter}.`);
    }

    await writer.saveChapter(bookDir, syncedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, syncedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetChapter, syncedOutput);
    await this.syncNarrativeMemoryIndex(bookId);
    await this.state.snapshotState(bookId, targetChapter);
    await this.syncCurrentStateFactHistory(bookId, targetChapter);

    const finalStatus: "ready-for-review" | "audit-failed" =
      targetMeta.status === "state-degraded"
        ? resolveStateDegradedBaseStatus(targetMeta)
        : "ready-for-review";

    if (targetMeta.status === "state-degraded") {
      const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
      const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
      index[targetIndex] = {
        ...targetMeta,
        status: finalStatus,
        updatedAt: new Date().toISOString(),
        auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
        reviewNote: undefined,
      };
    } else {
      index[targetIndex] = {
        ...targetMeta,
        status: "ready-for-review",
        updatedAt: new Date().toISOString(),
      };
    }
    await this.state.saveChapterIndex(bookId, index);
    return {
      chapterNumber: targetChapter,
      title: targetMeta.title,
      wordCount: targetMeta.wordCount,
      auditResult: {
        passed: finalStatus !== "audit-failed",
        issues: [],
        summary:
          finalStatus === "audit-failed"
            ? "chapter truth/state resynced from edited body, but chapter still needs audit fixes"
            : "chapter truth/state resynced from edited body",
      },
      revised: false,
      status: finalStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    return this.import.generateStyleGuide(bookId, referenceText, sourceName);
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    return this.import.importCanon(targetBookId, parentBookId);
  }


  // ---------------------------------------------------------------------------
  // Chapter import (for continuation writing from existing chapters)
  // ---------------------------------------------------------------------------

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_frame, volume_map, book_rules) from all chapters.
   * Step 2: Sequentially replay each chapter through ChapterAnalyzer to build truth files.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    return this.import.importChapters(input);
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    output: WriteChapterOutput,
    finalContent: string,
    countingMode: Parameters<typeof countChapterLength>[1],
    reducedControlInput?: {
      chapterIntent: string;
      contextPackage: ContextPackage;
      ruleStack: RuleStack;
    },
  ): Promise<WriteChapterOutput> {
    if (finalContent === output.content) {
      return output;
    }

    const analyzer = await this.resolveAgent<ChapterAnalyzerAgent>("chapter-analyzer", bookId);
    const analyzed = await analyzer.analyzeChapter({
      book,
      bookDir,
      chapterNumber,
      chapterContent: finalContent,
      chapterTitle: output.title,
      chapterIntent: reducedControlInput?.chapterIntent,
      contextPackage: reducedControlInput?.contextPackage,
      ruleStack: reducedControlInput?.ruleStack,
    });

    return {
      ...analyzed,
      content: finalContent,
      wordCount: countChapterLength(finalContent, countingMode),
      postWriteErrors: [],
      postWriteWarnings: [],
      hookHealthIssues: output.hookHealthIssues,
      tokenUsage: output.tokenUsage,
    };
  }

  private async assertNoPendingStateRepair(bookId: string): Promise<void> {
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const latestChapter = [...existingIndex].sort((left, right) => right.number - left.number)[0];
    if (latestChapter?.status !== "state-degraded") {
      return;
    }

    throw new Error(
      `Latest chapter ${latestChapter.number} is state-degraded. Repair state or rewrite that chapter before continuing.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
  ): Promise<
    Pick<
      WriteChapterInput,
      | 'externalContext'
      | 'chapterIntent'
      | 'chapterMemo'
      | 'chapterIntentData'
      | 'contextPackage'
      | 'ruleStack'
    >
  > {
    return this.draft.prepareWriteInput(book, bookDir, chapterNumber, externalContext);
  }







  private async normalizeDraftLengthIfNeeded(params: {
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
    return this.draft.normalizeDraftLengthIfNeeded(params);
  }

  private assertChapterContentNotEmpty(
    content: string,
    chapterNumber: number,
    stage: string,
  ): void {
    if (content.trim().length > 0) return;
    throw new Error(`Chapter ${chapterNumber} has empty chapter content after ${stage}`);
  }

  private async syncCurrentStateFactHistory(bookId: string, uptoChapter: number): Promise<void> {
    return this.draft.syncCurrentStateFactHistory(bookId, uptoChapter);
  }

  private async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    chapterNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteChapterOutput['runtimeStateDelta'];
      readonly runtimeStateSnapshot?: WriteChapterOutput['runtimeStateSnapshot'];
    },
  ): Promise<void> {
    return this.draft.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, output);
  }

  private async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    return this.draft.syncNarrativeMemoryIndex(bookId);
  }








  private buildLengthWarnings(
    chapterNumber: number,
    finalCount: number,
    lengthSpec: LengthSpec,
  ): string[] {
    return buildLengthWarnings(chapterNumber, finalCount, lengthSpec);
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postWriterNormalizeCount: number;
    postReviseCount: number;
    finalCount: number;
    normalizeApplied: boolean;
    lengthWarning: boolean;
  }): LengthTelemetry {
    return buildLengthTelemetry(params);
  }

  private async persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void> {
    const storyDir = join(params.bookDir, "story");
    const driftPath = join(storyDir, "audit_drift.md");
    const statePath = join(storyDir, "current_state.md");
    const currentState = await readFile(statePath, "utf-8").catch(() => "");
    const sanitizedState = this.stripAuditDriftCorrectionBlock(currentState).trimEnd();

    if (sanitizedState !== currentState) {
      await writeFile(statePath, sanitizedState, "utf-8");
    }

    if (params.issues.length === 0) {
      await rm(driftPath, { force: true }).catch(() => undefined);
      return;
    }

    const block = [
      this.localize(params.language, {
        zh: "# 审计纠偏",
        en: "# Audit Drift",
      }),
      "",
      this.localize(params.language, {
        zh: "## 审计纠偏（自动生成，下一章写作前参照）",
        en: "## Audit Drift Correction",
      }),
      "",
      this.localize(params.language, {
        zh: `> 第${params.chapterNumber}章审计发现以下问题，下一章写作时必须避免：`,
        en: `> Chapter ${params.chapterNumber} audit found the following issues to avoid in the next chapter:`,
      }),
      ...params.issues.map(
        (issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`,
      ),
      "",
    ].join("\n");

    await writeFile(driftPath, block, "utf-8");
  }

  private stripAuditDriftCorrectionBlock(currentState: string): string {
    const headers = [
      "## 审计纠偏（自动生成，下一章写作前参照）",
      "## Audit Drift Correction",
      "# 审计纠偏",
      "# Audit Drift",
    ];

    let cutIndex = -1;
    for (const header of headers) {
      const index = currentState.indexOf(header);
      if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
        cutIndex = index;
      }
    }

    if (cutIndex < 0) {
      return currentState;
    }

    return currentState.slice(0, cutIndex).trimEnd();
  }

  private logLengthWarnings(lengthWarnings: ReadonlyArray<string>): void {
    logLengthWarnings(this.config.logger, lengthWarnings);
  }






  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    chapterNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
  ): Promise<{
    plan: PlanChapterOutput;
    composed: ComposeChapterOutput;
  }> {
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

    const planner = await this.resolveAgent<PlannerAgent>("planner", book.id);
    const plan = await planner.planChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext,
    });
    // Persist in the new memo format so subsequent compose/write phases can
    // skip the planner LLM call when no new context is supplied.
    await savePersistedPlan(bookDir, plan);
    return plan;
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }
}
