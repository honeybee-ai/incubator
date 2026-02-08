import { Database, ChevronRight } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { cn } from '@/lib/utils'

export function Sidebar() {
  const namespaces = useDashboardStore((s) => s.namespaces)
  const active = useDashboardStore((s) => s.activeNamespace)
  const setActive = useDashboardStore((s) => s.setActiveNamespace)
  const stateEntries = useDashboardStore((s) => s.stateEntries)
  const claims = useDashboardStore((s) => s.claims)
  const events = useDashboardStore((s) => s.events)

  return (
    <aside className="w-52 border-r border-border bg-card flex flex-col shrink-0">
      <div className="p-3 border-b border-border">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Namespaces</h2>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {namespaces.length === 0 && (
          <div className="text-xs text-muted-foreground px-2 py-4 text-center">
            No namespaces
          </div>
        )}
        {namespaces.map((ns) => (
          <button
            key={ns.name}
            onClick={() => setActive(ns.name)}
            className={cn(
              'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left transition-colors',
              active === ns.name
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {active === ns.name ? (
              <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Database className="w-3.5 h-3.5 shrink-0 opacity-50" />
            )}
            <span className="truncate font-mono text-xs">{ns.name}</span>
          </button>
        ))}
      </nav>

      <div className="p-3 border-t border-border space-y-1 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>state</span>
          <span className="font-mono">{stateEntries.length}</span>
        </div>
        <div className="flex justify-between">
          <span>claims</span>
          <span className="font-mono">{claims.filter(c => c.status === 'active').length}</span>
        </div>
        <div className="flex justify-between">
          <span>events</span>
          <span className="font-mono">{events.length}</span>
        </div>
      </div>
    </aside>
  )
}
