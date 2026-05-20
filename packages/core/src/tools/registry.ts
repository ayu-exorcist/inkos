import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../llm/provider.js";

// ---------------------------------------------------------------------------
// Unified tool contract
// ---------------------------------------------------------------------------

export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** JSON schema for LLM tool-use (OpenAI function calling style). */
  readonly schema: ToolDefinition["parameters"];
  /** Execute the tool. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Central registry
// ---------------------------------------------------------------------------

/**
 * ToolRegistry replaces scattered switch-cases in:
 *   - pipeline/agent.ts   (executeAgentTool)
 *   - agent-tools.ts      (pi-agent-core AgentTool factories)
 *   - project-tools.ts    (InteractionRuntimeTools)
 *
 * All tools self-register at import time or at host startup.
 * This makes the agent loop agnostic to which tools exist.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  override(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  resolve(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ReadonlyArray<RegisteredTool> {
    return [...this.tools.values()];
  }

  /** Collect JSON schemas for the LLM tool-calling payload. */
  toToolDefinitions(): ReadonlyArray<ToolDefinition> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }));
  }

  /** Execute by name, returning a JSON-stringify-friendly result. */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
    try {
      const result = await tool.execute(args);
      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton (per-process)
// ---------------------------------------------------------------------------

let globalRegistry: ToolRegistry | undefined;

export function getGlobalToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    globalRegistry = new ToolRegistry();
  }
  return globalRegistry;
}

export function resetGlobalToolRegistry(): void {
  globalRegistry = undefined;
}
