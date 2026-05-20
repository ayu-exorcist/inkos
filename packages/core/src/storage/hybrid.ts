import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import type { StorageLayer, FileHandle } from "./layer.js";
import { FileSystemStorage } from "./fs.js";

const require = createRequire(import.meta.url);

/**
 * HybridStorage: SQLite primary for structured data, filesystem mirror for blobs.
 *
 * Phase 2 architecture placeholder.  Currently all reads/writes still delegate
 * to the filesystem StorageLayer; SQLite tables are created and kept in sync
 * for future query acceleration.
 *
 * Structured paths (book.json, chapters/index.json, state/*.json) are mirrored
 * into an SQLite `files` table.  Large blobs (.md, snapshots) bypass SQLite
 * and go straight to the filesystem layer.
 */
export class HybridStorage implements StorageLayer {
  private fs: StorageLayer;
  private dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string, fsLayer?: StorageLayer) {
    this.fs = fsLayer ?? new FileSystemStorage();
    this.dbPath = dbPath;
    this.initDb();
  }

  private initDb(): void {
    try {
      const { DatabaseSync } = require("node:sqlite");
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    } catch {
      // node:sqlite unavailable — degrade gracefully to pure filesystem
      this.db = null;
    }
  }

  private isStructuredPath(path: string): boolean {
    return (
      path.endsWith("book.json") ||
      path.endsWith("chapters/index.json") ||
      /[\/]story[\/]state[\/][^\/]+\.json$/.test(path)
    );
  }

  async readFile(path: string, encoding: "utf-8"): Promise<string> {
    if (this.db && this.isStructuredPath(path)) {
      const row = this.db
        .prepare("SELECT content FROM files WHERE path = ?")
        .get(path) as { content: string } | undefined;
      if (row) return row.content;
    }
    return this.fs.readFile(path, encoding);
  }

  async writeFile(path: string, content: string, encoding?: "utf-8"): Promise<void> {
    await this.fs.writeFile(path, content, encoding);
    if (this.db && this.isStructuredPath(path)) {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO files (path, content, updated_at) VALUES (?, ?, datetime('now'))",
        )
        .run(path, content);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs.readdir(path);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return this.fs.stat(path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.fs.rm(path, options);
    if (this.db && options?.recursive) {
      this.db.prepare("DELETE FROM files WHERE path LIKE ? || '%'").run(path);
    } else if (this.db) {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    }
  }

  async unlink(path: string): Promise<void> {
    await this.fs.unlink(path);
    if (this.db) {
      this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
    }
  }

  async open(path: string, flags: string): Promise<FileHandle> {
    return this.fs.open(path, flags);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Query structured file content directly from SQLite (bypasses FS). */
  queryFilesLike(pattern: string): Array<{ path: string; content: string }> {
    if (!this.db) return [];
    return this.db
      .prepare("SELECT path, content FROM files WHERE path LIKE ?")
      .all(pattern) as Array<{ path: string; content: string }>;
  }
}
