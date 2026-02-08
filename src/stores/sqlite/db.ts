import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// better-sqlite3 types
export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  pragma(pragma: string): unknown;
  close(): void;
}

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const dbCache = new Map<string, Database>();

export function getDatabase(dbPath: string): Database {
  const resolved = dbPath === ':memory:' ? dbPath : resolve(dbPath);

  const cached = dbCache.get(resolved);
  if (cached) return cached;

  const require = createRequire(import.meta.url);
  const BetterSqlite3 = require('better-sqlite3') as new (path: string) => Database;
  const db = new BetterSqlite3(resolved);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  initSchema(db);

  if (resolved !== ':memory:') {
    dbCache.set(resolved, db);
  }

  return db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT,
      set_by TEXT NOT NULL,
      set_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ttl_ms INTEGER,
      PRIMARY KEY (namespace, key)
    );

    CREATE TABLE IF NOT EXISTS events (
      namespace TEXT NOT NULL,
      id INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (namespace, id)
    );

    CREATE TABLE IF NOT EXISTS event_cursors (
      namespace TEXT NOT NULL PRIMARY KEY,
      cursor INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS claims (
      namespace TEXT NOT NULL,
      resource TEXT NOT NULL,
      value TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      ttl_ms INTEGER,
      PRIMARY KEY (namespace, resource)
    );

    CREATE TABLE IF NOT EXISTS discoveries (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (namespace, id)
    );

    CREATE INDEX IF NOT EXISTS idx_state_ns_cat ON state (namespace, category);
    CREATE INDEX IF NOT EXISTS idx_events_ns_type ON events (namespace, type);
    CREATE INDEX IF NOT EXISTS idx_claims_ns_status ON claims (namespace, status);
    CREATE INDEX IF NOT EXISTS idx_discoveries_ns_cat ON discoveries (namespace, category);
  `);
}
