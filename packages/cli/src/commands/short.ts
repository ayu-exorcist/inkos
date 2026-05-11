import { Command } from "commander";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  SHORT_HIT_DEFAULT_CHAPTERS,
  SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_HIT_MAX_CHAPTERS,
  SHORT_HIT_MAX_CHARS_PER_CHAPTER,
  SHORT_HIT_MIN_CHAPTERS,
  SHORT_HIT_MIN_CHARS_PER_CHAPTER,
  ShortHitDraftReviewerAgent,
  ShortHitDraftReviserAgent,
  ShortHitOutlineAgent,
  ShortHitOutlineReviewerAgent,
  ShortHitOutlineReviserAgent,
  ShortHitPackagingAgent,
  ShortHitWriterAgent,
  createLLMClient,
  renderShortHitDraftMarkdown,
  validateShortHitDraftForFinal,
  type LLMConfig,
  type Logger,
  type OnStreamProgress,
  type ShortHitBatchDraft,
  type ShortHitOutline,
  type ShortHitReference,
  type ShortHitSalesPackage,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError } from "../utils.js";

export const shortCommand = new Command("short")
  .description("Public-safe commercial short fiction workflow");

shortCommand
  .command("run")
  .description("Run a benchmark-free short fiction chain from a commercial direction")
  .requiredOption("--direction <text>", "Commercial direction, e.g. 女频短篇 婚姻背叛 证据反杀")
  .option("--reference <path>", "Optional public-safe reference notes/text")
  .option("--story-id <id>", "Output story id under shorts/")
  .option("--out-dir <path>", "Output directory", "shorts")
  .option("--chapters <n>", "Complete short chapter count (12-18)", String(SHORT_HIT_DEFAULT_CHAPTERS))
  .option("--chars <n>", "Target characters per chapter (900-1200)", String(SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER))
  .option("--llm-base-url <url>", "Override LLM base URL")
  .option("--model <model>", "Fallback model for all short stages")
  .option("--planner-model <model>", "Model for outline creation/revision")
  .option("--outline-review-model <model>", "Model for outline review")
  .option("--writer-model <model>", "Model for first full draft")
  .option("--draft-review-model <model>", "Model for draft review")
  .option("--revise-model <model>", "Model for second full draft")
  .option("--package-model <model>", "Model for synopsis and cover prompt packaging")
  .option("--cover-base-url <url>", "OpenAI-compatible Responses API base URL for cover generation, e.g. https://api.openai.com/v1")
  .option("--cover-endpoint <url>", "Exact Responses endpoint for cover generation; overrides --cover-base-url")
  .option("--cover-model <model>", "Image-capable Responses model for cover generation", "gpt-5.5")
  .option("--cover-size <size>", "Cover image size", "1024x1360")
  .option("--cover-api-key-env <name>", "Env var containing cover API key", "INKOS_COVER_API_KEY")
  .option("--no-cover", "Skip cover image generation")
  .option("--json", "Output JSON")
  .action(async (opts: ShortRunOptions) => {
    try {
      const root = findProjectRoot();
      const chapterCount = parseBoundedInteger(
        opts.chapters,
        SHORT_HIT_DEFAULT_CHAPTERS,
        "chapters",
        SHORT_HIT_MIN_CHAPTERS,
        SHORT_HIT_MAX_CHAPTERS,
      );
      const charsPerChapter = parseBoundedInteger(
        opts.chars,
        SHORT_HIT_DEFAULT_CHARS_PER_CHAPTER,
        "chars",
        SHORT_HIT_MIN_CHARS_PER_CHAPTER,
        SHORT_HIT_MAX_CHARS_PER_CHAPTER,
      );
      const reference = opts.reference ? await readReference(root, opts.reference) : undefined;
      const models = resolveShortRunModels(opts);

      const plannerRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.planner,
        quiet: Boolean(opts.json),
      });
      const outlineReviewRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.outlineReview,
        quiet: Boolean(opts.json),
      });
      const writerRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.writer,
        quiet: Boolean(opts.json),
      });
      const draftReviewRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.draftReview,
        quiet: Boolean(opts.json),
      });
      const reviseRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.revise,
        quiet: Boolean(opts.json),
      });
      const packageRuntime = await createShortRuntime(root, {
        llmBaseUrl: opts.llmBaseUrl,
        model: models.package,
        quiet: Boolean(opts.json),
      });

      const outlineAgent = new ShortHitOutlineAgent({
        client: plannerRuntime.client,
        model: plannerRuntime.model,
        projectRoot: root,
        logger: plannerRuntime.logger,
        onStreamProgress: plannerRuntime.onStreamProgress,
      });
      const outlineV1 = await outlineAgent.createOutline({
        direction: opts.direction,
        chapterCount,
        charsPerChapter,
        reference,
      });

      const storyId = opts.storyId || slugify(outlineV1.storyTitle || opts.direction);
      const baseDir = join(opts.outDir, storyId);
      await writeText(root, join(baseDir, "outline", "v001.md"), outlineV1.rawContent);

      const outlineReviewer = new ShortHitOutlineReviewerAgent({
        client: outlineReviewRuntime.client,
        model: outlineReviewRuntime.model,
        projectRoot: root,
        logger: outlineReviewRuntime.logger,
        onStreamProgress: outlineReviewRuntime.onStreamProgress,
      });
      const outlineReview = await outlineReviewer.reviewOutline({
        direction: opts.direction,
        outline: outlineV1,
        reference,
      });
      await writeText(root, join(baseDir, "reviews", "outline-v001.md"), outlineReview);

      const outlineReviser = new ShortHitOutlineReviserAgent({
        client: plannerRuntime.client,
        model: plannerRuntime.model,
        projectRoot: root,
        logger: plannerRuntime.logger,
        onStreamProgress: plannerRuntime.onStreamProgress,
      });
      const outlineV2 = await outlineReviser.reviseOutline({
        direction: opts.direction,
        outline: outlineV1,
        review: outlineReview,
        reference,
        chapterCount,
        charsPerChapter,
      });
      await writeText(root, join(baseDir, "outline", "v002.md"), outlineV2.rawContent);

      const writer = new ShortHitWriterAgent({
        client: writerRuntime.client,
        model: writerRuntime.model,
        projectRoot: root,
        logger: writerRuntime.logger,
        onStreamProgress: writerRuntime.onStreamProgress,
      });
      const draftV1 = await writer.writeDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        chapterCount,
        charsPerChapter,
      });
      await writeDraftArtifacts(root, baseDir, "v001", draftV1);

      const draftReviewer = new ShortHitDraftReviewerAgent({
        client: draftReviewRuntime.client,
        model: draftReviewRuntime.model,
        projectRoot: root,
        logger: draftReviewRuntime.logger,
        onStreamProgress: draftReviewRuntime.onStreamProgress,
      });
      const draftReview = await draftReviewer.reviewDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV1,
        chapterCount,
        charsPerChapter,
      });
      await writeText(root, join(baseDir, "reviews", "draft-v001.md"), draftReview);

      const reviser = new ShortHitDraftReviserAgent({
        client: reviseRuntime.client,
        model: reviseRuntime.model,
        projectRoot: root,
        logger: reviseRuntime.logger,
        onStreamProgress: reviseRuntime.onStreamProgress,
      });
      const draftV2 = await reviser.reviseDraft({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV1,
        review: draftReview,
        chapterCount,
        charsPerChapter,
      });
      validateShortHitDraftForFinal(draftV2, { expectedChapters: chapterCount });
      await writeDraftArtifacts(root, baseDir, "v002", draftV2);
      await writeFinalArtifacts(root, baseDir, draftV2);

      const packager = new ShortHitPackagingAgent({
        client: packageRuntime.client,
        model: packageRuntime.model,
        projectRoot: root,
        logger: packageRuntime.logger,
        onStreamProgress: packageRuntime.onStreamProgress,
      });
      const salesPackage = await packager.generatePackage({
        direction: opts.direction,
        outlineMarkdown: outlineV2.rawContent,
        draft: draftV2,
      });
      await writePackageArtifacts(root, baseDir, salesPackage);
      const coverArtifacts: { readonly coverImagePath?: string; readonly coverError?: string } = opts.cover === false
        ? { coverError: "disabled by --no-cover" }
        : await generateCoverArtifact({
            root,
            baseDir,
            salesPackage,
            coverBaseUrl: opts.coverBaseUrl,
            coverEndpoint: opts.coverEndpoint,
            coverModel: opts.coverModel,
            coverSize: opts.coverSize,
            coverApiKeyEnv: opts.coverApiKeyEnv,
          }).catch((error: unknown) => ({ coverError: String(error) }));

      const payload = {
        storyId,
        outlinePath: join(baseDir, "outline", "v002.md"),
        outlineReviewPath: join(baseDir, "reviews", "outline-v001.md"),
        draftReviewPath: join(baseDir, "reviews", "draft-v001.md"),
        finalMarkdownPath: join(baseDir, "final", "full.md"),
        finalJsonPath: join(baseDir, "final", "short-story.json"),
        salesPackagePath: join(baseDir, "final", "sales-package.md"),
        coverPromptPath: join(baseDir, "final", "cover-prompt.md"),
        coverImagePath: coverArtifacts.coverImagePath,
        coverError: coverArtifacts.coverError,
        models,
      };

      if (opts.json) {
        log(JSON.stringify(payload, null, 2));
      } else {
        log(`Short run complete: ${storyId}`);
        log(`Final: ${payload.finalMarkdownPath}`);
        log(`Sales package: ${payload.salesPackagePath}`);
        log(formatCoverStatus(payload.coverImagePath, payload.coverError));
        log("Benchmark: not used");
      }
    } catch (e) {
      logCommandError("Short run failed", e, opts.json);
    }
  });

