import { Users } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { timeAgo } from '@/lib/utils'

export function TeamRoster() {
  const team = useDashboardStore((s) => s.team)
  const helpRequests = useDashboardStore((s) => s.helpRequests)
  const reinforcements = useDashboardStore((s) => s.reinforcements)
  const protocol = useDashboardStore((s) => s.protocol)

  if (team.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Users className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No role assignments</p>
        </div>
      </div>
    )
  }

  // Group by role
  const byRole = new Map<string, typeof team>()
  for (const a of team) {
    const list = byRole.get(a.role) ?? []
    list.push(a)
    byRole.set(a.role, list)
  }

  const openHelp = helpRequests.filter(h => h.status === 'open').length
  const pendingReinforcements = reinforcements.filter(r => r.status === 'pending').length

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{team.length} agents assigned</span>
        <span>{byRole.size} roles active</span>
        {openHelp > 0 && <span className="text-amber-400">{openHelp} help requests</span>}
        {pendingReinforcements > 0 && <span className="text-blue-400">{pendingReinforcements} reinforcement pending</span>}
      </div>

      {/* Role groups */}
      {[...byRole.entries()].map(([role, agents]) => {
        const roleDef = protocol?.roles?.[role]
        return (
          <section key={role} className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{role}</h3>
              <span className="text-[10px] text-muted-foreground">({agents.length})</span>
              {roleDef?.count && (
                <span className="text-[10px] text-muted-foreground/60">/ {roleDef.count} spec'd</span>
              )}
            </div>
            {roleDef?.description && (
              <p className="text-[10px] text-muted-foreground/70">{roleDef.description}</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {agents.map((a) => (
                <div key={a.agent} className="bg-card rounded-lg border border-border p-2.5 flex items-center gap-2.5">
                  <AgentBadge agentId={a.agent} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs truncate">{a.agent}</p>
                    <p className="text-[10px] text-muted-foreground">{timeAgo(a.assignedAt)}</p>
                  </div>
                  {roleDef?.capabilities && roleDef.capabilities.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {roleDef.capabilities.slice(0, 2).map(cap => (
                        <span key={cap} className="text-[9px] bg-primary/10 text-primary px-1 py-0.5 rounded">{cap}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}

      {/* Help Requests */}
      {helpRequests.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Help Requests</h3>
          <div className="space-y-1.5">
            {helpRequests.map((h) => (
              <div key={h.id} className="bg-card rounded-lg border border-border p-2.5 space-y-1">
                <div className="flex items-center gap-2">
                  <AgentBadge agentId={h.from} />
                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${
                    h.status === 'open' ? 'bg-amber-500/15 text-amber-400' :
                    h.status === 'claimed' ? 'bg-blue-500/15 text-blue-400' :
                    'bg-emerald-500/15 text-emerald-400'
                  }`}>{h.status}</span>
                  {h.urgency && h.urgency !== 'normal' && (
                    <span className={`text-[10px] ${h.urgency === 'high' ? 'text-red-400' : 'text-muted-foreground'}`}>
                      {h.urgency}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(h.createdAt)}</span>
                </div>
                <p className="text-xs">{h.problem}</p>
                {h.needs_capability && (
                  <span className="text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded inline-block">
                    needs: {h.needs_capability}
                  </span>
                )}
                {h.claimedBy && (
                  <div className="text-[10px] text-muted-foreground">
                    Claimed by <AgentBadge agentId={h.claimedBy} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Reinforcement Requests */}
      {reinforcements.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Reinforcements</h3>
          <div className="space-y-1.5">
            {reinforcements.map((r) => (
              <div key={r.id} className="bg-card rounded-lg border border-border p-2.5 flex items-center gap-2">
                <AgentBadge agentId={r.requestedBy} />
                <span className="text-xs font-mono text-primary">{r.role}</span>
                <span className="text-[10px] text-muted-foreground">×{r.count}</span>
                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ml-auto ${
                  r.status === 'pending' ? 'bg-amber-500/15 text-amber-400' :
                  r.status === 'approved' ? 'bg-emerald-500/15 text-emerald-400' :
                  'bg-red-500/15 text-red-400'
                }`}>{r.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
