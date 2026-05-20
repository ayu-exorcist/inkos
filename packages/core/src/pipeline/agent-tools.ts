import type { PipelineConfig } from "./runner-helpers.js";
import type { StateManager } from "../state/manager.js";
// PipelineRunner is referenced as a value in createCreateBookTool, so we need
// the concrete import, not just `import type`.
import { PipelineRunner } from "./runner.js";
import { getGlobalToolRegistry, type RegisteredTool } from "../tools/registry.js";
import { normalizePlatformOrOther, type Genre } from "../models/book.js";
import { DEFAULT_REVISE_MODE, type ReviseMode } from "../agents/reviser.js";
import { deriveBookIdFromTitle } from "../utils/book-id.js";

// ---------------------------------------------------------------------------
// Tool registration for the agent loop.
//
// These replace the hard-coded TOOLS array and switch-case in agent.ts.
// All tools self-register into the global ToolRegistry at module load time.
// ---------------------------------------------------------------------------

interface ToolDeps {
  readonly pipeline: PipelineRunner;
  readonly state: StateManager;
  readonly config: PipelineConfig;
}

function createToolRegistry(deps: ToolDeps): void {
  const registry = getGlobalToolRegistry();
  const tools = [
    createPlanChapterTool(deps),
    createComposeChapterTool(deps),
    createWriteDraftTool(deps),
    createAuditChapterTool(deps),
    createReviseChapterTool(deps),
    createScanMarketTool(deps),
    createCreateBookTool(deps),
    createUpdateAuthorIntentTool(deps),
    createUpdateCurrentFocusTool(deps),
    createGetBookStatusTool(deps),
    createReadTruthFilesTool(deps),
    createListBooksTool(deps),
    createWriteFullPipelineTool(deps),
    createWebFetchTool(),
    createImportStyleTool(deps),
    createImportCanonTool(deps),
    createImportChaptersTool(deps),
    createWriteTruthFileTool(deps),
  ];

  for (const tool of tools) {
    registry.override(tool);
  }
}

export function registerAgentTools(deps: ToolDeps): void {
  createToolRegistry(deps);
}

// ---------------------------------------------------------------------------
// Individual tools
// ---------------------------------------------------------------------------

function createPlanChapterTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "plan_chapter",
    description:
      "为下一章生成 chapter intent（章节目标、必须保留、冲突说明）。适合在正式写作前检查当前控制输入是否正确。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        guidance: { type: "string", description: "本章额外指导（可选，自然语言）" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const result = await deps.pipeline.planChapter(
        args.bookId as string,
        args.guidance as string | undefined,
      );
      return result;
    },
  };
}

function createComposeChapterTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "compose_chapter",
    description:
      "为下一章生成 context/rule-stack/trace 运行时产物。适合在写作前确认系统实际会带哪些上下文和优先级。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        guidance: { type: "string", description: "本章额外指导（可选，自然语言）" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const result = await deps.pipeline.composeChapter(
        args.bookId as string,
        args.guidance as string | undefined,
      );
      return result;
    },
  };
}

function createWriteDraftTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "write_draft",
    description:
      "写【下一章】草稿。只能续写最新章之后的下一章，不能指定章节号，不能补历史空章。生成正文、更新状态卡/账本/伏笔池、保存章节文件。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        guidance: { type: "string", description: "本章创作指导（可选，自然语言）" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const bookId = args.bookId as string;
      const writeGuardError = await getSequentialWriteGuardError(
        deps.state,
        bookId,
        "write_draft",
      );
      if (writeGuardError) {
        return { error: writeGuardError };
      }
      const result = await deps.pipeline.writeDraft(
        bookId,
        args.guidance as string | undefined,
      );
      return result;
    },
  };
}

function createAuditChapterTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "audit_chapter",
    description: "审计指定章节。检查连续性、OOC、数值、伏笔等问题。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        chapterNumber: { type: "number", description: "章节号（不填则审计最新章）" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const result = await deps.pipeline.auditDraft(
        args.bookId as string,
        args.chapterNumber as number | undefined,
      );
      return result;
    },
  };
}

function createReviseChapterTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "revise_chapter",
    description:
      "修订指定章节的文字质量。根据审计问题做局部修正，不改变剧情走向。默认 spot-fix（定点修复最小改动）；也支持 polish(润色)、rewrite(改写)、rework(重写)、anti-detect。注意：不能用来补缺失章节、不能改章节号、不能替代 write_draft。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        chapterNumber: { type: "number", description: "章节号（不填则修订最新章）" },
        mode: {
          type: "string",
          enum: ["polish", "rewrite", "rework", "spot-fix", "anti-detect"],
          description: `修订模式（默认${DEFAULT_REVISE_MODE}）`,
        },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const bookId = args.bookId as string;
      const chapterNum = args.chapterNumber as number | undefined;
      if (chapterNum !== undefined) {
        const index = await deps.state.loadChapterIndex(bookId);
        const chapter = index.find((ch) => ch.number === chapterNum);
        if (!chapter) {
          return {
            error: `第${chapterNum}章不存在。revise_chapter 只能修订已有章节，不能用来补写缺失章节。请用 get_book_status 确认。`,
          };
        }
        if (chapter.wordCount === 0) {
          return {
            error: `第${chapterNum}章内容为空（0字）。revise_chapter 不能修订空章节。`,
          };
        }
      }
      const result = await deps.pipeline.reviseDraft(
        bookId,
        chapterNum,
        (args.mode as ReviseMode) ?? DEFAULT_REVISE_MODE,
      );
      return result;
    },
  };
}

function createScanMarketTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "scan_market",
    description: "扫描市场趋势。从平台排行榜获取实时数据并分析。",
    schema: { type: "object", properties: {} },
    async execute() {
      const result = await deps.pipeline.runRadar();
      return result;
    },
  };
}

function createCreateBookTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "create_book",
    description: "创建一本新书。生成世界观、卷纲、文风指南等基础设定。",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "书名" },
        genre: {
          type: "string",
          enum: ["xuanhuan", "xianxia", "urban", "horror", "other"],
          description: "题材",
        },
        platform: {
          type: "string",
          enum: ["tomato", "feilu", "qidian", "other"],
          description: "目标平台",
        },
        brief: { type: "string", description: "创作简述/需求（自然语言）" },
      },
      required: ["title", "genre", "platform"],
    },
    async execute(args) {
      const now = new Date().toISOString();
      const title = args.title as string;
      const bookId = deriveBookIdFromTitle(title) || `book-${Date.now().toString(36)}`;

      const book = {
        id: bookId,
        title,
        platform: normalizePlatformOrOther(args.platform ?? "tomato"),
        genre: ((args.genre as string) ?? "xuanhuan") as Genre,
        status: "outlining" as const,
        targetChapters: 200,
        chapterWordCount: 3000,
        createdAt: now,
        updatedAt: now,
      };

      const brief = args.brief as string | undefined;
      if (brief) {
        const contextPipeline = new PipelineRunner({ ...deps.config, externalContext: brief });
        await contextPipeline.initBook(book);
      } else {
        await deps.pipeline.initBook(book);
      }

      return { bookId, title, status: "created" };
    },
  };
}

function createUpdateAuthorIntentTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "update_author_intent",
    description: "更新书级长期意图文档 author_intent.md。用于修改这本书长期想成为什么。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        content: { type: "string", description: "author_intent.md 的完整新内容" },
      },
      required: ["bookId", "content"],
    },
    async execute(args) {
      await deps.state.ensureControlDocuments(args.bookId as string);
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const storyDir = join(deps.state.bookDir(args.bookId as string), "story");
      await writeFile(join(storyDir, "author_intent.md"), args.content as string, "utf-8");
      return { bookId: args.bookId, file: "story/author_intent.md", written: true };
    },
  };
}

function createUpdateCurrentFocusTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "update_current_focus",
    description: "更新当前关注点文档 current_focus.md。用于把最近几章的注意力拉回某条主线或冲突。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        content: { type: "string", description: "current_focus.md 的完整新内容" },
      },
      required: ["bookId", "content"],
    },
    async execute(args) {
      await deps.state.ensureControlDocuments(args.bookId as string);
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const storyDir = join(deps.state.bookDir(args.bookId as string), "story");
      await writeFile(join(storyDir, "current_focus.md"), args.content as string, "utf-8");
      return { bookId: args.bookId, file: "story/current_focus.md", written: true };
    },
  };
}

function createGetBookStatusTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "get_book_status",
    description: "获取书籍状态概览：章数、字数、最近章节审计情况。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const result = await deps.pipeline.getBookStatus(args.bookId as string);
      return result;
    },
  };
}

function createReadTruthFilesTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "read_truth_files",
    description: "读取书籍的长期记忆（状态卡、资源账本、伏笔池）+ 世界观和卷纲。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const result = await deps.pipeline.readTruthFiles(args.bookId as string);
      return result;
    },
  };
}

function createListBooksTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "list_books",
    description: "列出所有书籍。",
    schema: { type: "object", properties: {} },
    async execute() {
      const bookIds = await deps.state.listBooks();
      const books = await Promise.all(
        bookIds.map(async (id) => {
          try {
            return await deps.pipeline.getBookStatus(id);
          } catch {
            return { bookId: id, error: "failed to load" };
          }
        }),
      );
      return books;
    },
  };
}

function createWriteFullPipelineTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "write_full_pipeline",
    description: "完整管线：写草稿 → 审计 → 自动修订（如需要）。一键完成。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        count: { type: "number", description: "连续写几章（默认1）" },
      },
      required: ["bookId"],
    },
    async execute(args) {
      const bookId = args.bookId as string;
      const writeGuardError = await getSequentialWriteGuardError(
        deps.state,
        bookId,
        "write_full_pipeline",
      );
      if (writeGuardError) {
        return { error: writeGuardError };
      }
      const count = (args.count as number) ?? 1;
      const results = [];
      for (let i = 0; i < count; i++) {
        const result = await deps.pipeline.writeNextChapter(bookId);
        results.push(result);
      }
      return results;
    },
  };
}

function createWebFetchTool(): RegisteredTool {
  return {
    name: "web_fetch",
    description: "抓取指定URL的文本内容。用于读取搜索结果中的详细页面。",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的URL" },
        maxChars: { type: "number", description: "最大返回字符数（默认8000）" },
      },
      required: ["url"],
    },
    async execute(args) {
      const { fetchUrl } = await import("../utils/web-search.js");
      const text = await fetchUrl(args.url as string, (args.maxChars as number) ?? 8000);
      return { url: args.url, content: text };
    },
  };
}

function createImportStyleTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "import_style",
    description:
      "从参考文本生成文风指南（统计 + LLM定性分析）。生成 style_profile.json 和 style_guide.md。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "目标书籍ID" },
        referenceText: { type: "string", description: "参考文本（至少2000字）" },
      },
      required: ["bookId", "referenceText"],
    },
    async execute(args) {
      const guide = await deps.pipeline.generateStyleGuide(
        args.bookId as string,
        args.referenceText as string,
      );
      return {
        bookId: args.bookId,
        statsProfile: "story/style_profile.json",
        styleGuide: "story/style_guide.md",
        guidePreview: guide.slice(0, 500),
      };
    },
  };
}

function createImportCanonTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "import_canon",
    description: "从正传导入正典参照，生成 parent_canon.md，启用番外写作和审计模式。",
    schema: {
      type: "object",
      properties: {
        targetBookId: { type: "string", description: "番外书籍ID" },
        parentBookId: { type: "string", description: "正传书籍ID" },
      },
      required: ["targetBookId", "parentBookId"],
    },
    async execute(args) {
      const canon = await deps.pipeline.importCanon(
        args.targetBookId as string,
        args.parentBookId as string,
      );
      return {
        targetBookId: args.targetBookId,
        parentBookId: args.parentBookId,
        output: "story/parent_canon.md",
        canonPreview: canon.slice(0, 500),
      };
    },
  };
}

function createImportChaptersTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "import_chapters",
    description:
      "【整书重导】导入已有章节。从完整文本中自动分割所有章节，逐章分析并重建全部真相文件。这是整书级操作，不是补某一章的工具。导入后可用 write_draft 续写。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "目标书籍ID" },
        text: { type: "string", description: "包含多章的完整文本" },
        splitPattern: { type: "string", description: "章节分割正则（可选，默认匹配'第X章'）" },
      },
      required: ["bookId", "text"],
    },
    async execute(args) {
      const { splitChapters } = await import("../utils/chapter-splitter.js");
      const chapters = splitChapters(args.text as string, args.splitPattern as string | undefined);
      if (chapters.length === 0) {
        return {
          error: "No chapters found. Check text format or provide a splitPattern.",
        };
      }
      if (chapters.length === 1) {
        return {
          error:
            "import_chapters 是整书重导工具，需要至少 2 个章节。如果只想补一章，请用 write_draft 续写或 revise_chapter 修订。",
        };
      }
      const result = await deps.pipeline.importChapters({
        bookId: args.bookId as string,
        chapters: [...chapters],
      });
      return result;
    },
  };
}

