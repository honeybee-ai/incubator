import { FileCode, Users, Layers, Package, Tag, AlertTriangle, Shield } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { RoleCard } from './RoleCard'
import { PhaseCard } from './PhaseCard'
import { ResourceSection } from './ResourceSection'
import { GovernanceSection } from './GovernanceSection'
import { ErrorsSection } from './ErrorsSection'

export function ProtocolViewer() {
  const protocol = useDashboardStore((s) => s.protocol)
  const stateEntries = useDashboardStore((s) => s.stateEntries)

  if (!protocol) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <FileCode className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No protocol loaded</p>
          <p className="text-xs">Start the server with --protocol to load a spec</p>
        </div>
      </div>
    )
  }

  const currentPhase = stateEntries.find(e => e.key === 'phase')?.value as string | undefined

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">{protocol.title}</h2>
        <p className="text-xs text-muted-foreground font-mono">{protocol.name} (ACP {protocol.acp})</p>
        {protocol.description && (
          <p className="text-sm text-muted-foreground mt-1">{protocol.description}</p>
        )}
        {protocol.tags && protocol.tags.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2">
            <Tag className="w-3 h-3 text-muted-foreground" />
            {protocol.tags.map((tag) => (
              <span key={tag} className="text-[10px] font-mono bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Roles */}
      {protocol.roles && Object.keys(protocol.roles).length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Roles
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {Object.entries(protocol.roles).map(([name, role]) => (
              <RoleCard key={name} name={name} role={role} />
            ))}
          </div>
        </section>
      )}

      {/* Phases */}
      {protocol.phases && Object.keys(protocol.phases).length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" /> Phases
          </h3>
          <div className="space-y-2">
            {Object.entries(protocol.phases).map(([name, phase]) => (
              <PhaseCard key={name} name={name} phase={phase} isCurrent={currentPhase === name} />
            ))}
          </div>
        </section>
      )}

      {/* Resources */}
      {protocol.resources && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Package className="w-3.5 h-3.5" /> Resources
          </h3>
          <ResourceSection resources={protocol.resources} />
        </section>
      )}

      {/* Errors */}
      {protocol.errors && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Error Handling
          </h3>
          <ErrorsSection errors={protocol.errors} />
        </section>
      )}

      {/* Governance */}
      {protocol.governance && (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" /> Governance
          </h3>
          <GovernanceSection governance={protocol.governance} />
        </section>
      )}
    </div>
  )
}
