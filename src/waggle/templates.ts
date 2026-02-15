/**
 * Template resolution for waggle compound operations.
 *
 * `$last` refers to the previous operation's result in a sequential batch.
 * `$last.foo.bar` navigates nested object paths.
 *
 * Examples:
 *   { do: 'get_state', key: 'research.files' }         → returns files array
 *   { do: 'write_file', path: '/tmp/f.json', content: '$last' }  → writes previous result
 *   { do: 'set_state', key: 'echo', value: '$last.status' }      → writes nested field
 */

/**
 * Resolve `$last` templates in an operation's args object.
 * Recursively walks objects and arrays; only resolves string values starting with `$last`.
 */
export function resolveTemplates(
  args: Record<string, unknown>,
  lastResult: unknown,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = resolveValue(value, lastResult);
  }
  return resolved;
}

function resolveValue(value: unknown, lastResult: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('$last')) {
    return resolveLastPath(value, lastResult);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return resolveTemplates(value as Record<string, unknown>, lastResult);
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveValue(v, lastResult));
  }
  return value;
}

function resolveLastPath(template: string, lastResult: unknown): unknown {
  if (template === '$last') return lastResult;

  const path = template.slice(6); // Remove '$last.'
  const parts = path.split('.');
  let current: unknown = lastResult;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
