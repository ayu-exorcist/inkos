#!/usr/bin/env node
/**
 * Extract pure openai-completions providers from .ts endpoint files
 * into a declarative bank.yaml.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump } from "js-yaml";

const endpointsDir = join(process.cwd(), "packages/core/src/llm/providers/endpoints");

function extractObject(filePath) {
  const content = readFileSync(filePath, "utf-8");
  // Find the export const X: InkosEndpoint = { ... }; block
  const match = content.match(/export\s+const\s+\w+:\s*InkosEndpoint\s*=\s*(\{[\s\S]*?\n\};?)/);
  if (!match) return null;

  let jsonLike = match[1];
  // Remove trailing semicolon if present
  jsonLike = jsonLike.replace(/;\s*$/, "");
  // Convert TS single-quoted strings or template literals to double-quoted
  // This is a best-effort parse — we use Function constructor for safety
  try {
    const obj = new Function(`return ${jsonLike}`)();
    return obj;
  } catch {
    console.error(`Failed to parse ${filePath}`);
    return null;
  }
}

const files = [
  "ai360.ts", "baichuan.ts", "custom.ts", "deepseek.ts", "giteeai.ts",
  "hunyuan.ts", "infiniai.ts", "internlm.ts", "kkaiapi.ts", "longcat.ts",
  "minimax.ts", "mistral.ts", "modelscope.ts", "moonshot.ts", "newapi.ts",
  "ollama.ts", "ppio.ts", "qiniu.ts", "sensenova.ts", "siliconcloud.ts",
  "spark.ts", "stepfun.ts", "tencentcloud.ts", "volcengine.ts", "wenxin.ts",
  "xai.ts", "xiaomimimo.ts", "zeroone.ts", "zhipu.ts",
];

const providers = [];
for (const file of files) {
  const obj = extractObject(join(endpointsDir, file));
  if (!obj) continue;
  if (obj.api !== "openai-completions") {
    console.log(`Skipping ${file} (api=${obj.api})`);
    continue;
  }
  providers.push(obj);
}

// Sort by id for stability
providers.sort((a, b) => a.id.localeCompare(b.id));

const yaml = dump({ providers }, { noRefs: true, lineWidth: -1 });
const outPath = join(process.cwd(), "packages/core/src/llm/providers/bank.yaml");
writeFileSync(outPath, yaml, "utf-8");
console.log(`Wrote ${providers.length} providers to ${outPath}`);
