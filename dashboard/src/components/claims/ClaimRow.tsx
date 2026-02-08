import { useEffect, useState } from 'react'
import type { Claim, ProgressReport } from '@/lib/types'
import { useDashboardStore } from '@/stores/dashboard'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { formatTime } from '@/lib/utils'

interface ClaimRowProps {
  claim: Claim
}

export function ClaimRow({ claim }: ClaimRowProps) {
  const [ttlPercent, setTtlPercent] = useState(100)
  const progressReports = useDashboardStore((s) => s.progressReports)

  // Find latest progress report for this claim
  const progress: ProgressReport | undefined = progressReports
    .filter(p => p.claim === claim.resource)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]

  useEffect(() => {
    if (!claim.ttlMs || claim.status !== 'active') return

    const claimedAt = new Date(claim.claimedAt).getTime()
    const expiresAt = claimedAt + claim.ttlMs

    function update() {
      const now = Date.now()
      const remaining = expiresAt - now
      const pct = Math.max(0, Math.min(100, (remaining / claim.ttlMs!) * 100))
      setTtlPercent(pct)
    }

    update()
    const timer = setInterval(update, 500)
    return () => clearInterval(timer)
  }, [claim.claimedAt, claim.ttlMs, claim.status])

  return (
    <div className="bg-card rounded-lg border border-border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-medium text-primary">{claim.resource}</span>
        <div className="flex items-center gap-1.5">
          {progress && (
            <span className="text-[10px] font-mono text-muted-foreground">{Math.round(progress.progress * 100)}%</span>
          )}
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
            claim.status === 'active'
              ? 'bg-emerald-500/15 text-emerald-500'
              : 'bg-muted text-muted-foreground'
          }`}>
            {claim.status}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono">{claim.value}</span>
        <AgentBadge agentId={claim.owner} />
        <span>{formatTime(claim.claimedAt)}</span>
      </div>
      {progress && claim.status === 'active' && (
        <div className="space-y-0.5">
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.round(progress.progress * 100)}%` }}
            />
          </div>
          {progress.note && (
            <p className="text-[10px] text-muted-foreground truncate">{progress.note}</p>
          )}
        </div>
      )}
      {claim.ttlMs && claim.status === 'active' && (
        <div className="h-1 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-primary/60 rounded-full transition-all duration-500"
            style={{ width: `${ttlPercent}%` }}
          />
        </div>
      )}
    </div>
  )
}
