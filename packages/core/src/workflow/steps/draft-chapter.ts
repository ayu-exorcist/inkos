import type { WorkflowContext } from "../context.js";
import type { Step } from "../step.js";
import type { WriteChapterInput, WriteChapterOutput } from "../../agents/writer.js";
import type { ComposeChapterOutput } from "../../agents/composer.js";
import { WriterAgent } from "../../agents/writer.js";
import { countChapterLength } from "../../utils/length-metrics.js";

export interface DraftChapterInput {
  readonly chapterNumber: number;
  readonly writeInput: Pick<
    WriteChapterInput,
    | "externalContext"
    | "chapterIntent"
    | "chapterMemo"
    | "chapterIntentData"
    | "contextPackage"
    | "ruleStack"
  >;
  readonly temperatureOverride?: number;
}

export interface DraftChapterOutput {
  readonly output: WriteChapterOutput;
  readonly writerCount: number;
}

/**
 * Step 1: Generate the raw chapter draft using the WriterAgent.
 * This replaces the inline writer invocation inside PipelineRunner.writeNextChapter.
 */
export const draftChapterStep: Step<DraftChapterInput, DraftChapterOutput> = {
  name: "draft-chapter",
  nameI18n: { zh: "撰写章节草稿", en: "writing chapter draft" },
  async run(ctx, input) {
    const { chapterNumber, writeInput, temperatureOverride } = input;
    const writer = new WriterAgent(ctx.runner.createAgentContext("writer", ctx.bookId));

    const output = await writer.writeChapter({
      ...writeInput,
      book: ctx.book,
      bookDir: ctx.bookDir,
      chapterNumber,
      lengthSpec: ctx.lengthSpec,
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });

    const writerCount = countChapterLength(output.content, ctx.lengthSpec.countingMode);

    // Store intermediate data in the bag for downstream steps.
    ctx.bag.set("draft:rawOutput", output);
    ctx.bag.set("draft:writerCount", writerCount);

    return { output, writerCount };
  },
};
