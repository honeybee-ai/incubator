import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeStartOn, waitForEvents } from './runner.js';
import type { AgentConfig, StartOnConfig } from './types.js';

// Mock @agentcoordinationprotocol/sdk
vi.mock('@agentcoordinationprotocol/sdk', () => {
  const mockGetEvents = vi.fn();
  return {
    createAcpClient: vi.fn(() => ({
      getEvents: mockGetEvents,
    })),
    _mockGetEvents: mockGetEvents,
  };
});

// Access the mock
import { createAcpClient, _mockGetEvents } from '@agentcoordinationprotocol/sdk';
const mockGetEvents = _mockGetEvents as ReturnType<typeof vi.fn>;

/** Helper: incubator response shape { events: [...], cursor: N } */
function eventsResponse(events: Array<{ type: string; [k: string]: unknown }>, cursor?: number) {
  return {
    ok: true,
    status: 200,
    data: { events, cursor: cursor ?? events.length },
  };
}

function emptyResponse() {
  return { ok: true, status: 200, data: { events: [], cursor: 0 } };
}

function makeConfig(startOn: StartOnConfig): AgentConfig {
  return {
    agentId: 'test-agent',
    role: 'editor',
    provider: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' },
    serverUrl: 'http://localhost:3100',
    namespace: 'default',
    maxIterations: 50,
    verbose: false,
    mode: 'drone',
    propolisTarget: 'http://localhost:3200',
    noAcp: false,
    startOn,
  };
}

describe('describeStartOn', () => {
  it('describes a single event', () => {
    const result = describeStartOn({
      conditions: [{ event: 'section_complete', count: 1 }],
      timeout: 300,
    });
    expect(result).toBe('section_complete (timeout: 300s)');
  });

  it('describes count > 1', () => {
    const result = describeStartOn({
      conditions: [{ event: 'section_complete', count: 3 }],
      timeout: 300,
    });
    expect(result).toBe('3x section_complete (timeout: 300s)');
  });

  it('describes AND conditions', () => {
    const result = describeStartOn({
      conditions: [
        { event: 'refactor_complete', count: 1 },
        { event: 'tests_complete', count: 1 },
      ],
      timeout: 120,
    });
    expect(result).toBe('refactor_complete + tests_complete (timeout: 120s)');
  });

  it('describes mixed count AND conditions', () => {
    const result = describeStartOn({
      conditions: [
        { event: 'section_complete', count: 3 },
        { event: 'review_ready', count: 1 },
      ],
      timeout: 300,
    });
    expect(result).toBe('3x section_complete + review_ready (timeout: 300s)');
  });

  it('describes no timeout when timeout is 0', () => {
    const result = describeStartOn({
      conditions: [{ event: 'section_complete', count: 5 }],
      timeout: 0,
    });
    expect(result).toBe('5x section_complete (no timeout)');
  });
});

describe('waitForEvents', () => {
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('resolves immediately when event exists', async () => {
    mockGetEvents.mockResolvedValue(
      eventsResponse([{ id: 1, type: 'section_complete', data: {}, publishedBy: 'researcher_1', publishedAt: '2026-01-01' }])
    );

    const config = makeConfig({
      conditions: [{ event: 'section_complete', count: 1 }],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(mockGetEvents).toHaveBeenCalledWith(0, { type: 'section_complete' });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Timeout'));
  });

  it('waits and resolves when event appears', async () => {
    mockGetEvents
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'section_complete', data: {}, publishedBy: 'researcher_1', publishedAt: '2026-01-01' }])
      );

    const config = makeConfig({
      conditions: [{ event: 'section_complete', count: 1 }],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('times out and proceeds with warning', async () => {
    mockGetEvents.mockResolvedValue(emptyResponse());

    const config = makeConfig({
      conditions: [{ event: 'section_complete', count: 1 }],
      timeout: 4,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(log).toHaveBeenCalledWith('Timeout (4s) — starting anyway');
  });

  it('requires count to be satisfied', async () => {
    mockGetEvents
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'section_complete', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }])
      )
      .mockResolvedValueOnce(
        eventsResponse([
          { id: 1, type: 'section_complete', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' },
          { id: 2, type: 'section_complete', data: {}, publishedBy: 'r2', publishedAt: '2026-01-01' },
        ])
      );

    const config = makeConfig({
      conditions: [{ event: 'section_complete', count: 2 }],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0); // 1 event, not enough
    await vi.advanceTimersByTimeAsync(2000); // 2 events, done
    await promise;

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('AND conditions — all must be met', async () => {
    // First poll: A exists, B doesn't
    mockGetEvents
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'refactor_complete', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }])
      )
      .mockResolvedValueOnce(emptyResponse());

    // Second poll: both exist
    mockGetEvents
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'refactor_complete', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }])
      )
      .mockResolvedValueOnce(
        eventsResponse([{ id: 2, type: 'tests_complete', data: {}, publishedBy: 'r2', publishedAt: '2026-01-01' }])
      );

    const config = makeConfig({
      conditions: [
        { event: 'refactor_complete', count: 1 },
        { event: 'tests_complete', count: 1 },
      ],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetEvents).toHaveBeenCalledTimes(4);
  });

  it('returns immediately when startOn is null', async () => {
    const config = makeConfig({
      conditions: [{ event: 'x', count: 1 }],
      timeout: 300,
    });
    config.startOn = null;

    await waitForEvents(config, log);
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('treats API errors as unmet condition', async () => {
    mockGetEvents
      .mockResolvedValueOnce({ ok: false, status: 500, data: null })
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'ready', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }])
      );

    const config = makeConfig({
      conditions: [{ event: 'ready', count: 1 }],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('waits indefinitely when timeout is 0', async () => {
    // First 3 polls: no events. Fourth: events arrive.
    mockGetEvents
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(
        eventsResponse([{ id: 1, type: 'done', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }])
      );

    const config = makeConfig({
      conditions: [{ event: 'done', count: 1 }],
      timeout: 0,
    });

    const promise = waitForEvents(config, log);
    // Advance well past what would be a normal timeout
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockGetEvents).toHaveBeenCalledTimes(4);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Timeout'));
  });

  it('handles bare array response (SDK type compat)', async () => {
    // Some SDK versions might return a plain array as data
    mockGetEvents.mockResolvedValue({
      ok: true,
      status: 200,
      data: [{ id: 1, type: 'done', data: {}, publishedBy: 'r1', publishedAt: '2026-01-01' }],
    });

    const config = makeConfig({
      conditions: [{ event: 'done', count: 1 }],
      timeout: 300,
    });

    const promise = waitForEvents(config, log);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Timeout'));
  });
});
