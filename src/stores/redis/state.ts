import type { StateEntry } from '../../types.js';
import type { IStateStore } from '../interfaces.js';
import type { Redis } from './db.js';
import { matchGlob, isExpired } from '../../utils.js';

export class RedisStateStore implements IStateStore {
  private client: Redis;
  private hashKey: string;

  constructor(client: Redis, namespace: string) {
    this.client = client;
    this.hashKey = `incubator:${namespace}:state`;
  }

  async get(key: string): Promise<StateEntry | null> {
    const raw = await this.client.hget(this.hashKey, key);
    if (!raw) return null;

    const entry: StateEntry = JSON.parse(raw);
    if (isExpired(entry.setAt, entry.ttlMs)) {
      await this.client.hdel(this.hashKey, key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: unknown, agentId: string, category?: string, ttlMs?: number): Promise<StateEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(key);
    const setAt = existing?.setAt ?? now;

    const entry: StateEntry = {
      key,
      value,
      category,
      setBy: agentId,
      setAt,
      updatedAt: now,
      ttlMs,
    };

    await this.client.hset(this.hashKey, key, JSON.stringify(entry));
    return entry;
  }

  async delete(key: string): Promise<boolean> {
    const count = await this.client.hdel(this.hashKey, key);
    return count > 0;
  }

  async query(pattern?: string, category?: string): Promise<StateEntry[]> {
    const all = await this.client.hgetall(this.hashKey);
    const results: StateEntry[] = [];

    for (const [, raw] of Object.entries(all)) {
      const entry: StateEntry = JSON.parse(raw);
      if (isExpired(entry.setAt, entry.ttlMs)) {
        await this.client.hdel(this.hashKey, entry.key);
        continue;
      }
      if (pattern && !matchGlob(pattern, entry.key)) continue;
      if (category && entry.category !== category) continue;
      results.push(entry);
    }
    return results;
  }

  async getAll(): Promise<StateEntry[]> {
    const all = await this.client.hgetall(this.hashKey);
    const results: StateEntry[] = [];

    for (const [, raw] of Object.entries(all)) {
      const entry: StateEntry = JSON.parse(raw);
      if (!isExpired(entry.setAt, entry.ttlMs)) {
        results.push(entry);
      }
    }
    return results;
  }

  async load(entries: StateEntry[]): Promise<void> {
    await this.client.del(this.hashKey);
    if (entries.length === 0) return;

    const data: Record<string, string> = {};
    for (const entry of entries) {
      if (!isExpired(entry.setAt, entry.ttlMs)) {
        data[entry.key] = JSON.stringify(entry);
      }
    }
    if (Object.keys(data).length > 0) {
      await this.client.hset(this.hashKey, data);
    }
  }
}
