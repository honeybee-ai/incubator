import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHandler, scrapePageHandler } from './web.js';

// Mock global fetch for controlled testing
const originalFetch = globalThis.fetch;

function mockFetch(response: { status: number; statusText?: string; headers?: Record<string, string>; body?: string }) {
  const bodyBytes = new TextEncoder().encode(response.body ?? '');
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText ?? 'OK',
    headers: new Headers(response.headers ?? {}),
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () => {
            if (done) return Promise.resolve({ done: true, value: undefined });
            done = true;
            return Promise.resolve({ done: false, value: bodyBytes });
          },
          cancel: vi.fn(),
        };
      },
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchHandler', () => {
  it('fetches a URL and returns status + body', async () => {
    mockFetch({ status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } });

    const result = await fetchHandler({ url: 'https://api.example.com/data' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.body).toBe('{"ok":true}');
    expect(parsed.headers['content-type']).toBe('application/json');
  });

  it('blocks localhost URLs (SSRF prevention)', async () => {
    const result = await fetchHandler({ url: 'http://localhost:8080/admin' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('localhost');
  });

  it('blocks private IP addresses', async () => {
    const result = await fetchHandler({ url: 'http://192.168.1.1/admin' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('private IP');
  });

  it('blocks 127.x.x.x addresses', async () => {
    const result = await fetchHandler({ url: 'http://127.0.0.1:3000/' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('localhost');
  });

  it('blocks 10.x.x.x addresses', async () => {
    const result = await fetchHandler({ url: 'http://10.0.0.1/secret' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('private IP');
  });
});

describe('scrapePageHandler', () => {
  it('strips HTML tags and returns text', async () => {
    mockFetch({
      status: 200,
      body: '<html><head><style>body{color:red}</style></head><body><h1>Title</h1><p>Hello <b>world</b></p><script>alert(1)</script></body></html>',
    });

    const result = await scrapePageHandler({ url: 'https://example.com' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe(200);
    expect(parsed.text).toContain('Title');
    expect(parsed.text).toContain('Hello world');
    expect(parsed.text).not.toContain('<script>');
    expect(parsed.text).not.toContain('alert');
    expect(parsed.text).not.toContain('color:red');
  });

  it('blocks localhost URLs', async () => {
    const result = await scrapePageHandler({ url: 'http://localhost:3000/' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('localhost');
  });

  it('returns error for non-OK responses', async () => {
    mockFetch({ status: 404, statusText: 'Not Found', body: 'not found' });

    const result = await scrapePageHandler({ url: 'https://example.com/missing' }, '/tmp', null);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('404');
  });
});