interface ShortRunOptions {
  readonly direction: string;
  readonly reference?: string;
  readonly storyId?: string;
  readonly outDir: string;
  readonly chapters?: string;
  readonly chars?: string;
  readonly llmBaseUrl?: string;
  readonly model?: string;
  readonly plannerModel?: string;
  readonly outlineReviewModel?: string;
  readonly writerModel?: string;
  readonly draftReviewModel?: string;
  readonly reviseModel?: string;
  readonly packageModel?: string;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
  readonly cover?: boolean;
  readonly json?: boolean;
}

interface ShortRuntime {
  readonly client: ReturnType<typeof createLLMClient>;
  readonly model: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
}

interface ShortRunModels {
  readonly planner?: string;
  readonly outlineReview?: string;
  readonly writer?: string;
  readonly draftReview?: string;
  readonly revise?: string;
  readonly package?: string;
}

function resolveShortRunModels(options: ShortRunOptions): ShortRunModels {
  return {
    planner: options.plannerModel || options.model,
    outlineReview: options.outlineReviewModel || options.model,
    writer: options.writerModel || options.model,
    draftReview: options.draftReviewModel || options.model,
    revise: options.reviseModel || options.model,
    package: options.packageModel || options.model,
  };
}

async function createShortRuntime(
  root: string,
  options: {
    readonly llmBaseUrl?: string;
    readonly model?: string;
    readonly quiet?: boolean;
  },
): Promise<ShortRuntime> {
  try {
    const config = await loadConfig({ projectRoot: root });
    if (options.llmBaseUrl) config.llm.baseUrl = options.llmBaseUrl;
    if (options.model) config.llm.model = options.model;
    const pipelineConfig = buildPipelineConfig(config, root, { quiet: options.quiet });
    return {
      client: pipelineConfig.client,
      model: pipelineConfig.model,
      logger: pipelineConfig.logger,
      onStreamProgress: pipelineConfig.onStreamProgress,
    };
  } catch (e) {
    if (!String(e).includes("inkos.json not found")) throw e;
    const llmConfig = buildEnvLLMConfig(options);
    return {
      client: createLLMClient(llmConfig),
      model: llmConfig.model,
    };
  }
}

