import type { ProtocolResources } from '@/lib/types'

interface ResourceSectionProps {
  resources: ProtocolResources
}

export function ResourceSection({ resources }: ResourceSectionProps) {
  const hasAny = resources.claim_patterns || resources.discovery_topics ||
    resources.event_types || resources.state_keys || resources.instances

  if (!hasAny) return null

  return (
    <div className="space-y-3">
      {resources.claim_patterns && Object.keys(resources.claim_patterns).length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Claim Patterns</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(resources.claim_patterns).map(([name, def]) => (
              <span key={name} className="text-xs font-mono bg-card border border-border rounded px-2 py-0.5">
                <span className="text-primary">{name}</span>
                <span className="text-muted-foreground ml-1">{typeof def === 'string' ? def : def.pattern ?? ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {resources.discovery_topics && Object.keys(resources.discovery_topics).length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Discovery Topics</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(resources.discovery_topics).map(([name, def]) => (
              <span key={name} className="text-xs font-mono bg-card border border-border rounded px-2 py-0.5">
                <span className="text-primary">{name}</span>
                <span className="text-muted-foreground ml-1">{def.pattern}</span>
                {def.category && <span className="text-purple-400 ml-1">[{def.category}]</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {resources.event_types && Object.keys(resources.event_types).length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Event Types</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(resources.event_types).map(([name, def]) => (
              <span key={name} className="text-xs font-mono bg-card border border-border rounded px-2 py-0.5">
                <span className="text-primary">{name}</span>
                <span className="text-muted-foreground ml-1">{def.type}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {resources.state_keys && Object.keys(resources.state_keys).length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-muted-foreground uppercase mb-1">State Keys</h4>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(resources.state_keys).map(([name, def]) => (
              <span key={name} className="text-xs font-mono bg-card border border-border rounded px-2 py-0.5">
                <span className="text-primary">{name}</span>
                <span className="text-muted-foreground ml-1">{def.key}</span>
                {def.type && <span className="text-amber-400 ml-1">:{def.type}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {resources.instances && resources.instances.length > 0 && (
        <div>
          <h4 className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Instances ({resources.instances.length})</h4>
          <div className="flex flex-wrap gap-1.5">
            {resources.instances.map((inst) => (
              <span key={inst} className="text-xs font-mono bg-card border border-border rounded px-2 py-0.5 text-muted-foreground">
                {inst}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
