import { describe, it, expect } from "vitest";
import {
  ContextBudgetManager,
  estimateTokens,
  estimateMessageTokens,
} from "../llm/context-budget.js";
import type { LLMMessage } from "../llm/provider.js";

describe("estimateTokens", () => {
  it("returns a positive count for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("scales roughly with character count", () => {
    const short = estimateTokens("hi");
    const long = estimateTokens("a".repeat(350));
    expect(long).toBeGreaterThan(short);
  });
});

describe("estimateMessageTokens", () => {
  it("includes overhead", () => {
    const msg: LLMMessage = { role: "user", content: "test" };
    expect(estimateMessageTokens(msg)).toBeGreaterThan(estimateTokens("test"));
  });
});

describe("ContextBudgetManager", () => {
  const makeMessages = (count: number, charsEach = 100): LLMMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      role: "user",
      content: "x".repeat(charsEach),
    }));

  it("returns messages unchanged when under threshold", async () => {
    const mgr = new ContextBudgetManager({ contextWindow: 10_000 });
    const msgs = makeMessages(2, 100);
    const result = await mgr.compress(msgs);
    expect(result.messages).toEqual(msgs);
    expect(result.summary).toBeUndefined();
  });

  it("drops old messages when over threshold and no summarizer", async () => {
    const mgr = new ContextBudgetManager({
      contextWindow: 500,
      compressionThreshold: 0.5,
      preserveRecent: 2,
    });
    // 10 messages × ~100 chars ≈ ~290 tokens (with overhead) > 250 threshold
    const msgs = makeMessages(10, 100);
    const result = await mgr.compress(msgs);
    expect(result.messages.length).toBe(2);
    expect(result.originalTokenCount).toBeGreaterThan(result.compressedTokenCount);
  });

  it("summarizes old messages when summarizer is provided", async () => {
    const mgr = new ContextBudgetManager({
      contextWindow: 500,
      compressionThreshold: 0.5,
      preserveRecent: 2,
      summarize: (msgs) => `Summary of ${msgs.length} messages`,
    });
    const msgs = makeMessages(10, 100);
    const result = await mgr.compress(msgs);
    expect(result.summary).toBe("Summary of 8 messages");
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toContain("Summary of 8 messages");
    expect(result.messages.length).toBe(3); // system summary + 2 recent
  });

  it("preserves recent messages verbatim", async () => {
    const mgr = new ContextBudgetManager({
      contextWindow: 500,
      compressionThreshold: 0.5,
      preserveRecent: 3,
    });
    const msgs = makeMessages(10, 100);
    const result = await mgr.compress(msgs);
    // Last 3 messages should match exactly
    expect(result.messages.slice(-3)).toEqual(msgs.slice(-3));
  });

  it("does not mutate input array", async () => {
    const mgr = new ContextBudgetManager({
      contextWindow: 500,
      compressionThreshold: 0.5,
    });
    const msgs = makeMessages(10, 100);
    const original = [...msgs];
    await mgr.compress(msgs);
    expect(msgs).toEqual(original);
  });
});
