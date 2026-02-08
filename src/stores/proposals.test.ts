import { describe, it, expect } from 'vitest';
import { ProposalStore } from './proposals.js';
import { EventStore } from './events.js';

describe('ProposalStore', () => {
  function setup() {
    const events = new EventStore();
    const proposals = new ProposalStore(events);
    return { events, proposals };
  }

  it('creates a proposal with auto-endorsement', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'change strategy');
    expect(p.id).toBeDefined();
    expect(p.proposedBy).toBe('agent_1');
    expect(p.action).toBe('change strategy');
    expect(p.requires_quorum).toBe(2);
    expect(p.endorsements).toEqual(['agent_1']);
    expect(p.status).toBe('open');
    expect(p.createdAt).toBeDefined();
  });

  it('creates a proposal with custom detail and quorum', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'pivot', 'we need to pivot to plan B', 3);
    expect(p.detail).toBe('we need to pivot to plan B');
    expect(p.requires_quorum).toBe(3);
  });

  it('endorsing reaches quorum and auto-approves', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'change strategy'); // quorum=2, endorsements=['agent_1']
    const endorsed = await proposals.endorse(p.id, 'agent_2');
    expect(endorsed).not.toBeNull();
    expect(endorsed!.endorsements).toContain('agent_2');
    expect(endorsed!.endorsements.length).toBe(2);
    expect(endorsed!.status).toBe('approved');
  });

  it('duplicate endorsement does not double-count', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'change strategy', undefined, 3);
    await proposals.endorse(p.id, 'agent_1'); // already in endorsements
    const result = await proposals.get(p.id);
    expect(result!.endorsements.length).toBe(1);
    expect(result!.status).toBe('open');
  });

  it('returns null when endorsing unknown proposal', async () => {
    const { proposals } = setup();
    const result = await proposals.endorse('nonexistent', 'agent_1');
    expect(result).toBeNull();
  });

  it('returns null when endorsing already-approved proposal', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'change strategy');
    await proposals.endorse(p.id, 'agent_2'); // approved
    const result = await proposals.endorse(p.id, 'agent_3');
    expect(result).toBeNull();
  });

  it('lists proposals by status', async () => {
    const { proposals } = setup();
    const p1 = await proposals.propose('agent_1', 'action 1');
    await proposals.propose('agent_2', 'action 2');
    await proposals.endorse(p1.id, 'agent_3'); // approves p1

    const open = await proposals.list('open');
    expect(open.length).toBe(1);
    expect(open[0].action).toBe('action 2');

    const approved = await proposals.list('approved');
    expect(approved.length).toBe(1);
    expect(approved[0].id).toBe(p1.id);

    const all = await proposals.list();
    expect(all.length).toBe(2);
  });

  it('gets a proposal by id', async () => {
    const { proposals } = setup();
    const p = await proposals.propose('agent_1', 'do something');
    const result = await proposals.get(p.id);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('do something');
  });

  it('returns null for unknown proposal id', async () => {
    const { proposals } = setup();
    const result = await proposals.get('nonexistent');
    expect(result).toBeNull();
  });

  it('publishes events on creation and approval', async () => {
    const { events, proposals } = setup();
    const p = await proposals.propose('agent_1', 'change strategy');
    await proposals.endorse(p.id, 'agent_2');

    const { events: evts } = await events.getEvents();
    expect(evts.length).toBe(2);
    expect(evts[0].type).toBe('governance.proposal.created');
    expect(evts[1].type).toBe('governance.proposal.approved');
  });
});
