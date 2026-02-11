import { useDashboardStore } from '@/stores/dashboard'
import { StatCard } from './StatCard'

export function MetricsPanel() {
  const metrics = useDashboardStore((s) => s.metrics)

  if (!metrics) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-8">
        Waiting for metrics... Telemetry data will appear once agents start running.
      </div>
    )
  }

  const { counts, numerics } = metrics
  const avgLatency = numerics['llm_call.latency_ms']

  // Build sorted event type breakdown
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const maxCount = entries.length > 0 ? entries[0][1] : 1

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* Stat cards row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="LLM Calls" value={counts.llm_call ?? 0} />
        <StatCard label="Tool Calls" value={counts.tool_call ?? 0} />
        <StatCard label="Agent Spawns" value={counts.agent_spawn ?? 0} />
        <StatCard
          label="Guard Blocks"
          value={counts.guard_scan ?? 0}
          color={counts.guard_scan ? 'red' : 'default'}
        />
        <StatCard
          label="Avg Latency"
          value={avgLatency ? `${Math.round(avgLatency.avg)}ms` : '--'}
          color={avgLatency && avgLatency.avg > 5000 ? 'yellow' : 'default'}
        />
      </div>

      {/* Agent status */}
      {(counts.agent_spawn || counts.agent_complete) && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            Agents
          </h3>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Spawned" value={counts.agent_spawn ?? 0} color="green" />
            <StatCard label="Completed" value={counts.agent_complete ?? 0} />
            <StatCard
              label="Errors"
              value={counts.llm_error ?? 0}
              color={counts.llm_error ? 'red' : 'default'}
            />
          </div>
        </div>
      )}

      {/* Event type breakdown */}
      {entries.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            Event Breakdown (current window)
          </h3>
          <div className="space-y-1.5">
            {entries.map(([type, count]) => (
              <div key={type} className="flex items-center gap-2 text-xs">
                <span className="w-36 text-muted-foreground truncate" title={type}>
                  {type}
                </span>
                <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
                  <div
                    className="h-full bg-primary/40 rounded transition-all"
                    style={{ width: `${(count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-12 text-right tabular-nums text-foreground">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Numeric averages */}
      {Object.keys(numerics).length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            Numeric Averages
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {Object.entries(numerics).map(([key, { avg, count }]) => (
              <StatCard
                key={key}
                label={key.replace(/_/g, ' ')}
                value={`${Math.round(avg * 100) / 100} (n=${count})`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Last updated */}
      <div className="text-xs text-muted-foreground text-right">
        Updated {new Date(metrics.receivedAt).toLocaleTimeString()}
      </div>
    </div>
  )
}
