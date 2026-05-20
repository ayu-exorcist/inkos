/**
 * Phase 5 (v13) path resolution — prefer the new prose outline files, fall
 * back to legacy paths so older books keep working during transition.
 *
 * Maps:
 *   story/outline/story_frame.md  →  preferred replacement for story_bible.md
 *   story/outline/volume_map.md   →  preferred replacement for volume_outline.md
 *   story/roles/主要角色/*.md +
 *   story/roles/次要角色/*.md    →  preferred replacement for character_matrix.md
 *
 * All helpers accept a bookDir (path to a book root, containing `story/`)
 * and return a string — either the new-file content when it exists, or the
 * legacy file content, or an empty default placeholder.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Detect whether a book uses the Phase 5 new layout (outline/story_frame.md
 * exists on disk). If yes, story_bible.md / book_rules.md are compat shims.
 * If no, those files ARE the authoritative source.
 */
export async function isNewLayoutBook(bookDir: string): Promise<boolean> {
  try {
    await access(join(bookDir, "story", "outline", "story_frame.md"));
    return true;
  } catch {
    return false;
  }
}

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return fallback;
  }
}

/** Read story_frame.md, falling back to legacy story_bible.md. */
export async function readStoryFrame(
  bookDir: string,
  fallbackPlaceholder: string = "",
): Promise<string> {
  const newPath = join(bookDir, "story", "outline", "story_frame.md");
  const legacyPath = join(bookDir, "story", "story_bible.md");

  const newContent = await readOr(newPath, "");
  if (newContent.trim()) return newContent;

  return readOr(legacyPath, fallbackPlaceholder);
}

/** Read volume_map.md, falling back to legacy volume_outline.md. */
export async function readVolumeMap(
  bookDir: string,
  fallbackPlaceholder: string = "",
): Promise<string> {
  const newPath = join(bookDir, "story", "outline", "volume_map.md");
  const legacyPath = join(bookDir, "story", "volume_outline.md");

  const newContent = await readOr(newPath, "");
  if (newContent.trim()) return newContent;

  return readOr(legacyPath, fallbackPlaceholder);
}

/** Read the rhythm principles file (zh or en variant). */
export async function readRhythmPrinciples(bookDir: string): Promise<string> {
  const zhPath = join(bookDir, "story", "outline", "节奏原则.md");
  const enPath = join(bookDir, "story", "outline", "rhythm_principles.md");

  const zh = await readOr(zhPath, "");
  if (zh.trim()) return zh;
  return readOr(enPath, "");
}

