import type { EventSourceLike } from "../features/stream/fleet-stream-client";

/** `EventSource` falso: los tests disparan `open`, eventos con nombre y `error` a mano. */
export class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.dispatch("open", new Event("open"));
  }

  /** Un evento SSE con nombre; `data` se serializa como lo haría el servidor (una línea de JSON). */
  emit(type: string, data: unknown): void {
    this.dispatch(type, new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }

  fail(): void {
    this.dispatch("error", new Event("error"));
  }
}

/** Fábrica que guarda cada conexión creada, en orden. */
export function fakeEventSources() {
  const created: FakeEventSource[] = [];
  return {
    created,
    factory: (url: string) => {
      const source = new FakeEventSource(url);
      created.push(source);
      return source;
    },
    latest(): FakeEventSource {
      const source = created[created.length - 1];
      if (source === undefined) throw new Error("no se creó ninguna conexión");
      return source;
    },
  };
}
