import type { WorkflowContext } from "../context.js";
import type { Step } from "../step.js";
import type { WriteChapterOutput } from "../../agents/writer.js";
import type { AuditResult } from "../../agents/continuity.js";
import type { ChapterMeta } from "../../models/chapter.js";
import type { LengthTelemetry } from "../../models/length-governance.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { countChapterLength } from "../../utils/length-metrics.js";

export interface PersistChapterInput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly auditResult: AuditResult;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface PersistChapterOutput {
  readonly filePath: string;
  readonly chapterMeta: ChapterMeta;
}

/**
 * Step: Save chapter markdown, update index, snapshot state.
 * Keeps PipelineRunner thin — the actual fs/io logic lives here.
 */
export const persistChapterStep: Step<PersistChapterInput, PersistChapterOutput> = {
  name: "persist",
  nameI18n: { zh: "落盘最终章节", en: "persisting final chapter" },
  async run(ctx, input) {
    const { chapterNumber, title, content, auditResult, lengthTelemetry, tokenUsage } = input;
    const chaptersDir = join(ctx.bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });

    const paddedNum = String(chapterNumber).padStart(4, "0");
    const sanitized = title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
    const filename = `${paddedNum}_${sanitized}.md`;
    const filePath = join(chaptersDir, filename);

    const heading =
      ctx.language === "en"
        ? `# Chapter ${chapterNumber}: ${title}`
        : `# 第${chapterNumber}章 ${title}`;
    await writeFile(filePath, `${heading}\n\n${content}`, "utf-8");

    const now = new Date().toISOString();
    const chapterMeta: ChapterMeta = {
      number: chapterNumber,
      title,
      status: auditResult.passed ? "ready-for-review" : "audit-failed",
      wordCount: countChapterLength(content, ctx.lengthSpec.countingMode),
      createdAt: now,
      updatedAt: now,
      auditIssues: auditResult.issues.map((i) => `[${i.severity}] ${i.description}`),
      lengthWarnings: [],
      lengthTelemetry,
      ...(tokenUsage ? { tokenUsage } : {}),
    };

    const existingIndex = await ctx.state.loadChapterIndex(ctx.bookId);
    const existingIdx = existingIndex.findIndex((e) => e.number === chapterNumber);
    const updatedIndex =
      existingIdx >= 0
        ? existingIndex.map((e, i) => (i === existingIdx ? chapterMeta : e))
        : [...existingIndex, chapterMeta];
    await ctx.state.saveChapterIndex(ctx.bookId, updatedIndex);
    await ctx.state.snapshotState(ctx.bookId, chapterNumber);

    return { filePath, chapterMeta };
  },
};
