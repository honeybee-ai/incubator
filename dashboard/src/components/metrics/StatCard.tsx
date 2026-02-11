import { cn } from '@/lib/utils'

interface StatCardProps {
  label: string
  value: string | number
  color?: 'default' | 'red' | 'green' | 'yellow'
}

export function StatCard({ label, value, color = 'default' }: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums',
          color === 'red' && 'text-red-500',
          color === 'green' && 'text-green-500',
          color === 'yellow' && 'text-yellow-500',
          color === 'default' && 'text-foreground',
        )}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
