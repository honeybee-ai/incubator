import { useRef, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronUp, ArrowDownToLine } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { EventCard } from './EventCard'
import { EventFilters } from './EventFilters'

export function ActivityFeed() {
  const events = useDashboardStore((s) => s.events)
  const eventTypeFilter = useDashboardStore((s) => s.eventTypeFilter)
  const autoScroll = useDashboardStore((s) => s.autoScroll)
  const toggleAutoScroll = useDashboardStore((s) => s.toggleAutoScroll)
  const isOpen = useDashboardStore((s) => s.activityFeedOpen)
  const toggleOpen = useDashboardStore((s) => s.toggleActivityFeed)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (eventTypeFilter.size === 0) return events
    return events.filter(e => eventTypeFilter.has(e.type))
  }, [events, eventTypeFilter])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filtered, autoScroll])

  // Unique event types for filters
  const eventTypes = useMemo(() => {
    const types = new Set<string>()
    for (const e of events) types.add(e.type)
    return Array.from(types).sort()
  }, [events])

  return (
    <div className={`border-t border-border bg-card flex flex-col transition-all ${isOpen ? 'h-64' : 'h-9'}`}>
      {/* Header */}
      <button
        onClick={toggleOpen}
        className="h-9 shrink-0 flex items-center justify-between px-3 hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-xs">
          {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          <span className="font-medium">Activity Feed</span>
          <span className="text-muted-foreground">({filtered.length} events)</span>
        </div>
        {isOpen && (
          <div
            className="flex items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <EventFilters types={eventTypes} />
            <button
              onClick={toggleAutoScroll}
              className={`p-1 rounded transition-colors ${autoScroll ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
              title={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
            >
              <ArrowDownToLine className={`w-3.5 h-3.5 ${autoScroll ? 'scroll-indicator' : ''}`} />
            </button>
          </div>
        )}
      </button>

      {/* Events list */}
      {isOpen && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 pb-2 space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No events yet</p>
          )}
          {filtered.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
