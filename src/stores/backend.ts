import { createStores } from '../server.js';
import { createSqliteStores } from './sqlite/index.js';
import { createRedisStores } from './redis/index.js';
import type { Stores } from './interfaces.js';
import type { Redis } from './redis/db.js';

export interface BackendConfig {
  type: 'memory' | 'sqlite' | 'redis';
  dbPath?: string;
  namespace?: string;
  redisClient?: Redis;
}

/**
 * Create stores for the given backend config.
 * better-sqlite3 and ioredis are only loaded at runtime when their respective
 * stores are constructed (via createRequire), so it's safe to import the modules
 * statically — native deps are only required on first use.
 */
export function createBackend(config: BackendConfig): Stores {
  if (config.type === 'memory') {
    return createStores();
  }

  if (config.type === 'sqlite') {
    if (!config.dbPath) {
      throw new Error('SQLite backend requires dbPath');
    }
    return createSqliteStores(config.dbPath, config.namespace ?? 'default');
  }

  if (config.type === 'redis') {
    if (!config.redisClient) {
      throw new Error('Redis backend requires redisClient');
    }
    return createRedisStores(config.redisClient, config.namespace ?? 'default');
  }

  throw new Error(`Unknown backend type: ${(config as BackendConfig).type}`);
}
