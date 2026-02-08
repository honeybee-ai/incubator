import type { ExitCondition } from '@/lib/types'

interface Props {
  condition: ExitCondition
}

export function ExitConditionBadge({ condition }: Props) {
  if ('state_key' in condition) {
    return <span className="font-mono">state[{condition.state_key}] == {JSON.stringify(condition.equals)}</span>
  }
  if ('event' in condition) {
    return <span className="font-mono">event:{condition.event}</span>
  }
  if ('any_of' in condition) {
    return (
      <span>
        any_of({condition.any_of.map((c, i) => (
          <span key={i}>{i > 0 && ', '}<ExitConditionBadge condition={c} /></span>
        ))})
      </span>
    )
  }
  if ('all_of' in condition) {
    return (
      <span>
        all_of({condition.all_of.map((c, i) => (
          <span key={i}>{i > 0 && ', '}<ExitConditionBadge condition={c} /></span>
        ))})
      </span>
    )
  }
  return null
}
