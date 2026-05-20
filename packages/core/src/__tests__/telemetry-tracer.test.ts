import { describe, it, expect, vi } from "vitest";
import {
  TelemetryTracer,
  createConsoleExporter,
  createLoggerExporter,
  type FinishedSpan,
} from "../telemetry/tracer.js";

describe("TelemetryTracer", () => {
  it("starts and ends a single span", () => {
    const tracer = new TelemetryTracer();
    tracer.startSpan({ name: "write-chapter" });
    const span = tracer.endSpan();
    expect(span).toBeDefined();
    expect(span!.name).toBe("write-chapter");
    expect(span!.durationMs).toBeGreaterThanOrEqual(0);
    expect(span!.status).toBe("ok");
  });

  it("nests spans with parent references", () => {
    const tracer = new TelemetryTracer();
    tracer.startSpan({ name: "parent" });
    tracer.startSpan({ name: "child" });
    const child = tracer.endSpan()!;
    const parent = tracer.endSpan()!;

    expect(child.parentSpanId).toBe(parent.spanId);
    expect(parent.parentSpanId).toBeUndefined();
  });

  it("records events on the current span", () => {
    const tracer = new TelemetryTracer();
    tracer.startSpan({ name: "draft" });
    tracer.addEvent("llm-call-start", { model: "gpt-4o" });
    tracer.addEvent("llm-call-end");
    const span = tracer.endSpan()!;

    expect(span.events).toHaveLength(2);
    expect(span.events[0]!.name).toBe("llm-call-start");
    expect(span.events[0]!.attributes).toEqual({ model: "gpt-4o" });
  });

  it("records errors", () => {
    const tracer = new TelemetryTracer();
    tracer.startSpan({ name: "risky-op" });
    tracer.recordError("LLM timeout");
    const span = tracer.endSpan()!;

    expect(span.status).toBe("error");
    expect(span.errorMessage).toBe("LLM timeout");
  });

  it("flushes finished spans to exporters", () => {
    const tracer = new TelemetryTracer();
    const exported: FinishedSpan[][] = [];
    tracer.addExporter((spans) => exported.push([...spans]));

    tracer.startTrace("my-trace");
    tracer.startSpan({ name: "a" });
    tracer.endSpan();

    expect(exported).toHaveLength(1);
    expect(exported[0]![0]!.traceId).toBe("my-trace");
  });

  it("createLoggerExporter formats spans correctly", () => {
    const logger = { info: vi.fn() };
    const exporter = createLoggerExporter(logger);
    const tracer = new TelemetryTracer();
    tracer.addExporter(exporter);

    tracer.startSpan({ name: "test" });
    tracer.endSpan();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("name=test"),
    );
  });
});
