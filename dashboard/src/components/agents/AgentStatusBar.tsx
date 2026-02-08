import { useDashboardStore } from '@/stores/dashboard'
import { AgentBadge } from './AgentBadge'

const INACTIVE_THRESHOLD = 60_000 // 60s

export function AgentStatusBar() {
  const knownAgents = useDashboardStore((s) => s.knownAgents)
  const now = Date.now()

  const agents = Array.from(knownAgents.entries()).sort((a, b) => a[0].localeCompare(b[0]))

  if (agents.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {agents.map(([id, lastSeen]) => {
        const inactive = now - lastSeen > INACTIVE_THRESHOLD
        return (
          <span key={id} className={inactive ? 'opacity-40' : ''}>
            <AgentBadge agentId={id} size="md" />
          </span>
        )
      })}
    </div>
  )
}
