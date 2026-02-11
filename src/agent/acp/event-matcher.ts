/**
 * Event type matcher with glob pattern support.
 * Returns a function that tests event types against a set of patterns.
 *
 * Supports:
 *   "turn"          — exact match
 *   "turn.*"        — matches "turn.player_2", "turn.seer", etc.
 *   "turn.player_*" — matches "turn.player_2", "turn.player_3"
 *   "*.player_2"    — matches "turn.player_2", "speech.player_2"
 *
 * Globs use `*` to match within a dot-segment (any chars except `.`).
 */
export function createTypeMatcher(types: string[]): (eventType: string) => boolean {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  for (const t of types) {
    if (t.includes('*')) {
      // Escape regex-special chars (except *), replace * with [^.]* (match within segment)
      const escaped = t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
      patterns.push(new RegExp('^' + escaped + '$'));
    } else {
      exact.add(t);
    }
  }

  // Fast path: no globs, pure Set lookup
  if (patterns.length === 0) return (type) => exact.has(type);

  return (type) => exact.has(type) || patterns.some(p => p.test(type));
}
