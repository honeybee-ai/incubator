import type { Discovery } from '@/lib/types'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { timeAgo } from '@/lib/utils'

interface DiscoveryCardProps {
  discovery: Discovery
}

export function DiscoveryCard({ discovery }: DiscoveryCardProps) {
  return (
    <div className="bg-card rounded-lg border border-border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{discovery.topic}</span>
        {discovery.category && (
          <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
            {discovery.category}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{discovery.content}</p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AgentBadge agentId={discovery.publishedBy} />
        <span>{timeAgo(discovery.publishedAt)}</span>
      </div>
    </div>
  )
}
