import { agentColor, agentLabel } from '@/lib/utils'

interface AgentBadgeProps {
  agentId: string
  size?: 'sm' | 'md'
}

export function AgentBadge({ agentId, size = 'sm' }: AgentBadgeProps) {
  const color = agentColor(agentId)
  const label = agentLabel(agentId)
  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'

  return (
    <span
      className={`inline-flex items-center rounded-full font-mono font-medium ${sizeClasses}`}
      style={{ backgroundColor: color, color: 'oklch(0.12 0 0)' }}
      title={agentId}
    >
      {label}
    </span>
  )
}
