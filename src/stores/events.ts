import type { IncubatorEvent } from '../types.js';
import type { IEventStore } from './interfaces.js';

export class EventStore implements IEventStore {
  private events: IncubatorEvent[] = [];
  private cursor = 0;

  async publish(type: string, data: unknown, agentId: string): Promise<IncubatorEvent> {
    const event: IncubatorEvent = {
      id: ++this.cursor,
      type,
      data,
      publishedBy: agentId,
      publishedAt: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async getEvents(since?: number, type?: string): Promise<{ events: IncubatorEvent[]; cursor: number }> {
    let filtered = this.events;
    if (since !== undefined) {
      filtered = filtered.filter(e => e.id > since);
    }
    if (type) {
      filtered = filtered.filter(e => e.type === type);
    }
    return { events: filtered, cursor: this.cursor };
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  // For persistence
  async getAll(): Promise<IncubatorEvent[]> {
    return [...this.events];
  }

  async load(events: IncubatorEvent[], cursor: number): Promise<void> {
    this.events = events;
    this.cursor = cursor;
  }
}
