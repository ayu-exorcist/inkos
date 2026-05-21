import { join } from "node:path";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { chatCompletion } from "../llm/provider.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { ArchitectAgent } from "../agents/architect.js";
import type { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import type { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import type { WriterAgent } from "../agents/writer.js";
import type { BaseAgent } from "../agents/base.js";
import type { StateManager } from "../state/manager.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { countChapterLength, resolveLengthCountingMode } from "../utils/length-metrics.js";
import { formatLengthCount } from "../utils/length-metrics.js";
import { buildWritingMethodologySection } from "../utils/writing-methodology.js";
import type { TelemetryTracer } from "../telemetry/tracer.js";
import type { Logger } from "../utils/logger.js";
import type { DraftService } from "./draft.js";
import type {
  ImportChaptersInput,
  ImportChaptersResult,
} from "../pipeline/runner-helpers.js";
import { buildImportFoundationSource } from "../pipeline/runner-helpers.js";

export interface ImportServiceDeps {
  readonly state: StateManager;
  readonly projectRoot: string;
  readonly resolveAgent: <T extends BaseAgent>(name: string, bookId?: string) => Promise<T>;
  readonly logger?: Logger;
  readonly client: LLMClient;
  readonly model: string;
  readonly telemetry?: TelemetryTracer;
  readonly foundationReviewRetries?: number;
  localize(language: LengthLanguage, messages: { zh: string; en: string }): string;
  logStage(language: LengthLanguage, message: { zh: string; en: string }): void;
  logWarn(language: LengthLanguage, message: { zh: string; en: string }): void;
  resolveBookLanguage(book: Pick<BookConfig, "genre" | "language">): Promise<LengthLanguage>;
  resolveBookLanguageById(bookId: string): Promise<LengthLanguage>;
  loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }>;
  generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<import("../agents/architect.js").ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly maxRetries?: number;
  }): Promise<import("../agents/architect.js").ArchitectOutput>;
  draft: DraftService;
  importFanficCanon?(bookId: string, sourceText: string, sourceName: string, fanficMode: FanficMode): Promise<string>;
}

/**
 * ImportService handles canon import, fanfic initialization, and chapter import.
 *
 * Extracted from PipelineRunner to decouple import/replay logic
 * from chapter-writing orchestration.
 */
export class ImportService {
  constructor(private readonly deps: ImportServiceDeps) {}

  /** Import external source material and generate fanfic_canon.md */
  async importFanficCanon(
    bookId: string,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<string> {
    const { FanficCanonImporter } = await import("../agents/fanfic-canon-importer.js");
    const importer = new FanficCanonImporter({
      client: this.deps.client,
      model: this.deps.model,
      projectRoot: this.deps.projectRoot,
      bookId,
      logger: this.deps.logger?.child("fanfic-canon-importer"),
    });
    const result = await importer.importFromText(sourceText, sourceName, fanficMode);

    const bookDir = this.deps.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(storyDir, "fanfic_canon.md"), result.fullDocument, "utf-8");

    return result.fullDocument;
  }

  /** One-step fanfic book creation: create book + import canon + generate foundation */
  async initFanficBook(
    book: BookConfig,
    sourceText: string,
    sourceName: string,
    fanficMode: FanficMode,
  ): Promise<void> {
    const bookDir = this.deps.state.bookDir(book.id);
    const stageLanguage = await this.deps.resolveBookLanguage(book);

    this.deps.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
    await this.deps.state.saveBookConfig(book.id, book);

    this.deps.logStage(stageLanguage, { zh: "导入同人正典", en: "importing fanfic canon" });
    const fanficCanon = this.deps.importFanficCanon
      ? await this.deps.importFanficCanon(book.id, sourceText, sourceName, fanficMode)
      : await this.importFanficCanon(book.id, sourceText, sourceName, fanficMode);

    const architect = await this.deps.resolveAgent<ArchitectAgent>("architect", book.id);
    const reviewer = await this.deps.resolveAgent<FoundationReviewerAgent>("foundation-reviewer", book.id);
    this.deps.logStage(stageLanguage, { zh: "生成同人基础设定", en: "generating fanfic foundation" });
    const { profile: gp } = await this.deps.loadGenreProfile(book.genre);
    const resolvedLanguage =
      (book.language ?? gp.language) === "en" ? ("en" as const) : ("zh" as const);
    const foundation = await this.deps.generateAndReviewFoundation({
      generate: (reviewFeedback) =>
        architect.generateFanficFoundation(book, fanficCanon, fanficMode, reviewFeedback),
      reviewer,
      mode: "fanfic",
      sourceCanon: fanficCanon,
      language: resolvedLanguage,
      stageLanguage,
      maxRetries: this.deps.foundationReviewRetries,
    });
    this.deps.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
    );
    this.deps.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
    await this.deps.state.ensureControlDocuments(book.id);

