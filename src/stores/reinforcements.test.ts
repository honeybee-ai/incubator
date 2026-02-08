import { describe, it, expect } from 'vitest';
import { ReinforcementStore } from './reinforcements.js';
import { EventStore } from './events.js';

describe('ReinforcementStore', () => {
  function setup() {
    const events = new EventStore();
    const reinforcements = new ReinforcementStore(events);
    return { events, reinforcements };
  }

  it('creates a reinforcement request', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 2, 'need more research capacity');
    expect(req.id).toBeDefined();
    expect(req.requestedBy).toBe('agent_1');
    expect(req.role).toBe('researcher');
    expect(req.count).toBe(2);
    expect(req.reason).toBe('need more research capacity');
    expect(req.status).toBe('pending');
    expect(req.createdAt).toBeDefined();
  });

  it('creates a request without reason', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'writer', 1);
    expect(req.reason).toBeUndefined();
  });

  it('clamps count to minimum of 1', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 0);
    expect(req.count).toBe(1);
    const req2 = await reinforcements.request('agent_1', 'researcher', -5);
    expect(req2.count).toBe(1);
  });

  it('approves a pending request', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 2);
    const approved = await reinforcements.approve(req.id);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
  });

  it('returns null when approving non-pending request', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 2);
    await reinforcements.approve(req.id);
    // Already approved, can't approve again
    const result = await reinforcements.approve(req.id);
    expect(result).toBeNull();
  });

  it('returns null when approving unknown request', async () => {
    const { reinforcements } = setup();
    const result = await reinforcements.approve('nonexistent');
    expect(result).toBeNull();
  });

  it('denies a pending request with reason', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 5);
    const denied = await reinforcements.deny(req.id, 'too many requested');
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe('denied');
    expect(denied!.denialReason).toBe('too many requested');
  });

  it('returns null when denying non-pending request', async () => {
    const { reinforcements } = setup();
    const req = await reinforcements.request('agent_1', 'researcher', 2);
    await reinforcements.deny(req.id, 'no');
    const result = await reinforcements.deny(req.id, 'still no');
    expect(result).toBeNull();
  });

  it('lists all reinforcement requests', async () => {
    const { reinforcements } = setup();
    await reinforcements.request('agent_1', 'researcher', 2);
    await reinforcements.request('agent_2', 'writer', 1);
    await reinforcements.request('agent_3', 'reviewer', 3);

    const all = await reinforcements.list();
    expect(all.length).toBe(3);
  });

  it('publishes events on approve and deny', async () => {
    const { events, reinforcements } = setup();
    const r1 = await reinforcements.request('agent_1', 'researcher', 2);
    const r2 = await reinforcements.request('agent_2', 'writer', 1);
    await reinforcements.approve(r1.id);
    await reinforcements.deny(r2.id, 'not needed');

    const { events: evts } = await events.getEvents();
    expect(evts.length).toBe(2);
    expect(evts[0].type).toBe('reinforcement.approved');
    expect(evts[1].type).toBe('reinforcement.denied');
  });
});
