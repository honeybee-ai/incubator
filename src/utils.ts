let idCounter = 0;

export function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

export function matchGlob(pattern: string, text: string): boolean {
  // Convert glob pattern to regex
  // Supports * (any chars) and ? (single char)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(text);
}

export function isExpired(timestamp: string, ttlMs?: number): boolean {
  if (!ttlMs) return false;
  const created = new Date(timestamp).getTime();
  return Date.now() > created + ttlMs;
}
