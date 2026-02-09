import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { Snapshot } from './types.js';
import type { Stores } from './stores/interfaces.js';
import type { NamespaceRegistry } from './namespaces.js';

export async function saveSnapshot(path: string, stores: Stores): Promise<void> {
  const snapshot: Snapshot = {
    state: await stores.state.getAll(),
    claims: await stores.claims.getAll(),
    events: await stores.events.getAll(),
    discoveries: await stores.discoveries.getAll(),
    eventCursor: await stores.events.getCursor(),
    savedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
}

export async function loadSnapshot(
  path: string,
  stores: Stores,
  sanitize?: (snapshot: Snapshot) => void,
): Promise<boolean> {
  try {
    const raw = readFileSync(path, 'utf-8');
    const snapshot: Snapshot = JSON.parse(raw);

    if (sanitize) sanitize(snapshot);

    // Load events first since other stores may reference the event store
    await stores.events.load(snapshot.events, snapshot.eventCursor);
    await stores.state.load(snapshot.state);
    await stores.claims.load(snapshot.claims);
    await stores.discoveries.load(snapshot.discoveries);

    return true;
  } catch {
    return false;
  }
}

export async function saveAllSnapshots(basePath: string, registry: NamespaceRegistry): Promise<void> {
  for (const ns of registry.list()) {
    const filePath = `${basePath}.${ns}.json`;
    await saveSnapshot(filePath, registry.get(ns));
  }
}

export async function loadAllSnapshots(
  basePath: string,
  registry: NamespaceRegistry,
  sanitize?: (snapshot: Snapshot) => void,
): Promise<number> {
  const dir = dirname(basePath);
  const prefix = basename(basePath) + '.';
  const suffix = '.json';
  let count = 0;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
      const ns = file.slice(prefix.length, -suffix.length);
      if (!ns) continue;

      const stores = registry.get(ns);
      const loaded = await loadSnapshot(join(dir, file), stores, sanitize);
      if (loaded) count++;
    }
  } catch {
    // directory doesn't exist yet — no snapshots to load
  }

  return count;
}
