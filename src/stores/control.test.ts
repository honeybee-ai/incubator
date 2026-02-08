import { describe, it, expect } from 'vitest';
import { ControlStore } from './control.js';
import { EventStore } from './events.js';

describe('ControlStore', () => {
  function setup() {
    const events = new EventStore();
    const control = new ControlStore(events);
    return { events, control };
  }

  it('starts with running status', () => {
    const { control } = setup();
    const status = control.getStatus();
    expect(status.halted).toBe(false);
    expect(status.paused).toBe(false);
  });

  it('starts with running status for a specific agent', () => {
    const { control } = setup();
    const status = control.getStatus('agent_1');
    expect(status.halted).toBe(false);
    expect(status.paused).toBe(false);
  });

  it('halts protocol-wide', async () => {
    const { control } = setup();
    const info = await control.halt('all done', 'admin');
    expect(info.halted).toBe(true);
    expect(info.reason).toBe('all done');
    expect(info.status).toBe('completed');
    expect(info.haltedBy).toBe('admin');
    expect(info.haltedAt).toBeTruthy();

    const status = control.getStatus('agent_1');
    expect(status.halted).toBe(true);
    expect(status.haltReason).toBe('all done');
    expect(status.haltStatus).toBe('completed');
  });

  it('protocol-wide halt shows halted for any agent', async () => {
    const { control } = setup();
    await control.halt('shutdown', 'admin');
    expect(control.getStatus('agent_1').halted).toBe(true);
    expect(control.getStatus('agent_2').halted).toBe(true);
    expect(control.getStatus().halted).toBe(true);
  });

  it('halts a specific agent', async () => {
    const { control } = setup();
    await control.halt('you broke the build', 'admin', 'failed', 'agent_1');

    const s1 = control.getStatus('agent_1');
    expect(s1.halted).toBe(true);
    expect(s1.haltReason).toBe('you broke the build');
    expect(s1.haltStatus).toBe('failed');

    const s2 = control.getStatus('agent_2');
    expect(s2.halted).toBe(false);
    expect(s2.paused).toBe(false);
  });

  it('protocol-wide halt takes priority over per-agent states', async () => {
    const { control } = setup();
    await control.pause('thinking', 'admin', 'agent_1');
    await control.halt('emergency', 'admin');

    // Even though agent_1 has a per-agent pause, protocol halt wins
    const status = control.getStatus('agent_1');
    expect(status.halted).toBe(true);
    expect(status.paused).toBe(false);
    expect(status.haltReason).toBe('emergency');
  });

  it('pauses protocol-wide', async () => {
    const { control } = setup();
    const info = await control.pause('waiting for input', 'admin');
    expect(info.paused).toBe(true);
    expect(info.reason).toBe('waiting for input');
    expect(info.pausedBy).toBe('admin');
    expect(info.pausedAt).toBeTruthy();

    const status = control.getStatus('agent_1');
    expect(status.paused).toBe(true);
    expect(status.pauseReason).toBe('waiting for input');
    expect(status.halted).toBe(false);
  });

  it('pauses a specific agent', async () => {
    const { control } = setup();
    await control.pause('rate limited', 'admin', 'agent_1');

    const s1 = control.getStatus('agent_1');
    expect(s1.paused).toBe(true);
    expect(s1.pauseReason).toBe('rate limited');

    const s2 = control.getStatus('agent_2');
    expect(s2.paused).toBe(false);
    expect(s2.halted).toBe(false);
  });

  it('resumes a per-agent pause', async () => {
    const { control } = setup();
    await control.pause('hold on', 'admin', 'agent_1');
    const resumed = await control.resume('admin', 'carry on', 'agent_1');
    expect(resumed).toBe(true);

    const status = control.getStatus('agent_1');
    expect(status.paused).toBe(false);
    expect(status.halted).toBe(false);
  });

  it('resumes a protocol-wide pause', async () => {
    const { control } = setup();
    await control.pause('intermission', 'admin');
    const resumed = await control.resume('admin', 'back to work');
    expect(resumed).toBe(true);

    const status = control.getStatus();
    expect(status.paused).toBe(false);
  });

  it('resume returns false if nothing was paused (protocol)', async () => {
    const { control } = setup();
    const resumed = await control.resume('admin', 'nothing to resume');
    expect(resumed).toBe(false);
  });

  it('resume returns false if agent was not paused', async () => {
    const { control } = setup();
    const resumed = await control.resume('admin', 'nothing to resume', 'agent_1');
    expect(resumed).toBe(false);
  });

  it('protocol-wide halt overrides pause', async () => {
    const { control } = setup();
    await control.pause('waiting', 'admin');
    await control.halt('abort', 'admin');

    const status = control.getStatus();
    expect(status.halted).toBe(true);
    expect(status.paused).toBe(false);
    expect(status.haltReason).toBe('abort');
  });

  it('halt with failed status is recorded correctly', async () => {
    const { control } = setup();
    const info = await control.halt('crash', 'system', 'failed');
    expect(info.status).toBe('failed');

    const status = control.getStatus();
    expect(status.haltStatus).toBe('failed');
  });

  it('publishes protocol.halt event', async () => {
    const { events, control } = setup();
    await control.halt('done', 'admin');
    const { events: evts } = await events.getEvents(undefined, 'protocol.halt');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ reason: 'done', status: 'completed', halted_by: 'admin' });
    expect(evts[0].publishedBy).toBe('admin');
  });

  it('publishes agent.halted event', async () => {
    const { events, control } = setup();
    await control.halt('bad agent', 'admin', 'failed', 'agent_1');
    const { events: evts } = await events.getEvents(undefined, 'agent.halted');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ agent: 'agent_1', reason: 'bad agent', status: 'failed', halted_by: 'admin' });
  });

  it('publishes protocol.paused event', async () => {
    const { events, control } = setup();
    await control.pause('hold', 'admin');
    const { events: evts } = await events.getEvents(undefined, 'protocol.paused');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ reason: 'hold', paused_by: 'admin' });
  });

  it('publishes agent.paused event', async () => {
    const { events, control } = setup();
    await control.pause('slow down', 'admin', 'agent_1');
    const { events: evts } = await events.getEvents(undefined, 'agent.paused');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ agent: 'agent_1', reason: 'slow down', paused_by: 'admin' });
  });

  it('publishes protocol.resumed event', async () => {
    const { events, control } = setup();
    await control.pause('break', 'admin');
    await control.resume('admin', 'continue');
    const { events: evts } = await events.getEvents(undefined, 'protocol.resumed');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ reason: 'continue', resumed_by: 'admin' });
  });

  it('publishes agent.resumed event', async () => {
    const { events, control } = setup();
    await control.pause('wait', 'admin', 'agent_1');
    await control.resume('admin', 'go', 'agent_1');
    const { events: evts } = await events.getEvents(undefined, 'agent.resumed');
    expect(evts.length).toBe(1);
    expect(evts[0].data).toEqual({ agent: 'agent_1', reason: 'go', resumed_by: 'admin' });
  });

  it('per-agent resume does not affect other paused agents', async () => {
    const { control } = setup();
    await control.pause('hold', 'admin', 'agent_1');
    await control.pause('hold', 'admin', 'agent_2');
    await control.resume('admin', 'go', 'agent_1');

    expect(control.getStatus('agent_1').paused).toBe(false);
    expect(control.getStatus('agent_2').paused).toBe(true);
  });

  it('per-agent halt does not affect protocol-wide status', async () => {
    const { control } = setup();
    await control.halt('bye', 'admin', 'completed', 'agent_1');

    // Protocol is still running
    expect(control.getStatus().halted).toBe(false);
    expect(control.getStatus().paused).toBe(false);

    // Other agents are still running
    expect(control.getStatus('agent_2').halted).toBe(false);
  });

  it('protocol-wide halt overrides per-agent halt reason', async () => {
    const { control } = setup();
    await control.halt('agent-level reason', 'admin', 'failed', 'agent_1');
    await control.halt('protocol-level reason', 'admin');

    // Protocol halt reason should be returned, not the per-agent one
    const status = control.getStatus('agent_1');
    expect(status.halted).toBe(true);
    expect(status.haltReason).toBe('protocol-level reason');
    expect(status.haltStatus).toBe('completed');
  });
});
