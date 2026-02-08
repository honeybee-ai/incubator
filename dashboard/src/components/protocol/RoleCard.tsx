import type { ProtocolRole } from '@/lib/types'

interface RoleCardProps {
  name: string
  role: ProtocolRole
}

export function RoleCard({ name, role }: RoleCardProps) {
  return (
    <div className="bg-card rounded-lg border border-border p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-medium text-primary">{name}</span>
        {role.count !== undefined && (
          <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
            x{role.count}
          </span>
        )}
      </div>
      {role.description && (
        <p className="text-xs text-muted-foreground">{role.description}</p>
      )}
      {role.capabilities && role.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {role.capabilities.map((cap) => (
            <span key={cap} className="text-[10px] font-mono bg-primary/15 text-primary px-1.5 py-0.5 rounded">
              {cap}
            </span>
          ))}
        </div>
      )}
      {role.scope && role.scope.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {role.scope.map((s) => (
            <span key={s} className="text-[10px] font-mono bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded">
              {s}
            </span>
          ))}
        </div>
      )}
      {role.can_become && role.can_become.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          can become: {role.can_become.map(r => <span key={r} className="font-mono text-primary ml-1">{r}</span>)}
        </p>
      )}
      <div className="flex gap-2">
        {role.can_request_reinforcement && (
          <span className="text-[10px] text-amber-500">+reinforce</span>
        )}
        {role.can_rollback && (
          <span className="text-[10px] text-red-400">+rollback</span>
        )}
      </div>
    </div>
  )
}
