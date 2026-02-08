/** Mirror of server types from @honeybee-ai/incubator (ACP 0.2.0) */

// ─── Core Primitives ────────────────────────────────────────

export interface StateEntry {
  key: string
  value: unknown
  category?: string
  setBy: string
  setAt: string
  updatedAt: string
  ttlMs?: number
}

export interface Claim {
  resource: string
  value: string
  owner: string
  status: 'active' | 'released' | 'expired'
  claimedAt: string
  ttlMs?: number
}

export interface IncubatorEvent {
  id: number
  type: string
  data: unknown
  publishedBy: string
  publishedAt: string
}

export interface Discovery {
  id: string
  topic: string
  content: string
  category?: string
  publishedBy: string
  publishedAt: string
}

// ─── 0.2.0 Primitives ──────────────────────────────────────

export interface Message {
  id: string
  from: string
  to: string
  content: string
  replyTo?: string
  sentAt: string
}

export interface HelpRequest {
  id: string
  from: string
  problem: string
  needs_capability?: string
  urgency?: 'low' | 'normal' | 'high'
  status: 'open' | 'claimed' | 'resolved'
  claimedBy?: string
  createdAt: string
}

export interface ProgressReport {
  claim: string
  agent: string
  progress: number
  note?: string
  updatedAt: string
}

export interface Conflict {
  id: string
  flaggedBy: string
  discovery_a: string
  discovery_b: string
  reason: string
  status: 'open' | 'resolved'
  resolvedBy?: string
  resolution?: string
  createdAt: string
}

export interface RoleAssignment {
  agent: string
  role: string
  assignedAt: string
}

export interface ReinforcementRequest {
  id: string
  requestedBy: string
  role: string
  count: number
  reason?: string
  status: 'pending' | 'approved' | 'denied'
  denialReason?: string
  createdAt: string
}

export interface Proposal {
  id: string
  proposedBy: string
  action: string
  detail?: string
  requires_quorum: number
  endorsements: string[]
  status: 'open' | 'approved' | 'rejected'
  createdAt: string
}

// ─── API Responses ──────────────────────────────────────────

export interface HealthResponse {
  status: string
  uptime: number
  agents: number
  claims: number
  events: number
}

export interface NamespaceInfo {
  name: string
  state: number
  claims: number
  events: number
  discoveries: number
}

// ─── Protocol Spec (ACP 0.2.0) ─────────────────────────────

export interface ProtocolSpec {
  acp: string
  name: string
  title: string
  description?: string
  tags?: string[]
  roles: Record<string, ProtocolRole>
  phases: Record<string, ProtocolPhase>
  resources?: ProtocolResources
  rules?: Record<string, Record<string, ProtocolPhaseRules | ProtocolStep[]>>
  completion?: ProtocolCompletion
  errors?: ProtocolErrors
  governance?: GovernanceDef
}

export interface ProtocolRole {
  description: string
  count?: string | number
  can_become?: string[]
  scope?: string[]
  capabilities?: string[]
  can_request_reinforcement?: boolean
  can_rollback?: boolean
}

export interface ProtocolPhase {
  description: string
  terminal?: boolean
  exit_condition?: ExitCondition
}

export type ExitCondition =
  | { event: string; data?: Record<string, unknown> }
  | { state_key: string; equals: unknown }
  | { any_of: ExitCondition[] }
  | { all_of: ExitCondition[] }

export interface ProtocolPhaseRules {
  loop?: boolean
  steps?: ProtocolStep[]
}

export interface ProtocolStep {
  action: string
  description?: string
  params?: Record<string, unknown>
  hint?: string
  on_rejected?: { skip?: boolean; goto?: string; retry_after_ms?: number }
  on_match?: { value: unknown; goto?: string; skip?: boolean }
}

export interface ProtocolResources {
  claim_patterns?: Record<string, string | { pattern?: string }>
  discovery_topics?: Record<string, { pattern: string; category?: string }>
  event_types?: Record<string, { type: string }>
  state_keys?: Record<string, { key: string; type?: string }>
  instances?: string[]
}

export interface ProtocolCompletion {
  condition: ExitCondition
  verify?: Array<{
    all_resources_have_discovery?: boolean
    no_active_claims?: boolean
    custom?: string
  }>
}

export interface ProtocolErrors {
  claim_rejected?: { action: string; retry_after_ms?: number }
  claim_expired?: { action: string; retry_after_ms?: number }
  halt_received?: { action: string; retry_after_ms?: number }
  [key: string]: { action: string; retry_after_ms?: number } | undefined
}

// ─── Governance ─────────────────────────────────────────────

export interface GovernanceDef {
  budget?: {
    max_tokens?: number
    max_cost?: number
    warn_at?: number
  }
  escalation?: {
    triggers?: Array<{
      condition: string
      action: 'notify' | 'halt' | 'request_approval'
    }>
    channel?: string
  }
  quorum?: {
    default?: number
    actions?: Record<string, number>
  }
  approval_gates?: Array<{
    action: string
    scope?: string[]
    required_role?: string
  }>
  heartbeat?: {
    stale_after_ms?: number
    dead_after_ms?: number
    auto_release_claims?: boolean
  }
  reinforcement?: {
    auto_heal?: boolean
    cooldown_ms?: number
  }
}

// ─── WebSocket ──────────────────────────────────────────────

export type WsMessage =
  | { type: 'event'; event: IncubatorEvent }
  | { type: 'replay_done'; cursor: number }
  | { type: 'ping'; ts: number }
  | { type: 'error'; message: string }

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
