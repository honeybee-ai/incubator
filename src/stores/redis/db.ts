import { createRequire } from 'node:module';

// ioredis types — loaded dynamically
export interface Redis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK'>;
  del(...keys: string[]): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hset(key: string, data: Record<string, string>): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  incr(key: string): Promise<number>;
  zadd(key: string, ...args: (string | number)[]): Promise<number>;
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  multi(): RedisPipeline;
  publish(channel: string, message: string): Promise<number>;
  quit(): Promise<'OK'>;
  status: string;
  duplicate(): Redis;
}

export interface RedisPipeline {
  incr(key: string): RedisPipeline;
  set(key: string, value: string): RedisPipeline;
  zadd(key: string, ...args: (string | number)[]): RedisPipeline;
  del(...keys: string[]): RedisPipeline;
  rpush(key: string, ...values: string[]): RedisPipeline;
  hset(key: string, data: Record<string, string>): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

const clientCache = new Map<string, Redis>();

/**
 * Get or create a Redis client for the given URL.
 * Cached by URL — same URL returns the same client.
 */
export function getRedisClient(url: string): Redis {
  const cached = clientCache.get(url);
  if (cached) return cached;

  const require = createRequire(import.meta.url);
  const IORedis = require('ioredis') as new (url: string) => Redis;
  const client = new IORedis(url);

  clientCache.set(url, client);
  return client;
}

/**
 * Wait for a Redis client to be ready.
 */
export async function waitForReady(client: Redis): Promise<void> {
  if (client.status === 'ready') return;
  return new Promise<void>((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const cleanup = () => {
      (client as unknown as { removeListener(e: string, fn: unknown): void }).removeListener('ready', onReady);
      (client as unknown as { removeListener(e: string, fn: unknown): void }).removeListener('error', onError);
    };
    (client as unknown as { once(e: string, fn: unknown): void }).once('ready', onReady);
    (client as unknown as { once(e: string, fn: unknown): void }).once('error', onError);
  });
}
