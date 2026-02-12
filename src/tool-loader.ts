/**
 * Dynamic propolis loader.
 * Incubator treats @honeybee-ai/propolis as an optional dependency.
 * When available: full tool suite (filesystem, shell, git, web, PTY).
 * When missing: drones only (ACP + dances).
 */

type PropolisModule = typeof import('@honeybee-ai/propolis');

let propolisModule: PropolisModule | null = null;
let loadAttempted = false;

/**
 * Try to load propolis. Returns true if available.
 * Safe to call multiple times — caches result after first attempt.
 */
export async function loadPropolis(): Promise<boolean> {
  if (loadAttempted) return propolisModule !== null;
  loadAttempted = true;

  try {
    propolisModule = await import('@honeybee-ai/propolis');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the propolis module. Returns null if not installed.
 * Must call loadPropolis() first.
 */
export function getPropolis(): PropolisModule | null {
  return propolisModule;
}

/** Reset loader state (for testing). */
export function _resetPropolisLoader(): void {
  propolisModule = null;
  loadAttempted = false;
}
