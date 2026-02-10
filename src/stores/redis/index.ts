import type { Stores } from '../interfaces.js';
import type { Redis } from './db.js';
import { RedisStateStore } from './state.js';
import { RedisEventStore } from './events.js';
import { RedisClaimStore } from './claims.js';
import { RedisDiscoveryStore } from './discoveries.js';
import { MessageStore } from '../messages.js';
import { HelpStore } from '../help.js';
import { ProgressStore } from '../progress.js';
import { ConflictStore } from '../conflicts.js';
import { RoleStore } from '../roles.js';
import { ProposalStore } from '../proposals.js';
import { ReinforcementStore } from '../reinforcements.js';
import { ControlStore } from '../control.js';
import { RunStore } from '../runs.js';

export function createRedisStores(client: Redis, namespace: string): Stores {
  const events = new RedisEventStore(client, namespace);
  const state = new RedisStateStore(client, namespace);
  const claims = new RedisClaimStore(client, namespace, events);
  const discoveries = new RedisDiscoveryStore(client, namespace, events);
  // New coordination stores use in-memory backend for now
  const messages = new MessageStore();
  const help = new HelpStore(events);
  const progress = new ProgressStore();
  const conflicts = new ConflictStore(events);
  const roles = new RoleStore();
  const proposals = new ProposalStore(events);
  const reinforcements = new ReinforcementStore(events);
  const control = new ControlStore(events);
  const runs = new RunStore();
  return { state, events, claims, discoveries, messages, help, progress, conflicts, roles, proposals, reinforcements, control, runs };
}
