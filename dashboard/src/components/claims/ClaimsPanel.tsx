import { Lock } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { ClaimRow } from './ClaimRow'

export function ClaimsPanel() {
  const claims = useDashboardStore((s) => s.claims)
  const active = claims.filter(c => c.status === 'active')
  const released = claims.filter(c => c.status !== 'active')

  if (claims.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Lock className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No claims</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {active.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Active ({active.length})
          </h3>
          <div className="space-y-2">
            {active.map((claim) => (
              <ClaimRow key={claim.resource} claim={claim} />
            ))}
          </div>
        </section>
      )}

      {released.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Released / Expired ({released.length})
          </h3>
          <div className="space-y-1 opacity-60">
            {released.map((claim, i) => (
              <ClaimRow key={`${claim.resource}-${i}`} claim={claim} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
