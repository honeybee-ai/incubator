import { useMemo } from 'react'
import type { IncubatorEvent } from '@/lib/types'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { formatTime } from '@/lib/utils'

const TYPE_COLORS: Record<string, string> = {
  'state.set': 'bg-blue-500/15 text-blue-400',
  'state.delete': 'bg-red-500/15 text-red-400',
  'claim.acquired': 'bg-emerald-500/15 text-emerald-400',
  'claim.released': 'bg-amber-500/15 text-amber-400',
  'claim.expired': 'bg-orange-500/15 text-orange-400',
  'claim.rejected': 'bg-red-500/15 text-red-400',
  'discovery.published': 'bg-purple-500/15 text-purple-400',
  'message.sent': 'bg-sky-500/15 text-sky-400',
  'role.assigned': 'bg-indigo-500/15 text-indigo-400',
  'role.transition': 'bg-violet-500/15 text-violet-400',
  'help.requested': 'bg-amber-500/15 text-amber-400',
  'help.claimed': 'bg-blue-500/15 text-blue-400',
  'help.resolved': 'bg-emerald-500/15 text-emerald-400',
  'progress.reported': 'bg-teal-500/15 text-teal-400',
  'conflict.flagged': 'bg-red-500/15 text-red-400',
  'conflict.resolved': 'bg-emerald-500/15 text-emerald-400',
  'reinforcement.requested': 'bg-orange-500/15 text-orange-400',
  'reinforcement.approved': 'bg-emerald-500/15 text-emerald-400',
  'reinforcement.denied': 'bg-red-500/15 text-red-400',
  'proposal.created': 'bg-cyan-500/15 text-cyan-400',
  'proposal.endorsed': 'bg-cyan-500/15 text-cyan-400',
  'proposal.approved': 'bg-emerald-500/15 text-emerald-400',
  'proposal.rejected': 'bg-red-500/15 text-red-400',
  'phase.transition': 'bg-yellow-500/15 text-yellow-400',
  'governance.halt': 'bg-red-500/15 text-red-400',
}

const DEFAULT_TYPE_COLOR = 'bg-secondary text-muted-foreground'

interface EventCardProps {
  event: IncubatorEvent
}

export function EventCard({ event }: EventCardProps) {
  const typeColor = TYPE_COLORS[event.type] ?? DEFAULT_TYPE_COLOR

  const summary = useMemo(() => {
    if (!event.data || typeof event.data !== 'object') return null
    const d = event.data as Record<string, unknown>
    if (d.key) return String(d.key)
    if (d.resource) return String(d.resource)
    if (d.topic) return String(d.topic)
    if (d.role) return String(d.role)
    if (d.action) return String(d.action)
    if (d.problem) return String(d.problem)
    if (d.to) return `→ ${String(d.to)}`
    if (d.reason) return String(d.reason)
    return null
  }, [event.data])

  return (
    <div className="flex items-center gap-2 py-1 text-xs group hover:bg-accent/30 rounded px-1 -mx-1">
      <span className="font-mono text-muted-foreground w-16 shrink-0">{formatTime(event.publishedAt)}</span>
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${typeColor}`}>
        {event.type}
      </span>
      <AgentBadge agentId={event.publishedBy} />
      {summary && (
        <span className="text-muted-foreground truncate font-mono">{summary}</span>
      )}
    </div>
  )
}
