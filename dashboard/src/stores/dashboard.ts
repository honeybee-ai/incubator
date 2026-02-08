import { create } from 'zustand'
import type {
  StateEntry,
  Claim,
  IncubatorEvent,
  Discovery,
  HealthResponse,
  NamespaceInfo,
  ProtocolSpec,
  ConnectionStatus,
  RoleAssignment,
  HelpRequest,
  ProgressReport,
  Conflict,
  ReinforcementRequest,
  Proposal,
} from '@/lib/types'

interface DashboardState {
  // Connection
  wsStatus: ConnectionStatus
  setWsStatus: (status: ConnectionStatus) => void

  // Namespace
  activeNamespace: string
  namespaces: NamespaceInfo[]
  setActiveNamespace: (ns: string) => void
  setNamespaces: (ns: NamespaceInfo[]) => void

  // Health
  health: HealthResponse | null
  setHealth: (h: HealthResponse) => void

  // Protocol
  protocol: ProtocolSpec | null
  setProtocol: (p: ProtocolSpec | null) => void

  // State entries
  stateEntries: StateEntry[]
  setStateEntries: (entries: StateEntry[]) => void

  // Claims
  claims: Claim[]
  setClaims: (claims: Claim[]) => void

  // Events
  events: IncubatorEvent[]
  eventCursor: number
  addEvents: (events: IncubatorEvent[]) => void
  setEventCursor: (cursor: number) => void
  clearEvents: () => void

  // Discoveries
  discoveries: Discovery[]
  setDiscoveries: (d: Discovery[]) => void

  // ─── 0.2.0 primitives ────────────────────────────────────

  // Team / Roles
  team: RoleAssignment[]
  setTeam: (t: RoleAssignment[]) => void

  // Help requests
  helpRequests: HelpRequest[]
  setHelpRequests: (h: HelpRequest[]) => void

  // Progress reports
  progressReports: ProgressReport[]
  setProgressReports: (p: ProgressReport[]) => void

  // Conflicts
  conflicts: Conflict[]
  setConflicts: (c: Conflict[]) => void

  // Reinforcements
  reinforcements: ReinforcementRequest[]
  setReinforcements: (r: ReinforcementRequest[]) => void

  // Proposals
  proposals: Proposal[]
  setProposals: (p: Proposal[]) => void

  // ─── Agents tracking ─────────────────────────────────────

  knownAgents: Map<string, number>
  trackAgent: (agentId: string) => void

  // ─── UI state ─────────────────────────────────────────────

  activeTab: string
  setActiveTab: (tab: string) => void
  eventTypeFilter: Set<string>
  toggleEventTypeFilter: (type: string) => void
  clearEventTypeFilters: () => void
  autoScroll: boolean
  toggleAutoScroll: () => void
  activityFeedOpen: boolean
  toggleActivityFeed: () => void

  // Reset on namespace switch
  resetData: () => void
}

const INITIAL_DATA = {
  health: null,
  protocol: null,
  stateEntries: [],
  claims: [],
  events: [],
  eventCursor: 0,
  discoveries: [],
  team: [],
  helpRequests: [],
  progressReports: [],
  conflicts: [],
  reinforcements: [],
  proposals: [],
  knownAgents: new Map<string, number>(),
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  // Connection
  wsStatus: 'disconnected',
  setWsStatus: (wsStatus) => set({ wsStatus }),

  // Namespace
  activeNamespace: 'default',
  namespaces: [],
  setActiveNamespace: (activeNamespace) => {
    get().resetData()
    set({ activeNamespace })
  },
  setNamespaces: (namespaces) => set({ namespaces }),

  // Health
  health: null,
  setHealth: (health) => set({ health }),

  // Protocol
  protocol: null,
  setProtocol: (protocol) => set({ protocol }),

  // State
  stateEntries: [],
  setStateEntries: (stateEntries) => set({ stateEntries }),

  // Claims
  claims: [],
  setClaims: (claims) => set({ claims }),

  // Events
  events: [],
  eventCursor: 0,
  addEvents: (newEvents) => set((s) => {
    const existingIds = new Set(s.events.map(e => e.id))
    const deduped = newEvents.filter(e => !existingIds.has(e.id))
    if (deduped.length === 0) return s
    const events = [...s.events, ...deduped].slice(-500)
    const knownAgents = new Map(s.knownAgents)
    for (const e of deduped) {
      knownAgents.set(e.publishedBy, Date.now())
    }
    return { events, knownAgents }
  }),
  setEventCursor: (eventCursor) => set({ eventCursor }),
  clearEvents: () => set({ events: [], eventCursor: 0 }),

  // Discoveries
  discoveries: [],
  setDiscoveries: (discoveries) => set({ discoveries }),

  // 0.2.0 primitives
  team: [],
  setTeam: (team) => set({ team }),
  helpRequests: [],
  setHelpRequests: (helpRequests) => set({ helpRequests }),
  progressReports: [],
  setProgressReports: (progressReports) => set({ progressReports }),
  conflicts: [],
  setConflicts: (conflicts) => set({ conflicts }),
  reinforcements: [],
  setReinforcements: (reinforcements) => set({ reinforcements }),
  proposals: [],
  setProposals: (proposals) => set({ proposals }),

  // Agents
  knownAgents: new Map(),
  trackAgent: (agentId) => set((s) => {
    const knownAgents = new Map(s.knownAgents)
    knownAgents.set(agentId, Date.now())
    return { knownAgents }
  }),

  // UI
  activeTab: 'protocol',
  setActiveTab: (activeTab) => set({ activeTab }),
  eventTypeFilter: new Set(),
  toggleEventTypeFilter: (type) => set((s) => {
    const f = new Set(s.eventTypeFilter)
    if (f.has(type)) f.delete(type); else f.add(type)
    return { eventTypeFilter: f }
  }),
  clearEventTypeFilters: () => set({ eventTypeFilter: new Set() }),
  autoScroll: true,
  toggleAutoScroll: () => set((s) => ({ autoScroll: !s.autoScroll })),
  activityFeedOpen: true,
  toggleActivityFeed: () => set((s) => ({ activityFeedOpen: !s.activityFeedOpen })),

  // Reset
  resetData: () => set({ ...INITIAL_DATA, knownAgents: new Map() }),
}))
