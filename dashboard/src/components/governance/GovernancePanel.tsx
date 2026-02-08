import { Shield } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { GovernanceSection } from '@/components/protocol/GovernanceSection'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { timeAgo } from '@/lib/utils'

export function GovernancePanel() {
  const protocol = useDashboardStore((s) => s.protocol)
  const proposals = useDashboardStore((s) => s.proposals)
  const conflicts = useDashboardStore((s) => s.conflicts)

  const governance = protocol?.governance
  const hasContent = governance || proposals.length > 0 || conflicts.length > 0

  if (!hasContent) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Shield className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No governance rules</p>
        </div>
      </div>
    )
  }

  const openConflicts = conflicts.filter(c => c.status === 'open')
  const resolvedConflicts = conflicts.filter(c => c.status === 'resolved')
  const openProposals = proposals.filter(p => p.status === 'open')
  const closedProposals = proposals.filter(p => p.status !== 'open')

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* Governance rules from protocol */}
      {governance && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Protocol Rules</h3>
          <GovernanceSection governance={governance} />
        </section>
      )}

      {/* Proposals */}
      {proposals.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Proposals ({openProposals.length} open)
          </h3>
          <div className="space-y-2">
            {openProposals.map((p) => (
              <div key={p.id} className="bg-card rounded-lg border border-primary/30 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <AgentBadge agentId={p.proposedBy} />
                  <span className="font-mono text-xs text-primary">{p.action}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(p.createdAt)}</span>
                </div>
                {p.detail && <p className="text-xs text-muted-foreground">{p.detail}</p>}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${Math.min(100, (p.endorsements.length / p.requires_quorum) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {p.endorsements.length}/{p.requires_quorum}
                  </span>
                </div>
                {p.endorsements.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {p.endorsements.map(e => <AgentBadge key={e} agentId={e} />)}
                  </div>
                )}
              </div>
            ))}
            {closedProposals.length > 0 && (
              <div className="space-y-1 opacity-60">
                {closedProposals.map((p) => (
                  <div key={p.id} className="bg-card rounded-lg border border-border p-2.5 flex items-center gap-2 text-xs">
                    <AgentBadge agentId={p.proposedBy} />
                    <span className="font-mono text-muted-foreground">{p.action}</span>
                    <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ml-auto ${
                      p.status === 'approved' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                    }`}>{p.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Conflicts */}
      {conflicts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Conflicts ({openConflicts.length} open)
          </h3>
          <div className="space-y-2">
            {openConflicts.map((c) => (
              <div key={c.id} className="bg-card rounded-lg border border-red-500/30 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <AgentBadge agentId={c.flaggedBy} />
                  <span className="bg-red-500/15 text-red-400 text-[10px] uppercase px-1.5 py-0.5 rounded">open</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(c.createdAt)}</span>
                </div>
                <p className="text-xs">{c.reason}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
                  <span className="text-amber-400">{c.discovery_a}</span>
                  <span>vs</span>
                  <span className="text-amber-400">{c.discovery_b}</span>
                </div>
              </div>
            ))}
            {resolvedConflicts.length > 0 && (
              <div className="space-y-1 opacity-60">
                {resolvedConflicts.map((c) => (
                  <div key={c.id} className="bg-card rounded-lg border border-border p-2.5 space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <AgentBadge agentId={c.flaggedBy} />
                      <span className="text-muted-foreground">{c.reason}</span>
                      <span className="bg-emerald-500/15 text-emerald-400 text-[10px] uppercase px-1.5 py-0.5 rounded ml-auto">resolved</span>
                    </div>
                    {c.resolution && (
                      <p className="text-[10px] text-muted-foreground">
                        {c.resolvedBy && <AgentBadge agentId={c.resolvedBy} />} {c.resolution}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