function buildEnvLLMConfig(options: {
  readonly llmBaseUrl?: string;
  readonly model?: string;
}): LLMConfig {
  const baseUrl = options.llmBaseUrl ?? process.env.INKOS_LLM_BASE_URL;
  const model = options.model ?? process.env.INKOS_LLM_MODEL;
  if (!baseUrl) throw new Error("LLM base URL is required. Set INKOS_LLM_BASE_URL or pass --llm-base-url.");
  if (!model) throw new Error("LLM model is required. Set INKOS_LLM_MODEL or pass --model.");
  return {
    provider: "openai",
    service: process.env.INKOS_LLM_SERVICE ?? "custom",
    configSource: "env",
    baseUrl,
    apiKey: process.env.INKOS_LLM_API_KEY ?? "",
    model,
    temperature: parseEnvNumber(process.env.INKOS_LLM_TEMPERATURE, 0.1),
    thinkingBudget: parseEnvInteger(process.env.INKOS_LLM_THINKING_BUDGET, 0),
    apiFormat: process.env.INKOS_LLM_API_FORMAT === "responses" ? "responses" : "chat",
    stream: process.env.INKOS_LLM_STREAM === "false" ? false : true,
  };
}

async function readReference(root: string, path: string): Promise<ShortHitReference> {
  const resolved = resolvePath(root, path);
  return {
    path,
    text: await readFile(resolved, "utf-8"),
  };
}

