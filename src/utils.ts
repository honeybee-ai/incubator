let idCounter = 0;

export function generateId(): string {
  return `${Date.now()}-${++idCounter}`;
}

export function matchGlob(pattern: string, text: string): boolean {
  // Linear-time wildcard matching (no regex, no backtracking)
  let pi = 0, ti = 0;
  let starP = -1, starT = -1;
  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
      pi++; ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starP = pi++; starT = ti;
    } else if (starP >= 0) {
      pi = starP + 1; ti = ++starT;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

export function isExpired(timestamp: string, ttlMs?: number): boolean {
  if (!ttlMs) return false;
  const created = new Date(timestamp).getTime();
  return Date.now() > created + ttlMs;
}
