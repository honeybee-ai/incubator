import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatMonitor } from './heartbeat.js';
import { createStores } from './server.js';
import type { Stores } from './stores/interfaces.js';

describe('HeartbeatMonitor', () => {
  let stores: Stores;

  beforeEach(() => {
    vi.useFakeTimers();
    stores = createStores();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('touch records agent activity and getStatus shows alive', () => {
    const monitor = new HeartbeatMonitor(stores);
    monitor.touch('agent_1');

    const status = monitor.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ agent: 'agent_1', status: 'alive' });
  });

  it('agent becomes stale after stale_after_ms', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(60); // past stale, before dead
    await monitor.check();

    const status = monitor.getStatus();
    expect(status[0].status).toBe('stale');
  });

  it('agent becomes dead after dead_after_ms', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(110); // past dead threshold
    await monitor.check();

    // Dead agents are removed from tracking after handleDeath
    const status = monitor.getStatus();
    expect(status).toHaveLength(0);
  });

  it('dead agent claims are auto-released when auto_release_claims=true', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100, auto_release_claims: true },
    });

    // Agent claims some resources
    await stores.claims.claim('file:a.ts', 'editing', 'agent_1');
    await stores.claims.claim('file:b.ts', 'editing', 'agent_1');

    monitor.touch('agent_1');
    vi.advanceTimersByTime(110);
    await monitor.check();

    // Claims should be released
    const remaining = await stores.claims.list();
    const ownedByAgent1 = remaining.filter(c => c.owner === 'agent_1');
    expect(ownedByAgent1).toHaveLength(0);
  });

  it('dead agent emits agent.died event with released_claims', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100, auto_release_claims: true },
    });

    await stores.claims.claim('file:a.ts', 'editing', 'agent_1');
    await stores.claims.claim('file:b.ts', 'editing', 'agent_1');

    monitor.touch('agent_1');
    vi.advanceTimersByTime(110);
    await monitor.check();

    const { events } = await stores.events.getEvents(undefined, 'agent.died');
    expect(events).toHaveLength(1);
    const data = events[0].data as { agent: string; released_claims: string[] };
    expect(data.agent).toBe('agent_1');
    expect(data.released_claims).toContain('file:a.ts');
    expect(data.released_claims).toContain('file:b.ts');
  });

  it('stale agent emits agent.stale event', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    await stores.roles.assign('agent_1', 'trader');
    monitor.touch('agent_1');
    vi.advanceTimersByTime(60); // past stale, before dead
    await monitor.check();

    const { events } = await stores.events.getEvents(undefined, 'agent.stale');
    expect(events).toHaveLength(1);
    const data = events[0].data as { agent: string; role: string };
    expect(data.agent).toBe('agent_1');
    expect(data.role).toBe('trader');
  });

  it('touch resets stale status (agent comes back)', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(60); // stale
    await monitor.check();

    // Agent comes back
    monitor.touch('agent_1');
    const status = monitor.getStatus();
    expect(status[0].status).toBe('alive');

    // Advancing again past stale should re-emit stale event (staleNotified was cleared by touch)
    vi.advanceTimersByTime(60);
    await monitor.check();

    const { events } = await stores.events.getEvents(undefined, 'agent.stale');
    expect(events).toHaveLength(2); // emitted twice since touch cleared the notification
  });

  it('custom governance config overrides defaults', () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 5000, dead_after_ms: 15000, auto_release_claims: false },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(6000); // past custom stale, well before default dead

    const status = monitor.getStatus();
    expect(status[0].status).toBe('stale');
  });

  it('dead agent role is removed', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    await stores.roles.assign('agent_1', 'trader');
    monitor.touch('agent_1');
    vi.advanceTimersByTime(110);
    await monitor.check();

    const assignment = await stores.roles.getByAgent('agent_1');
    expect(assignment).toBeNull();
  });

  it('does not re-emit stale event without intervening touch', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 200 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(60);
    await monitor.check();
    await monitor.check(); // second check at same time

    const { events } = await stores.events.getEvents(undefined, 'agent.stale');
    expect(events).toHaveLength(1); // only one stale event
  });

  it('does not re-emit agent.died event on repeated checks', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(110);
    await monitor.check();
    // Agent is removed from lastActivity by handleDeath, so second check is a no-op
    await monitor.check();

    const { events } = await stores.events.getEvents(undefined, 'agent.died');
    expect(events).toHaveLength(1);
  });

  it('tracks multiple agents independently', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    vi.advanceTimersByTime(30);
    monitor.touch('agent_2'); // agent_2 touched later

    vi.advanceTimersByTime(30); // total: agent_1 at 60ms, agent_2 at 30ms

    const status = monitor.getStatus();
    const a1 = status.find(s => s.agent === 'agent_1');
    const a2 = status.find(s => s.agent === 'agent_2');
    expect(a1?.status).toBe('stale');
    expect(a2?.status).toBe('alive');
  });

  it('start and stop control the periodic timer', () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100 },
    });

    monitor.touch('agent_1');
    monitor.start();

    // start is idempotent
    monitor.start();

    monitor.stop();
    // After stop, advancing time should not trigger checks automatically
    // (No crash or side effects from stop)
    monitor.stop(); // stop is also idempotent
  });

  it('auto_release_claims=false skips claim release on death', async () => {
    const monitor = new HeartbeatMonitor(stores, {
      heartbeat: { stale_after_ms: 50, dead_after_ms: 100, auto_release_claims: false },
    });

    await stores.claims.claim('file:a.ts', 'editing', 'agent_1');
    monitor.touch('agent_1');
    vi.advanceTimersByTime(110);
    await monitor.check();

    // agent.died event should have empty released_claims
    const { events } = await stores.events.getEvents(undefined, 'agent.died');
    expect(events).toHaveLength(1);
    const data = events[0].data as { released_claims: string[] };
    expect(data.released_claims).toHaveLength(0);

    // Claim still exists (owned by dead agent, but not released by monitor)
    const claim = await stores.claims.check('file:a.ts');
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('active');
  });

  it('uses default config when no governance provided', () => {
    const monitor = new HeartbeatMonitor(stores);

    monitor.touch('agent_1');
    // With defaults (30000/60000), agent should be alive at 10s
    vi.advanceTimersByTime(10000);
    const status = monitor.getStatus();
    expect(status[0].status).toBe('alive');

    // Should be stale at 35s
    vi.advanceTimersByTime(25000);
    const status2 = monitor.getStatus();
    expect(status2[0].status).toBe('stale');
  });
});
