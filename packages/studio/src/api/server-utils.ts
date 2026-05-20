import {
  StateManager,
  resolveServicePreset,
  resolveServiceProviderFamily,
  resolveServiceModelsBaseUrl,
  resolveCoverProviderPreset,
  getAllEndpoints,
  createLLMClient,
  chatCompletion,
  fetchWithProxy,
  GLOBAL_ENV_PATH,
  type ProjectConfig,
  type LogEntry,
  type LogSink,
  type ResolvedModel,
} from "@actalk/inkos-core";
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isSafeBookId } from "./safety.js";
import { ApiError } from "./errors.js";

const PIPELINE_STAGES: Record<string, string[]> = {
  writer: [
    "准备章节输入",
    "撰写章节草稿",
    "落盘最终章节",
    "生成最终真相文件",
    "校验真相文件变更",
    "同步记忆索引",
    "更新章节索引与快照",
  ],
  architect: ["生成基础设定", "保存书籍配置", "写入基础设定文件", "初始化控制文档", "创建初始快照"],
  reviser: ["加载修订上下文", "修订章节", "落盘修订结果", "更新索引与快照"],
  auditor: ["审计章节"],
};

const AGENT_LABELS: Record<string, string> = {
  architect: "建书",
  writer: "写作",
  auditor: "审计",
  reviser: "修订",
  exporter: "导出",
};
const TOOL_LABELS: Record<string, string> = {
  read: "读取文件",
  edit: "编辑文件",
  grep: "搜索",
  ls: "列目录",
  short_fiction_run: "短篇生产",
  generate_cover: "生成封面",
};

function resolveToolLabel(tool: string, agent?: string): string {
  if (tool === "sub_agent" && agent) return AGENT_LABELS[agent] ?? agent;
  return TOOL_LABELS[tool] ?? tool;
}

function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 200);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 200);
    if (typeof r.text === "string") return r.text.slice(0, 200);
  }
  return String(result).slice(0, 200);
}

function compareServiceListItems(
  left: { readonly service: string },
  right: { readonly service: string },
): number {
  const priority = ["kkaiapi", "openrouter", "newapi", "siliconcloud"];
  const leftPriority = priority.indexOf(left.service);
  const rightPriority = priority.indexOf(right.service);
  if (leftPriority !== -1 || rightPriority !== -1) {
    return (
      (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority)
    );
  }
  return 0;
}

function isHeaderSafeApiKey(value: string): boolean {
  if (!value) return true;
  return /^[\x21-\x7E]+$/.test(value);
}

const NON_TEXT_MODEL_ID_PARTS = [
  "image",
  "embedding",
  "embed",
  "rerank",
  "tts",
  "speech",
  "audio",
  "moderation",
] as const;

const SERVICE_MODELS_PROBE_TIMEOUT_MS = 4_000;
const SERVICE_CHAT_PROBE_TIMEOUT_MS = 8_000;
const MAX_DISCOVERED_MODELS_TO_PING = 2;
const MAX_GENERIC_FALLBACK_MODELS_TO_PING = 2;

function isTextChatModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  return !NON_TEXT_MODEL_ID_PARTS.some((part) => normalized.includes(part));
}

function filterTextChatModels<T extends { readonly id: string }>(models: ReadonlyArray<T>): T[] {
  return models.filter((model) => isTextChatModelId(model.id));
}

