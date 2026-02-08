import type { Discovery } from '../../types.js';
import type { IDiscoveryStore, IEventStore } from '../interfaces.js';
import type { Database } from './db.js';
import { generateId } from '../../utils.js';

export class SqliteDiscoveryStore implements IDiscoveryStore {
  private db: Database;
  private ns: string;
  private eventStore: IEventStore;

  constructor(db: Database, namespace: string, eventStore: IEventStore) {
    this.db = db;
    this.ns = namespace;
    this.eventStore = eventStore;
  }

  async publish(topic: string, content: string, agentId: string, category?: string): Promise<Discovery> {
    const id = generateId();
    const now = new Date().toISOString();

    this.db.prepare(
      'INSERT INTO discoveries (namespace, id, topic, content, category, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(this.ns, id, topic, content, category ?? null, agentId, now);

    await this.eventStore.publish('discovery.published', { id, topic, category }, agentId);

    return {
      id,
      topic,
      content,
      category,
      publishedBy: agentId,
      publishedAt: now,
    };
  }

  async search(query?: string, category?: string): Promise<Discovery[]> {
    let sql = 'SELECT id, topic, content, category, published_by, published_at FROM discoveries WHERE namespace = ?';
    const params: unknown[] = [this.ns];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    const rows = this.db.prepare(sql).all(...params) as DiscoveryRow[];

    let results = rows.map(r => this.rowToDiscovery(r));

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
    const rows = this.db.prepare(
      'SELECT id, topic, content, category, published_by, published_at FROM discoveries WHERE namespace = ?'
    ).all(this.ns) as DiscoveryRow[];

    return rows.map(r => this.rowToDiscovery(r));
  }

  async load(discoveries: Discovery[]): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM discoveries WHERE namespace = ?').run(this.ns);
      const insert = this.db.prepare(
        'INSERT INTO discoveries (namespace, id, topic, content, category, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const d of discoveries) {
        insert.run(this.ns, d.id, d.topic, d.content, d.category ?? null, d.publishedBy, d.publishedAt);
      }
    });
    txn();
  }

  private rowToDiscovery(row: DiscoveryRow): Discovery {
    return {
      id: row.id,
      topic: row.topic,
      content: row.content,
      category: row.category ?? undefined,
      publishedBy: row.published_by,
      publishedAt: row.published_at,
    };
  }
}

interface DiscoveryRow {
  id: string;
  topic: string;
  content: string;
  category: string | null;
  published_by: string;
  published_at: string;
}