    if (sourceText.length >= 500) {
      this.deps.logStage(stageLanguage, {
        zh: "提取原作风格指纹",
        en: "extracting source style fingerprint",
      });
      await this.tryGenerateStyleGuide(book.id, sourceText, sourceName, stageLanguage);
    }

    this.deps.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await this.deps.state.saveChapterIndex(book.id, []);
    await this.deps.state.snapshotState(book.id, 0);
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    const bookIds = await this.deps.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(
        `Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`,
      );
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(
        `Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`,
      );
    }

    const parentDir = this.deps.state.bookDir(parentBookId);
    const targetDir = this.deps.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(无)";
      }
    };

    const parentBook = await this.deps.state.loadBookConfig(parentBookId);

    const readParentOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(parentDir, "story", newRel));
      if (preferred.trim() && preferred !== "(无)") return preferred;
      return readSafe(join(parentDir, "story", legacyRel));
    };

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readParentOutline("outline/story_frame.md", "story_bible.md"),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/chapter_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(
      this.deps.client,
      this.deps.model,
      [
        {
          role: "system",
          content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。\n\n输出格式（Markdown）：\n# 正传正典（《{正传书名}》）\n\n## 世界规则（完整，来自正传设定）\n（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）\n\n## 正典约束（不可违反的事实）\n| 约束ID | 类型 | 约束内容 | 严重性 |\n|---|---|---|---|\n| C01 | 人物存亡 | ... | critical |\n（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）\n\n## 角色快照\n| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |\n|---|---|---|---|---|---|\n（从状态卡和角色矩阵中提取每个重要角色的完整快照）\n\n## 角色双态处理原则\n- 未来会变强的角色：写潜力暗示\n- 未来会黑化的角色：写微小裂痕\n- 未来会死的角色：写导致死亡的性格底色\n\n## 关键事件时间线\n| 章节 | 事件 | 涉及角色 | 对番外的约束 |\n|---|---|---|---|\n（从章节摘要中提取关键事件）\n\n## 伏笔状态\n| Hook ID | 类型 | 状态 | 内容 | 预期回收 |\n|---|---|---|---|---|\n\n## 资源账本快照\n（当前资源状态）\n\n---\nmeta:\n  parentBookId: "{parentBookId}"\n  parentTitle: "{正传书名}"\n  generatedAt: "{ISO timestamp}"\n\n要求：\n1. 世界规则完整复制，不压缩——准确性优先\n2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾\n3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
        },
        {
          role: "user",
          content: `正传书名：${parentBook.title}\n正传ID：${parentBookId}\n\n## 正传世界设定\n${storyBible}\n\n## 正传当前状态卡\n${currentState}\n\n## 正传资源账本\n${ledger}\n\n## 正传伏笔池\n${hooks}\n\n## 正传章节摘要\n${summaries}\n\n## 正传支线进度\n${subplots}\n\n## 正传情感弧线\n${emotions}\n\n## 正传角色矩阵\n${matrix}`,
        },
      ],
      { temperature: 0.3 },
    );

    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");

    const parentChaptersDir = join(parentDir, "chapters");
    const parentChapterText = await this.readParentChapterSample(parentChaptersDir);
    if (parentChapterText.length >= 500) {
      await this.tryGenerateStyleGuide(targetBookId, parentChapterText, parentBook.title);
    }

    return canon;
  }

  private async readParentChapterSample(chaptersDir: string): Promise<string> {
    try {
      const entries = await readdir(chaptersDir);
      const mdFiles = entries
        .filter((file) => file.endsWith(".md"))
        .sort()
        .slice(0, 5);
      const chunks: string[] = [];
      let totalLength = 0;
      for (const file of mdFiles) {
        if (totalLength >= 20000) break;
        const content = await readFile(join(chaptersDir, file), "utf-8");
        chunks.push(content);
        totalLength += content.length;
      }
      return chunks.join("\n\n---\n\n");
    } catch {
      return "";
    }
  }

  /**
   * Import existing chapters into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   */
  async importChapters(input: ImportChaptersInput): Promise<ImportChaptersResult> {
    this.deps.telemetry?.startSpan({
      name: "importChapters",
      attributes: { bookId: input.bookId, count: input.chapters.length },
    });
    const releaseLock = await this.deps.state.acquireBookLock(input.bookId);
    try {
      const book = await this.deps.state.loadBookConfig(input.bookId);
      const bookDir = this.deps.state.bookDir(input.bookId);
      const { profile: gp } = await this.deps.loadGenreProfile(book.genre);
      const resolvedLanguage = book.language ?? gp.language;

      const startFrom = input.resumeFrom ?? 1;
      const log = this.deps.logger?.child("import");

      if (startFrom === 1) {
        log?.info(
          this.deps.localize(resolvedLanguage, {
            zh: `步骤 1：从 ${input.chapters.length} 章生成基础设定...`,
            en: `Step 1: Generating foundation from ${input.chapters.length} chapters...`,
          }),
        );
        const foundationSource = buildImportFoundationSource(input.chapters, resolvedLanguage);

        const architect = await this.deps.resolveAgent<ArchitectAgent>("architect", input.bookId);
        const isSeries = input.importMode === "series";
        const foundation = isSeries
          ? await this.deps.generateAndReviewFoundation({
              generate: (reviewFeedback) =>
                architect.generateFoundationFromImport(
                  book,
                  foundationSource,
                  undefined,
                  reviewFeedback,
                  { importMode: "series" },
                ),
              reviewer: await this.deps.resolveAgent<FoundationReviewerAgent>(
                "foundation-reviewer",
                input.bookId,
              ),
              mode: "series",
              language: resolvedLanguage === "en" ? "en" : "zh",
              stageLanguage: resolvedLanguage,
              maxRetries: this.deps.foundationReviewRetries,
            })
          : await architect.generateFoundationFromImport(book, foundationSource);
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          gp.numericalSystem,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.deps.state.saveChapterIndex(input.bookId, []);
        await this.deps.state.snapshotState(input.bookId, 0);

        if (foundationSource.length >= 500) {
          log?.info(
            this.deps.localize(resolvedLanguage, {
              zh: "提取原文风格指纹...",
              en: "Extracting source style fingerprint...",
            }),
          );
          await this.tryGenerateStyleGuide(
            input.bookId,
            foundationSource,
            book.title,
            resolvedLanguage,
          );
        }

        log?.info(
          this.deps.localize(resolvedLanguage, {
            zh: "基础设定已生成。",
            en: "Foundation generated.",
          }),
        );
      }

      log?.info(
        this.deps.localize(resolvedLanguage, {
          zh: `步骤 2：从第 ${startFrom} 章开始顺序回放...`,
          en: `Step 2: Sequential replay from chapter ${startFrom}...`,
        }),
      );
      const analyzer = await this.deps.resolveAgent<ChapterAnalyzerAgent>(
        "chapter-analyzer",
        input.bookId,
      );
      const writer = await this.deps.resolveAgent<WriterAgent>("writer", input.bookId);
      const countingMode = resolveLengthCountingMode(book.language ?? gp.language);
      let totalWords = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.chapters.length; i++) {
        const ch = input.chapters[i]!;
        const chapterNumber = i + 1;
        const governedInput = await this.deps.draft.prepareWriteInput(book, bookDir, chapterNumber);

        log?.info(
          this.deps.localize(resolvedLanguage, {
            zh: `分析章节 ${chapterNumber}/${input.chapters.length}：${ch.title}...`,
            en: `Analyzing chapter ${chapterNumber}/${input.chapters.length}: ${ch.title}...`,
          }),
        );

        const output = await analyzer.analyzeChapter({
          book,
          bookDir,
          chapterNumber,
          chapterContent: ch.content,
          chapterTitle: ch.title,
          chapterIntent: governedInput.chapterIntent,
          contextPackage: governedInput.contextPackage,
          ruleStack: governedInput.ruleStack,
        });

        await writer.saveChapter(
          bookDir,
          {
            ...output,
            postWriteErrors: [],
            postWriteWarnings: [],
          },
          gp.numericalSystem,
          resolvedLanguage,
        );

        await writer.saveNewTruthFiles(
          bookDir,
          {
            ...output,
            postWriteErrors: [],
            postWriteWarnings: [],
          },
          resolvedLanguage,
        );
        await this.deps.draft.syncLegacyStructuredStateFromMarkdown(bookDir, chapterNumber, output);
        await this.deps.draft.syncNarrativeMemoryIndex(input.bookId);

        const existingIndex = await this.deps.state.loadChapterIndex(input.bookId);
        const now = new Date().toISOString();
        const chapterWordCount = countChapterLength(ch.content, countingMode);
        const newEntry: ChapterMeta = {
          number: chapterNumber,
          title: output.title,
          status: "imported",
          wordCount: chapterWordCount,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        };
        const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
        const updatedIndex =
          existingIdx >= 0
            ? existingIndex.map((e, idx) => (idx === existingIdx ? newEntry : e))
            : [...existingIndex, newEntry];
        await this.deps.state.saveChapterIndex(input.bookId, updatedIndex);

        await this.deps.state.snapshotState(input.bookId, chapterNumber);

        importedCount++;
        totalWords += chapterWordCount;
      }

      if (input.chapters.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
        await this.deps.draft.syncCurrentStateFactHistory(input.bookId, input.chapters.length);
      }

      const nextChapter = input.chapters.length + 1;
      log?.info(
        this.deps.localize(resolvedLanguage, {
          zh: `完成。已导入 ${importedCount} 章，共 ${formatLengthCount(totalWords, countingMode)}。下一章：${nextChapter}`,
          en: `Done. ${importedCount} chapters imported, ${formatLengthCount(totalWords, countingMode)}. Next chapter: ${nextChapter}`,
        }),
      );

      return {
        bookId: input.bookId,
        importedCount,
        totalWords,
        nextChapter,
      };
    } finally {
      await releaseLock();
      this.deps.telemetry?.endSpan();
    }
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "chapter_summaries.md"), { force: true }),
      rm(join(storyDir, "subplot_board.md"), { force: true }),
      rm(join(storyDir, "emotional_arcs.md"), { force: true }),
      rm(join(storyDir, "character_matrix.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "particle_ledger.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.deps.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.deps.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(
    bookId: string,
    referenceText: string,
    sourceName?: string,
  ): Promise<string> {
    const sample = referenceText.trim();
    if (!sample) {
      throw new Error("Reference text is required for style extraction.");
    }

    const { analyzeStyle } = await import("../agents/style-analyzer.js");
    const bookDir = this.deps.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    const profile = analyzeStyle(sample, sourceName);
    await writeFile(
      join(storyDir, "style_profile.json"),
      JSON.stringify(profile, null, 2),
      "utf-8",
    );

    const book = await this.deps.state.loadBookConfig(bookId);
    const { profile: gp } = await this.deps.loadGenreProfile(book.genre);
    const lang = (book.language ?? gp.language) === "en" ? ("en" as const) : ("zh" as const);

    let qualitativeGuide: string;
    if (sample.length < 500) {
      qualitativeGuide = this.buildDeterministicStyleGuide(profile, {
        language: lang,
        reason:
          lang === "en"
            ? `The sample is short (${sample.length} chars), so this guide uses the statistical fingerprint instead of LLM qualitative extraction.`
            : `样本文本较短（${sample.length}字），本次先使用统计指纹生成文风指南，不强行调用 LLM 做定性拆解。`,
      });
    } else {
      try {
        const response = await chatCompletion(
          this.deps.client,
          this.deps.model,
          [
            {
              role: "system",
              content: `你是一位文学风格分析专家。分析参考文本的写作风格，提取可供模仿的定性特征。\n\n输出格式（Markdown）：\n## 叙事声音与语气\n（冷峻/热烈/讽刺/温情/...，附1-2个原文例句）\n\n## 对话风格\n（角色说话的共性特征：句子长短、口头禅倾向、方言痕迹、对话节奏）\n\n## 场景描写特征\n（五感偏好、意象选择、描写密度、环境与情绪的关联方式）\n\n## 转折与衔接手法\n（场景如何切换、时间跳跃的处理方式、段落间的过渡特征）\n\n## 节奏特征\n（长短句分布、段落长度偏好、高潮/舒缓的交替方式）\n\n## 词汇偏好\n（高频特色用词、比喻/修辞倾向、口语化程度）\n\n## 情绪表达方式\n（直白抒情 vs 动作外化、内心独白的频率和风格）\n\n## 独特习惯\n（任何值得模仿的个人写作习惯）\n\n分析必须基于原文实际特征，不要泛泛而谈。每个部分用1-2个原文例句佐证。`,
            },
            {
              role: "user",
              content: `分析以下参考文本的写作风格：\n\n${sample.slice(0, 20000)}`,
            },
          ],
          { temperature: 0.3 },
        );
        qualitativeGuide = response.content.trim()
          ? response.content
          : this.buildDeterministicStyleGuide(profile, {
              language: lang,
              reason:
                lang === "en"
                  ? "The LLM returned empty style analysis; using the statistical fingerprint fallback."
                  : "LLM 未返回有效文风分析，本次使用统计指纹兜底生成文风指南。",
            });
      } catch (error) {
        qualitativeGuide = this.buildDeterministicStyleGuide(profile, {
          language: lang,
          reason:
            lang === "en"
              ? `LLM qualitative extraction failed: ${error instanceof Error ? error.message : String(error)}. Using the statistical fingerprint fallback.`
              : `LLM 定性拆解失败：${error instanceof Error ? error.message : String(error)}。本次使用统计指纹兜底生成文风指南。`,
        });
      }
    }

    const craftMethodology = buildWritingMethodologySection(lang);
    const fullStyleGuide = `${qualitativeGuide}\n\n${craftMethodology}`;
    await writeFile(join(storyDir, "style_guide.md"), fullStyleGuide, "utf-8");
    return fullStyleGuide;
  }

  private async tryGenerateStyleGuide(
    bookId: string,
    referenceText: string,
    sourceName: string | undefined,
    language?: LengthLanguage,
  ): Promise<void> {
    try {
      await this.generateStyleGuide(bookId, referenceText, sourceName);
    } catch (error) {
      const resolvedLanguage = language ?? (await this.deps.resolveBookLanguageById(bookId));
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.logWarn(resolvedLanguage, {
        zh: `风格指纹提取失败，已跳过：${detail}`,
        en: `Style fingerprint extraction failed and was skipped: ${detail}`,
      });
    }
  }

  private buildDeterministicStyleGuide(
    profile: {
      readonly avgSentenceLength: number;
      readonly sentenceLengthStdDev: number;
      readonly avgParagraphLength: number;
      readonly vocabularyDiversity: number;
      readonly topPatterns: ReadonlyArray<string>;
      readonly rhetoricalFeatures: ReadonlyArray<string>;
      readonly sourceName?: string;
    },
    options: { readonly language: "zh" | "en"; readonly reason: string },
  ): string {
    if (options.language === "en") {
      return [
        "# Style Guide",
        "",
        `> ${options.reason}`,
        "",
        "## Statistical Fingerprint",
        `- Source: ${profile.sourceName ?? "unknown"}`,
        `- Average sentence length: ${profile.avgSentenceLength}`,
        `- Sentence length variance: ${profile.sentenceLengthStdDev}`,
        `- Average paragraph length: ${profile.avgParagraphLength}`,
        `- Vocabulary diversity: ${Math.round(profile.vocabularyDiversity * 100)}%`,
        profile.topPatterns.length > 0
          ? `- Repeated openings: ${profile.topPatterns.join(", ")}`
          : "- Repeated openings: none obvious in this sample",
        profile.rhetoricalFeatures.length > 0
          ? `- Rhetorical features: ${profile.rhetoricalFeatures.join(", ")}`
          : "- Rhetorical features: none obvious in this sample",
        "",
        "## How To Use",
        "- Treat this as a lightweight style fingerprint, not a full imitation bible.",
        "- Keep sentence and paragraph rhythm close to the sample when drafting.",
        "- If this guide feels too thin, import a longer excerpt later; the file will be replaced.",
      ].join("\n");
    }

    return [
      "# 文风指南",
      "",
      `> ${options.reason}`,
      "",
      "## 统计风格指纹",
      `- 来源：${profile.sourceName ?? "unknown"}`,
      `- 平均句长：${profile.avgSentenceLength}`,
      `- 句长波动：${profile.sentenceLengthStdDev}`,
      `- 平均段落长度：${profile.avgParagraphLength}`,
      `- 词汇多样性：${Math.round(profile.vocabularyDiversity * 100)}%`,
      profile.topPatterns.length > 0
        ? `- 高频句首/模式：${profile.topPatterns.join("、")}`
        : "- 高频句首/模式：样本内不明显",
      profile.rhetoricalFeatures.length > 0
        ? `- 修辞特征：${profile.rhetoricalFeatures.join("、")}`
        : "- 修辞特征：样本内不明显",
      "",
      "## 使用方式",
      "- 这是一份轻量文风指纹，不是完整仿写圣经。",
      "- 后续写作优先参考句长、段落长度、节奏波动和可见修辞。",
      "- 如果想得到更稳定的定性拆解，后续可以导入更长片段覆盖本文件。",
    ].join("\n");
  }
}
