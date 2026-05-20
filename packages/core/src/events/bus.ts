/**
 * Lightweight event bus — zero external dependencies.
 *
 * Supports typed events, multiple subscribers per event type,
 * and async handlers.  Events are dispatched sequentially to
 * preserve ordering within a single event type.
 */

export type EventHandler<T> = (payload: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Array<EventHandler<unknown>>>();

  /** Subscribe to an event type. Returns an unsubscribe function. */
  on<T>(eventType: string, handler: EventHandler<T>): () => void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler as EventHandler<unknown>);
    this.handlers.set(eventType, list);

    return () => {
      const updated = list.filter((h) => h !== handler);
      if (updated.length === 0) {
        this.handlers.delete(eventType);
      } else {
        this.handlers.set(eventType, updated);
      }
    };
  }

  /** Emit an event to all subscribers. */
  async emit<T>(eventType: string, payload: T): Promise<void> {
    const list = this.handlers.get(eventType);
    if (!list) return;
    for (const handler of list) {
      try {
        await handler(payload);
      } catch {
        // ignore handler errors to prevent one broken consumer from breaking the pipeline
      }
    }
  }

  /** Check if there are any subscribers for an event type. */
  hasListeners(eventType: string): boolean {
    const list = this.handlers.get(eventType);
    return list !== undefined && list.length > 0;
  }

  /** Remove all subscribers. */
  clear(): void {
    this.handlers.clear();
  }
}
