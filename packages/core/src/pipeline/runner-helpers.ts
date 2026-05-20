import type { LLMClient, OnStreamProgress } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { ChapterMeta } from "../models/chapter.js";
import type {
  NotifyChannel,
  LLMConfig,
  AgentLLMOverride,
  InputGovernanceMode,
} from "../models/project.js";
import type { RadarSource } from "../agents/radar-source.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";

const SEQUENCE_LEVEL_CATEGORIES = new Set([
  "Pacing Monotony",
  "节奏单调",
  "Mood Monotony",
  "情绪单调",
  "Title Collapse",
  "标题重复",
  "Title Clustering",
  "标题聚集",
  "Opening Pattern Repetition",
  "开头同构",
  "Ending Pattern Repetition",
  "结尾同构",
]);

function isSequenceLevelCategory(category: string): boolean {
  return SEQUENCE_LEVEL_CATEGORIES.has(category);
}

interface ImportFoundationSourceOptions {
  readonly maxFullTextChars?: number;
  readonly chapterExcerptChars?: number;
  readonly titleCatalogChars?: number;
  readonly edgeChapterCount?: number;
  readonly middleAnchorCount?: number;
}

const DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS = 80_000;
const DEFAULT_IMPORT_CHAPTER_EXCERPT_CHARS = 6_000;
const DEFAULT_IMPORT_TITLE_CATALOG_CHARS = 24_000;
const DEFAULT_IMPORT_EDGE_CHAPTER_COUNT = 4;
const DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT = 8;

function formatImportedChapter(
  chapter: { readonly title: string; readonly content: string },
  index: number,
  language: LengthLanguage,
  content = chapter.content,
): string {
  return language === "en"
    ? `Chapter ${index + 1}: ${chapter.title}\n\n${content}`
    : `第${index + 1}章 ${chapter.title}\n\n${content}`;
}

function estimateImportFullTextLength(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
): number {
  return chapters.reduce(
    (total, chapter) => total + chapter.title.length + chapter.content.length + 24,
    0,
  );
}

function excerptHeadTail(text: string, maxChars: number, language: LengthLanguage): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const headChars = Math.max(200, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(200, maxChars - headChars);
  const omitted = clean.length - headChars - tailChars;
  const marker =
    language === "en"
      ? `\n\n[... ${omitted} chars omitted for import-context budget ...]\n\n`
      : `\n\n【中间省略 ${omitted} 字，用于控制导入上下文预算】\n\n`;
  return `${clean.slice(0, headChars).trimEnd()}${marker}${clean.slice(-tailChars).trimStart()}`;
}

function pickImportAnchorIndexes(
  chapterCount: number,
  edgeChapterCount: number,
  middleAnchorCount: number,
): ReadonlyArray<number> {
  const selected = new Set<number>();
  for (let i = 0; i < Math.min(edgeChapterCount, chapterCount); i++) selected.add(i);
  for (let i = Math.max(0, chapterCount - edgeChapterCount); i < chapterCount; i++) selected.add(i);

  const middleStart = Math.min(edgeChapterCount, chapterCount);
  const middleEnd = Math.max(middleStart, chapterCount - edgeChapterCount);
  const middleSize = middleEnd - middleStart;
  const anchors = Math.min(middleAnchorCount, middleSize);
  for (let i = 0; i < anchors; i++) {
    const offset = Math.floor(((i + 1) * middleSize) / (anchors + 1));
    selected.add(Math.min(chapterCount - 1, middleStart + offset));
  }

  return [...selected].sort((a, b) => a - b);
}

