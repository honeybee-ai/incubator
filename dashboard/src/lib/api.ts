import type {
  StateEntry,
  Claim,
  IncubatorEvent,
  Discovery,
  HealthResponse,
  NamespaceInfo,
  ProtocolSpec,
  RoleAssignment,
  HelpRequest,
  ProgressReport,
  Conflict,
  ReinforcementRequest,
  Proposal,
} from './types'

const BASE = ''  // same origin

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

function nsPrefix(ns: string): string {
  return ns === 'default' ? '/api' : `/api/${ns}`
}

// ─── Original primitives ────────────────────────────────────

export async function fetchHealth(ns: string): Promise<HealthResponse> {
  return get<HealthResponse>(`${nsPrefix(ns)}/health`)
}

export async function fetchState(ns: string): Promise<StateEntry[]> {
  const data = await get<{ count: number; entries: StateEntry[] }>(`${nsPrefix(ns)}/state`)
  return data.entries
}

export async function fetchClaims(ns: string): Promise<Claim[]> {
  const data = await get<{ count: number; claims: Claim[] }>(`${nsPrefix(ns)}/claims`)
  return data.claims
}

export async function fetchEvents(ns: string, since?: number): Promise<{ events: IncubatorEvent[]; cursor: number }> {
  const qs = since !== undefined ? `?since=${since}` : ''
  return get<{ events: IncubatorEvent[]; cursor: number }>(`${nsPrefix(ns)}/events${qs}`)
}

export async function fetchDiscoveries(ns: string): Promise<Discovery[]> {
  const data = await get<{ count: number; discoveries: Discovery[] }>(`${nsPrefix(ns)}/discoveries`)
  return data.discoveries
}

export async function fetchNamespaces(): Promise<NamespaceInfo[]> {
  const data = await get<{ namespaces: NamespaceInfo[] }>('/api/_ns')
  return data.namespaces
}

export async function fetchProtocol(ns: string): Promise<{ spec: ProtocolSpec | null; team: RoleAssignment[] }> {
  const data = await get<{ loaded: boolean; spec?: ProtocolSpec; team?: RoleAssignment[] }>(`${nsPrefix(ns)}/protocol`)
  return { spec: data.loaded ? data.spec! : null, team: data.team ?? [] }
}

// ─── 0.2.0 primitives ──────────────────────────────────────

export async function fetchRoles(ns: string): Promise<RoleAssignment[]> {
  const data = await get<{ count: number; assignments: RoleAssignment[] }>(`${nsPrefix(ns)}/roles`)
  return data.assignments
}

export async function fetchHelp(ns: string): Promise<HelpRequest[]> {
  const data = await get<{ count: number; requests: HelpRequest[] }>(`${nsPrefix(ns)}/help`)
  return data.requests
}

export async function fetchProgress(ns: string): Promise<ProgressReport[]> {
  const data = await get<{ count: number; reports: ProgressReport[] }>(`${nsPrefix(ns)}/progress`)
  return data.reports
}

export async function fetchConflicts(ns: string): Promise<Conflict[]> {
  const data = await get<{ count: number; conflicts: Conflict[] }>(`${nsPrefix(ns)}/conflicts`)
  return data.conflicts
}

export async function fetchReinforcements(ns: string): Promise<ReinforcementRequest[]> {
  const data = await get<{ count: number; requests: ReinforcementRequest[] }>(`${nsPrefix(ns)}/reinforcements`)
  return data.requests
}

export async function fetchProposals(ns: string): Promise<Proposal[]> {
  const data = await get<{ count: number; proposals: Proposal[] }>(`${nsPrefix(ns)}/governance/proposals`)
  return data.proposals
}
