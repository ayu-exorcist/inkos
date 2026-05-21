# InkOS Core Architecture

> Architecture decisions and component boundaries for the InkOS pipeline engine.

## Overview

InkOS is a monorepo with three packages:

- `packages/core` — pipeline engine, agents, state management
- `packages/cli` — command-line interface
- `packages/studio` — web-based IDE

This document focuses on `packages/core`.

## Layer Model

```
┌─────────────────────────────────────────┐
│  CLI / Studio / External Tools          │
├─────────────────────────────────────────┤
│  PipelineRunner   (orchestration facade)│
├─────────────────────────────────────────┤
│  Service Layer    (business logic)      │
│  - FoundationService                    │
│  - DraftService                         │
│  - AuditService                         │
│  - RevisionService                      │
│  - ImportService                        │
├─────────────────────────────────────────┤
│  Workflow Engine  (reusable sequences)  │
│  - runDraftAndReviewWorkflow            │
├─────────────────────────────────────────┤
│  Agent Layer      (LLM interactions)    │
│  - WriterAgent, ReviserAgent, ...       │
├─────────────────────────────────────────┤
│  State & Storage  (persistence)         │
│  - StateManager, StorageLayer           │
├─────────────────────────────────────────┤
│  Governance       (cross-cutting)       │
│  - AdaptiveQualityGate                  │
│  - AgentHealthMonitor                   │
│  - PolicyLoader                         │
│  - TelemetryTracer                      │
│  - EventBus                             │
└─────────────────────────────────────────┘
```

## PipelineRunner (Orchestration Facade)

`PipelineRunner` is the public API surface. It does **not** contain business logic directly; instead it delegates to:

- `FoundationService` for book initialization and foundation revision
- `DraftService` for chapter drafting, planning, and composition
- `AuditService` for chapter auditing and merged evaluation
- `RevisionService` for chapter revision based on audit feedback
- `ImportService` for canon import, fanfic initialization, and chapter import

The Runner remains responsible for:
- Agent resolution (registry fallback)
- Telemetry span wrapping
- Event emission
- Webhook dispatch
- Lock management (acquires locks, then delegates)
- Public API facade (all public methods delegate to Services)

### Backward Compatibility

All public methods on `PipelineRunner` retain their original signatures. Internal refactoring does not affect consumers.

## Service Layer

### FoundationService

**Responsibility**: Book initialization and foundation lifecycle.

- `initBook()` — creates directory structure, generates foundation via ArchitectAgent, writes control documents
- `reviseFoundation()` — regenerates foundation based on feedback

**Dependencies**: `StateManager`, agent resolver, optional logger.

### DraftService

**Responsibility**: Chapter drafting and persistence.

- `writeChapter()` — full draft pipeline: prepare inputs → call WriterAgent → normalize length → persist files → update index → sync memory → emit event
- `planChapter()` / `composeChapter()` — governed artifact creation (intent + context package)
- `prepareWriteInput()` — legacy/v2 input governance
- `normalizeDraftLengthIfNeeded()` — length normalization with safety thresholds
- `sync*()` methods — structured state and narrative memory synchronization

**Dependencies**: `StateManager`, agent resolver, optional logger/eventBus.

### AuditService

**Responsibility**: Chapter auditing and merged evaluation.

- `auditChapter()` — LLM structural audit via ContinuityAuditor
- `evaluateMergedAudit()` — combines LLM audit + AI-tells + sensitive words + long-span fatigue into a single evaluation

**Dependencies**: agent resolver only.

### RevisionService

**Responsibility**: Chapter revision based on audit feedback.

- `reviseDraft()` — re-audit → call ReviserAgent → normalize length → re-audit → decide whether to apply → persist files → update index → sync memory

**Dependencies**: `StateManager`, `AuditService`, `DraftService`, agent resolver, optional logger/eventBus.

### ImportService

**Responsibility**: Canon import, fanfic initialization, and chapter import.

- `importFanficCanon()` — generates `fanfic_canon.md` from source text
- `initFanficBook()` — one-step fanfic book creation (config + canon + foundation)
- `importCanon()` — generates `parent_canon.md` from parent book truth files
- `importChapters()` — sequential replay of existing chapters through ChapterAnalyzer
- `generateStyleGuide()` — qualitative + statistical style extraction

