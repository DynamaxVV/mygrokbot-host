// Event bus: the same fan-out the real gateway serves on GET /events (SSE).
// Every transcript mutation is published as a typed event so a client can rebuild
// the UI without polling, which is what the desktop app does.

export class EventBus {
  constructor() {
    this.listeners = new Set();
    this.seq = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event) {
    this.seq += 1;
    const payload = { seq: this.seq, at: Date.now(), ...event };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        /* a broken client must not break the turn */
      }
    }
    return payload;
  }

  get size() {
    return this.listeners.size;
  }
}
