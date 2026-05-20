import type { LLMMessage } from "./provider.js";

/**
 * Rough token estimator: ~4 chars per token for CJK, ~4 for English.
 * Fast, zero-dependency.  Not exact but good enough for budget decisions.
 */
export function estimateTokens(text: string): number {
  // CJK characters are roughly 1 token each; Latin ~0.25 per char.
  // Blend: count all chars and divide by a conservative factor.
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(msg: LLMMessage): number {
  // Base overhead per message (~4 tokens for role/name delimiters)
  const overhead = 4;
  return overhead + estimateTokens(msg.content);
}

export interface CompressionResult {
  readonly messages: LLMMessage[];
  readonly summary?: string;
  readonly originalTokenCount: number;
  readonly compressedTokenCount: number;
}

export interface ContextBudgetOptions {
  /** Total context window (e.g. 128000). */
  readonly contextWindow: number;
  /** Trigger compression when usage exceeds this ratio (default 0.8). */
  readonly compressionThreshold?: number;
  /** How many recent messages to always keep uncompressed (default 4). */
  readonly preserveRecent?: number;
  /** Summarizer callback. If omitted, old messages are simply dropped. */
  readonly summarize?: (messages: LLMMessage[]) => Promise<string> | string;
}

/**
 * ContextBudgetManager decides when and how to compress a message list
 * so it fits inside a model's context window.
 *
 * Strategy (Phase 2 baseline):
 *   1. Estimate total tokens.
 *   2. If below threshold, return as-is.
 *   3. If above threshold, split into "old" (to compress) and "recent" (to keep).
 *   4. If a summarizer is provided, collapse old messages into a single
 *      system message; otherwise drop them.
 *   5. Return the new message list + metadata.
 *
 * This is intentionally simple. Future enhancements:
 *   - Importance scoring (keep high-signal messages)
 *   - Hierarchical summarization (multi-level)
 *   - Prompt-caching awareness (keep cache breakpoints)
 */
export class ContextBudgetManager {
  private readonly contextWindow: number;
  private readonly compressionThreshold: number;
  private readonly preserveRecent: number;
  private readonly summarize?: (messages: LLMMessage[]) => Promise<string> | string;

  constructor(options: ContextBudgetOptions) {
    this.contextWindow = options.contextWindow;
    this.compressionThreshold = options.compressionThreshold ?? 0.8;
    this.preserveRecent = options.preserveRecent ?? 4;
    this.summarize = options.summarize;
  }

  /**
   * Check and optionally compress messages.
   * Never mutates the input array.
   */
  async compress(messages: ReadonlyArray<LLMMessage>): Promise<CompressionResult> {
    const originalTokenCount = messages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    const thresholdTokens = Math.floor(this.contextWindow * this.compressionThreshold);
    if (originalTokenCount <= thresholdTokens) {
      return {
        messages: [...messages],
        originalTokenCount,
        compressedTokenCount: originalTokenCount,
      };
    }

    // Split: keep recent messages verbatim, compress the rest.
    const splitIndex = Math.max(0, messages.length - this.preserveRecent);
    const oldMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    let summary: string | undefined;
    let compressed: LLMMessage[];

    if (oldMessages.length > 0 && this.summarize) {
      summary = await this.summarize(oldMessages);
      compressed = [
        { role: "system", content: `[Earlier conversation summary]\n${summary}` },
        ...recentMessages,
      ];
    } else {
      // No summarizer or nothing to compress — just drop old messages.
      compressed = [...recentMessages];
    }

    const compressedTokenCount = compressed.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );

    return {
      messages: compressed,
      summary,
      originalTokenCount,
      compressedTokenCount,
    };
  }
}
