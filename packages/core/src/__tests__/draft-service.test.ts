import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { DraftService } from "../services/draft.js";
import { StateManager } from "../state/manager.js";
import { EventBus } from "../events/bus.js";
import { INKOS_EVENTS } from "../events/events.js";
import type { BookConfig } from "../models/book.js";
import type { WriterAgent } from "../agents/writer.js";

describe("DraftService", () => {
  async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "inkos-draft-test-"));
    const state = new StateManager(root);
    const bookId = "test-book";
    const now = "2026-03-19T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Test Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      createdAt: now,
      updatedAt: now,
    };

    await state.saveBookConfig(bookId, book);
    await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
    await mkdir(join(state.bookDir(bookId), "chapters"), { recursive: true });

    const bus = new EventBus();
    const events: Array<{ type: string; payload: unknown }> = [];
    bus.on(INKOS_EVENTS.CHAPTER_DRAFTED, (payload) => {
      events.push({ type: INKOS_EVENTS.CHAPTER_DRAFTED, payload });
    });

    const service = new DraftService({
      state,
      projectRoot: root,
      inputGovernanceMode: "legacy",
      resolveAgent: async (name) => {
        if (name === "writer") {
          return {
            writeChapter: vi.fn().mockResolvedValue({
              chapterNumber: 1,
              title: "Draft Chapter",
              content: "Draft body.",
              wordCount: 11,
              preWriteCheck: "ok",
              postSettlement: "settled",
              updatedState: "state",
              updatedLedger: "ledger",
              updatedHooks: "hooks",
              chapterSummary: "| 1 | Summary |",
              updatedSubplots: "subplots",
              updatedEmotionalArcs: "arcs",
              updatedCharacterMatrix: "matrix",
              postWriteErrors: [],
              postWriteWarnings: [],
              tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              },
            }),
            saveChapter: vi.fn().mockResolvedValue(undefined),
            saveNewTruthFiles: vi.fn().mockResolvedValue(undefined),
          } as unknown as WriterAgent;
        }
        if (name === "length-normalizer") {
          return {
            normalizeChapter: vi.fn().mockResolvedValue({
              normalizedContent: "Draft body.",
              finalCount: 11,
              applied: false,
              mode: "none",
              tokenUsage: {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              },
            }),
          } as unknown as import("../agents/length-normalizer.js").LengthNormalizerAgent;
        }
        throw new Error(`Unknown agent ${name}`);
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() },
      eventBus: bus,
    });

    return { root, state, bookId, book, service, events };
  }

  it("writes a chapter, persists files, and emits event", async () => {
    const { root, service, bookId, events } = await createFixture();

    const result = await service.writeChapter(bookId);

    expect(result.chapterNumber).toBe(1);
    expect(result.title).toBe("Draft Chapter");
    expect(result.wordCount).toBe(11);

    const chapterFile = join(root, "books", bookId, "chapters", "0001_Draft_Chapter.md");
    const chapterContent = await readFile(chapterFile, "utf-8");
    expect(chapterContent).toContain("Draft Chapter");
    expect(chapterContent).toContain("Draft body.");

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(INKOS_EVENTS.CHAPTER_DRAFTED);
    expect((events[0]?.payload as { title: string }).title).toBe("Draft Chapter");

    await rm(root, { recursive: true, force: true });
  });

  it("prepareWriteInput returns legacy mode when configured", async () => {
    const { root, state, bookId, service } = await createFixture();

    const book = await state.loadBookConfig(bookId);
    const bookDir = state.bookDir(bookId);

    const input = await service.prepareWriteInput(book, bookDir, 1, "context");

    expect(input.externalContext).toBe("context");
    expect(input.chapterIntent).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });
});
