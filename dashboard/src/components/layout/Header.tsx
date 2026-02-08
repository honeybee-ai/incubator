import { Wifi, WifiOff, Loader2 } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { formatUptime } from '@/lib/utils'
import { AgentStatusBar } from '@/components/agents/AgentStatusBar'

export function Header() {
  const wsStatus = useDashboardStore((s) => s.wsStatus)
  const health = useDashboardStore((s) => s.health)

  return (
    <header className="h-12 border-b border-border bg-card flex items-center justify-between px-4 shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm tracking-tight">incubator</span>
          <span className="text-muted-foreground text-xs">dashboard</span>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          {wsStatus === 'connected' && (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-500 pulse-live" />
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-emerald-500">connected</span>
            </>
          )}
          {wsStatus === 'connecting' && (
            <>
              <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />
              <span className="text-amber-500">connecting</span>
            </>
          )}
          {wsStatus === 'disconnected' && (
            <>
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <WifiOff className="w-3.5 h-3.5 text-red-500" />
              <span className="text-red-500">disconnected</span>
            </>
          )}
        </div>

        {health && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>uptime {formatUptime(health.uptime)}</span>
            <span>{health.agents} agent{health.agents !== 1 ? 's' : ''}</span>
            <span>{health.events} events</span>
          </div>
        )}
      </div>

      <AgentStatusBar />
    </header>
  )
}
