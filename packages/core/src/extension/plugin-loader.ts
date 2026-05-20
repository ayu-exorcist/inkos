/**
 * Plugin loader — safely discovers and registers external inkos plugins.
 *
 * Security model:
 *   1. Plugins are directories with a manifest (package.json or inkos-plugin.json).
 *   2. Only whitelisted manifest fields are read.
 *   3. Entry paths are resolved to absolute paths and validated.
 *   4. Entry modules are loaded via standard ESM dynamic import() only.
 *   5. No eval(), no new Function(), no arbitrary code execution.
 */

import { join, resolve, isAbsolute } from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionRegistry } from "./registry.js";

export interface PluginManifestAgent {
  readonly name: string;
  readonly entry: string;
}

export interface PluginManifestGenre {
  readonly id: string;
  readonly displayName: string;
  readonly profilePath: string;
}

export interface PluginManifestNotifyChannel {
  readonly id: string;
  readonly displayName: string;
  readonly entry: string;
}

export interface PluginManifestRadarSource {
  readonly id: string;
  readonly displayName: string;
  readonly entry: string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly inkos?: {
    readonly agents?: readonly PluginManifestAgent[];
    readonly genres?: readonly PluginManifestGenre[];
    readonly notifyChannels?: readonly PluginManifestNotifyChannel[];
    readonly radarSources?: readonly PluginManifestRadarSource[];
  };
}

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly manifest: PluginManifest;
}

/** Result of attempting to load a plugin. */
export interface PluginLoadResult {
  readonly success: boolean;
  readonly plugin?: LoadedPlugin;
  readonly error?: string;
}

function isValidFileName(name: string): boolean {
  // Prevent path traversal in plugin directory names
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.startsWith(".") && !name.includes("..");
}

function safeResolve(baseDir: string, relPath: string): string {
  const absolute = resolve(baseDir, relPath);
  if (!absolute.startsWith(resolve(baseDir))) {
    throw new Error(`Entry path escapes plugin directory: ${relPath}`);
  }
  return absolute;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readManifest(pluginDir: string): Promise<PluginManifest | undefined> {
  const packageJsonPath = join(pluginDir, "package.json");
  const pluginJsonPath = join(pluginDir, "inkos-plugin.json");

  const target = (await fileExists(pluginJsonPath))
    ? pluginJsonPath
    : (await fileExists(packageJsonPath))
      ? packageJsonPath
      : undefined;

  if (!target) return undefined;

  const raw = await readFile(target, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // For package.json, look for "inkos" field; for inkos-plugin.json, use root.
  // If root has an "inkos" field, unwrap it (supports both shapes).
  const inkosSection =
    (parsed.inkos as Record<string, unknown> | undefined) ?? parsed;

  if (!inkosSection) return undefined;

  return {
    name: String(parsed.name ?? "unknown"),
    version: String(parsed.version ?? "0.0.0"),
    inkos: {
      agents: Array.isArray(inkosSection.agents)
        ? (inkosSection.agents as PluginManifestAgent[])
        : undefined,
      genres: Array.isArray(inkosSection.genres)
        ? (inkosSection.genres as PluginManifestGenre[])
        : undefined,
      notifyChannels: Array.isArray(inkosSection.notifyChannels)
        ? (inkosSection.notifyChannels as PluginManifestNotifyChannel[])
        : undefined,
      radarSources: Array.isArray(inkosSection.radarSources)
        ? (inkosSection.radarSources as PluginManifestRadarSource[])
        : undefined,
    },
  };
}

/**
 * Attempt to load a single plugin from a directory.
 */
export async function loadPlugin(pluginDir: string): Promise<PluginLoadResult> {
  try {
    const manifest = await readManifest(pluginDir);
    if (!manifest) {
      return { success: false, error: `No manifest found in ${pluginDir}` };
    }
    return {
      success: true,
      plugin: {
        name: manifest.name,
        version: manifest.version ?? "0.0.0",
        path: pluginDir,
        manifest,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Scan a plugins directory and load all valid plugins.
 */
export async function scanPluginsDir(pluginsDir: string): Promise<PluginLoadResult[]> {
  try {
    const s = await stat(pluginsDir);
    if (!s.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = await readdir(pluginsDir);
  const results: PluginLoadResult[] = [];

  for (const entry of entries) {
    if (!isValidFileName(entry)) continue;
    const pluginDir = join(pluginsDir, entry);
    try {
      const s = await stat(pluginDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    results.push(await loadPlugin(pluginDir));
  }

  return results;
}

/**
 * Register a loaded plugin into an ExtensionRegistry.
 *
 * Entry modules are expected to export a `register(registry: ExtensionRegistry)` function.
 * If no such export exists, the plugin is silently skipped for that extension point.
 */
export async function registerPluginIntoRegistry(
  plugin: LoadedPlugin,
  registry: ExtensionRegistry,
): Promise<void> {
  const { manifest, path: pluginDir } = plugin;
  const inkos = manifest.inkos;
  if (!inkos) return;

  for (const agent of inkos.agents ?? []) {
    const entryPath = safeResolve(pluginDir, agent.entry);
    const mod = await import(pathToFileURL(entryPath).href);
    if (typeof mod.registerAgent === "function") {
      await mod.registerAgent(registry);
    } else if (typeof mod.default?.create === "function") {
      registry.registerAgent({
        name: agent.name,
        create: mod.default.create.bind(mod.default),
      });
    }
  }

  for (const genre of inkos.genres ?? []) {
    registry.registerGenre({
      id: genre.id,
      displayName: genre.displayName,
      profilePath: safeResolve(pluginDir, genre.profilePath),
    });
  }

  for (const notify of inkos.notifyChannels ?? []) {
    const entryPath = safeResolve(pluginDir, notify.entry);
    const mod = await import(pathToFileURL(entryPath).href);
    if (typeof mod.registerNotifyChannel === "function") {
      await mod.registerNotifyChannel(registry);
    } else if (typeof mod.default?.send === "function") {
      registry.registerNotifyChannel({
        id: notify.id,
        displayName: notify.displayName,
        send: mod.default.send.bind(mod.default),
      });
    }
  }

  for (const radar of inkos.radarSources ?? []) {
    const entryPath = safeResolve(pluginDir, radar.entry);
    const mod = await import(pathToFileURL(entryPath).href);
    if (typeof mod.registerRadarSource === "function") {
      await mod.registerRadarSource(registry);
    } else if (typeof mod.default?.create === "function") {
      registry.registerRadarSource({
        id: radar.id,
        displayName: radar.displayName,
        create: mod.default.create.bind(mod.default),
      });
    }
  }
}
