import type { BaseAgent, AgentContext } from "../agents/base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { NotifyChannel } from "../models/project.js";
import type { RadarSource } from "../agents/radar-source.js";

// ---------------------------------------------------------------------------
// Agent extension point
// ---------------------------------------------------------------------------

export interface AgentFactory {
  readonly name: string;
  create(ctx: AgentContext): BaseAgent | Promise<BaseAgent>;
}

// ---------------------------------------------------------------------------
// Genre extension point
// ---------------------------------------------------------------------------

export interface GenreRegistration {
  readonly id: string;
  readonly displayName: string;
  /** Absolute path to the genre profile markdown, or a loader function. */
  readonly profilePath: string;
}

// ---------------------------------------------------------------------------
// Notify channel extension point
// ---------------------------------------------------------------------------

export interface NotifyChannelFactory {
  readonly id: string;
  readonly displayName: string;
  send(config: unknown, message: NotifyMessage): Promise<void>;
}

export interface NotifyMessage {
  readonly title?: string;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Radar source extension point
// ---------------------------------------------------------------------------

export interface RadarSourceFactory {
  readonly id: string;
  readonly displayName: string;
  create(): RadarSource | Promise<RadarSource>;
}

// ---------------------------------------------------------------------------
// Central registry
// ---------------------------------------------------------------------------

/**
 * ExtensionRegistry decouples core from concrete agent/channel/genre implementations.
 *
 * Migration path:
 *   1. Register built-ins at startup (see registerBuiltins below).
 *   2. Replace direct `new WriterAgent(ctx)` with `registry.resolveAgent("writer")?.create(ctx)`.
 *   3. Later: scan ~/.inkos/plugins/ for external extensions.
 */
export class ExtensionRegistry {
  private agents = new Map<string, AgentFactory>();
  private genres = new Map<string, GenreRegistration>();
  private notifyChannels = new Map<string, NotifyChannelFactory>();
  private radarSources = new Map<string, RadarSourceFactory>();

  // --- Agents ---

  registerAgent(factory: AgentFactory): void {
    if (this.agents.has(factory.name)) {
      throw new Error(`Agent "${factory.name}" is already registered`);
    }
    this.agents.set(factory.name, factory);
  }

  resolveAgent(name: string): AgentFactory | undefined {
    return this.agents.get(name);
  }

  listAgents(): ReadonlyArray<string> {
    return [...this.agents.keys()];
  }

  // --- Genres ---

  registerGenre(reg: GenreRegistration): void {
    this.genres.set(reg.id, reg);
  }

  resolveGenre(id: string): GenreRegistration | undefined {
    return this.genres.get(id);
  }

  listGenres(): ReadonlyArray<GenreRegistration> {
    return [...this.genres.values()];
  }

  // --- Notify ---

  registerNotifyChannel(factory: NotifyChannelFactory): void {
    this.notifyChannels.set(factory.id, factory);
  }

  resolveNotifyChannel(id: string): NotifyChannelFactory | undefined {
    return this.notifyChannels.get(id);
  }

  // --- Radar ---

  registerRadarSource(factory: RadarSourceFactory): void {
    this.radarSources.set(factory.id, factory);
  }

  resolveRadarSource(id: string): RadarSourceFactory | undefined {
    return this.radarSources.get(id);
  }
}

// ---------------------------------------------------------------------------
// Built-in registration helper
// ---------------------------------------------------------------------------

let builtInRegistry: ExtensionRegistry | undefined;

export function getBuiltInRegistry(): ExtensionRegistry {
  if (builtInRegistry) return builtInRegistry;

  const r = new ExtensionRegistry();

  // Agents — lazy-import to avoid loading all agent code when only a subset is used.
  r.registerAgent({
    name: "writer",
    create: async (ctx) => {
      const { WriterAgent } = await import("../agents/writer.js");
      return new WriterAgent(ctx);
    },
  });
  r.registerAgent({
    name: "auditor",
    create: async (ctx) => {
      const { ContinuityAuditor } = await import("../agents/continuity.js");
      return new ContinuityAuditor(ctx);
    },
  });
  r.registerAgent({
    name: "reviser",
    create: async (ctx) => {
      const { ReviserAgent } = await import("../agents/reviser.js");
      return new ReviserAgent(ctx);
    },
  });
  r.registerAgent({
    name: "architect",
    create: async (ctx) => {
      const { ArchitectAgent } = await import("../agents/architect.js");
      return new ArchitectAgent(ctx);
    },
  });
  r.registerAgent({
    name: "planner",
    create: async (ctx) => {
      const { PlannerAgent } = await import("../agents/planner.js");
      return new PlannerAgent(ctx);
    },
  });
  r.registerAgent({
    name: "composer",
    create: async (ctx) => {
      const { ComposerAgent } = await import("../agents/composer.js");
      return new ComposerAgent(ctx);
    },
  });

  // Genres — could be scanned from genres/ directory in the future.
  const builtinGenres = [
    { id: "xuanhuan", displayName: "玄幻", profilePath: "genres/xuanhuan.md" },
    { id: "xianxia", displayName: "仙侠", profilePath: "genres/xianxia.md" },
    { id: "urban", displayName: "都市", profilePath: "genres/urban.md" },
    { id: "scifi", displayName: "科幻", profilePath: "genres/sci-fi.md" },
    { id: "horror", displayName: "悬疑恐怖", profilePath: "genres/horror.md" },
    { id: "litrpg", displayName: "LitRPG", profilePath: "genres/litrpg.md" },
    { id: "progression", displayName: "Progression", profilePath: "genres/progression.md" },
    { id: "cozy", displayName: "Cozy", profilePath: "genres/cozy.md" },
  ];
  for (const g of builtinGenres) {
    r.registerGenre(g);
  }

  // Notify channels
  r.registerNotifyChannel({
    id: "telegram",
    displayName: "Telegram",
    send: async (config, message) => {
      const { sendTelegram } = await import("../notify/telegram.js");
      await sendTelegram(config as any, message.text);
    },
  });
  r.registerNotifyChannel({
    id: "feishu",
    displayName: "飞书",
    send: async (config, message) => {
      const { sendFeishu } = await import("../notify/feishu.js");
      await sendFeishu(config as any, message.title ?? "InkOS", message.text);
    },
  });
  r.registerNotifyChannel({
    id: "webhook",
    displayName: "Webhook",
    send: async (config, message) => {
      const { sendWebhook } = await import("../notify/webhook.js");
      await sendWebhook(config as any, { event: "notify", payload: message } as any);
    },
  });

  // Radar sources
  r.registerRadarSource({
    id: "qidian",
    displayName: "起点中文网",
    create: async () => {
      const { QidianRadarSource } = await import("../agents/radar-source.js");
      return new QidianRadarSource();
    },
  });
  r.registerRadarSource({
    id: "fanqie",
    displayName: "番茄小说",
    create: async () => {
      const { FanqieRadarSource } = await import("../agents/radar-source.js");
      return new FanqieRadarSource();
    },
  });

  builtInRegistry = r;
  return r;
}

export function resetBuiltInRegistry(): void {
  builtInRegistry = undefined;
}
