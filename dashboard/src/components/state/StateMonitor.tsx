import { useMemo, useRef, useEffect, useState } from 'react'
import { Database } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { AgentBadge } from '@/components/agents/AgentBadge'
import { formatTime } from '@/lib/utils'

export function StateMonitor() {
  const stateEntries = useDashboardStore((s) => s.stateEntries)
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set())
  const prevRef = useRef<Map<string, string>>(new Map())

  // Detect changes for flash
  useEffect(() => {
    const prev = prevRef.current
    const changed = new Set<string>()
    for (const entry of stateEntries) {
      const prevUpdated = prev.get(entry.key)
      if (prevUpdated !== entry.updatedAt) {
        changed.add(entry.key)
      }
    }
    if (changed.size > 0 && prev.size > 0) {
      setFlashKeys(changed)
      const timer = setTimeout(() => setFlashKeys(new Set()), 1500)
      return () => clearTimeout(timer)
    }
    // Update prev
    const next = new Map<string, string>()
    for (const entry of stateEntries) {
      next.set(entry.key, entry.updatedAt)
    }
    prevRef.current = next
  }, [stateEntries])

  // Update prev map every render
  useEffect(() => {
    const next = new Map<string, string>()
    for (const entry of stateEntries) {
      next.set(entry.key, entry.updatedAt)
    }
    prevRef.current = next
  }, [stateEntries])

  const categories = useMemo(() => {
    const cats = new Set<string>()
    for (const e of stateEntries) {
      if (e.category) cats.add(e.category)
    }
    return Array.from(cats).sort()
  }, [stateEntries])

  const [filterCat, setFilterCat] = useState<string | null>(null)

  const filtered = filterCat
    ? stateEntries.filter(e => e.category === filterCat)
    : stateEntries

  if (stateEntries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Database className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No state entries</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Category filter chips */}
      {categories.length > 0 && (
        <div className="flex items-center gap-1.5 p-3 pb-0 flex-wrap">
          <button
            onClick={() => setFilterCat(null)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
              filterCat === null ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            all
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilterCat(filterCat === cat ? null : cat)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                filterCat === cat ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto p-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground uppercase tracking-wider">
              <th className="text-left py-1.5 px-2 font-medium">Key</th>
              <th className="text-left py-1.5 px-2 font-medium">Value</th>
              <th className="text-left py-1.5 px-2 font-medium">Category</th>
              <th className="text-left py-1.5 px-2 font-medium">Set By</th>
              <th className="text-left py-1.5 px-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr
                key={entry.key}
                className={`border-t border-border/50 ${flashKeys.has(entry.key) ? 'flash-update' : ''}`}
              >
                <td className="py-1.5 px-2 font-mono text-xs text-primary">{entry.key}</td>
                <td className="py-1.5 px-2 font-mono text-xs max-w-[300px] truncate">
                  {typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)}
                </td>
                <td className="py-1.5 px-2 text-xs text-muted-foreground">{entry.category ?? '-'}</td>
                <td className="py-1.5 px-2"><AgentBadge agentId={entry.setBy} /></td>
                <td className="py-1.5 px-2 text-xs text-muted-foreground font-mono">{formatTime(entry.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
