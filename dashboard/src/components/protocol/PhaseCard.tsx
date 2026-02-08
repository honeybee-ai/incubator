import { cn } from '@/lib/utils'
import type { ProtocolPhase } from '@/lib/types'
import { ExitConditionBadge } from './ExitConditionBadge'

interface PhaseCardProps {
  name: string
  phase: ProtocolPhase
  isCurrent: boolean
}

export function PhaseCard({ name, phase, isCurrent }: PhaseCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 space-y-2 transition-colors',
        isCurrent
          ? 'border-primary bg-primary/10 shadow-[0_0_12px_oklch(0.7_0.15_160/0.15)]'
          : 'border-border bg-card'
      )}
    >
      <div className="flex items-center gap-2">
        {isCurrent && <span className="w-2 h-2 rounded-full bg-primary pulse-live" />}
        <span className="font-mono text-sm font-medium">{name}</span>
        {isCurrent && <span className="text-[10px] text-primary uppercase tracking-wider">current</span>}
        {phase.terminal && <span className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">terminal</span>}
      </div>
      {phase.description && (
        <p className="text-xs text-muted-foreground">{phase.description}</p>
      )}
      {phase.exit_condition && (
        <div className="text-[10px] text-muted-foreground">
          <span className="mr-1">exit:</span>
          <ExitConditionBadge condition={phase.exit_condition} />
        </div>
      )}
    </div>
  )
}
