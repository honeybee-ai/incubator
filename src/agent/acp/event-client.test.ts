import { describe, it, expect, vi } from 'vitest';
import { EventClient } from './event-client.js';

function createMockClient(events: Array<{ type: string; data: unknown; agentId: string; seq: number }> = []) {
  return {
    getEvents: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { events, cursor: events.length },
    }),
    getMessages: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: [],
    }),
  };
}

describe('EventClient', () => {
  it('drains events from other agents', async () => {
    const client = createMockClient([
      { type: 'progress', data: { step: 1 }, agentId: 'other-agent', seq: 1 },
      { type: 'warning', data: 'watch out', agentId: 'another-agent', seq: 2 },
    ]);

    const eventClient = new EventClient(client as any, 'my-agent');
    const messages = await eventClient.drain();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('other-agent');
    expect(messages[0]).toContain('progress');
    expect(messages[1]).toContain('watch out');
  });

  it('filters out own events', async () => {
    const client = createMockClient([
      { type: 'progress', data: { step: 1 }, agentId: 'my-agent', seq: 1 },
      { type: 'warning', data: 'important', agentId: 'other-agent', seq: 2 },
    ]);

    const eventClient = new EventClient(client as any, 'my-agent');
    const messages = await eventClient.drain();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('other-agent');
  });

  it('returns empty array when no events', async () => {
    const client = createMockClient([]);
    const eventClient = new EventClient(client as any, 'my-agent');
    const messages = await eventClient.drain();
    expect(messages).toHaveLength(0);
  });

  it('handles server errors gracefully', async () => {
    const client = {
      getEvents: vi.fn().mockRejectedValue(new Error('network error')),
      getMessages: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const eventClient = new EventClient(client as any, 'my-agent');
    const messages = await eventClient.drain();
    expect(messages).toHaveLength(0);
  });

  it('tracks cursor between calls', async () => {
    const client = createMockClient([
      { type: 'a', data: {}, agentId: 'other', seq: 1 },
    ]);

    const eventClient = new EventClient(client as any, 'my-agent');
    await eventClient.drain();

    // Second call should use cursor from first call
    await eventClient.drain();
    expect(client.getEvents).toHaveBeenCalledTimes(2);
    expect(client.getEvents).toHaveBeenLastCalledWith(1); // cursor from first call
  });
});
