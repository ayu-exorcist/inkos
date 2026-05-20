import type { InkosEndpoint } from "./types.js";
import { ProviderRegistry, getGlobalProviderRegistry } from "./registry.js";

// Special-protocol adapters (kept as .ts files)
import { ANTHROPIC } from "./endpoints/anthropic.js";
import { BAILIAN } from "./endpoints/bailian.js";
import { GOOGLE } from "./endpoints/google.js";
import { OPENAI } from "./endpoints/openai.js";
import { GITHUB_COPILOT } from "./endpoints/githubCopilot.js";
import { OPENROUTER } from "./endpoints/openrouter.js";
import { CUSTOM } from "./endpoints/custom.js";

// CodingPlan adapters
import { KIMI_CODING_PLAN } from "./endpoints/kimiCodingPlan.js";
import { KIMI_CODE } from "./endpoints/kimiCode.js";
import { MINIMAX_CODING_PLAN } from "./endpoints/minimaxCodingPlan.js";
import { BAILIAN_CODING_PLAN } from "./endpoints/bailianCodingPlan.js";
import { GLM_CODING_PLAN } from "./endpoints/glmCodingPlan.js";
import { VOLCENGINE_CODING_PLAN } from "./endpoints/volcengineCodingPlan.js";
import { OPENCODE_CODING_PLAN } from "./endpoints/opencodeCodingPlan.js";
import { ASTRON_CODING_PLAN } from "./endpoints/astronCodingPlan.js";

export type { InkosEndpoint, InkosModel, ApiProtocol, EndpointGroup } from "./types.js";

function buildRegistry(): ProviderRegistry {
  const registry = getGlobalProviderRegistry();

  // Register special adapters (YAML does not cover these)
  const specials = [
    ANTHROPIC,
    BAILIAN,
    GOOGLE,
    OPENAI,
    GITHUB_COPILOT,
    OPENROUTER,
    CUSTOM,
    KIMI_CODING_PLAN,
    KIMI_CODE,
    MINIMAX_CODING_PLAN,
    BAILIAN_CODING_PLAN,
    GLM_CODING_PLAN,
    VOLCENGINE_CODING_PLAN,
    OPENCODE_CODING_PLAN,
    ASTRON_CODING_PLAN,
  ];

  for (const special of specials) {
    // Use override so repeated imports (e.g. in tests) don't throw.
    registry.override(special);
  }

  return registry;
}

const registry = buildRegistry();

/**
 * All registered provider endpoints.
 * Pure OpenAI-compatible providers come from bank.yaml;
 * special-protocol adapters are registered above.
 */
export function getAllEndpoints(): readonly InkosEndpoint[] {
  return registry.list();
}

/** Lookup a provider by its id. */
export function getEndpoint(id: string): InkosEndpoint | undefined {
  return registry.get(id);
}
