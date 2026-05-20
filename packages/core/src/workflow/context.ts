import type { PipelineRunner } from "../pipeline/runner.js";
import type { PipelineConfig } from "../pipeline/runner-helpers.js";
import type { StateManager } from "../state/manager.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { BaseAgent } from "../agents/base.js";

/**
 * Immutable workflow context shared across all steps.
 * Steps communicate through the strongly-typed bag.
 */
export interface WorkflowContext {
  readonly runner: PipelineRunner;
  readonly state: StateManager;
  readonly config: PipelineConfig;
  readonly logger: Logger | undefined;
  readonly bookId: string;
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly genreProfile: GenreProfile;
  readonly language: "zh" | "en";
  readonly lengthSpec: LengthSpec;
  /** Resolve an agent by name through the runner's extension registry. */
  readonly resolveAgent: (name: string) => Promise<BaseAgent>;
  /** Mutable bag for cross-step data. Steps should document the keys they read/write. */
  readonly bag: Map<string, unknown>;
}

export interface WorkflowContextInit {
  readonly runner: PipelineRunner;
  readonly state: StateManager;
  readonly config: PipelineConfig;
  readonly logger?: Logger;
  readonly bookId: string;
}

export async function createWorkflowContext(init: WorkflowContextInit): Promise<WorkflowContext> {
  const { runner, state, config, logger, bookId } = init;
  const book = await state.loadBookConfig(bookId);
  const { readGenreProfile } = await import("../agents/rules-reader.js");
  const { profile: genreProfile } = await readGenreProfile(config.projectRoot, book.genre);
  const language = (book.language ?? genreProfile.language) === "en" ? ("en" as const) : ("zh" as const);
  const { buildLengthSpec } = await import("../utils/length-metrics.js");
  const lengthSpec = buildLengthSpec(book.chapterWordCount, language);
  const bookDir = state.bookDir(bookId);

  return {
    runner,
    state,
    config,
    logger,
    bookId,
    book,
    bookDir,
    genreProfile,
    language,
    lengthSpec,
    resolveAgent: (name: string) => (runner as any).resolveAgent(name, bookId),
    bag: new Map(),
  };
}
