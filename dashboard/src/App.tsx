import { FileCode, Database, Lock, Lightbulb, Users, Shield, BarChart3 } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { useWebSocket } from '@/hooks/useWebSocket'
import { usePolling } from '@/hooks/usePolling'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'
import { ProtocolViewer } from '@/components/protocol/ProtocolViewer'
import { StateMonitor } from '@/components/state/StateMonitor'
import { ClaimsPanel } from '@/components/claims/ClaimsPanel'
import { DiscoveriesPanel } from '@/components/discoveries/DiscoveriesPanel'
import { TeamRoster } from '@/components/team/TeamRoster'
import { GovernancePanel } from '@/components/governance/GovernancePanel'
import { MetricsPanel } from '@/components/metrics/MetricsPanel'
import { ActivityFeed } from '@/components/events/ActivityFeed'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'protocol', label: 'Protocol', icon: FileCode },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'state', label: 'State', icon: Database },
  { id: 'claims', label: 'Claims', icon: Lock },
  { id: 'discoveries', label: 'Discoveries', icon: Lightbulb },
  { id: 'governance', label: 'Governance', icon: Shield },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
] as const

export function App() {
  useWebSocket()
  usePolling()

  const activeTab = useDashboardStore((s) => s.activeTab)
  const setActiveTab = useDashboardStore((s) => s.setActiveTab)

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Header />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar />

        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Tabs */}
          <div className="h-10 border-b border-border flex items-center px-2 gap-1 shrink-0">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                  activeTab === id
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex-1 overflow-hidden">
              {activeTab === 'protocol' && <ProtocolViewer />}
              {activeTab === 'team' && <TeamRoster />}
              {activeTab === 'state' && <StateMonitor />}
              {activeTab === 'claims' && <ClaimsPanel />}
              {activeTab === 'discoveries' && <DiscoveriesPanel />}
              {activeTab === 'governance' && <GovernancePanel />}
              {activeTab === 'metrics' && <MetricsPanel />}
            </div>

            <ActivityFeed />
          </div>
        </main>
      </div>
    </div>
  )
}
