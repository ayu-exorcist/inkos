import { chatWithTools, type ToolDefinition, type AgentMessage, type LLMClient } from "./provider.js";
import { getGlobalToolRegistry, type RegisteredTool } from "../tools/registry.js";
import type { Logger } from "../utils/logger.js";

/**
 * UnifiedAgentLoop replaces the hard-coded switch-case in pipeline/agent.ts.
 *
 * It drives a multi-turn conversation where the LLM may invoke any tool
 * registered in the global ToolRegistry. This makes the loop agnostic to
 * the tool set — new tools are picked up automatically.
 */
export interface AgentLoopConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly systemPrompt: string;
  /** Optional tool whitelist. If omitted, all registered tools are exposed. */
  readonly toolNames?: ReadonlyArray<string>;
  readonly maxTurns?: number;
  readonly logger?: Logger;
  readonly onTurnStart?: (turn: number) => void;
  readonly onToolCall?: (name: string, args: Record<string, unknown>) => void;
  readonly onToolResult?: (name: string, result: string) => void;
  readonly onMessage?: (content: string) => void;
}

export interface AgentLoopResult {
  readonly finalMessage: string;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly turnsUsed: number;
}

/**
 * Build the subset of ToolDefinitions exposed to the LLM.
 */
function resolveTools(requested?: ReadonlyArray<string>): ReadonlyArray<ToolDefinition> {
  const registry = getGlobalToolRegistry();
  const all = registry.list();
  const filtered = requested
    ? all.filter((t) => requested.includes(t.name))
    : all;
  return filtered.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.schema,
  }));
}

/**
 * Run the agent loop until the model stops calling tools or maxTurns is reached.
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  userInstruction: string,
): Promise<AgentLoopResult> {
  const {
    client,
    model,
    systemPrompt,
    toolNames,
    maxTurns = 20,
    logger,
    onTurnStart,
    onToolCall,
    onToolResult,
    onMessage,
  } = config;

  const tools = resolveTools(toolNames);
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInstruction },
  ];

  let finalMessage = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    onTurnStart?.(turn);

    const result = await chatWithTools(client, model, messages, tools);

    messages.push({
      role: "assistant",
      content: result.content || null,
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    });

    if (result.content) {
      finalMessage = result.content;
      onMessage?.(result.content);
    }

    if (result.toolCalls.length === 0) {
      break;
    }

    const registry = getGlobalToolRegistry();
    for (const toolCall of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
      } catch {
        logger?.warn(`[agent-loop] Failed to parse args for tool "${toolCall.name}"`);
      }

      onToolCall?.(toolCall.name, args);
      const toolResult = await registry.execute(toolCall.name, args);
      onToolResult?.(toolCall.name, toolResult);

      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: toolResult,
      });
    }
  }

  return {
    finalMessage,
    messages: messages.slice(),
    turnsUsed: messages.filter((m) => m.role === "assistant").length,
  };
}
