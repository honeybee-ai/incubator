import type { GovernanceDef } from '@/lib/types'

interface Props {
  governance: GovernanceDef
}

export function GovernanceSection({ governance }: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      {governance.budget && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Budget</h4>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {governance.budget.max_tokens && <p>Max tokens: <span className="font-mono text-foreground">{governance.budget.max_tokens.toLocaleString()}</span></p>}
            {governance.budget.max_cost && <p>Max cost: <span className="font-mono text-foreground">${governance.budget.max_cost.toFixed(2)}</span></p>}
            {governance.budget.warn_at && <p>Warn at: <span className="font-mono text-amber-400">{(governance.budget.warn_at * 100).toFixed(0)}%</span></p>}
          </div>
        </div>
      )}

      {governance.quorum && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Quorum</h4>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {governance.quorum.default && <p>Default: <span className="font-mono text-foreground">{governance.quorum.default} agents</span></p>}
            {governance.quorum.actions && Object.entries(governance.quorum.actions).map(([action, count]) => (
              <p key={action}><span className="font-mono text-primary">{action}</span>: {count} agents</p>
            ))}
          </div>
        </div>
      )}

      {governance.escalation && governance.escalation.triggers && governance.escalation.triggers.length > 0 && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Escalation Triggers</h4>
          <div className="space-y-1">
            {governance.escalation.triggers.map((t, i) => (
              <div key={i} className="text-xs flex items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                  t.action === 'halt' ? 'bg-red-500/15 text-red-400' :
                  t.action === 'request_approval' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-blue-500/15 text-blue-400'
                }`}>{t.action}</span>
                <span className="font-mono text-muted-foreground">{t.condition}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {governance.approval_gates && governance.approval_gates.length > 0 && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Approval Gates</h4>
          <div className="space-y-1">
            {governance.approval_gates.map((gate, i) => (
              <div key={i} className="text-xs">
                <span className="font-mono text-primary">{gate.action}</span>
                {gate.required_role && <span className="text-muted-foreground ml-1">requires <span className="text-foreground">{gate.required_role}</span></span>}
                {gate.scope && <span className="text-muted-foreground ml-1">({gate.scope.join(', ')})</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {governance.heartbeat && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Heartbeat</h4>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {governance.heartbeat.stale_after_ms && <p>Stale: <span className="font-mono text-amber-400">{(governance.heartbeat.stale_after_ms / 1000).toFixed(0)}s</span></p>}
            {governance.heartbeat.dead_after_ms && <p>Dead: <span className="font-mono text-red-400">{(governance.heartbeat.dead_after_ms / 1000).toFixed(0)}s</span></p>}
            {governance.heartbeat.auto_release_claims !== undefined && <p>Auto-release claims: <span className="font-mono">{governance.heartbeat.auto_release_claims ? 'yes' : 'no'}</span></p>}
          </div>
        </div>
      )}

      {governance.reinforcement && (
        <div className="bg-card rounded-lg border border-border p-3 space-y-1">
          <h4 className="text-xs font-medium">Reinforcement</h4>
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {governance.reinforcement.auto_heal !== undefined && <p>Auto-heal: <span className="font-mono">{governance.reinforcement.auto_heal ? 'yes' : 'no'}</span></p>}
            {governance.reinforcement.cooldown_ms && <p>Cooldown: <span className="font-mono">{(governance.reinforcement.cooldown_ms / 1000).toFixed(0)}s</span></p>}
          </div>
        </div>
      )}
    </div>
  )
}
