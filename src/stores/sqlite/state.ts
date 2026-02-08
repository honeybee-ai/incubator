import type { StateEntry } from '../../types.js';
import type { IStateStore } from '../interfaces.js';
import type { Database } from './db.js';
import { matchGlob, isExpired } from '../../utils.js';

export class SqliteStateStore implements IStateStore {
  private db: Database;
  private ns: string;

  constructor(db: Database, namespace: string) {
    this.db = db;
    this.ns = namespace;
  }

  async get(key: string): Promise<StateEntry | null> {
    const row = this.db.prepare(
      'SELECT key, value, category, set_by, set_at, updated_at, ttl_ms FROM state WHERE namespace = ? AND key = ?'
    ).get(this.ns, key) as { key: string; value: string; category: string | null; set_by: string; set_at: string; updated_at: string; ttl_ms: number | null } | undefined;

    if (!row) return null;

    const entry = this.rowToEntry(row);
    if (isExpired(entry.setAt, entry.ttlMs)) {
      this.db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run(this.ns, key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: unknown, agentId: string, category?: string, ttlMs?: number): Promise<StateEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(key);
    const setAt = existing?.setAt ?? now;

    this.db.prepare(`
      INSERT INTO state (namespace, key, value, category, set_by, set_at, updated_at, ttl_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        category = excluded.category,
        set_by = excluded.set_by,
        updated_at = excluded.updated_at,
        ttl_ms = excluded.ttl_ms
    `).run(this.ns, key, JSON.stringify(value), category ?? null, agentId, setAt, now, ttlMs ?? null);

    return {
      key,
      value,
      category,
      setBy: agentId,
      setAt,
      updatedAt: now,
      ttlMs,
    };
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run(this.ns, key);
    return result.changes > 0;
  }

  async query(pattern?: string, category?: string): Promise<StateEntry[]> {
    let sql = 'SELECT key, value, category, set_by, set_at, updated_at, ttl_ms FROM state WHERE namespace = ?';
    const params: unknown[] = [this.ns];

    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ key: string; value: string; category: string | null; set_by: string; set_at: string; updated_at: string; ttl_ms: number | null }>;

    const results: StateEntry[] = [];
    for (const row of rows) {
      const entry = this.rowToEntry(row);
      if (isExpired(entry.setAt, entry.ttlMs)) {
        this.db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run(this.ns, entry.key);
        continue;
      }
      if (pattern && !matchGlob(pattern, entry.key)) continue;
      results.push(entry);
    }
    return results;
  }

  async getAll(): Promise<StateEntry[]> {
    const rows = this.db.prepare(
      'SELECT key, value, category, set_by, set_at, updated_at, ttl_ms FROM state WHERE namespace = ?'
    ).all(this.ns) as Array<{ key: string; value: string; category: string | null; set_by: string; set_at: string; updated_at: string; ttl_ms: number | null }>;

    return rows
      .map(r => this.rowToEntry(r))
      .filter(e => !isExpired(e.setAt, e.ttlMs));
  }

  async load(entries: StateEntry[]): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM state WHERE namespace = ?').run(this.ns);
      const insert = this.db.prepare(
        'INSERT INTO state (namespace, key, value, category, set_by, set_at, updated_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const entry of entries) {
        if (!isExpired(entry.setAt, entry.ttlMs)) {
          insert.run(this.ns, entry.key, JSON.stringify(entry.value), entry.category ?? null, entry.setBy, entry.setAt, entry.updatedAt, entry.ttlMs ?? null);
        }
      }
    });
    txn();
  }

  private rowToEntry(row: { key: string; value: string; category: string | null; set_by: string; set_at: string; updated_at: string; ttl_ms: number | null }): StateEntry {
    return {
      key: row.key,
      value: JSON.parse(row.value),
      category: row.category ?? undefined,
      setBy: row.set_by,
      setAt: row.set_at,
      updatedAt: row.updated_at,
      ttlMs: row.ttl_ms ?? undefined,
    };
  }
}
