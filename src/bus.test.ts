import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalBus } from './bus.js';
import type { IncubatorEvent } from './types.js';

function makeEvent(id: number, type = 'test'): IncubatorEvent {
  return { id, type, data: { n: id }, publishedBy: 'agent', publishedAt: new Date().toISOString() };
}

describe('LocalBus', () => {
  let bus: LocalBus;

  beforeEach(() => { bus = new LocalBus(); });
  afterEach(async () => { await bus.close(); });

  it('delivers events to subscriber', () => {
    const received: IncubatorEvent[] = [];
    bus.subscribe('ns1', (e) => received.push(e));

    const event = makeEvent(1);
    bus.publish('ns1', event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it('isolates namespaces', () => {
    const ns1: IncubatorEvent[] = [];
    const ns2: IncubatorEvent[] = [];
    bus.subscribe('ns1', (e) => ns1.push(e));
    bus.subscribe('ns2', (e) => ns2.push(e));

    bus.publish('ns1', makeEvent(1));
    bus.publish('ns2', makeEvent(2));

    expect(ns1).toHaveLength(1);
    expect(ns1[0].id).toBe(1);
    expect(ns2).toHaveLength(1);
    expect(ns2[0].id).toBe(2);
  });

  it('supports multiple subscribers on same namespace', () => {
    const a: IncubatorEvent[] = [];
    const b: IncubatorEvent[] = [];
    bus.subscribe('ns1', (e) => a.push(e));
    bus.subscribe('ns1', (e) => b.push(e));

    bus.publish('ns1', makeEvent(1));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops delivery', () => {
    const received: IncubatorEvent[] = [];
    const unsub = bus.subscribe('ns1', (e) => received.push(e));

    bus.publish('ns1', makeEvent(1));
    expect(received).toHaveLength(1);

    unsub();
    bus.publish('ns1', makeEvent(2));
    expect(received).toHaveLength(1);
  });

  it('close removes all listeners', () => {
    const received: IncubatorEvent[] = [];
    bus.subscribe('ns1', (e) => received.push(e));
    bus.subscribe('ns2', (e) => received.push(e));

    bus.close();

    bus.publish('ns1', makeEvent(1));
    bus.publish('ns2', makeEvent(2));
    expect(received).toHaveLength(0);
  });
});