function normalizeApiBookId(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} must be a string`);
  }
  const bookId = value.trim();
  if (!bookId) {
    throw new ApiError(400, "INVALID_BOOK_ID", `${fieldName} cannot be blank`);
  }
  if (!isSafeBookId(bookId)) {
    throw new ApiError(400, "INVALID_BOOK_ID", `Invalid ${fieldName}: "${bookId}"`);
  }
  return bookId;
}

function nonTextModelMessage(modelId: string): string {
  return `模型 ${modelId} 不适合文本聊天/写作。请在模型选择器中改用文本模型，例如 gemini-2.5-flash、gemini-2.5-pro 或对应服务的 chat 模型。`;
}

function extractToolError(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content.slice(0, 500);
    if (r.content && Array.isArray(r.content)) {
      const textPart = r.content.find((c: any) => c.type === "text");
      if (textPart) return (textPart as any).text?.slice(0, 500) ?? "";
    }
  }
  return String(result).slice(0, 500);
}

function resolveProjectImageFile(
  root: string,
  rawPath: string,
): { readonly resolved: string; readonly contentType: string } {
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawPath).replace(/^\/+/u, "");
  } catch {
    // failure expected, safe to ignore
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }

  if (
    !relPath ||
    relPath.includes("\0") ||
    isAbsolute(relPath) ||
    relPath.split(/[\\/]+/u).includes("..")
  ) {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }
  if (!relPath.startsWith("shorts/") && !relPath.startsWith("covers/")) {
    throw new ApiError(
      400,
      "INVALID_PROJECT_FILE_PATH",
      "Only generated shorts/ and covers/ images can be previewed",
    );
  }

  const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
  const contentTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const contentType = contentTypes[ext];
  if (!contentType) {
    throw new ApiError(415, "UNSUPPORTED_PROJECT_FILE_TYPE", "Unsupported project file type");
  }

  const resolved = resolve(root, relPath);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ApiError(400, "INVALID_PROJECT_FILE_PATH", "Invalid project file path");
  }
  return { resolved, contentType };
}

function isLikelyFailedToolResult(exec: CollectedToolExec): boolean {
  if (exec.status === "error") return true;
  const text = `${exec.error ?? ""}\n${exec.result ?? ""}`.toLowerCase();
  return /\bfailed\b|\berror\b|失败|异常|出错/.test(text);
}

function hasSuccessfulSubAgentExec(
  execs: ReadonlyArray<CollectedToolExec>,
  agent: string,
): boolean {
  return execs.some(
    (exec) =>
      exec.tool === "sub_agent" &&
      exec.agent === agent &&
      exec.status === "completed" &&
      !isLikelyFailedToolResult(exec),
  );
}

function isWriteNextInstruction(instruction: string): boolean {
  const trimmed = instruction.trim();
  return (
    /^(continue|继续|继续写|写下一章|write next|下一章|再来一章)$/i.test(trimmed) ||
    /(继续写|写下一章|下一章|再来一章|write\s+next)/i.test(trimmed)
  );
}

type ExternalChatEditResult = {
  readonly responseText: string;
  readonly activeBookId?: string;
};

const CHAT_EDIT_WARNING = "[warning] Chat external edit requires review before continuation.";
const CHAT_EDIT_TEXT_EXTENSIONS = /\.(md|txt|json|ya?ml)$/i;
const CHAT_EDIT_ALLOWED_ROOTS = new Set(["books", "shorts", "covers", "genres"]);

function parseReplacementInstruction(
  instruction: string,
): { oldText: string; newText: string } | null {
  const inFileQuoted = instruction.match(
    /(?:里|里的|中|中的|里面)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/,
  );
  if (inFileQuoted?.[1] && inFileQuoted[2] !== undefined) {
    return { oldText: inFileQuoted[1], newText: inFileQuoted[2] };
  }
  const quoted = instruction.match(
    /(?:把|将)\s*[「“"]([\s\S]+?)[」”"]\s*(?:改成|替换成|换成)\s*[「“"]([\s\S]+?)[」”"]/,
  );
  if (quoted?.[1] && quoted[2] !== undefined) {
    return { oldText: quoted[1], newText: quoted[2] };
  }
  const plain = instruction.match(
    /(?:把|将)\s+([^\s，。；;]+)\s*(?:改成|替换成|换成)\s+([^\n，。；;]+)/,
  );
  if (plain?.[1] && plain[2] !== undefined) {
    return { oldText: plain[1], newText: plain[2].trim() };
  }
  return null;
}

function parseChapterNumberForEdit(instruction: string): number | null {
  const match = instruction.match(/第\s*(\d{1,4})\s*章/);
  if (!match?.[1]) return null;
  const chapterNumber = Number.parseInt(match[1], 10);
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : null;
}

function parseExplicitEditPath(instruction: string): string | null {
  const match = instruction.match(
    /(?:把|将)\s+([^「“"\s，。；;]+?\.[A-Za-z0-9]+)\s*(?:里|里的|中|中的|里面)/,
  );
  return match?.[1]?.trim() ?? null;
}

function countContentUnits(content: string): number {
  const stripped = content.replace(/^#{1,6}\s+.*$/gm, "").trim();
  if (!stripped) return 0;
  if (/[\u3400-\u9fff]/.test(stripped)) {
    return stripped.replace(/\s/g, "").length;
  }
  return stripped.split(/\s+/).filter(Boolean).length;
}

function resolveExternalChatEditPath(
  root: string,
  requestedPath: string,
): { path: string; rel: string } {
  if (isAbsolute(requestedPath)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHAT_EDIT_TARGET",
      "Chat external edits only support project-relative content paths.",
    );
  }
  const projectRoot = resolve(root);
  const resolved = resolve(projectRoot, requestedPath);
  const rel = relative(projectRoot, resolved).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..") {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHAT_EDIT_TARGET",
      "Chat external edit path escapes the project root.",
    );
  }
  const first = rel.split("/")[0] ?? "";
  if (!CHAT_EDIT_ALLOWED_ROOTS.has(first)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHAT_EDIT_TARGET",
      "Chat external edits cannot modify source code, config, or arbitrary project files.",
    );
  }
  if (
    rel.includes("/.inkos/") ||
    rel.endsWith("/.inkos") ||
    rel.includes("/secrets") ||
    rel.endsWith(".env")
  ) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHAT_EDIT_TARGET",
      "Chat external edits cannot modify secrets or runtime internals.",
    );
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(rel)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_CHAT_EDIT_TARGET",
      "Chat external edits only support text content files.",
    );
  }
  return { path: resolved, rel };
}

async function findChapterFile(
  root: string,
  bookId: string,
  chapterNumber: number,
): Promise<string | null> {
  const chaptersDir = join(root, "books", bookId, "chapters");
  const padded = String(chapterNumber).padStart(4, "0");
  const files = await readdir(chaptersDir).catch(() => []);
  const match = files.find((file) => file.startsWith(`${padded}_`) && file.endsWith(".md"));
  return match ? join(chaptersDir, match) : null;
}

function parseBookChapterFromRelativePath(
  rel: string,
): { bookId: string; chapterNumber: number } | null {
  const match = rel.match(/^books\/([^/]+)\/chapters\/(\d{4})_[^/]+\.md$/);
  if (!match?.[1] || !match[2]) return null;
  const chapterNumber = Number.parseInt(match[2], 10);
  return Number.isInteger(chapterNumber) ? { bookId: match[1], chapterNumber } : null;
}

async function syncExternalChapterEdit(params: {
  readonly state: StateManager;
  readonly root: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly content: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const index = [...(await params.state.loadChapterIndex(params.bookId))];
  const updated = index.map((chapter) =>
    chapter.number === params.chapterNumber
      ? {
          ...chapter,
          status: "audit-failed" as const,
          wordCount: countContentUnits(params.content),
          updatedAt: now,
          auditIssues: [
            ...chapter.auditIssues.filter((issue) => issue !== CHAT_EDIT_WARNING),
            CHAT_EDIT_WARNING,
          ],
        }
      : chapter,
  );
  if (updated.length > 0) {
    await params.state.saveChapterIndex(params.bookId, updated);
  }

  const runtimeDir = join(params.root, "books", params.bookId, "story", "runtime");
  const padded = String(params.chapterNumber).padStart(4, "0");
  const runtimeFiles = await readdir(runtimeDir).catch(() => []);
  await Promise.all(
    runtimeFiles
      .filter((file) => file.startsWith(`chapter-${padded}.`))
      .map((file) => rm(join(runtimeDir, file), { force: true })),
  );
}

async function tryHandleExternalChatEdit(params: {
  readonly root: string;
  readonly state: StateManager;
  readonly instruction: string;
  readonly activeBookId: string | null;
}): Promise<ExternalChatEditResult | null> {
  const replacement = parseReplacementInstruction(params.instruction);
  if (!replacement) return null;

  const explicitPath = parseExplicitEditPath(params.instruction);
  if (explicitPath) {
    const target = resolveExternalChatEditPath(params.root, explicitPath);
    const content = await readFile(target.path, "utf-8").catch((error) => {
      throw new ApiError(
        404,
        "CHAT_EDIT_TARGET_NOT_FOUND",
        error instanceof Error ? error.message : String(error),
      );
    });
    const first = content.indexOf(replacement.oldText);
    if (first === -1) {
      throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标文件中找到。");
    }
    if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
      throw new ApiError(
        400,
        "EDIT_TARGET_AMBIGUOUS",
        "要替换的原文出现多次，请给出更具体的一段。",
      );
    }
    const updated =
      content.slice(0, first) +
      replacement.newText +
      content.slice(first + replacement.oldText.length);
    await writeFile(target.path, updated, "utf-8");

    const chapterTarget = parseBookChapterFromRelativePath(target.rel);
    if (chapterTarget) {
      await syncExternalChapterEdit({
        state: params.state,
        root: params.root,
        bookId: chapterTarget.bookId,
        chapterNumber: chapterTarget.chapterNumber,
        content: updated,
      });
    }

    return {
      activeBookId: chapterTarget?.bookId ?? params.activeBookId ?? undefined,
      responseText: `已直接编辑 ${target.rel}${chapterTarget ? "，并标记为需要复核" : ""}。`,
    };
  }

  if (!params.activeBookId) return null;
  const chapterNumber = parseChapterNumberForEdit(params.instruction);
  if (!replacement || !chapterNumber) return null;

  const chapterPath = await findChapterFile(params.root, params.activeBookId, chapterNumber);
  if (!chapterPath) {
    throw new ApiError(
      404,
      "CHAPTER_NOT_FOUND",
      `Chapter ${chapterNumber} not found in ${params.activeBookId}`,
    );
  }
  if (!CHAT_EDIT_TEXT_EXTENSIONS.test(chapterPath)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_EDIT_TARGET",
      "Chat external edits only support text files.",
    );
  }

  const content = await readFile(chapterPath, "utf-8");
  const first = content.indexOf(replacement.oldText);
  if (first === -1) {
    throw new ApiError(400, "EDIT_TARGET_NOT_FOUND", "要替换的原文没有在目标章节中找到。");
  }
  if (content.indexOf(replacement.oldText, first + replacement.oldText.length) !== -1) {
    throw new ApiError(400, "EDIT_TARGET_AMBIGUOUS", "要替换的原文出现多次，请给出更具体的一段。");
  }

  const updated =
    content.slice(0, first) +
    replacement.newText +
    content.slice(first + replacement.oldText.length);
  await writeFile(chapterPath, updated, "utf-8");
  await syncExternalChapterEdit({
    state: params.state,
    root: params.root,
    bookId: params.activeBookId,
    chapterNumber,
    content: updated,
  });

  return {
    activeBookId: params.activeBookId,
    responseText: `已直接编辑 ${params.activeBookId} 第 ${chapterNumber} 章，并标记为需要复核。`,
  };
}

function looksLikeBookCreatedClaim(responseText: string): boolean {
  return (
    /(?:已|已经|成功).{0,12}(?:创建|建书|初始化|保存).{0,12}(?:作品|书|书籍|文件夹)?/.test(
      responseText,
    ) || /\b(?:created|initiali[sz]ed|saved)\b.{0,40}\b(?:book|project|novel)\b/i.test(responseText)
  );
}

function validateAgentActionExecution(args: {
  readonly instruction: string;
  readonly agentBookId: string | null | undefined;
  readonly responseText: string;
  readonly collectedToolExecs: ReadonlyArray<CollectedToolExec>;
}): string | undefined {
  const failedExec = args.collectedToolExecs.find(isLikelyFailedToolResult);
  if (failedExec) {
    return `${failedExec.label} 执行失败：${failedExec.error ?? failedExec.result ?? "未知错误"}`;
  }

  if (
    args.agentBookId &&
    isWriteNextInstruction(args.instruction) &&
    !hasSuccessfulSubAgentExec(args.collectedToolExecs, "writer")
  ) {
    return "模型声称已完成下一章，但没有实际调用写作工具。请重试；如果仍失败，请检查模型是否支持工具调用。";
  }

  if (
    !args.agentBookId &&
    looksLikeBookCreatedClaim(args.responseText) &&
    !resolveCreatedBookIdFromToolExecs(args.collectedToolExecs)
  ) {
    return "模型声称已创建作品，但没有实际调用建书工具，也没有生成作品文件。请补充书名/题材后重试，或换用支持工具调用的模型。";
  }

  return undefined;
}

interface CollectedToolExec {
  id: string;
  tool: string;
  agent?: string;
  label: string;
  status: "running" | "completed" | "error";
  args?: Record<string, unknown>;
  result?: string;
  details?: unknown;
  error?: string;
  stages?: Array<{ label: string; status: "pending" | "completed" }>;
  startedAt: number;
  completedAt?: number;
}

interface StudioBookListSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly [key: string]: unknown;
}

// --- Event bus for SSE ---

type EventHandler = (event: string, data: unknown) => void;
const subscribers = new Set<EventHandler>();
const bookCreateStatus = new Map<string, { status: "creating" | "error"; error?: string }>();

// 内存缓存：service -> 模型列表 + 更新时间戳；避免每次 sidebar 挂载时都打真实 LLM /models
const modelListCache = new Map<
  string,
  { models: Array<{ id: string; name: string }>; at: number }
>();

interface ServiceConfigEntry {
  service: string;
  name?: string;
  baseUrl?: string;
  temperature?: number;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
}

type LLMConfigSource = "env" | "studio";

interface EnvConfigSummary {
  detected: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
}

interface EnvConfigStatus {
  project: EnvConfigSummary;
  global: EnvConfigSummary;
  effectiveSource: "project" | "global" | null;
  runtimeUsesEnv: false;
}

interface ServiceProbeResult {
  ok: boolean;
  models: Array<{ id: string; name: string }>;
  selectedModel?: string;
  apiFormat?: "chat" | "responses";
  stream?: boolean;
  baseUrl?: string;
  modelsSource?: "api" | "fallback";
  error?: string;
}

function broadcast(event: string, data: unknown): void {
  for (const handler of subscribers) {
    handler(event, data);
  }
}

function deriveBookIdFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function resolveArchitectBookIdFromArgs(args?: Record<string, unknown>): string | null {
  if (!args || args.agent !== "architect" || args.revise === true) return null;
  if (typeof args.bookId === "string" && args.bookId.trim()) return args.bookId.trim();
  if (typeof args.title === "string" && args.title.trim()) {
    return deriveBookIdFromTitle(args.title) || null;
  }
  return null;
}

function resolveCreatedBookIdFromToolExecs(execs: ReadonlyArray<CollectedToolExec>): string | null {
  for (let i = execs.length - 1; i >= 0; i -= 1) {
    const exec = execs[i];
    if (exec.tool !== "sub_agent" || exec.agent !== "architect" || exec.status !== "completed")
      continue;

    const details = exec.details as { kind?: unknown; bookId?: unknown } | undefined;
    if (
      details?.kind === "book_created" &&
      typeof details.bookId === "string" &&
      details.bookId.trim()
    ) {
      return details.bookId.trim();
    }

    const fromArgs = resolveArchitectBookIdFromArgs(exec.args);
    if (fromArgs) return fromArgs;
  }
  return null;
}

async function loadStudioBookListSummary(
  state: StateManager,
  bookId: string,
): Promise<StudioBookListSummary> {
  const book = await state.loadBookConfig(bookId);
  const nextChapter = await state.getNextChapterNumber(bookId);
  return { ...book, chaptersWritten: nextChapter - 1 };
}

function isCustomServiceId(serviceId: string): boolean {
  return serviceId === "custom" || serviceId.startsWith("custom:");
}

function serviceConfigKey(entry: ServiceConfigEntry): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

function normalizeServiceEntry(
  serviceId: string,
  value: Record<string, unknown>,
): ServiceConfigEntry {
  if (serviceId.startsWith("custom:")) {
    return {
      service: "custom",
      name: decodeURIComponent(serviceId.slice("custom:".length)),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0
        ? { baseUrl: value.baseUrl }
        : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses"
        ? { apiFormat: value.apiFormat }
        : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  if (serviceId === "custom") {
    return {
      service: "custom",
      ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
      ...(typeof value.baseUrl === "string" && value.baseUrl.length > 0
        ? { baseUrl: value.baseUrl }
        : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
      ...(value.apiFormat === "chat" || value.apiFormat === "responses"
        ? { apiFormat: value.apiFormat }
        : {}),
      ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    };
  }

  return {
    service: serviceId,
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(value.apiFormat === "chat" || value.apiFormat === "responses"
      ? { apiFormat: value.apiFormat }
      : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
  };
}

function normalizeConfigSource(value: unknown): LLMConfigSource {
  return value === "studio" ? "studio" : "env";
}

function normalizeServiceConfig(raw: unknown): ServiceConfigEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
      )
      .map((entry) => ({
        service:
          typeof entry.service === "string" && entry.service.length > 0 ? entry.service : "custom",
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        ...(typeof entry.baseUrl === "string" && entry.baseUrl.length > 0
          ? { baseUrl: entry.baseUrl }
          : {}),
        ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
        ...(entry.apiFormat === "chat" || entry.apiFormat === "responses"
          ? { apiFormat: entry.apiFormat }
          : {}),
        ...(typeof entry.stream === "boolean" ? { stream: entry.stream } : {}),
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value && typeof value === "object")
      .map(([serviceId, value]) =>
        normalizeServiceEntry(serviceId, value as Record<string, unknown>),
      );
  }

  return [];
}

function mergeServiceConfig(
  existing: ServiceConfigEntry[],
  updates: ServiceConfigEntry[],
): ServiceConfigEntry[] {
  const merged = new Map(existing.map((entry) => [serviceConfigKey(entry), entry]));
  for (const update of updates) {
    merged.set(serviceConfigKey(update), update);
  }
  return [...merged.values()];
}

function normalizeCoverConfig(raw: unknown): { service: string; model: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const service = typeof record.service === "string" ? record.service : "";
  const preset = resolveCoverProviderPreset(service);
  if (!preset) return undefined;
  const requestedModel = typeof record.model === "string" ? record.model.trim() : "";
  const model =
    requestedModel && preset.models.includes(requestedModel) ? requestedModel : preset.defaultModel;
  return { service: preset.service, model };
}

function syncTopLevelLlmMirror(llm: Record<string, unknown>): void {
  const selectedService = typeof llm.service === "string" ? llm.service : undefined;
  if (!selectedService) return;

  const services = normalizeServiceConfig(llm.services);
  const selectedEntry =
    services.find((entry) => serviceConfigKey(entry) === selectedService) ??
    (!isCustomServiceId(selectedService) ? { service: selectedService } : undefined);
  if (!selectedEntry) return;

  const preset = resolveServicePreset(selectedEntry.service);
  llm.provider = resolveServiceProviderFamily(selectedEntry.service) ?? "openai";
  llm.baseUrl = selectedEntry.baseUrl ?? preset?.baseUrl ?? "";

  const defaultModel = typeof llm.defaultModel === "string" ? llm.defaultModel.trim() : "";
  if (defaultModel) llm.model = defaultModel;
  if (selectedEntry.temperature !== undefined) llm.temperature = selectedEntry.temperature;
  if (selectedEntry.apiFormat !== undefined) llm.apiFormat = selectedEntry.apiFormat;
  if (selectedEntry.stream !== undefined) llm.stream = selectedEntry.stream;
}

async function loadRawConfig(root: string): Promise<Record<string, unknown>> {
  const configPath = join(root, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function saveRawConfig(root: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
}

async function readEnvConfigSummary(path: string): Promise<EnvConfigSummary> {
  try {
    const raw = await readFile(path, "utf-8");
    const values = new Map<string, string>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      values.set(key, value.trim());
    }

    const provider = values.get("INKOS_LLM_PROVIDER") ?? null;
    const baseUrl = values.get("INKOS_LLM_BASE_URL") ?? null;
    const model = values.get("INKOS_LLM_MODEL") ?? null;
    const apiKey = values.get("INKOS_LLM_API_KEY") ?? "";
    const detected = Boolean(provider || baseUrl || model || apiKey);

    return {
      detected,
      provider,
      baseUrl,
      model,
      hasApiKey: apiKey.length > 0,
    };
  } catch {
    // failure expected, safe to ignore
    return {
      detected: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasApiKey: false,
    };
  }
}

async function readEnvConfigStatus(root: string): Promise<EnvConfigStatus> {
  const project = await readEnvConfigSummary(join(root, ".env"));
  const global = await readEnvConfigSummary(GLOBAL_ENV_PATH);
  return {
    project,
    global,
    effectiveSource: project.detected ? "project" : global.detected ? "global" : null,
    runtimeUsesEnv: false,
  };
}

async function resolveConfiguredServiceBaseUrl(
  root: string,
  serviceId: string,
  inlineBaseUrl?: string,
): Promise<string | undefined> {
  if (inlineBaseUrl?.trim()) return inlineBaseUrl.trim();

  if (!isCustomServiceId(serviceId)) {
    return resolveServicePreset(serviceId)?.baseUrl;
  }

  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig(
      (config.llm as Record<string, unknown> | undefined)?.services,
    );
    const matched = services.find((entry) => serviceConfigKey(entry) === serviceId);
    return matched?.baseUrl;
  } catch {
    // failure expected, safe to ignore
    return undefined;
  }
}

async function resolveConfiguredServiceEntry(
  root: string,
  serviceId: string,
): Promise<ServiceConfigEntry | undefined> {
  try {
    const config = await loadRawConfig(root);
    const services = normalizeServiceConfig(
      (config.llm as Record<string, unknown> | undefined)?.services,
    );
    return services.find((entry) => serviceConfigKey(entry) === serviceId);
  } catch {
    // failure expected, safe to ignore
    return undefined;
  }
}

function buildProbePlans(
  preferredApiFormat: "chat" | "responses" | undefined,
  preferredStream: boolean | undefined,
): Array<{ apiFormat: "chat" | "responses"; stream: boolean }> {
  const candidates: Array<{ apiFormat: "chat" | "responses"; stream: boolean }> = [];
  const seen = new Set<string>();
  const push = (apiFormat: "chat" | "responses", stream: boolean) => {
    const key = `${apiFormat}:${stream ? "1" : "0"}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ apiFormat, stream });
  };

  if (preferredApiFormat) {
    push(preferredApiFormat, preferredStream ?? false);
    if (preferredStream) push(preferredApiFormat, false);
    return candidates;
  }

  push("chat", false);
  push("responses", false);
  return candidates;
}

