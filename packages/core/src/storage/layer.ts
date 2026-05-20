/**
 * StorageLayer abstracts all filesystem IO used by StateManager.
 *
 * This allows swapping the backend for testing (in-memory), SQLite hybrid,
 * or remote storage without touching business logic.
 */

export interface FileHandle {
  writeFile(content: string, encoding: "utf-8"): Promise<void>;
  close(): Promise<void>;
}

export interface StorageLayer {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, content: string, encoding?: "utf-8"): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  open(path: string, flags: string): Promise<FileHandle>;
}
