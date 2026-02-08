import type { Claim, ClaimResult } from '../types.js';
import type { IClaimStore, IEventStore } from './interfaces.js';
import { matchGlob, isExpired } from '../utils.js';

export { type ClaimResult } from '../types.js';

export class ClaimStore implements IClaimStore {
  private claims = new Map<string, Claim>();
  private eventStore: IEventStore;

  constructor(eventStore: IEventStore) {
    this.eventStore = eventStore;
  }

  async claim(resource: string, value: string, agentId: string, ttlMs?: number): Promise<ClaimResult> {
    const existing = this.claims.get(resource);

    // If there's an active, non-expired claim by someone else, reject
    if (existing && existing.status === 'active' && !isExpired(existing.claimedAt, existing.ttlMs)) {
      if (existing.owner !== agentId) {
        return { status: 'rejected', claim: existing };
      }
      // Same owner re-claiming: update value/ttl
      existing.value = value;
      existing.ttlMs = ttlMs;
      return { status: 'approved', claim: existing };
    }

    const claim: Claim = {
      resource,
      value,
      owner: agentId,
      status: 'active',
      claimedAt: new Date().toISOString(),
      ttlMs,
    };
    this.claims.set(resource, claim);

    await this.eventStore.publish('claim.acquired', { resource, value, owner: agentId }, agentId);

    return { status: 'approved', claim };
  }

  async release(resource: string, agentId: string): Promise<Claim | null> {
    const claim = this.claims.get(resource);
    if (!claim || claim.status !== 'active') return null;

    // Only the owner can release
    if (claim.owner !== agentId) return null;

    claim.status = 'released';
    await this.eventStore.publish('claim.released', { resource, owner: agentId }, agentId);
    return claim;
  }

  async check(resource: string): Promise<Claim | null> {
    const claim = this.claims.get(resource);
    if (!claim) return null;
    if (claim.status === 'active' && isExpired(claim.claimedAt, claim.ttlMs)) {
      claim.status = 'expired';
    }
    return claim;
  }

  async list(pattern?: string): Promise<Claim[]> {
    const results: Claim[] = [];
    for (const claim of this.claims.values()) {
      if (claim.status === 'active' && isExpired(claim.claimedAt, claim.ttlMs)) {
        claim.status = 'expired';
      }
      if (claim.status !== 'active') continue;
      if (pattern && !matchGlob(pattern, claim.resource)) continue;
      results.push(claim);
    }
    return results;
  }

  // For persistence
  async getAll(): Promise<Claim[]> {
    return [...this.claims.values()];
  }

  async load(claims: Claim[]): Promise<void> {
    this.claims.clear();
    for (const claim of claims) {
      this.claims.set(claim.resource, claim);
    }
  }
}
