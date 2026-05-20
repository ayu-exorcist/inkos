import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { FoundationService } from "../services/foundation.js";
import { StateManager } from "../state/manager.js";
import type { BookConfig } from "../models/book.js";

describe("FoundationService", () => {
  async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "inkos-foundation-test-"));
    const state = new StateManager(root);
    const bookId = "test-book";
    const now = "2026-03-19T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Test Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "outlining",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    const service = new FoundationService({
      state,
      projectRoot: root,
      resolveAgent: async (name) => {
        if (name === "architect") {
          return {
            generateFoundation: vi.fn().mockResolvedValue({
              storyBible: "# Story Bible\n",
              volumeOutline: "# Volume Outline\n",
              bookRules: '---\nversion: "1.0"\n---\n\n# Book Rules\n',
              currentState: "# Current State\n",
              pendingHooks: "# Pending Hooks\n",
            }),
            writeFoundationFiles: vi.fn().mockResolvedValue(undefined),
          } as unknown as import("../agents/architect.js").ArchitectAgent;
        }
        if (name === "foundation-reviewer") {
          return {
            review: vi.fn().mockResolvedValue({
              passed: true,
              totalScore: 85,
              dimensions: [],
              overallFeedback: "auto-pass",
            }),
          } as unknown as import("../agents/foundation-reviewer.js").FoundationReviewerAgent;
        }
        throw new Error(`Unknown agent ${name}`);
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    return { root, state, bookId, book, service };
  }

  it("initializes book directory and control documents", async () => {
    const { root, service, book } = await createFixture();

    await service.initBook(book);

    const bookDir = join(root, "books", book.id);
    const storyDir = join(bookDir, "story");

    const authorIntent = await readFile(join(storyDir, "author_intent.md"), "utf-8");
    const currentFocus = await readFile(join(storyDir, "current_focus.md"), "utf-8");
    const runtimeDir = await stat(join(storyDir, "runtime"));

    expect(authorIntent).toContain("作者意图");
    expect(currentFocus).toContain("当前聚焦");
    expect(runtimeDir.isDirectory()).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it("injects externalContext into brief.md when provided", async () => {
    const { root, service, book } = await createFixture();

    await service.initBook(book, { externalContext: "mentor conflict focus" });

    const brief = await readFile(join(root, "books", book.id, "story", "brief.md"), "utf-8");
    expect(brief).toContain("mentor conflict focus");

    await rm(root, { recursive: true, force: true });
  });
});