function buildModelCandidates(args: {
  preferredModel?: string;
  configModel?: string;
  envModel?: string | null;
  discoveredModels: Array<{ id: string; name: string }>;
  includeGenericFallbacks?: boolean;
}): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (!value || value.trim().length === 0) return;
    const id = value.trim();
    if (seen.has(id)) return;
    seen.add(id);
    candidates.push(id);
  };

  push(args.preferredModel);
  push(args.configModel);
  push(args.envModel ?? undefined);
  for (const model of args.discoveredModels.slice(0, MAX_DISCOVERED_MODELS_TO_PING)) push(model.id);
  if (args.includeGenericFallbacks === false) return candidates;
  for (const fallback of [
    "gpt-5.4",
    "gpt-4o",
    "claude-sonnet-4-6",
    "MiniMax-M2.7",
    "kimi-k2.5",
  ].slice(0, MAX_GENERIC_FALLBACK_MODELS_TO_PING)) {
    push(fallback);
  }
  return candidates;
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function radarTimestampForFilename(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[:.]/g, "-");
}

async function saveRadarScan(root: string, result: unknown): Promise<string> {
  const radarDir = join(root, "radar");
  await mkdir(radarDir, { recursive: true });
  const timestamp =
    typeof result === "object" && result !== null && "timestamp" in result
      ? String((result as { timestamp?: unknown }).timestamp ?? "")
      : "";
  const fileName = `scan-${radarTimestampForFilename(timestamp)}.json`;
  const filePath = join(radarDir, fileName);
  await writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

async function loadRadarHistory(root: string): Promise<
  Array<{
    readonly file: string;
    readonly timestamp: string;
    readonly marketSummary: string;
    readonly summaryPreview: string;
    readonly result: unknown;
  }>
> {
  const radarDir = join(root, "radar");
  let files: string[] = [];
  try {
    files = await readdir(radarDir);
  } catch {
    // failure expected, safe to ignore
    return [];
  }

  const scans = await Promise.all(
    files
      .filter((file) => /^scan-.+\.json$/.test(file))
      .map(async (file) => {
        try {
          const raw = await readFile(join(radarDir, file), "utf-8");
          const result = JSON.parse(raw) as { timestamp?: unknown; marketSummary?: unknown };
          const timestamp =
            typeof result.timestamp === "string"
              ? result.timestamp
              : file.replace(/^scan-/, "").replace(/\.json$/, "");
          const marketSummary =
            typeof result.marketSummary === "string" ? result.marketSummary : "";
          return {
            file,
            timestamp,
            marketSummary,
            summaryPreview: marketSummary.slice(0, 100),
            result,
          };
        } catch {
          // failure expected, safe to ignore
          return null;
        }
      }),
  );

  return scans
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.file.localeCompare(a.file));
}