export interface RoleCard {
  readonly tier: "major" | "minor";
  readonly name: string;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// ECCM (Environment-Causal Character Model) — migrated from xs/castor
// ---------------------------------------------------------------------------

export interface ECCMRoot {
  readonly family: string;
  readonly formativeEvents: ReadonlyArray<string>;
  readonly socialImprint: string;
}

export interface ECCMStem {
  readonly personality: string;
  readonly values: string;
  readonly abilities: string;
}

export interface ECCMBranch {
  readonly decisionMatrix: ReadonlyArray<string>;
  readonly currentPressure: string;
  readonly physiologicalReactions: ReadonlyArray<string>;
}

export interface ECCMFruit {
  readonly narrativeFunction: string;
  readonly readerEmotionArc: string;
  readonly absoluteTaboos: ReadonlyArray<string>;
  readonly signatureActions: ReadonlyArray<string>;
}

export interface ECCMProfile {
  readonly root: ECCMRoot;
  readonly stem: ECCMStem;
  readonly branch: ECCMBranch;
  readonly fruit: ECCMFruit;
}

/**
 * Parse ECCM sections from a role card markdown body.
 * Looks for heading patterns like "## 根系" / "## 茎干" / "## Root" etc.
 * Returns null when no ECCM structure is detected.
 */
export function parseECCMFromRole(content: string): ECCMProfile | null {
  const root = extractSection(content, ["根系", "Root", "环境决定层"]);
  if (!root) return null;

  const stem = extractSection(content, ["茎干", "Stem", "当前状态层"]);
  const branch = extractSection(content, ["枝叶", "Branch", "动态变化层"]);
  const fruit = extractSection(content, ["花果", "Fruit", "叙事功能层"]);

  return {
    root: {
      family: extractSubSection(root, ["原生家庭", "Family"]),
      formativeEvents: extractListItems(root, ["早期形成事件", "形成事件", "Formative Events"]),
      socialImprint: extractSubSection(root, ["社会环境烙印", "Social Imprint"]),
    },
    stem: {
      personality: extractSubSection(stem ?? "", ["性格", "Personality"]),
      values: extractSubSection(stem ?? "", ["三观", "价值观", "Values"]),
      abilities: extractSubSection(stem ?? "", ["能力", "局限", "Abilities"]),
    },
    branch: {
      decisionMatrix: extractTableRows(branch ?? ""),
      currentPressure: extractSubSection(branch ?? "", ["当前压力", "Current Pressure"]),
      physiologicalReactions: extractListItems(branch ?? "", ["身体反应", "Physiological"]),
    },
    fruit: {
      narrativeFunction: extractSubSection(fruit ?? "", ["叙事功能", "Narrative Function"]),
      readerEmotionArc: extractSubSection(fruit ?? "", ["读者情感", "Reader Emotion"]),
      absoluteTaboos: extractListItems(fruit ?? "", ["绝对不能", "禁忌", "Taboos"]),
      signatureActions: extractListItems(fruit ?? "", ["标志性动作", "Signature"]),
    },
  };
}

/**
 * Build a causal-reasoning prompt block from an ECCM profile.
 * Injected into the writer's context so every character action is rooted.
 */
export function buildECCMContext(name: string, eccm: ECCMProfile): string {
  const parts: string[] = [`## 角色因果推理：${name}`];

  if (eccm.root.formativeEvents.length > 0) {
    parts.push("### 形成事件（根系）");
    parts.push(...eccm.root.formativeEvents.map((e) => `- ${e}`));
  }

  if (eccm.branch.decisionMatrix.length > 0) {
    parts.push("### 决策矩阵（枝叶）");
    parts.push(...eccm.branch.decisionMatrix.map((d) => `- ${d}`));
  }

  if (eccm.branch.physiologicalReactions.length > 0) {
    parts.push("### 身体反应模式");
    parts.push(...eccm.branch.physiologicalReactions.map((r) => `- ${r}`));
  }

  if (eccm.fruit.absoluteTaboos.length > 0) {
    parts.push("### 绝对禁忌");
    parts.push(...eccm.fruit.absoluteTaboos.map((t) => `- ${t}`));
  }

  if (eccm.fruit.signatureActions.length > 0) {
    parts.push("### 标志性动作");
    parts.push(...eccm.fruit.signatureActions.map((a) => `- ${a}`));
  }

  parts.push("");
  parts.push("**写作前必须回答**：");
  parts.push(`1. 本章情境对${name}来说是安全区还是威胁区？`);
  parts.push(`2. 他的反应应该激活哪个早期形成事件？`);
  parts.push(`3. 这个反应是否符合他的决策矩阵中的默认模式？`);
  parts.push(`4. 他的身体反应是什么？来源是什么？`);
  parts.push(`5. 如果读者看到他的行为，能否倒推出他的过去？`);
  parts.push("**禁止**：使用性格标签（\"他很固执\"），必须用具体动作展示。");

  return parts.join("\n");
}

function extractSection(body: string, headings: ReadonlyArray<string>): string | null {
  for (const h of headings) {
    const pattern = new RegExp(`^##\\s*${escapeRegex(h)}[^\\n]*$`, "im");
    const match = body.match(pattern);
    if (match && match.index !== undefined) {
      const after = body.slice(match.index + match[0].length);
      const next = after.search(/^##\s/m);
      const text = next >= 0 ? after.slice(0, next) : after;
      return text.trim();
    }
  }
  return null;
}

function extractSubSection(section: string, headings: ReadonlyArray<string>): string {
  for (const h of headings) {
    const pattern = new RegExp(`^###\\s*${escapeRegex(h)}[^\\n]*$`, "im");
    const match = section.match(pattern);
    if (match && match.index !== undefined) {
      const after = section.slice(match.index + match[0].length);
      const next = after.search(/^#{1,3}\s/m);
      const text = next >= 0 ? after.slice(0, next) : after;
      return text.trim();
    }
  }
  return "";
}

function extractListItems(section: string, headings: ReadonlyArray<string>): string[] {
  const text = extractSubSection(section, headings);
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"))
    .map((line) => line.replace(/^[-*]\s+/, "").trim());
}

function extractTableRows(section: string): string[] {
  if (!section) return [];
  const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.some((c) => /^-+/.test(c))) continue; // separator
    if (cells[0]?.toLowerCase().includes("情境")) continue; // header
    const row = cells.filter(Boolean).join(" · ");
    if (row) rows.push(row);
  }
  return rows;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the roles/ directory. Returns [] when no roles are present (e.g. old
 * books still on character_matrix.md).
 */
export async function readRoleCards(bookDir: string): Promise<ReadonlyArray<RoleCard>> {
  const rolesRoot = join(bookDir, "story", "roles");
  const majorDirZh = join(rolesRoot, "主要角色");
  const minorDirZh = join(rolesRoot, "次要角色");
  const majorDirEn = join(rolesRoot, "major");
  const minorDirEn = join(rolesRoot, "minor");

  const cards: RoleCard[] = [];
  await Promise.all([
    collectRoleDir(majorDirZh, "major", cards),
    collectRoleDir(minorDirZh, "minor", cards),
    collectRoleDir(majorDirEn, "major", cards),
    collectRoleDir(minorDirEn, "minor", cards),
  ]);
  return cards;
}

async function collectRoleDir(
  dir: string,
  tier: "major" | "minor",
  out: RoleCard[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const reads = entries
    .filter((entry) => entry.endsWith(".md"))
    .map(async (entry) => {
      const content = await readOr(join(dir, entry), "");
      if (!content.trim()) return;
      out.push({
        tier,
        name: entry.replace(/\.md$/, ""),
        content,
      });
    });
  await Promise.all(reads);
}

/**
 * Render role cards in a format compatible with downstream consumers that
 * previously expected character_matrix.md prose. When no role cards exist,
 * returns the legacy character_matrix.md content or the placeholder.
 */
export async function readCharacterContext(
  bookDir: string,
  fallbackPlaceholder: string = "",
): Promise<string> {
  const cards = await readRoleCards(bookDir);
  if (cards.length > 0) {
    const groups: Record<"major" | "minor", RoleCard[]> = { major: [], minor: [] };
    for (const card of cards) groups[card.tier].push(card);

    const render = (tierCards: RoleCard[], heading: string): string => {
      if (tierCards.length === 0) return "";
      const sections = tierCards.map((card) => `### ${card.name}\n\n${card.content.trim()}`);
      return `## ${heading}\n\n${sections.join("\n\n")}`;
    };

    const blocks = [
      render(groups.major, "主要角色 / Major characters"),
      render(groups.minor, "次要角色 / Minor characters"),
    ].filter(Boolean);

    return blocks.join("\n\n");
  }

  // Fallback: legacy character_matrix.md (may itself be a shim pointer).
  const legacyPath = join(bookDir, "story", "character_matrix.md");
  return readOr(legacyPath, fallbackPlaceholder);
}

// ---------------------------------------------------------------------------
// Phase 5 consolidation: current_state.md initial fallback
//
// After architect consolidation (7→5 sections), current_state.md is seeded
// with a tiny placeholder at book creation. Real content only arrives once
// the consolidator has appended output from chapter 1 onward. Readers that
// previously relied on architect-provided initial state (writer phase-1
// creative prompt, continuity, chapter-analyzer, reviser, composer) should
// substitute a derived initial-state block when the seed placeholder is all
// that's on disk — otherwise the "## 当前状态卡" block in prompts degenerates
// into a meta note about runtime append behaviour.
// ---------------------------------------------------------------------------

/**
 * Marker substring emitted by architect.writeFoundationFiles when seeding
 * current_state.md. Its presence is how readers detect "nothing real yet".
 */
const CURRENT_STATE_SEED_MARKERS = [
  "建书时占位",
  "Seeded at book creation",
];

export function isCurrentStateSeedPlaceholder(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  // Heuristic: short file AND contains one of the seed markers.
  if (trimmed.length > 600) return false;
  return CURRENT_STATE_SEED_MARKERS.some((marker) => trimmed.includes(marker));
}

function extractCurrentStateFromRole(content: string): string | null {
  // Accept both zh (`## 当前现状`) and en (`## Current_State` / `## Current State`).
  const pattern = /^##\s*(?:当前现状|Current[_\s]?State)[^\n]*$/im;
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;
  const after = content.slice(match.index + match[0].length);
  // Cut at next `## ` heading (same or higher level).
  const nextHeading = after.search(/^##\s/m);
  const raw = nextHeading >= 0 ? after.slice(0, nextHeading) : after;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

function extractSeedHooksFromPendingHooks(raw: string): string[] {
  if (!raw.trim()) return [];
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const seedRows: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (cells[0]?.toLowerCase() === "hook_id" || cells[0] === "hookId") continue;
    const startCh = Number.parseInt(cells[1] ?? "", 10);
    if (!Number.isFinite(startCh) || startCh !== 0) continue;
    // cells[2] type, cells[5] expected payoff, last cell notes
    const notes = cells[cells.length - 1] ?? "";
    const summary = [cells[0], cells[2], notes].filter(Boolean).join(" · ");
    if (summary) seedRows.push(summary);
  }
  return seedRows;
}

/**
 * Read current_state.md; when the file is only a seed placeholder (chapter 0,
 * before consolidator has appended anything), derive an initial-state block
 * from roles/*.Current_State + pending_hooks startChapter=0 rows so callers
 * still have substantive content to feed into writer / analyzer prompts.
 */
export async function readCurrentStateWithFallback(
  bookDir: string,
  fallbackPlaceholder: string = "",
): Promise<string> {
  const storyDir = join(bookDir, "story");
  const currentStatePath = join(storyDir, "current_state.md");
  const raw = await readOr(currentStatePath, "");

  if (!isCurrentStateSeedPlaceholder(raw)) {
    return raw;
  }

  const [cards, pendingHooks] = await Promise.all([
    readRoleCards(bookDir),
    readOr(join(storyDir, "pending_hooks.md"), ""),
  ]);

  const roleLines = cards
    .map((card) => {
      const state = extractCurrentStateFromRole(card.content);
      if (!state) return null;
      const tierLabel = card.tier === "major" ? "主要" : "次要";
      return `- ${card.name}（${tierLabel}）：${state.replace(/\s+/g, " ")}`;
    })
    .filter((line): line is string => line !== null);

  const hookLines = extractSeedHooksFromPendingHooks(pendingHooks);

  if (roleLines.length === 0 && hookLines.length === 0) {
    return raw.trim() ? raw : fallbackPlaceholder;
  }

  const parts: string[] = ["# 初始状态（第 0 章，由 roles + 种子伏笔派生）"];
  if (roleLines.length > 0) {
    parts.push("\n## 角色初始位置 / 处境");
    parts.push(...roleLines);
  }
  if (hookLines.length > 0) {
    parts.push("\n## 种子伏笔（startChapter = 0）");
    parts.push(...hookLines.map((line) => `- ${line}`));
  }
  return parts.join("\n");
}
