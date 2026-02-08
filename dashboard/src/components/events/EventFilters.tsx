import { useDashboardStore } from '@/stores/dashboard'

interface EventFiltersProps {
  types: string[]
}

export function EventFilters({ types }: EventFiltersProps) {
  const filter = useDashboardStore((s) => s.eventTypeFilter)
  const toggle = useDashboardStore((s) => s.toggleEventTypeFilter)
  const clear = useDashboardStore((s) => s.clearEventTypeFilters)

  if (types.length === 0) return null

  return (
    <div className="flex items-center gap-1">
      {filter.size > 0 && (
        <button
          onClick={clear}
          className="text-[10px] text-muted-foreground hover:text-foreground px-1"
        >
          clear
        </button>
      )}
      {types.map((type) => (
        <button
          key={type}
          onClick={() => toggle(type)}
          className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
            filter.has(type)
              ? 'border-primary text-primary bg-primary/10'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {type.split('.').pop()}
        </button>
      ))}
    </div>
  )
}
