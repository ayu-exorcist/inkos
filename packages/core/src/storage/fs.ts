import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open } from "node:fs/promises";
import type { StorageLayer, FileHandle } from "./layer.js";

class NodeFileHandle implements FileHandle {
  constructor(private handle: import("node:fs/promises").FileHandle) {}

  async writeFile(content: string, encoding: "utf-8"): Promise<void> {
    await this.handle.writeFile(content, encoding);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export class FileSystemStorage implements StorageLayer {
  async readFile(path: string, encoding: "utf-8"): Promise<string> {
    return readFile(path, encoding);
  }

  async writeFile(path: string, content: string, encoding?: "utf-8"): Promise<void> {
    await writeFile(path, content, encoding);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }> {
    return stat(path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await rm(path, options);
  }

  async unlink(path: string): Promise<void> {
    await unlink(path);
  }

  async open(path: string, flags: string): Promise<FileHandle> {
    const handle = await open(path, flags);
    return new NodeFileHandle(handle);
  }
}
