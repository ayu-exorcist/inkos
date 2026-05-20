import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPluginsDir, loadPlugin, registerPluginIntoRegistry } from "../extension/discovery.js";
import { ExtensionRegistry } from "../extension/registry.js";

describe("plugin discovery", () => {
  let tempDir: string;
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-plugins-"));
    registry = new ExtensionRegistry();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("scanPluginsDir skips directories without manifest", async () => {
    await mkdir(join(tempDir, "empty-plugin"), { recursive: true });
    const results = await scanPluginsDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
  });

  it("scanPluginsDir loads plugin with inkos-plugin.json", async () => {
    const pluginDir = join(tempDir, "my-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "inkos-plugin.json"),
      JSON.stringify({
        name: "my-plugin",
        version: "1.0.0",
        inkos: {
          agents: [{ name: "custom-agent", entry: "./agent.js" }],
        },
      }),
      "utf-8",
    );

    const results = await scanPluginsDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.plugin!.name).toBe("my-plugin");
  });

  it("scanPluginsDir loads plugin with package.json + inkos field", async () => {
    const pluginDir = join(tempDir, "pkg-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "pkg-plugin",
        version: "2.0.0",
        inkos: {
          genres: [{ id: "wuxia", displayName: "武侠", profilePath: "./wuxia.md" }],
        },
      }),
      "utf-8",
    );

    const results = await scanPluginsDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.plugin!.version).toBe("2.0.0");
  });

  it("scanPluginsDir ignores dotfiles and suspicious names", async () => {
    await mkdir(join(tempDir, ".hidden"), { recursive: true });
    await mkdir(join(tempDir, ".."), { recursive: true });
    // foo is a valid directory name but has no manifest → one failed result
    await mkdir(join(tempDir, "foo"), { recursive: true });
    const results = await scanPluginsDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
  });

  it("registerPluginIntoRegistry registers genres from manifest", async () => {
    const pluginDir = join(tempDir, "genre-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "wuxia.md"), "# 武侠\n", "utf-8");
    await writeFile(
      join(pluginDir, "inkos-plugin.json"),
      JSON.stringify({
        name: "genre-plugin",
        inkos: {
          genres: [{ id: "wuxia", displayName: "武侠", profilePath: "./wuxia.md" }],
        },
      }),
      "utf-8",
    );

    const result = await loadPlugin(pluginDir);
    expect(result.success).toBe(true);
    await registerPluginIntoRegistry(result.plugin!, registry);

    const genre = registry.resolveGenre("wuxia");
    expect(genre).toBeDefined();
    expect(genre!.displayName).toBe("武侠");
  });

  it("safeResolve blocks path traversal in entry", async () => {
    const pluginDir = join(tempDir, "bad-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "inkos-plugin.json"),
      JSON.stringify({
        name: "bad-plugin",
        inkos: {
          agents: [{ name: "evil", entry: "../../../etc/passwd" }],
        },
      }),
      "utf-8",
    );

    const result = await loadPlugin(pluginDir);
    expect(result.success).toBe(true);
    await expect(registerPluginIntoRegistry(result.plugin!, registry)).rejects.toThrow(
      "escapes plugin directory",
    );
  });

  it("returns empty array when plugins dir does not exist", async () => {
    const results = await scanPluginsDir(join(tempDir, "nonexistent"));
    expect(results).toEqual([]);
  });
});
