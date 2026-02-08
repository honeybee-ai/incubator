import type { Stores } from '../interfaces.js';
import { getDatabase } from './db.js';
import { SqliteStateStore } from './state.js';
import { SqliteEventStore } from './events.js';
import { SqliteClaimStore } from './claims.js';
import { SqliteDiscoveryStore } from './discoveries.js';
import { MessageStore } from '../messages.js';
import { HelpStore } from '../help.js';
import { ProgressStore } from '../progress.js';
import { ConflictStore } from '../conflicts.js';
import { RoleStore } from '../roles.js';
import { ProposalStore } from '../proposals.js';
import { ReinforcementStore } from '../reinforcements.js';
import { ControlStore } from '../control.js';

export function createSqliteStores(dbPath: string, namespace: string): Stores {
  const db = getDatabase(dbPath);
  const events = new SqliteEventStore(db, namespace);
  const state = new SqliteStateStore(db, namespace);
  const claims = new SqliteClaimStore(db, namespace, events);
  const discoveries = new SqliteDiscoveryStore(db, namespace, events);
  // New coordination stores use in-memory backend for now
  const messages = new MessageStore();
  const help = new HelpStore(events);
  const progress = new ProgressStore();
  const conflicts = new ConflictStore(events);
  const roles = new RoleStore();
  const proposals = new ProposalStore(events);
  const reinforcements = new ReinforcementStore(events);
  const control = new ControlStore(events);
  return { state, events, claims, discoveries, messages, help, progress, conflicts, roles, proposals, reinforcements, control };
}
