import type {
  StateEntry, Claim, IncubatorEvent, Discovery, ClaimResult,
  Message, HelpRequest, ProgressReport, Conflict, RoleAssignment,
  ReinforcementRequest, Proposal,
} from '../types.js';
import type { ControlStore } from './control.js';

export interface IStateStore {
  get(key: string): Promise<StateEntry | null>;
  set(key: string, value: unknown, agentId: string, category?: string, ttlMs?: number): Promise<StateEntry>;
  delete(key: string): Promise<boolean>;
  query(pattern?: string, category?: string): Promise<StateEntry[]>;
  getAll(): Promise<StateEntry[]>;
  load(entries: StateEntry[]): Promise<void>;
}

export interface IEventStore {
  publish(type: string, data: unknown, agentId: string): Promise<IncubatorEvent>;
  getEvents(since?: number, type?: string): Promise<{ events: IncubatorEvent[]; cursor: number }>;
  getCursor(): Promise<number>;
  getAll(): Promise<IncubatorEvent[]>;
  load(events: IncubatorEvent[], cursor: number): Promise<void>;
}

export interface IClaimStore {
  claim(resource: string, value: string, agentId: string, ttlMs?: number): Promise<ClaimResult>;
  release(resource: string, agentId: string): Promise<Claim | null>;
  check(resource: string): Promise<Claim | null>;
  list(pattern?: string): Promise<Claim[]>;
  getAll(): Promise<Claim[]>;
  load(claims: Claim[]): Promise<void>;
}

export interface IDiscoveryStore {
  publish(topic: string, content: string, agentId: string, category?: string): Promise<Discovery>;
  search(query?: string, category?: string): Promise<Discovery[]>;
  getAll(): Promise<Discovery[]>;
  load(discoveries: Discovery[]): Promise<void>;
}

export interface IMessageStore {
  send(from: string, to: string, content: string, replyTo?: string): Promise<Message>;
  getFor(agentId: string, since?: string): Promise<Message[]>;
  getAll(): Promise<Message[]>;
}

export interface IHelpStore {
  request(from: string, problem: string, needs_capability?: string, urgency?: 'low' | 'normal' | 'high'): Promise<HelpRequest>;
  claim(requestId: string, agentId: string): Promise<HelpRequest | null>;
  resolve(requestId: string, agentId: string): Promise<HelpRequest | null>;
  list(status?: string): Promise<HelpRequest[]>;
}

export interface IProgressStore {
  report(claim: string, agentId: string, progress: number, note?: string): Promise<ProgressReport>;
  get(claim: string): Promise<ProgressReport | null>;
  list(): Promise<ProgressReport[]>;
}

export interface IConflictStore {
  flag(agentId: string, discovery_a: string, discovery_b: string, reason: string): Promise<Conflict>;
  resolve(conflictId: string, agentId: string, resolution: string): Promise<Conflict | null>;
  list(status?: string): Promise<Conflict[]>;
}

export interface IRoleStore {
  assign(agentId: string, role: string): Promise<RoleAssignment>;
  getAssignments(): Promise<RoleAssignment[]>;
  getByAgent(agentId: string): Promise<RoleAssignment | null>;
  remove(agentId: string): Promise<boolean>;
}

export interface IProposalStore {
  propose(agentId: string, action: string, detail?: string, quorum?: number): Promise<Proposal>;
  endorse(proposalId: string, agentId: string): Promise<Proposal | null>;
  list(status?: string): Promise<Proposal[]>;
  get(proposalId: string): Promise<Proposal | null>;
}

export interface IReinforcementStore {
  request(agentId: string, role: string, count: number, reason?: string): Promise<ReinforcementRequest>;
  approve(requestId: string): Promise<ReinforcementRequest | null>;
  deny(requestId: string, reason: string): Promise<ReinforcementRequest | null>;
  list(): Promise<ReinforcementRequest[]>;
}

export interface IterationDetail {
  index: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: string;
}

export interface AgentRun {
  agentId: string;
  role: string;
  status: 'running' | 'completed' | 'error' | 'halted';
  startedAt: string;
  completedAt?: string;
  elapsed?: number;
  iterations?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  iterationDetails?: IterationDetail[];
  summary?: string;
  error?: string;
}

export interface IRunStore {
  start(agentId: string, role: string): Promise<AgentRun>;
  complete(agentId: string, data: Partial<AgentRun>): Promise<AgentRun | null>;
  get(agentId: string): Promise<AgentRun | null>;
  list(status?: string): Promise<AgentRun[]>;
  summary(): Promise<{ agents: number; completed: number; errors: number; totalTokens: number; totalDuration: number }>;
}

export interface Stores {
  state: IStateStore;
  events: IEventStore;
  claims: IClaimStore;
  discoveries: IDiscoveryStore;
  messages: IMessageStore;
  help: IHelpStore;
  progress: IProgressStore;
  conflicts: IConflictStore;
  roles: IRoleStore;
  proposals: IProposalStore;
  reinforcements: IReinforcementStore;
  control: ControlStore;
  runs: IRunStore;
}