function buildTitleCatalog(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  maxChars: number,
): string {
  const lines = chapters.map((chapter, index) =>
    language === "en"
      ? `- Chapter ${index + 1}: ${chapter.title} (${chapter.content.length} chars)`
      : `- 第${index + 1}章：${chapter.title}（${chapter.content.length}字）`,
  );
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;

  const headBudget = Math.floor(maxChars * 0.55);
  const tailBudget = maxChars - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  for (const line of lines) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (tailChars + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    tailChars += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  const marker =
    language === "en"
      ? `- ... ${omitted} chapter titles omitted ...`
      : `- ……中间 ${omitted} 个章节标题省略……`;
  return [...head, marker, ...tail].join("\n");
}

export function buildImportFoundationSource(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  options: ImportFoundationSourceOptions = {},
): string {
  const maxFullTextChars =
    options.maxFullTextChars ?? DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS;
  const chapterExcerptChars = options.chapterExcerptChars ?? DEFAULT_IMPORT_CHAPTER_EXCERPT_CHARS;
  const titleCatalogChars = options.titleCatalogChars ?? DEFAULT_IMPORT_TITLE_CATALOG_CHARS;
  const edgeChapterCount = options.edgeChapterCount ?? DEFAULT_IMPORT_EDGE_CHAPTER_COUNT;
  const middleAnchorCount = options.middleAnchorCount ?? DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT;

  if (estimateImportFullTextLength(chapters) <= maxFullTextChars) {
    return chapters
      .map((chapter, index) => formatImportedChapter(chapter, index, language))
      .join("\n\n---\n\n");
  }

  const anchorIndexes = pickImportAnchorIndexes(
    chapters.length,
    edgeChapterCount,
    middleAnchorCount,
  );
  const header =
    language === "en"
      ? [
          "## Import foundation source package",
          "",
          `The imported book has ${chapters.length} chapters. To avoid overflowing the LLM context, this package keeps the opening chapters, ending/continuation point, selected middle anchors, and a capped title catalog. Full chapters will still be replayed sequentially after foundation generation to rebuild truth files.`,
        ].join("\n")
      : [
          "## 导入基础设定压缩资料包",
          "",
          `本次导入共 ${chapters.length} 章。为避免超出 LLM 上下文，这里保留开篇、结尾续写点、少量中段锚点和标题目录；完整章节将在后续顺序回放中逐章分析并沉淀 truth files。`,
        ].join("\n");
  const catalogTitle =
    language === "en" ? "## Capped chapter title catalog" : "## 章节标题目录（截断）";
  const anchorsTitle =
    language === "en" ? "## Source excerpts for architecture" : "## 用于反推基础设定的正文摘录";
  const anchorText = anchorIndexes
    .map((index) => {
      const chapter = chapters[index]!;
      return formatImportedChapter(
        chapter,
        index,
        language,
        excerptHeadTail(chapter.content, chapterExcerptChars, language),
      );
    })
    .join("\n\n---\n\n");

  return [
    header,
    "",
    catalogTitle,
    buildTitleCatalog(chapters, language, titleCatalogChars),
    "",
    anchorsTitle,
    anchorText,
  ].join("\n");
}

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly foundationReviewRetries?: number;
  readonly writingReviewRetries?: number;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly inputGovernanceMode?: InputGovernanceMode;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  /** Optional extension registry. Defaults to built-in registry. */
  readonly registry?: import("../extension/registry.js").ExtensionRegistry;
  /**
   * Model context-window size in tokens.
   * When provided, all agents created by this runner will automatically
   * compress message history via ContextBudgetManager.
   */
  readonly contextWindow?: number;
  /** Optional telemetry tracer for pipeline observability. */
  readonly telemetry?: import("../telemetry/tracer.js").TelemetryTracer;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly revised: boolean;
  readonly status: "ready-for-review" | "audit-failed" | "state-degraded";
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

// Atomic operation results
export interface DraftResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly filePath: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
}

export interface PlanChapterResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly intentPath: string;
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
}

export interface ComposeChapterResult extends PlanChapterResult {
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly applied: boolean;
  readonly status: "unchanged" | "ready-for-review" | "audit-failed";
  readonly skippedReason?: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}
