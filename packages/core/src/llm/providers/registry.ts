import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import type { InkosEndpoint } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * ProviderRegistry holds all inkos LLM provider definitions.
 *
 * Migration from hard-coded .ts files:
 *   1. Pure OpenAI-compatible providers → bank.yaml
 *   2. Special-protocol providers (anthropic, google, openai-responses, codingPlan)
 *      remain as .ts adapters and are registered explicitly.
 */
export class ProviderRegistry {
  private providers = new Map<string, InkosEndpoint>();

  /** Load providers from a YAML bank file. */
  loadBankYaml(path: string = join(__dirname, "bank.yaml")): void {
    const content = readFileSync(path, "utf-8");
    const parsed = load(content) as { providers: InkosEndpoint[] };
    for (const provider of parsed.providers) {
      this.register(provider);
    }
  }

  /** Register a single provider (used by special adapters). */
  register(provider: InkosEndpoint): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /** Overwrite an existing provider (used for hot-reloading or testing). */
  override(provider: InkosEndpoint): void {
    this.providers.set(provider.id, provider);
  }

  /** Lookup by id. */
  get(id: string): InkosEndpoint | undefined {
    return this.providers.get(id);
  }

  /** List all registered providers. */
  list(): InkosEndpoint[] {
    return [...this.providers.values()];
  }
}

let globalRegistry: ProviderRegistry | undefined;

/** Lazy-initialized singleton registry. */
export function getGlobalProviderRegistry(): ProviderRegistry {
  if (!globalRegistry) {
    globalRegistry = new ProviderRegistry();
    globalRegistry.loadBankYaml();
  }
  return globalRegistry;
}

export function resetGlobalProviderRegistry(): void {
  globalRegistry = undefined;
}
