import type { IncubatorEvent } from '../../types.js';
import type { IEventStore } from '../interfaces.js';
import type { Redis } from './db.js';

export class RedisEventStore implements IEventStore {
  private client: Redis;
  private eventsKey: string;
  private cursorKey: string;

  constructor(client: Redis, namespace: string) {
    this.client = client;
    this.eventsKey = `incubator:${namespace}:events`;
    this.cursorKey = `incubator:${namespace}:cursor`;
  }

  async publish(type: string, data: unknown, agentId: string): Promise<IncubatorEvent> {
    const now = new Date().toISOString();

    // Atomic: increment cursor, then add event with cursor as score
    const pipeline = this.client.multi();
    pipeline.incr(this.cursorKey);
    const results = await pipeline.exec();
    if (!results) throw new Error('Redis MULTI/EXEC failed');

    const id = results[0][1] as number;

    const event: IncubatorEvent = {
      id,
      type,
      data,
      publishedBy: agentId,
      publishedAt: now,
    };

    await this.client.zadd(this.eventsKey, id, JSON.stringify(event));
    return event;
  }

  async getEvents(since?: number, type?: string): Promise<{ events: IncubatorEvent[]; cursor: number }> {
    const min = since !== undefined ? since + 1 : '-inf';
    const raws = await this.client.zrangebyscore(this.eventsKey, min, '+inf');

    let events = raws.map(raw => JSON.parse(raw) as IncubatorEvent);

    if (type) {
      events = events.filter(e => e.type === type);
    }

    const cursor = await this.getCursor();
    return { events, cursor };
  }

  async getCursor(): Promise<number> {
    const raw = await this.client.get(this.cursorKey);
    return raw ? parseInt(raw, 10) : 0;
  }

  async getAll(): Promise<IncubatorEvent[]> {
    const raws = await this.client.zrange(this.eventsKey, 0, -1);
    return raws.map(raw => JSON.parse(raw) as IncubatorEvent);
  }

  async load(events: IncubatorEvent[], cursor: number): Promise<void> {
    const pipeline = this.client.multi();
    pipeline.del(this.eventsKey);

    for (const event of events) {
      pipeline.zadd(this.eventsKey, event.id, JSON.stringify(event));
    }

    pipeline.set(this.cursorKey, String(cursor));
    await pipeline.exec();
  }
}
