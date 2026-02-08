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

export interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  replyTo?: string;
  sentAt: string;
}

export interface HelpRequest {
  id: string;
  from: string;
  problem: string;
  needs_capability?: string;
  urgency?: 'low' | 'normal' | 'high';
  status: 'open' | 'claimed' | 'resolved';
  claimedBy?: string;
  createdAt: string;
}

export interface ProgressReport {
  claim: string;
  agent: string;
  progress: number;
  note?: string;
  updatedAt: string;
}

export interface Conflict {
  id: string;
  flaggedBy: string;
  discovery_a: string;
  discovery_b: string;
  reason: string;
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolution?: string;
  createdAt: string;
}

export interface RoleAssignment {
  agent: string;
  role: string;
  assignedAt: string;
}

export interface ReinforcementRequest {
  id: string;
  requestedBy: string;
  role: string;
  count: number;
  reason?: string;
  status: 'pending' | 'approved' | 'denied';
  denialReason?: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  proposedBy: string;
  action: string;
  detail?: string;
  requires_quorum: number;
  endorsements: string[];
  status: 'open' | 'approved' | 'rejected';
  createdAt: string;
}

export interface Snapshot {
  state: StateEntry[];
  claims: Claim[];
  events: IncubatorEvent[];
  discoveries: Discovery[];
  eventCursor: number;
  savedAt: string;
}