function createWriteTruthFileTool(deps: ToolDeps): RegisteredTool {
  return {
    name: "write_truth_file",
    description:
      "【整文件覆盖】直接替换书的真相文件内容。用于扩展大纲、修改世界观、调整规则。注意：这是整文件覆盖写入，不是追加；不要用来改 current_state.md 的章节进度指针或 hack 章节号；不要用来补空章节。book_rules.md / story_bible.md 是 Phase 5 之后的兼容指针，不再作为写入目标——请改写 outline/story_frame.md 的 YAML frontmatter。",
    schema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍ID" },
        fileName: {
          type: "string",
          description:
            "文件名（如 outline/story_frame.md、outline/volume_map.md、outline/节奏原则.md（可选，Phase 5 后节奏原则合并到 volume_map 尾段，仅 legacy / 人工写入时出现）、roles/主要角色/<name>.md、roles/次要角色/<name>.md、current_state.md、pending_hooks.md）",
        },
        content: { type: "string", description: "新的完整文件内容" },
      },
      required: ["bookId", "fileName", "content"],
    },
    async execute(args) {
      const bookId = args.bookId as string;
      const fileName = args.fileName as string;
      const content = args.content as string;

      const LEGACY_SHIM_FILES = new Set(["story_bible.md", "book_rules.md"]);
      const ALLOWED_FLAT_FILES = [
        "story_bible.md",
        "book_rules.md",
        "current_state.md",
        "particle_ledger.md",
        "pending_hooks.md",
        "chapter_summaries.md",
        "subplot_board.md",
        "emotional_arcs.md",
        "character_matrix.md",
        "style_guide.md",
      ];
      const ALLOWED_OUTLINE_FILES = [
        "outline/story_frame.md",
        "outline/volume_map.md",
        "outline/节奏原则.md",
        "outline/rhythm_principles.md",
      ];
      const ROLE_PATH_PATTERN = /^roles\/(主要角色|次要角色|major|minor)\/[^/]+\.md$/;

      const isAllowed =
        ALLOWED_FLAT_FILES.includes(fileName) ||
        ALLOWED_OUTLINE_FILES.includes(fileName) ||
        ROLE_PATH_PATTERN.test(fileName);

      if (!isAllowed) {
        const allowedExamples = [
          ...ALLOWED_FLAT_FILES,
          ...ALLOWED_OUTLINE_FILES,
          "roles/主要角色/<name>.md",
          "roles/次要角色/<name>.md",
          "roles/major/<name>.md",
          "roles/minor/<name>.md",
        ];
        return {
          error: `不允许修改文件 "${fileName}"。允许的文件：${allowedExamples.join(", ")}`,
        };
      }

      if (LEGACY_SHIM_FILES.has(fileName)) {
        const { isNewLayoutBook } = await import("../utils/outline-paths.js");
        const bookDirForCheck = new (await import("../state/manager.js")).StateManager(
          deps.config.projectRoot,
        ).bookDir(bookId);
        if (await isNewLayoutBook(bookDirForCheck)) {
          return {
            error: `"${fileName}" 是兼容指针（新布局书籍），请改写 outline/story_frame.md。`,
          };
        }
      }

      if (fileName.includes("..") || fileName.startsWith("/") || fileName.includes("\0")) {
        return { error: `不安全的文件路径："${fileName}"` };
      }

      if (fileName === "current_state.md" && containsProgressManipulation(content)) {
        return {
          error: "不允许通过 write_truth_file 修改 current_state.md 中的章节进度。章节进度由系统自动管理。",
        };
      }

      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const bookDir = new (await import("../state/manager.js")).StateManager(
        deps.config.projectRoot,
      ).bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const targetPath = join(storyDir, fileName);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content, "utf-8");

      return {
        bookId,
        file: `story/${fileName}`,
        written: true,
        size: content.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSequentialWriteGuardError(
  state: StateManager,
  bookId: string,
  toolName: "write_draft" | "write_full_pipeline",
): Promise<string | null> {
  const nextNum = await state.getNextChapterNumber(bookId);
  const index = await state.loadChapterIndex(bookId);
  if (index.length === 0) return null;
  const lastIndexedChapter = index[index.length - 1]!.number;
  if (lastIndexedChapter === nextNum - 1) return null;
  return `${toolName} 只能续写下一章（当前应写第${nextNum}章）。检测到章节索引与运行时进度不一致，请先用 get_book_status 确认状态。`;
}

function containsProgressManipulation(content: string): boolean {
  const patterns = [
    /\blastAppliedChapter\b/i,
    /\|\s*Current Chapter\s*\|\s*\d+\s*\|/i,
    /\|\s*当前章(?:节)?\s*\|\s*\d+\s*\|/,
    /\bCurrent Chapter\b\s*[:：]\s*\d+/i,
    /当前章(?:节)?\s*[:：]\s*\d+/,
    /\bprogress\b\s*[:：]\s*\d+/i,
    /进度\s*[:：]\s*\d+/,
  ];
  return patterns.some((pattern) => pattern.test(content));
}
