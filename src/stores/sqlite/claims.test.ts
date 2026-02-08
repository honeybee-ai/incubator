import { describe, it, expect } from 'vitest';
import { getDatabase } from './db.js';
import { SqliteEventStore } from './events.js';
import { SqliteClaimStore } from './claims.js';

describe('SqliteClaimStore', () => {
  function setup() {
    const db = getDatabase(':memory:');
    const events = new SqliteEventStore(db, 'test');
    const claims = new SqliteClaimStore(db, 'test', events);
    return { events, claims };
  }

  it('approves first claim', async () => {
    const { claims } = setup();
    const result = await claims.claim('file.ts', 'editing', 'agent_1');
    expect(result.status).toBe('approved');
    expect(result.claim.owner).toBe('agent_1');
  });

  it('rejects conflicting claim', async () => {
    const { claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1');
    const result = await claims.claim('file.ts', 'also editing', 'agent_2');
    expect(result.status).toBe('rejected');
    expect(result.claim.owner).toBe('agent_1');
  });

  it('allows same owner to re-claim', async () => {
    const { claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1');
    const result = await claims.claim('file.ts', 'updating', 'agent_1');
    expect(result.status).toBe('approved');
    expect(result.claim.value).toBe('updating');
  });

  it('releases claims', async () => {
    const { claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1');
    const released = await claims.release('file.ts', 'agent_1');
    expect(released).not.toBeNull();
    expect(released!.status).toBe('released');

    // Now another agent can claim
    const result = await claims.claim('file.ts', 'editing', 'agent_2');
    expect(result.status).toBe('approved');
  });

  it('prevents non-owner from releasing', async () => {
    const { claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1');
    const released = await claims.release('file.ts', 'agent_2');
    expect(released).toBeNull();
  });

  it('checks claim status', async () => {
    const { claims } = setup();
    expect(await claims.check('file.ts')).toBeNull();
    await claims.claim('file.ts', 'editing', 'agent_1');
    const check = await claims.check('file.ts');
    expect(check).not.toBeNull();
    expect(check!.owner).toBe('agent_1');
  });

  it('lists active claims', async () => {
    const { claims } = setup();
    await claims.claim('src/a.ts', 'editing', 'agent_1');
    await claims.claim('src/b.ts', 'editing', 'agent_2');
    await claims.claim('lib/c.ts', 'editing', 'agent_1');
    const all = await claims.list();
    expect(all.length).toBe(3);
    const srcOnly = await claims.list('src/*');
    expect(srcOnly.length).toBe(2);
  });

  it('publishes events on claim and release', async () => {
    const { events, claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1');
    await claims.release('file.ts', 'agent_1');
    const { events: evts } = await events.getEvents();
    expect(evts.length).toBe(2);
    expect(evts[0].type).toBe('claim.acquired');
    expect(evts[1].type).toBe('claim.released');
  });

  it('expires claims with TTL', async () => {
    const { claims } = setup();
    await claims.claim('file.ts', 'editing', 'agent_1', 1); // 1ms TTL
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    // Expired claim allows new claim
    const result = await claims.claim('file.ts', 'editing', 'agent_2');
    expect(result.status).toBe('approved');
  });

  it('getAll returns all claims', async () => {
    const { claims } = setup();
    await claims.claim('a', 'v', 'agent_1');
    await claims.claim('b', 'v', 'agent_2');
    const all = await claims.getAll();
    expect(all.length).toBe(2);
  });

  it('load replaces all claims', async () => {
    const { claims } = setup();
    await claims.claim('old', 'v', 'agent_1');

    await claims.load([
      { resource: 'new1', value: 'v', owner: 'a', status: 'active', claimedAt: new Date().toISOString() },
      { resource: 'new2', value: 'v', owner: 'b', status: 'active', claimedAt: new Date().toISOString() },
    ]);

    expect(await claims.check('old')).toBeNull();
    expect((await claims.check('new1'))!.owner).toBe('a');
    expect((await claims.check('new2'))!.owner).toBe('b');
  });
});
