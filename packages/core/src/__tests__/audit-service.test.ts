import { describe, it, expect, vi } from "vitest";
import { AuditService } from "../services/audit.js";
import type { BookConfig } from "../models/book.js";
import type { ContinuityAuditor } from "../agents/continuity.js";

describe("AuditService", () => {
  const mockBook: BookConfig = {
    id: "test-book",
    title: "Test",
    platform: "tomato",
    genre: "xuanhuan",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 3000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("evaluateMergedAudit combines LLM audit with local heuristics", async () => {
    const service = new AuditService({
      resolveAgent: async () =>
        ({
          auditChapter: vi.fn().mockResolvedValue({
            passed: true,
            issues: [],
            summary: "clean",
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
        }) as unknown as ContinuityAuditor,
    });

    const result = await service.evaluateMergedAudit({
      book: mockBook,
      bookDir: "/tmp",
      chapterContent: "正文内容",
      chapterNumber: 1,
    });

    expect(result.auditResult.passed).toBe(true);
    expect(result.aiTellCount).toBe(0);
    expect(result.blockingCount).toBe(0);
  });

  it("auditChapter returns chapterNumber in result", async () => {
    const service = new AuditService({
      resolveAgent: async () =>
        ({
          auditChapter: vi.fn().mockResolvedValue({
            passed: false,
            issues: [
              {
                severity: "warning",
                category: "continuity",
                description: "gap",
                suggestion: "fix",
              },
            ],
            summary: "needs revision",
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          }),
        }) as unknown as ContinuityAuditor,
    });

    const result = await service.auditChapter("/tmp", "content", 3, mockBook);
    expect(result.chapterNumber).toBe(3);
    expect(result.passed).toBe(false);
  });
});
