import { createRequire } from 'node:module';
import type { Stores } from './stores/interfaces.js';

// carapace scan result shape (CJS module, no types available)
interface ScanResult {
  pass: boolean;
  score: number;
  action: 'PASS' | 'LOG' | 'WARN' | 'BLOCK';
  findings: Array<{ category: string; severity: string; description: string }>;
  summary: string;
}

export interface Guard {
  scan(message: string): ScanResult;
}

export class CarapaceBlockedError extends Error {
  readonly score: number;
  readonly action: string;
  readonly findings: ScanResult['findings'];

  constructor(result: ScanResult) {
    super(`[carapace] Blocked: ${result.summary}`);
    this.name = 'CarapaceBlockedError';
    this.score = result.score;
    this.action = result.action;
    this.findings = result.findings;
  }
}

/**
 * Load carapace (CJS) from an ESM context via createRequire.
 */
export function loadGuard(verbose?: boolean): Guard {
  const require = createRequire(import.meta.url);
  const mod = require('@honeybee-ai/carapace');
  if (verbose) {
    console.error('[incubator] carapace loaded');
  }
  return mod as Guard;
}

/**
 * Concatenate text fields and run a single scan.
 * Throws CarapaceBlockedError on BLOCK, logs on WARN.
 */
function scanFields(guard: Guard, fields: (string | undefined)[], verbose?: boolean): void {
  const text = fields.filter(Boolean).join(' ');
  if (!text) return;

  const result = guard.scan(text);

  if (verbose && result.findings.length > 0) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${ts} [carapace] score=${result.score} action=${result.action} findings=${result.findings.length}`);
  }

  if (result.action === 'BLOCK') {
    throw new CarapaceBlockedError(result);
  }

  if (result.action === 'WARN' && verbose) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${ts} [carapace] WARN: ${result.summary}`);
  }
}

/**
 * Scan fields and return true if content is clean (PASS/LOG/WARN), false if BLOCK.
 * Used for read-side filtering — poisoned data is silently dropped, not thrown.
 */
function isClean(guard: Guard, fields: (string | undefined)[], verbose?: boolean): boolean {
  const text = fields.filter(Boolean).join(' ');
  if (!text) return true;

  const result = guard.scan(text);

  if (result.action === 'BLOCK') {
    if (verbose) {
      const ts = new Date().toISOString().slice(11, 23);
      console.error(`  ${ts} [carapace] READ BLOCKED: score=${result.score} — poisoned entry filtered out`);
    }
    return false;
  }

  return true;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return JSON.stringify(v);
}

/**
 * Wrap store methods with Carapace scanning.
 * Writes throw CarapaceBlockedError on BLOCK. Reads silently filter out poisoned entries.
 * Internal system events bypass the guard.
 */
export function createGuardedStores(stores: Stores, guard: Guard, verbose?: boolean): Stores {
  // ClaimStore and DiscoveryStore emit internal events like "claim.acquired" and
  // "discovery.published" — these are system-generated and bypass the guard.
  // We only guard user-facing methods.

  return {
    state: {
      ...stores.state,
      set: async (key: string, value: unknown, agentId: string, category?: string, ttlMs?: number) => {
        scanFields(guard, [key, stringify(value), category], verbose);
        return stores.state.set(key, value, agentId, category, ttlMs);
      },
      get: async (key: string) => {
        const entry = await stores.state.get(key);
        if (!entry) return null;
        if (!isClean(guard, [entry.key, stringify(entry.value), entry.category], verbose)) return null;
        return entry;
      },
      query: async (pattern?: string, category?: string) => {
        const entries = await stores.state.query(pattern, category);
        return entries.filter(e => isClean(guard, [e.key, stringify(e.value), e.category], verbose));
      },
    },
    events: {
      ...stores.events,
      publish: async (type: string, data: unknown, agentId: string) => {
        scanFields(guard, [type, stringify(data)], verbose);
        return stores.events.publish(type, data, agentId);
      },
      getEvents: async (since?: number, type?: string) => {
        const result = await stores.events.getEvents(since, type);
        return {
          events: result.events.filter(e => isClean(guard, [e.type, stringify(e.data)], verbose)),
          cursor: result.cursor,
        };
      },
    },
    claims: {
      ...stores.claims,
      claim: async (resource: string, value: string, agentId: string, ttlMs?: number) => {
        scanFields(guard, [resource, value], verbose);
        return stores.claims.claim(resource, value, agentId, ttlMs);
      },
      check: async (resource: string) => {
        const claim = await stores.claims.check(resource);
        if (!claim) return null;
        if (!isClean(guard, [claim.resource, claim.value], verbose)) return null;
        return claim;
      },
      list: async (pattern?: string) => {
        const claims = await stores.claims.list(pattern);
        return claims.filter(c => isClean(guard, [c.resource, c.value], verbose));
      },
    },
    discoveries: {
      ...stores.discoveries,
      publish: async (topic: string, content: string, agentId: string, category?: string) => {
        scanFields(guard, [topic, content, category], verbose);
        return stores.discoveries.publish(topic, content, agentId, category);
      },
      search: async (query?: string, category?: string) => {
        const discoveries = await stores.discoveries.search(query, category);
        return discoveries.filter(d => isClean(guard, [d.topic, d.content, d.category], verbose));
      },
    },
    messages: {
      ...stores.messages,
      send: async (from: string, to: string, content: string, replyTo?: string) => {
        scanFields(guard, [content], verbose);
        return stores.messages.send(from, to, content, replyTo);
      },
    },
    help: {
      ...stores.help,
      request: async (agentId: string, problem: string, needsCapability?: string, urgency?: 'low' | 'normal' | 'high') => {
        scanFields(guard, [problem, needsCapability], verbose);
        return stores.help.request(agentId, problem, needsCapability, urgency);
      },
    },
    progress: stores.progress,
    conflicts: stores.conflicts,
    roles: stores.roles,
    proposals: stores.proposals,
    reinforcements: stores.reinforcements,
    control: stores.control,
    runs: stores.runs,
  };
}

/**
 * Scan a snapshot's entries on load. Returns counts of blocked items.
 * Mutates the snapshot arrays in place, removing poisoned entries.
 */
export function scanSnapshot(
  snapshot: { state: unknown[]; claims: unknown[]; events: unknown[]; discoveries: unknown[] },
  guard: Guard,
  verbose?: boolean,
): { blocked: number } {
  let blocked = 0;

  const scanAndFilter = <T>(items: T[], getFields: (item: T) => (string | undefined)[]): T[] => {
    return items.filter(item => {
      if (isClean(guard, getFields(item), verbose)) return true;
      blocked++;
      return false;
    });
  };

  snapshot.state = scanAndFilter(
    snapshot.state as Array<{ key: string; value: unknown; category?: string }>,
    e => [e.key, stringify(e.value), e.category],
  );

  snapshot.claims = scanAndFilter(
    snapshot.claims as Array<{ resource: string; value: string }>,
    c => [c.resource, c.value],
  );

  snapshot.events = scanAndFilter(
    snapshot.events as Array<{ type: string; data: unknown }>,
    e => [e.type, stringify(e.data)],
  );

  snapshot.discoveries = scanAndFilter(
    snapshot.discoveries as Array<{ topic: string; content: string; category?: string }>,
    d => [d.topic, d.content, d.category],
  );

  if (blocked > 0) {
    console.error(`[incubator] Carapace: ${blocked} poisoned entries removed from snapshot`);
  }

  return { blocked };
}
