import { join } from "node:path";
import { homedir } from "node:os";
import {
  scanPluginsDir,
  loadPlugin,
  registerPluginIntoRegistry,
  type PluginLoadResult,
  type LoadedPlugin,
} from "./plugin-loader.js";
import type { ExtensionRegistry } from "./registry.js";

export interface DiscoveryOptions {
  /** Project root — scans <root>/.inkos/plugins */
  readonly projectRoot?: string;
  /** Global plugins dir — defaults to ~/.inkos/plugins */
  readonly globalPluginsDir?: string;
  /** When true, skip global plugins (useful for sandboxed tests). */
  readonly skipGlobal?: boolean;
}

export interface DiscoveryResult {
  readonly global: PluginLoadResult[];
  readonly project: PluginLoadResult[];
  readonly loadedPlugins: LoadedPlugin[];
}

/**
 * Discover and register plugins from standard directories:
 *   1. ~/.inkos/plugins/   (global)
 *   2. <projectRoot>/.inkos/plugins/   (project-local)
 *
 * Plugins are loaded in order: global first, then project-local.
 * Project-local plugins can override global ones if they share the same id/name.
 */
export async function discoverAndRegisterPlugins(
  registry: ExtensionRegistry,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const globalDir = options.globalPluginsDir ?? join(homedir(), ".inkos", "plugins");
  const projectDir = options.projectRoot
    ? join(options.projectRoot, ".inkos", "plugins")
    : undefined;

  const globalResults = options.skipGlobal ? [] : await scanPluginsDir(globalDir);
  const projectResults = projectDir ? await scanPluginsDir(projectDir) : [];

  const loadedPlugins: LoadedPlugin[] = [];

  for (const result of globalResults) {
    if (result.success && result.plugin) {
      await registerPluginIntoRegistry(result.plugin, registry);
      loadedPlugins.push(result.plugin);
    }
  }

  for (const result of projectResults) {
    if (result.success && result.plugin) {
      await registerPluginIntoRegistry(result.plugin, registry);
      loadedPlugins.push(result.plugin);
    }
  }

  return { global: globalResults, project: projectResults, loadedPlugins };
}

export { scanPluginsDir, loadPlugin, registerPluginIntoRegistry };
export type {
  PluginLoadResult,
  LoadedPlugin,
  PluginManifest,
  PluginManifestAgent,
  PluginManifestGenre,
  PluginManifestNotifyChannel,
  PluginManifestRadarSource,
} from "./plugin-loader.js";
