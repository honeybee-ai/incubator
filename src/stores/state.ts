import type { StateEntry } from '../types.js';
import type { IStateStore } from './interfaces.js';
import { matchGlob, isExpired } from '../utils.js';

export class StateStore implements IStateStore {
  private entries = new Map<string, StateEntry>();

  async get(key: string): Promise<StateEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (isExpired(entry.setAt, entry.ttlMs)) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: unknown, agentId: string, category?: string, ttlMs?: number): Promise<StateEntry> {
    const now = new Date().toISOString();
    const existing = this.entries.get(key);
    const entry: StateEntry = {
      key,
      value,
      category,
      setBy: agentId,
      setAt: existing?.setAt ?? now,
      updatedAt: now,
      ttlMs,
    };
    this.entries.set(key, entry);
    return entry;
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async query(pattern?: string, category?: string): Promise<StateEntry[]> {
    const results: StateEntry[] = [];
    for (const entry of this.entries.values()) {
      if (isExpired(entry.setAt, entry.ttlMs)) {
        this.entries.delete(entry.key);
        continue;
      }
      if (pattern && !matchGlob(pattern, entry.key)) continue;
      if (category && entry.category !== category) continue;
      results.push(entry);
    }
    return results;
  }

  // For persistence
  async getAll(): Promise<StateEntry[]> {
    // Clean expired on export
    const results: StateEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!isExpired(entry.setAt, entry.ttlMs)) {
        results.push(entry);
      }
    }
    return results;
  }

  async load(entries: StateEntry[]): Promise<void> {
    this.entries.clear();
    for (const entry of entries) {
      if (!isExpired(entry.setAt, entry.ttlMs)) {
        this.entries.set(entry.key, entry);
      }
    }
  }
}
