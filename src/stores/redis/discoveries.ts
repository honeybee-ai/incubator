import type { Discovery } from '../../types.js';
import type { IDiscoveryStore, IEventStore } from '../interfaces.js';
import type { Redis } from './db.js';
import { generateId } from '../../utils.js';

export class RedisDiscoveryStore implements IDiscoveryStore {
  private client: Redis;
  private listKey: string;
  private eventStore: IEventStore;

  constructor(client: Redis, namespace: string, eventStore: IEventStore) {
    this.client = client;
    this.listKey = `incubator:${namespace}:discoveries`;
    this.eventStore = eventStore;
  }

  async publish(topic: string, content: string, agentId: string, category?: string): Promise<Discovery> {
    const discovery: Discovery = {
      id: generateId(),
      topic,
      content,
      category,
      publishedBy: agentId,
      publishedAt: new Date().toISOString(),
    };

    await this.client.rpush(this.listKey, JSON.stringify(discovery));
    await this.eventStore.publish('discovery.published', {
      id: discovery.id,
      topic,
      category,
    }, agentId);

    return discovery;
  }

  async search(query?: string, category?: string): Promise<Discovery[]> {
    const raws = await this.client.lrange(this.listKey, 0, -1);
    let results = raws.map(raw => JSON.parse(raw) as Discovery);

    if (category) {
      results = results.filter(d => d.category === category);
    }

    if (query) {
      const lower = query.toLowerCase();
      results = results.filter(d =>
        d.topic.toLowerCase().includes(lower) ||
        d.content.toLowerCase().includes(lower)
      );
    }

    return results;
  }

  async getAll(): Promise<Discovery[]> {
    const raws = await this.client.lrange(this.listKey, 0, -1);
    return raws.map(raw => JSON.parse(raw) as Discovery);
  }

  async load(discoveries: Discovery[]): Promise<void> {
    const pipeline = this.client.multi();
    pipeline.del(this.listKey);

    for (const d of discoveries) {
      pipeline.rpush(this.listKey, JSON.stringify(d));
    }

    await pipeline.exec();
  }
}
