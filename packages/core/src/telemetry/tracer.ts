/**
 * Lightweight telemetry tracer — OpenTelemetry-compatible JSON output,
 * zero external dependencies.
 *
 * Tracks spans with start/end times, attributes, and events.
 * Spans can be nested via a simple context stack.
 */

export interface SpanOptions {
  readonly name: string;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes?: Record<string, string | number | boolean>;
}

export interface FinishedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly attributes: Record<string, string | number | boolean>;
  readonly events: SpanEvent[];
  readonly status: "ok" | "error";
  readonly errorMessage?: string;
}

let traceIdCounter = 0;
let spanIdCounter = 0;

function genTraceId(): string {
  return `trace-${Date.now()}-${++traceIdCounter}`;
}

function genSpanId(): string {
  return `span-${++spanIdCounter}`;
}

class ActiveSpan {
  readonly spanId = genSpanId();
  readonly startTime = Date.now();
  readonly events: SpanEvent[] = [];
  status: "ok" | "error" = "ok";
  errorMessage?: string;

  constructor(
    readonly traceId: string,
    readonly parentSpanId: string | undefined,
    readonly name: string,
    readonly attributes: Record<string, string | number | boolean>,
  ) {}

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    this.events.push({ name, timestamp: Date.now(), attributes });
  }

  finish(): FinishedSpan {
    const endTime = Date.now();
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      attributes: this.attributes,
      events: this.events,
      status: this.status,
      errorMessage: this.errorMessage,
    };
  }
}

export type SpanExporter = (spans: ReadonlyArray<FinishedSpan>) => void;

export class TelemetryTracer {
  private activeSpans: ActiveSpan[] = [];
  private finishedSpans: FinishedSpan[] = [];
  private currentTraceId?: string;
  private exporters: SpanExporter[] = [];

  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  /** Start a new trace (or continue an existing one if traceId provided). */
  startTrace(traceId?: string): string {
    this.currentTraceId = traceId ?? genTraceId();
    this.finishedSpans = [];
    return this.currentTraceId;
  }

  /** Start a span. If another span is active, this becomes its child. */
  startSpan(options: SpanOptions): void {
    const traceId = this.currentTraceId ?? genTraceId();
    if (!this.currentTraceId) this.currentTraceId = traceId;

    const parent = this.activeSpans[this.activeSpans.length - 1];
    const span = new ActiveSpan(traceId, parent?.spanId, options.name, options.attributes ?? {});
    this.activeSpans.push(span);
  }

  /** Add an event to the current active span. */
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = this.activeSpans[this.activeSpans.length - 1];
    if (span) span.addEvent(name, attributes);
  }

  /** Record an error on the current active span. */
  recordError(message: string): void {
    const span = this.activeSpans[this.activeSpans.length - 1];
    if (span) {
      span.status = "error";
      span.errorMessage = message;
    }
  }

  /** End the current active span and flush if it's the root. */
  endSpan(): FinishedSpan | undefined {
    const span = this.activeSpans.pop();
    if (!span) return undefined;

    const finished = span.finish();
    this.finishedSpans.push(finished);

    // If no more active spans, flush the trace
    if (this.activeSpans.length === 0) {
      this.flush();
    }

    return finished;
  }

  /** Get all finished spans for the current trace. */
  getFinishedSpans(): ReadonlyArray<FinishedSpan> {
    return this.finishedSpans;
  }

  private flush(): void {
    if (this.exporters.length === 0 || this.finishedSpans.length === 0) return;
    const batch = [...this.finishedSpans];
    for (const exporter of this.exporters) {
      try {
        exporter(batch);
      } catch {
        // ignore exporter errors
      }
    }
  }
}

/** Console exporter for local debugging. */
export function createConsoleExporter(prefix = "[telemetry]"): SpanExporter {
  return (spans) => {
    for (const span of spans) {
      const indent = span.parentSpanId ? "  " : "";
      const statusMarker = span.status === "error" ? "❌" : "✅";
      // eslint-disable-next-line no-console
      console.log(
        `${prefix} ${indent}${statusMarker} ${span.name} (${span.durationMs}ms)` +
          (span.errorMessage ? ` — ${span.errorMessage}` : ""),
      );
      for (const event of span.events) {
        // eslint-disable-next-line no-console
        console.log(`${prefix} ${indent}  📌 ${event.name}`);
      }
    }
  };
}

/** Logger exporter for production. */
export function createLoggerExporter(logger: { info: (msg: string) => void }): SpanExporter {
  return (spans) => {
    for (const span of spans) {
      logger.info(
        `trace=${span.traceId} span=${span.spanId} name=${span.name} ` +
          `duration=${span.durationMs}ms status=${span.status}` +
          (span.errorMessage ? ` error="${span.errorMessage}"` : ""),
      );
    }
  };
}
