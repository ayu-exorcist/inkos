import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStorage } from "../storage/memory.js";
import { FileSystemStorage } from "../storage/fs.js";
import { HybridStorage } from "../storage/hybrid.js";
import { StateManager } from "../state/manager.js";

describe("InMemoryStorage", () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it("round-trips file content", async () => {
    await storage.writeFile("/books/demo/book.json", '{"id":"demo"}', "utf-8");
    const loaded = await storage.readFile("/books/demo/book.json", "utf-8");
    expect(loaded).toBe('{"id":"demo"}');
  });

  it("throws ENOENT for missing files", async () => {
    await expect(storage.readFile("/missing.txt", "utf-8")).rejects.toThrow("ENOENT");
  });

  it("lists directory entries", async () => {
    await storage.writeFile("/books/a/book.json", "{}", "utf-8");
    await storage.writeFile("/books/b/book.json", "{}", "utf-8");
    const entries = await storage.readdir("/books");
    expect(entries.sort()).toEqual(["a", "b"]);
  });

  it("removes files recursively", async () => {
    await storage.writeFile("/books/demo/chapters/001.md", "# Ch1", "utf-8");
    await storage.rm("/books/demo", { recursive: true });
    expect(await storage.readdir("/books")).toEqual([]);
  });

  it("provides exclusive-open semantics (wx)", async () => {
    await storage.writeFile("/lock", "old", "utf-8");
    await expect(storage.open("/lock", "wx")).rejects.toThrow("EEXIST");
  });

  it("works end-to-end with StateManager", async () => {
    const mem = new InMemoryStorage();
    const manager = new StateManager("/project", mem);
    await manager.saveBookConfig("book-1", {
      id: "book-1",
      title: "Test",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2000,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    const loaded = await manager.loadBookConfig("book-1");
    expect(loaded.title).toBe("Test");
    expect(mem.hasFile(join("/project", "books", "book-1", "book.json"))).toBe(true);
  });
});

describe("FileSystemStorage", () => {
  let tempDir: string;
  let storage: FileSystemStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-fs-test-"));
    storage = new FileSystemStorage();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips through real filesystem", async () => {
    const path = join(tempDir, "test.json");
    await storage.writeFile(path, '{"ok":true}', "utf-8");
    const loaded = await storage.readFile(path, "utf-8");
    expect(loaded).toBe('{"ok":true}');
  });
});

describe("HybridStorage", () => {
  let tempDir: string;
  let storage: HybridStorage;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-hybrid-test-"));
    storage = new HybridStorage(join(tempDir, "meta.db"));
  });

  afterEach(async () => {
    storage.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("mirrors structured writes into SQLite", async () => {
    const bookJson = join(tempDir, "book.json");
    await storage.writeFile(bookJson, '{"id":"hybrid"}', "utf-8");

    // Should be queryable from SQLite
    const rows = storage.queryFilesLike("%book.json");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.content === '{"id":"hybrid"}')).toBe(true);

    // Should also be readable back through the layer
    const loaded = await storage.readFile(bookJson, "utf-8");
    expect(loaded).toBe('{"id":"hybrid"}');
  });

  it("delegates markdown blobs to filesystem", async () => {
    const mdPath = join(tempDir, "chapter.md");
    await storage.writeFile(mdPath, "# Chapter\n\nText", "utf-8");

    // Markdown should NOT appear in SQLite
    const rows = storage.queryFilesLike("%chapter.md");
    expect(rows).toHaveLength(0);

    // But should still be readable
    const loaded = await storage.readFile(mdPath, "utf-8");
    expect(loaded).toBe("# Chapter\n\nText");
  });
});
