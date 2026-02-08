import type { IncubatorEvent } from '../../types.js';
import type { IEventStore } from '../interfaces.js';
import type { Database } from './db.js';

export class SqliteEventStore implements IEventStore {
  private db: Database;
  private ns: string;

  constructor(db: Database, namespace: string) {
    this.db = db;
    this.ns = namespace;

    // Ensure cursor row exists
    this.db.prepare(
      'INSERT OR IGNORE INTO event_cursors (namespace, cursor) VALUES (?, 0)'
    ).run(this.ns);
  }

  async publish(type: string, data: unknown, agentId: string): Promise<IncubatorEvent> {
    const now = new Date().toISOString();

    let event!: IncubatorEvent;
    const txn = this.db.transaction(() => {
      // Increment cursor
      this.db.prepare('UPDATE event_cursors SET cursor = cursor + 1 WHERE namespace = ?').run(this.ns);
      const cursorRow = this.db.prepare('SELECT cursor FROM event_cursors WHERE namespace = ?').get(this.ns) as { cursor: number };
      const id = cursorRow.cursor;

      // Insert event
      this.db.prepare(
        'INSERT INTO events (namespace, id, type, data, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(this.ns, id, type, JSON.stringify(data), agentId, now);

      event = { id, type, data, publishedBy: agentId, publishedAt: now };
    });
    txn();

    return event;
  }

  async getEvents(since?: number, type?: string): Promise<{ events: IncubatorEvent[]; cursor: number }> {
    let sql = 'SELECT id, type, data, published_by, published_at FROM events WHERE namespace = ?';
    const params: unknown[] = [this.ns];

    if (since !== undefined) {
      sql += ' AND id > ?';
      params.push(since);
    }
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }

    sql += ' ORDER BY id';

    const rows = this.db.prepare(sql).all(...params) as Array<{ id: number; type: string; data: string; published_by: string; published_at: string }>;

    const events = rows.map(r => ({
      id: r.id,
      type: r.type,
      data: JSON.parse(r.data),
      publishedBy: r.published_by,
      publishedAt: r.published_at,
    }));

    const cursorRow = this.db.prepare('SELECT cursor FROM event_cursors WHERE namespace = ?').get(this.ns) as { cursor: number } | undefined;
    const cursor = cursorRow?.cursor ?? 0;

    return { events, cursor };
  }

  async getCursor(): Promise<number> {
    const row = this.db.prepare('SELECT cursor FROM event_cursors WHERE namespace = ?').get(this.ns) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  async getAll(): Promise<IncubatorEvent[]> {
    const rows = this.db.prepare(
      'SELECT id, type, data, published_by, published_at FROM events WHERE namespace = ? ORDER BY id'
    ).all(this.ns) as Array<{ id: number; type: string; data: string; published_by: string; published_at: string }>;

    return rows.map(r => ({
      id: r.id,
      type: r.type,
      data: JSON.parse(r.data),
      publishedBy: r.published_by,
      publishedAt: r.published_at,
    }));
  }

  async load(events: IncubatorEvent[], cursor: number): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE namespace = ?').run(this.ns);
      const insert = this.db.prepare(
        'INSERT INTO events (namespace, id, type, data, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const event of events) {
        insert.run(this.ns, event.id, event.type, JSON.stringify(event.data), event.publishedBy, event.publishedAt);
      }
      this.db.prepare(
        'INSERT INTO event_cursors (namespace, cursor) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET cursor = excluded.cursor'
      ).run(this.ns, cursor);
    });
    txn();
  }
}