async function writeDraftArtifacts(
  root: string,
  baseDir: string,
  version: string,
  draft: ShortHitBatchDraft,
): Promise<void> {
  const draftDir = join(baseDir, "drafts", version);
  await writeText(root, join(draftDir, "full.md"), renderShortHitDraftMarkdown(draft));
  await writeJson(root, join(draftDir, "draft.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(draftDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writeFinalArtifacts(root: string, baseDir: string, draft: ShortHitBatchDraft): Promise<void> {
  const finalDir = join(baseDir, "final");
  const markdown = renderShortHitDraftMarkdown(draft);
  await writeText(root, join(finalDir, "full.md"), markdown);
  await writeText(root, join(finalDir, `${safeFileName(draft.storyTitle)}.md`), markdown);
  await writeJson(root, join(finalDir, "short-story.json"), draft);
  await Promise.all(draft.chapters.map((chapter) =>
    writeText(root, join(finalDir, "chapters", `${String(chapter.number).padStart(4, "0")}.md`), [
      `# 第${chapter.number}章 ${chapter.title}`,
      "",
      chapter.content,
    ].join("\n")),
  ));
}

async function writePackageArtifacts(root: string, baseDir: string, salesPackage: ShortHitSalesPackage): Promise<void> {
  const finalDir = join(baseDir, "final");
  await writeJson(root, join(finalDir, "sales-package.json"), salesPackage);
  await writeText(root, join(finalDir, "sales-package.md"), [
    `# ${salesPackage.title}`,
    "",
    "## 简介",
    "",
    salesPackage.intro,
    "",
    "## 卖点",
    "",
    ...salesPackage.sellingPoints.map((point) => `- ${point}`),
    "",
    "## 封面提示词",
    "",
    salesPackage.coverPrompt,
  ].join("\n"));
  await writeText(root, join(finalDir, "cover-prompt.md"), salesPackage.coverPrompt || "(empty)");
}

async function generateCoverArtifact(input: {
  readonly root: string;
  readonly baseDir: string;
  readonly salesPackage: ShortHitSalesPackage;
  readonly coverBaseUrl?: string;
  readonly coverEndpoint?: string;
  readonly coverModel?: string;
  readonly coverSize?: string;
  readonly coverApiKeyEnv?: string;
}): Promise<{ readonly coverImagePath: string }> {
  const endpoint = resolveCoverEndpoint(input.coverEndpoint, input.coverBaseUrl);
  const model = input.coverModel || process.env.INKOS_COVER_MODEL || "gpt-5.5";
  const size = input.coverSize || process.env.INKOS_COVER_SIZE || "1024x1360";
  const apiKeyEnv = input.coverApiKeyEnv || "INKOS_COVER_API_KEY";
  const apiKey = resolveCoverApiKey(apiKeyEnv);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      input: buildCoverImagePrompt(input.salesPackage),
      tools: [{ type: "image_generation", size }],
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cover generation failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    throw new Error(`cover generation returned non-JSON response: ${String(e)}`);
  }

  const imageBase64 = extractResponsesImageBase64(payload);
  if (!imageBase64) {
    throw new Error("cover generation response did not include image_generation_call result.");
  }

  const coverPath = join(input.baseDir, "final", "cover.png");
  await writeBinary(input.root, coverPath, Buffer.from(imageBase64, "base64"));
  return { coverImagePath: coverPath };
}

export function extractResponsesImageBase64(payload: unknown): string | undefined {
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;

  for (const item of output) {
    const record = item as { type?: unknown; result?: unknown; content?: unknown };
    if (record.type === "image_generation_call" && typeof record.result === "string" && record.result.trim()) {
      return record.result.trim();
    }
    if (Array.isArray(record.content)) {
      for (const contentItem of record.content) {
        const contentRecord = contentItem as { type?: unknown; result?: unknown; image_base64?: unknown };
        if (typeof contentRecord.result === "string" && contentRecord.result.trim()) return contentRecord.result.trim();
        if (typeof contentRecord.image_base64 === "string" && contentRecord.image_base64.trim()) return contentRecord.image_base64.trim();
      }
    }
  }

  return undefined;
}

export function resolveCoverApiKey(apiKeyEnv: string): string {
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Cover API key is required. Set ${apiKeyEnv} or pass --cover-api-key-env.`);
  }
  return apiKey;
}

function resolveCoverEndpoint(coverEndpoint?: string, coverBaseUrl?: string): string {
  const endpoint = coverEndpoint || process.env.INKOS_COVER_ENDPOINT;
  if (endpoint) return endpoint;
  const baseUrl = coverBaseUrl || process.env.INKOS_COVER_BASE_URL;
  if (!baseUrl) {
    throw new Error("cover endpoint is required. Set INKOS_COVER_BASE_URL or pass --cover-base-url, or use --no-cover.");
  }
  return `${baseUrl.replace(/\/+$/u, "")}/responses`;
}

function buildCoverImagePrompt(salesPackage: ShortHitSalesPackage): string {
  return [
    "为中文商业短篇小说生成手机端平台书封，3:4竖图。",
    `主标题：${salesPackage.title}`,
    salesPackage.intro ? `简介：${salesPackage.intro}` : "",
    salesPackage.sellingPoints.length > 0 ? `卖点：${salesPackage.sellingPoints.join("；")}` : "",
    salesPackage.coverPrompt ? `包装提示：${salesPackage.coverPrompt}` : "",
    "",
    "封面方向：平台短篇书封，不是电影海报。标题字要成为主视觉，预留两到四行大字排版区；人物近景或半身，表情有冷笑、震惊、崩溃、压迫或反杀感；道具少而大，一眼能看出冲突。",
    "颜色高对比、高饱和，适合手机列表缩略图。避免写实会议摄影、横版视频缩略图、杂志大片、小清新细字和长段文字。",
    "如果模型文字不稳定，优先生成明确标题留白/字块/排版空间，不要把大量乱码文字铺满画面。",
  ].filter(Boolean).join("\n");
}

async function writeBinary(root: string, path: string, value: Buffer): Promise<void> {
  const resolved = resolvePath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, value);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  await writeText(root, path, JSON.stringify(value, null, 2));
}

async function writeText(root: string, path: string, value: string): Promise<void> {
  const resolved = resolvePath(root, path);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${value.trimEnd()}\n`, "utf-8");
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseEnvNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || `short-${Date.now()}`;
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:\0*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "short-hit";
}

function formatCoverStatus(coverImagePath?: string, coverError?: string): string {
  if (coverImagePath) return `Cover: ${coverImagePath}`;
  if (coverError) return `Cover: skipped (${coverError})`;
  return "Cover: skipped";
}

function logCommandError(prefix: string, error: unknown, json?: boolean): void {
  if (json) {
    log(JSON.stringify({ error: `${prefix}: ${String(error)}` }, null, 2));
    return;
  }
  logError(`${prefix}: ${String(error)}`);
}
