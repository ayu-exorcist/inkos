import type { StorageLayer, FileHandle } from "./layer.js";

class MemoryFileHandle implements FileHandle {
  constructor(private storage: InMemoryStorage, private path: string) {}

  async writeFile(content: string, _encoding: "utf-8"): Promise<void> {
    this.storage.writeFile(this.path, content);
  }

  async close(): Promise<void> {
    // no-op
  }
}

/**
 * In-memory StorageLayer for fast, hermetic tests.
 *
 * No disk IO — all data lives in Maps.  Directories are implicit:
 * writing to "a/b/c.txt" creates the intermediate directories automatically.
 */
export class InMemoryStorage implements StorageLayer {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  readFile(path: string, _encoding: "utf-8"): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    }
    return Promise.resolve(content);
  }

  writeFile(path: string, content: string, _encoding?: "utf-8"): Promise<void> {
    // Ensure parent dirs exist
    const parts = path.split(/[/\\]/).filter((p) => p !== "");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      this.dirs.add(current);
      this.dirs.add(`/${current}`);
    }
    this.files.set(path, content);
    return Promise.resolve();
  }

  mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }

  readdir(path: string): Promise<string[]> {
    const entries = new Set<string>();
    for (const dir of this.dirs) {
      if (dir.startsWith(path + "/") || dir.startsWith(path + "\\")) {
        const relative = dir.slice(path.length + 1);
        const first = relative.split(/[/\\]/)[0];
        if (first) entries.add(first);
      }
    }
    for (const file of this.files.keys()) {
      if (file.startsWith(path + "/") || file.startsWith(path + "\\")) {
        const relative = file.slice(path.length + 1);
        const first = relative.split(/[/\\]/)[0];
        if (first && !relative.includes("/") && !relative.includes("\\")) {
          entries.add(first);
        }
      }
    }
    return Promise.resolve([...entries]);
  }

  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    const isDir = this.dirs.has(path);
    const isFile = this.files.has(path);
    if (!isDir && !isFile) {
      const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    }
    return Promise.resolve({
      isDirectory: () => isDir,
      isFile: () => isFile,
    });
  }

  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (this.dirs.has(path)) {
      if (!options?.recursive) {
        const err = new Error(`EISDIR: illegal operation on a directory, rm '${path}'`) as NodeJS.ErrnoException;
        err.code = "EISDIR";
        return Promise.reject(err);
      }
      // Remove dir and everything inside
      this.dirs.delete(path);
      for (const d of [...this.dirs]) {
        if (d.startsWith(path + "/") || d.startsWith(path + "\\")) {
          this.dirs.delete(d);
        }
      }
      for (const f of [...this.files.keys()]) {
        if (f.startsWith(path + "/") || f.startsWith(path + "\\")) {
          this.files.delete(f);
        }
      }
      return Promise.resolve();
    }
    if (this.files.has(path) || options?.force) {
      this.files.delete(path);
    }
    return Promise.resolve();
  }

  unlink(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  open(path: string, flags: string): Promise<FileHandle> {
    if (flags === "wx" && this.files.has(path)) {
      const err = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      return Promise.reject(err);
    }
    return Promise.resolve(new MemoryFileHandle(this, path));
  }

  // Test helpers -----------------------------------------------------------

  listFiles(): string[] {
    return [...this.files.keys()];
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  getFile(path: string): string | undefined {
    return this.files.get(path);
  }
}
