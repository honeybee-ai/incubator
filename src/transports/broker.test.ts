import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { IPCBroker } from './broker.js';
import { IPCTransport } from './ipc.js';
import type { TopicEvent } from './types.js';

function makeEvent(overrides: Partial<TopicEvent> = {}): TopicEvent {
  return {
    sourceHive: 'test',
    topic: 'test_topic',
    data: { value: 1 },
    publishedBy: 'agent_1',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('IPCBroker + IPCTransport', () => {
  let dir: string;
  let broker: IPCBroker;
  const transports: IPCTransport[] = [];

  function socketPath(): string {
    return join(dir, 'broker.sock');
  }

  async function createTransport(opts: {
    hiveName: string;
    publishes?: string[];
    subscribes?: string[];
  }): Promise<IPCTransport> {
    const t = new IPCTransport({
      socketPath: socketPath(),
      hiveName: opts.hiveName,
      publishes: opts.publishes ?? [],
      subscribes: opts.subscribes ?? [],
    });
    await t.connect();
    transports.push(t);
    return t;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'honeycomb-broker-'));
    broker = new IPCBroker();
  });

  afterEach(async () => {
    for (const t of transports) await t.close();
    transports.length = 0;
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('routes events from publisher to subscriber', async () => {
    await broker.listen(socketPath());

    const frontend = await createTransport({
      hiveName: 'frontend',
      publishes: ['code_changed'],
    });
    const backend = await createTransport({
      hiveName: 'backend',
      subscribes: ['code_changed'],
    });

    const received: TopicEvent[] = [];
    backend.subscribe('code_changed', (e) => received.push(e));

    // Wait for registrations to propagate
    await sleep(50);

    await frontend.publish('code_changed', makeEvent({
      sourceHive: 'frontend',
      topic: 'code_changed',
      data: { files: ['api.ts'] },
    }));

    await sleep(100);
    expect(received.length).toBe(1);
    expect(received[0].sourceHive).toBe('frontend');
    expect((received[0].data as Record<string, unknown>).files).toEqual(['api.ts']);
  });

  it('does not route back to source hive', async () => {
    await broker.listen(socketPath());

    const hive = await createTransport({
      hiveName: 'self',
      publishes: ['ping'],
      subscribes: ['ping'],
    });

    const received: TopicEvent[] = [];
    hive.subscribe('ping', (e) => received.push(e));

    await sleep(50);

    await hive.publish('ping', makeEvent({ sourceHive: 'self', topic: 'ping' }));

    await sleep(100);
    expect(received.length).toBe(0);
  });

  it('routes to multiple subscribers', async () => {
    await broker.listen(socketPath());

    const pub = await createTransport({
      hiveName: 'publisher',
      publishes: ['update'],
    });
    const sub1 = await createTransport({
      hiveName: 'sub1',
      subscribes: ['update'],
    });
    const sub2 = await createTransport({
      hiveName: 'sub2',
      subscribes: ['update'],
    });

    const r1: TopicEvent[] = [];
    const r2: TopicEvent[] = [];
    sub1.subscribe('update', (e) => r1.push(e));
    sub2.subscribe('update', (e) => r2.push(e));

    await sleep(50);

    await pub.publish('update', makeEvent({ sourceHive: 'publisher', topic: 'update' }));

    await sleep(100);
    expect(r1.length).toBe(1);
    expect(r2.length).toBe(1);
  });

  it('does not forward to non-subscribers', async () => {
    await broker.listen(socketPath());

    const pub = await createTransport({
      hiveName: 'pub',
      publishes: ['topic_a'],
    });
    const sub = await createTransport({
      hiveName: 'sub',
      subscribes: ['topic_b'], // different topic
    });

    const received: TopicEvent[] = [];
    sub.subscribe('topic_b', (e) => received.push(e));

    await sleep(50);

    await pub.publish('topic_a', makeEvent({ sourceHive: 'pub', topic: 'topic_a' }));

    await sleep(100);
    expect(received.length).toBe(0);
  });

  it('handles disconnect gracefully', async () => {
    await broker.listen(socketPath());

    const pub = await createTransport({
      hiveName: 'pub',
      publishes: ['evt'],
    });
    const sub = await createTransport({
      hiveName: 'sub',
      subscribes: ['evt'],
    });

    await sleep(50);
    expect(broker.getConnectedHives().sort()).toEqual(['pub', 'sub']);

    await sub.close();
    transports.pop(); // remove from cleanup list

    await sleep(50);
    expect(broker.getConnectedHives()).toEqual(['pub']);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
