import type { Claim, ClaimResult } from '../../types.js';
import type { IClaimStore, IEventStore } from '../interfaces.js';
import type { Redis } from './db.js';
import { matchGlob, isExpired } from '../../utils.js';

export class RedisClaimStore implements IClaimStore {
  private client: Redis;
  private hashKey: string;
  private eventStore: IEventStore;

  constructor(client: Redis, namespace: string, eventStore: IEventStore) {
    this.client = client;
    this.hashKey = `incubator:${namespace}:claims`;
    this.eventStore = eventStore;
  }

  async claim(resource: string, value: string, agentId: string, ttlMs?: number): Promise<ClaimResult> {
    const raw = await this.client.hget(this.hashKey, resource);

    if (raw) {
      const existing: Claim = JSON.parse(raw);

      if (existing.status === 'active' && !isExpired(existing.claimedAt, existing.ttlMs)) {
        if (existing.owner !== agentId) {
          return { status: 'rejected', claim: existing };
        }
        // Same owner re-claiming: update value/ttl
        existing.value = value;
        existing.ttlMs = ttlMs;
        await this.client.hset(this.hashKey, resource, JSON.stringify(existing));
        return { status: 'approved', claim: existing };
      }
    }

    const claim: Claim = {
      resource,
      value,
      owner: agentId,
      status: 'active',
      claimedAt: new Date().toISOString(),
      ttlMs,
    };

    await this.client.hset(this.hashKey, resource, JSON.stringify(claim));
    await this.eventStore.publish('claim.acquired', { resource, value, owner: agentId }, agentId);

    return { status: 'approved', claim };
  }

  async release(resource: string, agentId: string): Promise<Claim | null> {
    const raw = await this.client.hget(this.hashKey, resource);
    if (!raw) return null;

    const claim: Claim = JSON.parse(raw);
    if (claim.status !== 'active') return null;
    if (claim.owner !== agentId) return null;

    claim.status = 'released';
    await this.client.hset(this.hashKey, resource, JSON.stringify(claim));
    await this.eventStore.publish('claim.released', { resource, owner: agentId }, agentId);
    return claim;
  }

  async check(resource: string): Promise<Claim | null> {
    const raw = await this.client.hget(this.hashKey, resource);
    if (!raw) return null;

    const claim: Claim = JSON.parse(raw);
    if (claim.status === 'active' && isExpired(claim.claimedAt, claim.ttlMs)) {
      claim.status = 'expired';
      await this.client.hset(this.hashKey, resource, JSON.stringify(claim));
    }
    return claim;
  }

  async list(pattern?: string): Promise<Claim[]> {
    const all = await this.client.hgetall(this.hashKey);
    const results: Claim[] = [];

    for (const [, raw] of Object.entries(all)) {
      const claim: Claim = JSON.parse(raw);
      if (claim.status === 'active' && isExpired(claim.claimedAt, claim.ttlMs)) {
        claim.status = 'expired';
        await this.client.hset(this.hashKey, claim.resource, JSON.stringify(claim));
        continue;
      }
      if (claim.status !== 'active') continue;
      if (pattern && !matchGlob(pattern, claim.resource)) continue;
      results.push(claim);
    }
    return results;
  }

  async getAll(): Promise<Claim[]> {
    const all = await this.client.hgetall(this.hashKey);
    return Object.values(all).map(raw => JSON.parse(raw) as Claim);
  }

  async load(claims: Claim[]): Promise<void> {
    await this.client.del(this.hashKey);
    if (claims.length === 0) return;

    const data: Record<string, string> = {};
    for (const claim of claims) {
      data[claim.resource] = JSON.stringify(claim);
    }
    await this.client.hset(this.hashKey, data);
  }
}