**Dependencies**: `StateManager`, `DraftService`, agent resolver, LLM client/model, optional logger/telemetry.

**Backward compatibility note**: `initFanficBook` accepts an optional `importFanficCanon` callback so that `PipelineRunner` facade spies continue to work in tests.

## Workflow Engine

Reusable linear workflows composed of discrete steps:

- `runDraftAndReviewWorkflow()` — draft → review → normalize → audit loop
- `createWorkflowContext()` — builds execution context for workflow steps

Workflows are used by `PipelineRunner._writeNextChapterLocked()` but can also be invoked independently by external tools (OpenClaw, agent mode).

## Extension System

### ExtensionRegistry

A factory registry for agents and other extensible components.

- Built-in registry populated at startup
- Plugins can register custom agents via `inkos-plugin.json`
- `PipelineRunner.resolveAgent()` falls back to hardcoded instantiation if no registry entry exists

### Plugin Discovery

`discoverAndRegisterPlugins()` scans:
- `~/.inkos/plugins/`
- `<projectRoot>/.inkos/plugins/`

Supports both `inkos-plugin.json` and `package.json` with `inkos` field.

## Governance Layer

### AdaptiveQualityGate

Replaces static quality gates with dynamic thresholds based on historical success rates:

- **Baseline** (first 5 chapters): +1 retry, +2 pause tolerance
- **Tightened** (success < 50% or dimension clustering ≥ 3): stricter gates
- **Relaxed** (success > 85%): looser gates
- **Normal**: base settings

### AgentHealthMonitor

Circuit-breaker for LLM agent calls:

- **Closed** → normal operation
- **Open** (5 consecutive failures) → reject calls fast
- **Half-open** (after 60s cooldown) → allow probe

### PolicyLoader

File-based governance policy with hot-reload:

- Loads YAML/JSON from `~/.inkos/policies/` and `<project>/.inkos/policies/`
- Merges multi-source policies (project-local wins)
- Applies dimension enable/disable overrides and score calibration

### TelemetryTracer

Zero-dependency OTel-compatible span tracer:

- JSON output compatible with collector ingestion
- Used by `PipelineRunner.withSpan()`

### EventBus

Lightweight pub/sub for decoupled cross-cutting concerns:

```ts
bus.on(INKOS_EVENTS.CHAPTER_DRAFTED, handler);
bus.emit(INKOS_EVENTS.CHAPTER_DRAFTED, payload);
```

Core events:
- `chapter:drafted`
- `chapter:audited`
- `chapter:revised`
- `audit:failed`
- `book:paused`
- `book:resumed`
- `pipeline:error`

## Storage Abstraction

`StorageLayer` abstracts all filesystem I/O:

- `FileSystemStorage` — default, maps 1:1 to disk
- `InMemoryStorage` — zero-disk, for tests
- `HybridStorage` — SQLite mirror for structured data + filesystem for blobs

`StateManager` accepts optional `storage?: StorageLayer` parameter.

## Provider Registry

Declarative provider configuration:

- `bank.yaml` — 29 pure OpenAI-compatible providers
- Special adapters (Anthropic Messages, Google Generative AI, etc.) registered explicitly in TypeScript
- Total: 43 providers (35 base + 8 CodingPlan)

## Testing Strategy

| Layer | Test Approach |
|-------|--------------|
| Service Layer | Unit tests with mocked agents (`foundation-service.test.ts`, `audit-service.test.ts`, `draft-service.test.ts`) |
| PipelineRunner | Integration tests through public API (`pipeline-runner.test.ts`) |
| Workflow Engine | Integration tests via runner invocation |
| Agents | Mocked at vitest spy level |
| Storage | InMemoryStorage for zero-disk tests |

## Migration Notes

### P0-P5 Refactoring

| Phase | Change |
|-------|--------|
| P0 | Workflow engine + ExtensionRegistry |
| P1 | Unified agent loop + ToolRegistry |
| P2 | Provider registry (YAML bank) + StorageLayer + ContextBudgetManager |
| P3 | Adaptive gates + Health monitor + Telemetry |
| P4 | Plugin discovery |
| P5 | Governance policy file loader + Service extraction + EventBus |
| P5-2 | RevisionService + ImportService extraction |

All phases maintain **full backward compatibility** at the `PipelineRunner` public API level.
