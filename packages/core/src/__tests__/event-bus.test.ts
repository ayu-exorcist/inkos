import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../events/bus.js";
import { INKOS_EVENTS, type ChapterDraftedEvent } from "../events/events.js";

describe("EventBus", () => {
  it("delivers events to subscribers", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on(INKOS_EVENTS.CHAPTER_DRAFTED, handler);

    const event: ChapterDraftedEvent = {
      bookId: "test",
      chapterNumber: 1,
      title: "Ch1",
      wordCount: 3000,
      status: "drafted",
    };
    await bus.emit(INKOS_EVENTS.CHAPTER_DRAFTED, event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("supports multiple subscribers", async () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test", h1);
    bus.on("test", h2);

    await bus.emit("test", 42);

    expect(h1).toHaveBeenCalledWith(42);
    expect(h2).toHaveBeenCalledWith(42);
  });

  it("unsubscribe removes handler", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.on("test", handler);

    unsub();
    await bus.emit("test", 42);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not throw when emitting with no listeners", async () => {
    const bus = new EventBus();
    await expect(bus.emit("nobody-listening", {})).resolves.toBeUndefined();
  });

  it("isolates handler errors so one broken consumer does not break others", async () => {
    const bus = new EventBus();
    const bad = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    bus.on("test", bad);
    bus.on("test", good);

    await bus.emit("test", "payload");

    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalledWith("payload");
  });

  it("reports listener presence correctly", () => {
    const bus = new EventBus();
    expect(bus.hasListeners("empty")).toBe(false);
    bus.on("empty", () => {});
    expect(bus.hasListeners("empty")).toBe(true);
  });

  it("clears all subscribers", async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("test", handler);
    bus.clear();
    await bus.emit("test", 1);
    expect(handler).not.toHaveBeenCalled();
  });
});
