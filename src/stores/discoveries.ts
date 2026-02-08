import type { Discovery } from '../types.js';
import type { IDiscoveryStore, IEventStore } from './interfaces.js';
import { generateId } from '../utils.js';

export class DiscoveryStore implements IDiscoveryStore {
  private discoveries: Discovery[] = [];
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
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
    this.discoveries.push(discovery);

    await this.eventStore.publish('discovery.published', {
      id: discovery.id,
      topic,
      category,
    }, agentId);

    return discovery;
  }

  async search(query?: string, category?: string): Promise<Discovery[]> {
    let results = this.discoveries;

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

  // For persistence
  async getAll(): Promise<Discovery[]> {
    return [...this.discoveries];
  }

  async load(discoveries: Discovery[]): Promise<void> {
    this.discoveries = discoveries;
  }
}
