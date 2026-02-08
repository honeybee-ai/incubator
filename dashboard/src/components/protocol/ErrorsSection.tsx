import type { ProtocolErrors } from '@/lib/types'

interface Props {
  errors: ProtocolErrors
}

export function ErrorsSection({ errors }: Props) {
  const entries = Object.entries(errors).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return null

  return (
    <div className="space-y-1">
      {entries.map(([key, def]) => (
        <div key={key} className="bg-card rounded-lg border border-border px-3 py-2 flex items-center gap-2 text-xs">
          <span className="font-mono text-amber-400">{key}</span>
          <span className="text-muted-foreground">→</span>
          <span className="font-mono">{def!.action}</span>
          {def!.retry_after_ms && <span className="text-muted-foreground">({def!.retry_after_ms}ms)</span>}
        </div>
      ))}
    </div>
  )
}
