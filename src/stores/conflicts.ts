import type { Conflict } from '../types.js';
import type { IConflictStore, IEventStore } from './interfaces.js';
import { randomBytes } from 'node:crypto';

export class ConflictStore implements IConflictStore {
  private conflicts = new Map<string, Conflict>();
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore;
  }

  async flag(agentId: string, discovery_a: string, discovery_b: string, reason: string): Promise<Conflict> {
    const conflict: Conflict = {
      id: randomBytes(8).toString('hex'),
      flaggedBy: agentId,
      discovery_a,
      discovery_b,
      reason,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.conflicts.set(conflict.id, conflict);
    await this.eventStore.publish('conflict.flagged', { conflict_id: conflict.id, flagged_by: agentId, discovery_a, discovery_b }, agentId);
    return conflict;
  }

  async resolve(conflictId: string, agentId: string, resolution: string): Promise<Conflict | null> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict || conflict.status !== 'open') return null;
    conflict.status = 'resolved';
    conflict.resolvedBy = agentId;
    conflict.resolution = resolution;
    await this.eventStore.publish('conflict.resolved', { conflict_id: conflictId, resolved_by: agentId, resolution }, agentId);
    return conflict;
  }

  async list(status?: string): Promise<Conflict[]> {
    const all = [...this.conflicts.values()];
    if (!status) return all;
    return all.filter(c => c.status === status);
  }
}
