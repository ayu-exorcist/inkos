import { join } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { ArchitectOutput } from "../agents/architect.js";
import { ArchitectAgent } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { StateManager } from "../state/manager.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { isNewLayoutBook, readStoryFrame, readVolumeMap, readCharacterContext } from "../utils/outline-paths.js";

export interface FoundationServiceDeps {
  readonly state: StateManager;
  readonly projectRoot: string;
  resolveAgent(name: string, bookId?: string): Promise<unknown>;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}

/**
 * FoundationService handles book creation and foundation management.
 *
 * Extracted from PipelineRunner to decouple foundation lifecycle
 * from chapter-writing orchestration.
 */
export class FoundationService {
  constructor(private readonly deps: FoundationServiceDeps) {}

  private get log() {
    return this.deps.logger;
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.deps.projectRoot, genre);
    return { profile: parsed.profile };
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.log?.info(`${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`);
  }

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    const architect = await this.deps.resolveAgent("architect", book.id) as ArchitectAgent;
    const bookDir = this.deps.state.bookDir(book.id);
    const stagingBookDir = join(
      this.deps.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);
    const effectiveExternalContext = options.externalContext ?? "";

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const reviewer = await this.deps.resolveAgent("foundation-reviewer", book.id) as FoundationReviewerAgent;
    const resolvedLanguage =
      (book.language ?? gp.language) === "en" ? ("en" as const) : ("zh" as const);
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) =>
        architect.generateFoundation(book, effectiveExternalContext, reviewFeedback),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
    });
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.deps.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        gp.numericalSystem,
        book.language ?? gp.language,
      );

      if (effectiveExternalContext && effectiveExternalContext.trim().length > 0) {
        const storyDir = join(stagingBookDir, "story");
        await mkdir(storyDir, { recursive: true });
        await writeFile(join(storyDir, "brief.md"), effectiveExternalContext, "utf-8");
      }

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.deps.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language ?? gp.language,
        options.authorIntent ?? effectiveExternalContext,
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.deps.state.saveChapterIndexAt(stagingBookDir, []);

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.deps.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.deps.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(
            `Book "${book.id}" already exists at books/${book.id}/. Use a different title or delete the existing book first.`,
          );
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      await rename(stagingBookDir, bookDir);
    } catch (error) {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    const bookDir = this.deps.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const isPhase5 = await isNewLayoutBook(bookDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupTag = isPhase5 ? "phase5" : "phase4";
    const backupDir = join(storyDir, `.backup-${backupTag}-${timestamp}`);
    await mkdir(backupDir, { recursive: true });

    const flatFiles = [
      "story_bible.md",
      "volume_outline.md",
      "book_rules.md",
      "character_matrix.md",
    ];
    for (const fileName of flatFiles) {
      try {
        const content = await (await import("node:fs/promises")).readFile(join(storyDir, fileName), "utf-8");
        await writeFile(join(backupDir, fileName), content, "utf-8");
      } catch {
        // Missing legacy shim files are fine for partially migrated books.
      }
    }

    if (isPhase5) {
      await this.copyDirShallow(join(storyDir, "outline"), join(backupDir, "outline"));
      await this.copyDirRecursive(join(storyDir, "roles"), join(backupDir, "roles"));
    }

    const book = await this.deps.state.loadBookConfig(bookId);
    let oldStoryBible: string;
    let oldVolumeOutline: string;
    let oldBookRules: string;
    let oldCharacterMatrix: string;

    if (isPhase5) {
      [oldStoryBible, oldVolumeOutline, oldCharacterMatrix] = await Promise.all([
        readStoryFrame(bookDir),
        readVolumeMap(bookDir),
        readCharacterContext(bookDir),
      ]);
      oldBookRules = await (await import("node:fs/promises")).readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => "");
    } else {
      const { readFile } = await import("node:fs/promises");
      [oldStoryBible, oldVolumeOutline, oldBookRules, oldCharacterMatrix] = await Promise.all([
        readFile(join(storyDir, "story_bible.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "volume_outline.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
        readFile(join(storyDir, "character_matrix.md"), "utf-8").catch(() => ""),
      ]);
    }

    const architect = await this.deps.resolveAgent("architect", bookId) as ArchitectAgent;
    const foundation = await architect.generateFoundation(book, undefined, undefined, {
      reviseFrom: {
        storyBible: oldStoryBible,
        volumeOutline: oldVolumeOutline,
        bookRules: oldBookRules,
        characterMatrix: oldCharacterMatrix,
        userFeedback: feedback,
      },
    });

    const reviewer = await this.deps.resolveAgent("foundation-reviewer", bookId) as FoundationReviewerAgent;
    const resolvedLanguage = (book.language ?? "zh") === "en" ? ("en" as const) : ("zh" as const);
    try {
      const review = await reviewer.review({
        foundation,
        mode: "original",
        language: resolvedLanguage,
      } as Parameters<FoundationReviewerAgent["review"]>[0]);
      if (!review.passed) {
        this.log?.warn?.(
          `[reviseFoundation] Foundation review did not pass; accepting rewrite. Feedback: ${review.overallFeedback ?? ""}`,
        );
      }
    } catch (error) {
      this.log?.warn?.(
        `[reviseFoundation] Foundation review failed and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const outlineDir = join(storyDir, "outline");
    await mkdir(outlineDir, { recursive: true });
    await mkdir(join(storyDir, "roles", "主要角色"), { recursive: true });
    await mkdir(join(storyDir, "roles", "次要角色"), { recursive: true });

    const { profile: gp } = await this.loadGenreProfile(book.genre);
    await architect.writeFoundationFiles(
      bookDir,
      foundation,
      gp.numericalSystem,
      book.language ?? gp.language,
      "revise",
    );
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
    const maxRetries = params.maxRetries ?? 2;
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

      this.log?.info(`Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`);
      for (const dim of review.dimensions) {
        this.log?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logStage(params.stageLanguage, {
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
    this.log?.info(
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
      return "zh";
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await (await import("node:fs/promises")).stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async copyDirShallow(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(src);
      await Promise.all(
        entries.map(async (entry) => {
          try {
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(join(src, entry), "utf-8");
            await writeFile(join(dest, entry), content, "utf-8");
          } catch {
            // Skip unreadable files.
          }
        }),
      );
    } catch {
      // Source directory does not exist.
    }
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await this.copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          try {
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(srcPath, "utf-8");
            await writeFile(destPath, content, "utf-8");
          } catch {
            // Skip unreadable files.
          }
        }
      }
    } catch {
      // Source directory does not exist.
    }
  }
}
