import type { Claim, ClaimResult } from '../../types.js';
import type { IClaimStore, IEventStore } from '../interfaces.js';
import type { Database } from './db.js';
import { matchGlob, isExpired } from '../../utils.js';

export class SqliteClaimStore implements IClaimStore {
  private db: Database;
  private ns: string;
  private eventStore: IEventStore;

  constructor(db: Database, namespace: string, eventStore: IEventStore) {
    this.db = db;
    this.ns = namespace;
    this.eventStore = eventStore;
  }

  async claim(resource: string, value: string, agentId: string, ttlMs?: number): Promise<ClaimResult> {
    let result!: ClaimResult;
    let shouldPublishAcquired = false;

    const txn = this.db.transaction(() => {
      const existing = this.getClaimRow(resource);

      // If there's an active, non-expired claim by someone else, reject
      if (existing && existing.status === 'active' && !isExpired(existing.claimed_at, existing.ttl_ms ?? undefined)) {
        if (existing.owner !== agentId) {
          result = { status: 'rejected', claim: this.rowToClaim(existing) };
          return;
        }
        // Same owner re-claiming: update value/ttl
        this.db.prepare(
          'UPDATE claims SET value = ?, ttl_ms = ? WHERE namespace = ? AND resource = ?'
        ).run(value, ttlMs ?? null, this.ns, resource);

        result = {
          status: 'approved',
          claim: { ...this.rowToClaim(existing), value, ttlMs },
        };
        return;
      }

      // Create new claim
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO claims (namespace, resource, value, owner, status, claimed_at, ttl_ms)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(namespace, resource) DO UPDATE SET
          value = excluded.value,
          owner = excluded.owner,
          status = excluded.status,
          claimed_at = excluded.claimed_at,
          ttl_ms = excluded.ttl_ms
      `).run(this.ns, resource, value, agentId, now, ttlMs ?? null);

      const claim: Claim = {
        resource,
        value,
        owner: agentId,
        status: 'active',
        claimedAt: now,
        ttlMs,
      };

      shouldPublishAcquired = true;
      result = { status: 'approved', claim };
    });
    txn();

    if (shouldPublishAcquired) {
      await this.eventStore.publish('claim.acquired', { resource, value, owner: agentId }, agentId);
    }

    return result;
  }

  async release(resource: string, agentId: string): Promise<Claim | null> {
    const row = this.getClaimRow(resource);
    if (!row || row.status !== 'active') return null;
    if (row.owner !== agentId) return null;

    this.db.prepare(
      'UPDATE claims SET status = ? WHERE namespace = ? AND resource = ?'
    ).run('released', this.ns, resource);

    await this.eventStore.publish('claim.released', { resource, owner: agentId }, agentId);

    return { ...this.rowToClaim(row), status: 'released' };
  }

  async check(resource: string): Promise<Claim | null> {
    const row = this.getClaimRow(resource);
    if (!row) return null;

    if (row.status === 'active' && isExpired(row.claimed_at, row.ttl_ms ?? undefined)) {
      this.db.prepare(
        'UPDATE claims SET status = ? WHERE namespace = ? AND resource = ?'
      ).run('expired', this.ns, resource);
      return { ...this.rowToClaim(row), status: 'expired' };
    }

    return this.rowToClaim(row);
  }

  async list(pattern?: string): Promise<Claim[]> {
    const rows = this.db.prepare(
      'SELECT resource, value, owner, status, claimed_at, ttl_ms FROM claims WHERE namespace = ? AND status = ?'
    ).all(this.ns, 'active') as ClaimRow[];

    const results: Claim[] = [];
    for (const row of rows) {
      if (isExpired(row.claimed_at, row.ttl_ms ?? undefined)) {
        this.db.prepare(
          'UPDATE claims SET status = ? WHERE namespace = ? AND resource = ?'
        ).run('expired', this.ns, row.resource);
        continue;
      }
      if (pattern && !matchGlob(pattern, row.resource)) continue;
      results.push(this.rowToClaim(row));
    }
    return results;
  }

  async getAll(): Promise<Claim[]> {
    const rows = this.db.prepare(
      'SELECT resource, value, owner, status, claimed_at, ttl_ms FROM claims WHERE namespace = ?'
    ).all(this.ns) as ClaimRow[];

    return rows.map(r => this.rowToClaim(r));
  }

  async load(claims: Claim[]): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM claims WHERE namespace = ?').run(this.ns);
      const insert = this.db.prepare(
        'INSERT INTO claims (namespace, resource, value, owner, status, claimed_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const claim of claims) {
        insert.run(this.ns, claim.resource, claim.value, claim.owner, claim.status, claim.claimedAt, claim.ttlMs ?? null);
      }
    });
    txn();
  }

  private getClaimRow(resource: string): ClaimRow | undefined {
    return this.db.prepare(
      'SELECT resource, value, owner, status, claimed_at, ttl_ms FROM claims WHERE namespace = ? AND resource = ?'
    ).get(this.ns, resource) as ClaimRow | undefined;
  }

  private rowToClaim(row: ClaimRow): Claim {
    return {
      resource: row.resource,
      value: row.value,
      owner: row.owner,
      status: row.status as Claim['status'],
      claimedAt: row.claimed_at,
      ttlMs: row.ttl_ms ?? undefined,
    };
  }
}

interface ClaimRow {
  resource: string;
  value: string;
  owner: string;
  status: string;
  claimed_at: string;
  ttl_ms: number | null;
}
