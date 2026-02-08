import { useMemo, useState } from 'react'
import { Lightbulb, Search } from 'lucide-react'
import { useDashboardStore } from '@/stores/dashboard'
import { DiscoveryCard } from './DiscoveryCard'

export function DiscoveriesPanel() {
  const discoveries = useDashboardStore((s) => s.discoveries)
  const [query, setQuery] = useState('')

  const categories = useMemo(() => {
    const cats = new Set<string>()
    for (const d of discoveries) {
      if (d.category) cats.add(d.category)
    }
    return Array.from(cats).sort()
  }, [discoveries])

  const [filterCat, setFilterCat] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let result = discoveries
    if (filterCat) result = result.filter(d => d.category === filterCat)
    if (query) {
      const q = query.toLowerCase()
      result = result.filter(d =>
        d.topic.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q)
      )
    }
    return result
  }, [discoveries, filterCat, query])

  if (discoveries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Lightbulb className="w-10 h-10 mx-auto opacity-40" />
          <p className="text-sm">No discoveries</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Search + filters */}
      <div className="p-3 space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search discoveries..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-secondary text-sm rounded-md border border-border pl-8 pr-3 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {categories.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
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
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        {filtered.map((d) => (
          <DiscoveryCard key={d.id} discovery={d} />
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No matching discoveries</p>
        )}
      </div>
    </div>
  )
}
