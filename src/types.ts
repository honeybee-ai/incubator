export interface StateEntry {
  key: string;
  value: unknown;
  category?: string;
  setBy: string;
  setAt: string;
  updatedAt: string;
  ttlMs?: number;
}

export interface Claim {
  resource: string;
  value: string;
  owner: string;
  status: 'active' | 'released' | 'expired';
  claimedAt: string;
  ttlMs?: number;
}

export interface IncubatorEvent {
  id: number;
  type: string;
  data: unknown;
  publishedBy: string;
  publishedAt: string;
}

export interface Discovery {
  id: string;
  topic: string;
  content: string;
  category?: string;
  publishedBy: string;
  publishedAt: string;
}

export interface ClaimResult {
  status: 'approved' | 'rejected';
  claim: Claim;
}

// Runtime types — re-exported from spec (single source of truth)
export type {
  Message,
  HelpRequest,
  ProgressReport,
  Conflict,
  RoleAssignment,
  ReinforcementRequest,
  Proposal,
} from '@agentcoordinationprotocol/spec';

export interface Snapshot {
  state: StateEntry[];
  claims: Claim[];
  events: IncubatorEvent[];
  discoveries: Discovery[];
  eventCursor: number;
  savedAt: string;
}
