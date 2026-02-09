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

  // Lua script for atomic claim check-and-set
  // KEYS[1] = hash key, ARGV[1] = resource, ARGV[2] = new claim JSON,
  // ARGV[3] = agentId, ARGV[4] = now (epoch ms)
  private static CLAIM_SCRIPT = `
    local raw = redis.call('HGET', KEYS[1], ARGV[1])
    if raw then
      local existing = cjson.decode(raw)
      if existing.status == 'active' then
        -- Check if existing claim has expired
        local ttl = tonumber(existing.ttlMs or 0)
        if ttl and ttl > 0 and existing.claimedAt then
          -- Parse ISO date to epoch ms (compare with ARGV[4])
          -- claimedAtMs is stored alongside for Lua comparison
          local createdMs = tonumber(existing.claimedAtMs or 0)
          if createdMs > 0 and (tonumber(ARGV[4]) > createdMs + ttl) then
            -- expired, allow claim through
          elseif existing.owner ~= ARGV[3] then
            return raw
          end
        elseif existing.owner ~= ARGV[3] then
          return raw
        end
      end
    end
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    return nil
  `;

  async claim(resource: string, value: string, agentId: string, ttlMs?: number): Promise<ClaimResult> {
    const now = new Date();
    const claim: Claim & { claimedAtMs?: number } = {
      resource,
      value,
      owner: agentId,
      status: 'active',
      claimedAt: now.toISOString(),
      ttlMs,
    };
    // Store epoch ms for Lua script TTL comparison
    (claim as any).claimedAtMs = now.getTime();
    const claimJson = JSON.stringify(claim);

    // Atomic check-and-set via Lua script
    const result = await (this.client as any).eval(
      RedisClaimStore.CLAIM_SCRIPT,
      1, this.hashKey,
      resource, claimJson, agentId, String(now.getTime())
    );

    if (result) {
      // Script returned existing claim data — rejected
      const existing: Claim = JSON.parse(result);
      if (existing.owner === agentId) {
        // Same owner re-claiming: update
        existing.value = value;
        existing.ttlMs = ttlMs;
        await this.client.hset(this.hashKey, resource, JSON.stringify(existing));
        return { status: 'approved', claim: existing };
      }
      return { status: 'rejected', claim: existing };
    }

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