function fallbackTextModelsForEndpoint(
  endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined,
  preset: ReturnType<typeof resolveServicePreset> | undefined,
): Array<{ id: string; name: string }> {
  const endpointModels =
    endpoint?.models
      .filter((model) => model.enabled !== false)
      .filter((model) => isTextChatModelId(model.id))
      .map((model) => ({ id: model.id, name: model.id })) ?? [];
  if (endpointModels.length > 0) return endpointModels;
  return preset?.knownModels?.map((id) => ({ id, name: id })) ?? [];
}

function shouldTrustStaticModelsWhenLiveListUnavailable(
  endpoint: ReturnType<typeof getAllEndpoints>[number] | undefined,
): boolean {
  return endpoint?.group === "aggregator";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function formatServiceProbeError(args: {
  readonly service: string;
  readonly label?: string;
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiFormat?: "chat" | "responses";
  readonly stream?: boolean;
  readonly error: string;
}): string {
  const rawDetail = args.error.replace(/\n\s*\(baseUrl:[\s\S]*?\)$/m, "").trim();
  const upstreamDetail = rawDetail.includes("上游详情：") ? rawDetail : "";
  const context = [
    `服务商：${args.label ?? args.service}`,
    `测试模型：${args.model ?? "未确定"}`,
    `协议：${args.apiFormat === "responses" ? "Responses" : "Chat / Completions"}${typeof args.stream === "boolean" ? `，${args.stream ? "流式" : "非流式"}` : ""}`,
    `Base URL：${args.baseUrl}`,
  ].join("\n");

  if (args.service === "google") {
    return [
      "Google Gemini 测试连接失败。",
      context,
      "",
      "请优先检查：",
      "1. API Key 是否来自 Google AI Studio 的 Gemini API key，而不是 OAuth、Vertex AI 或其它 Google 服务凭据。",
      "2. 该 key 所属项目是否已启用 Gemini API，并且没有被限制到其它 API、来源或服务。",
      "3. 当前地区/账号是否允许访问 Gemini API。",
      "4. 如果 key 曾经泄露，请在 AI Studio 重新生成后再保存。",
      upstreamDetail ? `\n上游返回：${upstreamDetail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    args.service === "moonshot" ||
    args.service === "kimiCodingPlan" ||
    args.service === "kimicode"
  ) {
    return [
      `${args.label ?? args.service} 测试连接失败。`,
      context,
      "",
      "请优先检查模型是否可用，以及 kimi-k2.x 这类模型是否需要 temperature=1。",
      rawDetail ? `\n上游返回：${rawDetail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `${args.label ?? args.service} 测试连接失败。`,
    context,
    "",
    "请检查 API Key、模型可用性、账号额度，以及协议类型是否匹配该服务商。",
    rawDetail ? `\n上游返回：${rawDetail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function fetchModelsFromServiceBaseUrl(
  serviceId: string,
  baseUrl: string,
  apiKey: string,
  proxyUrl?: string,
): Promise<{ models: Array<{ id: string; name: string }>; error?: string; authFailed?: boolean }> {
  const endpoint = isCustomServiceId(serviceId)
    ? undefined
    : getAllEndpoints().find((ep) => ep.id === serviceId);
  const modelsBaseUrl = isCustomServiceId(serviceId)
    ? baseUrl
    : (endpoint?.modelsBaseUrl ??
      (endpoint ? baseUrl : (resolveServiceModelsBaseUrl(serviceId) ?? baseUrl)));
  const modelsUrl = modelsBaseUrl.replace(/\/$/, "") + "/models";
  try {
    const res = await fetchWithProxy(
      modelsUrl,
      {
        headers: buildBearerAuthHeaders(apiKey),
        signal: AbortSignal.timeout(SERVICE_MODELS_PROBE_TIMEOUT_MS),
      },
      proxyUrl,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        models: [],
        error: `服务商返回 ${res.status}: ${body.slice(0, 200)}`,
        authFailed: res.status === 401 || res.status === 403,
      };
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return {
      models: (json.data ?? []).map((m) => ({ id: m.id, name: m.id })),
    };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildBearerAuthHeaders(apiKey: string | undefined): Record<string, string> {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return {};
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new Error("API Key 只能包含英文、数字和常见 ASCII 符号，请检查是否误粘贴了中文说明。");
  }
  return { Authorization: `Bearer ${trimmed}` };
}

async function probeServiceCapabilities(args: {
  root: string;
  service: string;
  apiKey: string;
  baseUrl: string;
  preferredApiFormat?: "chat" | "responses";
  preferredStream?: boolean;
  preferredModel?: string;
  proxyUrl?: string;
}): Promise<ServiceProbeResult> {
  const rawConfig = await loadRawConfig(args.root).catch(() => ({}) as Record<string, unknown>);
  const llm = (rawConfig.llm as Record<string, unknown> | undefined) ?? {};
  const envConfig = await readEnvConfigStatus(args.root);
  const envModel =
    envConfig.effectiveSource === "project"
      ? envConfig.project.model
      : envConfig.effectiveSource === "global"
        ? envConfig.global.model
        : null;

  const baseService = isCustomServiceId(args.service) ? "custom" : args.service;
  const modelsResponse = await fetchModelsFromServiceBaseUrl(
    baseService,
    args.baseUrl,
    args.apiKey,
    args.proxyUrl,
  );
  if (modelsResponse.authFailed) {
    return {
      ok: false,
      models: [],
      error: modelsResponse.error ?? "API Key 无效或无权访问模型列表。",
    };
  }
  const discoveredModels = modelsResponse.models;
  const endpoint = getAllEndpoints().find((ep) => ep.id === baseService);
  const preset = resolveServicePreset(baseService);
  const discoveredFirstModel =
    discoveredModels.find((model) => isTextChatModelId(model.id))?.id ?? discoveredModels[0]?.id;
  if (discoveredModels.length > 0) {
    if (!discoveredFirstModel || !isTextChatModelId(discoveredFirstModel)) {
      return {
        ok: false,
        models: discoveredModels,
        error: "模型列表可访问，但没有发现可用于文本对话的模型。",
      };
    }
    return {
      ok: true,
      models: discoveredModels,
      selectedModel: discoveredFirstModel,
      apiFormat: args.preferredApiFormat ?? "chat",
      stream: args.preferredStream ?? false,
      baseUrl: args.baseUrl,
      modelsSource: "api",
    };
  }
  if (shouldTrustStaticModelsWhenLiveListUnavailable(endpoint)) {
    const models = fallbackTextModelsForEndpoint(endpoint, preset);
    const selectedModel =
      endpoint?.checkModel && models.some((model) => model.id === endpoint.checkModel)
        ? endpoint.checkModel
        : models[0]?.id;
    if (selectedModel) {
      return {
        ok: true,
        models,
        selectedModel,
        apiFormat: args.preferredApiFormat ?? "chat",
        stream: args.preferredStream ?? false,
        baseUrl: args.baseUrl,
        modelsSource: "fallback",
      };
    }
  }
  // Prefer live /models results; if unavailable, probe with the service's own check model before global defaults.
  const serviceFirstModel =
    endpoint?.checkModel ??
    preset?.knownModels?.[0] ??
    endpoint?.models.find((model) => model.enabled !== false)?.id;
  const useDynamicLocalModels = baseService === "ollama";
  const useEndpointCheckModel =
    !useDynamicLocalModels &&
    !isCustomServiceId(args.service) &&
    discoveredModels.length === 0 &&
    Boolean(endpoint?.checkModel);
  const configService = typeof llm.service === "string" ? llm.service : undefined;
  const configModel =
    !useEndpointCheckModel && configService === args.service
      ? typeof llm.defaultModel === "string"
        ? llm.defaultModel
        : typeof llm.model === "string"
          ? llm.model
          : undefined
      : undefined;
  const useCustomFallbacks = false;
  const modelCandidates = buildModelCandidates({
    preferredModel: args.preferredModel ?? serviceFirstModel,
    configModel,
    envModel: useCustomFallbacks ? envModel : undefined,
    discoveredModels: useEndpointCheckModel ? [] : discoveredModels,
    includeGenericFallbacks: useCustomFallbacks,
  });

  if (modelCandidates.length === 0) {
    return {
      ok: false,
      models: [],
      error: "无法自动确定模型，请先填写可用模型或提供支持 /models 的服务端点。",
    };
  }

  let lastError = modelsResponse.error ?? "自动探测失败";

  for (const model of modelCandidates) {
    for (const plan of buildProbePlans(args.preferredApiFormat, args.preferredStream)) {
      const client = createLLMClient({
        provider: resolveServiceProviderFamily(baseService) ?? "openai",
        service: baseService,
        configSource: "studio",
        baseUrl: args.baseUrl,
        apiKey: args.apiKey.trim(),
        model,
        temperature: 0.7,
        maxTokens: 16,
        thinkingBudget: 0,
        proxyUrl: args.proxyUrl,
        apiFormat: plan.apiFormat,
        stream: plan.stream,
      } as ProjectConfig["llm"]);

      try {
        await withTimeout(
          chatCompletion(client, model, [{ role: "user", content: "Reply with OK only." }], {
            maxTokens: 16,
          }),
          SERVICE_CHAT_PROBE_TIMEOUT_MS,
          "service connection test",
        );
        const models =
          discoveredModels.length > 0
            ? discoveredModels
            : fallbackTextModelsForEndpoint(endpoint, preset);
        return {
          ok: true,
          models: models.length > 0 ? models : [{ id: model, name: model }],
          selectedModel: model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          baseUrl: args.baseUrl,
          modelsSource: discoveredModels.length > 0 ? "api" : "fallback",
        };
      } catch (error) {
        lastError = formatServiceProbeError({
          service: baseService,
          label: endpoint?.label ?? preset?.label,
          baseUrl: args.baseUrl,
          model,
          apiFormat: plan.apiFormat,
          stream: plan.stream,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    ok: false,
    models: discoveredModels,
    error: lastError,
  };
}

export {
  PIPELINE_STAGES,
  AGENT_LABELS,
  TOOL_LABELS,
  resolveToolLabel,
  summarizeResult,
  compareServiceListItems,
  isHeaderSafeApiKey,
  NON_TEXT_MODEL_ID_PARTS,
  SERVICE_MODELS_PROBE_TIMEOUT_MS,
  SERVICE_CHAT_PROBE_TIMEOUT_MS,
  MAX_DISCOVERED_MODELS_TO_PING,
  MAX_GENERIC_FALLBACK_MODELS_TO_PING,
  isTextChatModelId,
  filterTextChatModels,
  normalizeApiBookId,
  nonTextModelMessage,
  extractToolError,
  resolveProjectImageFile,
  isLikelyFailedToolResult,
  hasSuccessfulSubAgentExec,
  isWriteNextInstruction,
  CHAT_EDIT_WARNING,
  CHAT_EDIT_TEXT_EXTENSIONS,
  CHAT_EDIT_ALLOWED_ROOTS,
  parseReplacementInstruction,
  parseChapterNumberForEdit,
  parseExplicitEditPath,
  countContentUnits,
  resolveExternalChatEditPath,
  findChapterFile,
  parseBookChapterFromRelativePath,
  syncExternalChapterEdit,
  tryHandleExternalChatEdit,
  looksLikeBookCreatedClaim,
  validateAgentActionExecution,
  broadcast,
  subscribers,
  bookCreateStatus,
  modelListCache,
  deriveBookIdFromTitle,
  resolveArchitectBookIdFromArgs,
  resolveCreatedBookIdFromToolExecs,
  loadStudioBookListSummary,
  isCustomServiceId,
  serviceConfigKey,
  normalizeServiceEntry,
  normalizeConfigSource,
  normalizeServiceConfig,
  mergeServiceConfig,
  normalizeCoverConfig,
  syncTopLevelLlmMirror,
  loadRawConfig,
  saveRawConfig,
  readEnvConfigSummary,
  readEnvConfigStatus,
  resolveConfiguredServiceBaseUrl,
  resolveConfiguredServiceEntry,
  buildProbePlans,
  buildModelCandidates,
  yamlScalar,
  radarTimestampForFilename,
  saveRadarScan,
  loadRadarHistory,
  fallbackTextModelsForEndpoint,
  shouldTrustStaticModelsWhenLiveListUnavailable,
  withTimeout,
  formatServiceProbeError,
  fetchModelsFromServiceBaseUrl,
  buildBearerAuthHeaders,
  probeServiceCapabilities,
};

export type {
  ExternalChatEditResult,
  CollectedToolExec,
  StudioBookListSummary,
  ServiceConfigEntry,
  LLMConfigSource,
  EnvConfigSummary,
  EnvConfigStatus,
  ServiceProbeResult,
  EventHandler,
};
