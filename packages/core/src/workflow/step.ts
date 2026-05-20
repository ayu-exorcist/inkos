import type { WorkflowContext } from "./context.js";

/**
 * A single unit of work in the writing pipeline.
 * Steps are pure functions (or thin wrappers around existing agents)
 * that receive a shared context and typed input, then produce typed output.
 */
export interface Step<TIn, TOut> {
  readonly name: string;
  /** Optional localized display names. When provided, runStep uses them instead of `name`. */
  readonly nameI18n?: { readonly zh: string; readonly en: string };
  run(ctx: WorkflowContext, input: TIn): Promise<TOut>;
}

/**
 * Compose two steps sequentially. The output of the first feeds into the second.
 */
export function pipe<TIn, TMid, TOut>(
  first: Step<TIn, TMid>,
  second: Step<TMid, TOut>,
): Step<TIn, TOut> {
  return {
    name: `${first.name} → ${second.name}`,
    async run(ctx, input) {
      const mid = await first.run(ctx, input);
      return second.run(ctx, mid);
    },
  };
}

/**
 * Run a step and automatically log stage transitions.
 */
export async function runStep<TIn, TOut>(
  ctx: WorkflowContext,
  step: Step<TIn, TOut>,
  input: TIn,
): Promise<TOut> {
  const displayName = step.nameI18n?.[ctx.language] ?? step.name;
  const label = ctx.language === "en" ? `Stage: ${displayName}` : `阶段：${displayName}`;
  ctx.logger?.info(label);
  try {
    return await step.run(ctx, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.logger?.error(`[${step.name}] failed: ${detail}`);
    throw error;
  }
}
