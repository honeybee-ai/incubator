import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stores } from './stores/interfaces.js';
import type { NamespaceRegistry } from './namespaces.js';
import { CarapaceBlockedError } from './guard.js';
import { parseSpec, SpecValidationError } from '@agentcoordinationprotocol/spec';

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, stores: Stores, match: RegExpMatchArray, body: Record<string, unknown>) => Promise<void>;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Id, X-Namespace',
  });
  res.end(JSON.stringify(data));
}

function getAgentId(req: IncomingMessage, body: Record<string, unknown>): string {
  return (body.agentId as string) ?? (req.headers['x-agent-id'] as string) ?? 'rest_anonymous';
}

async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.method === 'GET') return {};
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
  });
}

// Resource keywords that indicate the default namespace (no namespace prefix in URL)
const RESOURCE_KEYWORDS = new Set([
  'state', 'claims', 'events', 'discoveries', 'health', 'protocol',
  'messages', 'help', 'progress', 'conflicts', 'roles', 'reinforcements', 'governance',
  'control',
]);

const routes: Route[] = [
  // ─── Health ──────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async (_req, res, stores) => {
      const claims = await stores.claims.list();
      const events = await stores.events.getEvents();
      const state = await stores.state.query();
      json(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        agents: new Set([
          ...state.map(e => e.setBy),
          ...claims.map(c => c.owner),
          ...events.events.map(e => e.publishedBy),
        ]).size,
        claims: claims.length,
        events: events.cursor,
      });
    },
  },

  // ─── State ───────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/api\/state$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const pattern = url.searchParams.get('pattern') ?? undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const entries = await stores.state.query(pattern, category);
      json(res, 200, { count: entries.length, entries });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/state\/(.+)$/,
    handler: async (_req, res, stores, match) => {
      const key = decodeURIComponent(match[1]);
      const entry = await stores.state.get(key);
      if (!entry) {
        json(res, 200, { found: false, key });
        return;
      }
      json(res, 200, { found: true, entry });
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/state\/(.+)$/,
    handler: async (req, res, stores, match, body) => {
      const key = decodeURIComponent(match[1]);
      if (!('value' in body)) {
        json(res, 400, { error: 'Missing required field: value' });
        return;
      }
      const agentId = getAgentId(req, body);
      const entry = await stores.state.set(key, body.value, agentId, body.category as string | undefined, body.ttlMs as number | undefined);
      json(res, 200, { success: true, entry });
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/state\/(.+)$/,
    handler: async (_req, res, stores, match) => {
      const key = decodeURIComponent(match[1]);
      const deleted = await stores.state.delete(key);
      json(res, 200, { deleted });
    },
  },

  // ─── Claims ──────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/claims$/,
    handler: async (req, res, stores, _match, body) => {
      const resource = body.resource as string;
      const value = body.value as string;
      if (!resource || !value) {
        json(res, 400, { error: 'Missing required fields: resource, value' });
        return;
      }
      const agentId = getAgentId(req, body);
      const result = await stores.claims.claim(resource, value, agentId, body.ttlMs as number | undefined);
      json(res, 200, result);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/claims\/(.+)$/,
    handler: async (req, res, stores, match, body) => {
      const resource = decodeURIComponent(match[1]);
      const agentId = getAgentId(req, body);
      const claim = await stores.claims.release(resource, agentId);
      if (!claim) {
        json(res, 200, { released: false, reason: 'No active claim found or not owner' });
        return;
      }
      json(res, 200, { released: true, claim });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/claims\/(.+)$/,
    handler: async (_req, res, stores, match) => {
      const resource = decodeURIComponent(match[1]);
      const claim = await stores.claims.check(resource);
      if (!claim) {
        json(res, 200, { claimed: false, resource });
        return;
      }
      json(res, 200, { claimed: claim.status === 'active', claim });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/claims$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const pattern = url.searchParams.get('pattern') ?? undefined;
      const claims = await stores.claims.list(pattern);
      json(res, 200, { count: claims.length, claims });
    },
  },

  // ─── Events ──────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/events$/,
    handler: async (req, res, stores, _match, body) => {
      const type = body.type as string;
      if (!type) {
        json(res, 400, { error: 'Missing required field: type' });
        return;
      }
      const agentId = getAgentId(req, body);
      const event = await stores.events.publish(type, body.data ?? null, agentId);
      json(res, 200, { published: true, event });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/events$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const since = url.searchParams.get('since');
      const type = url.searchParams.get('type') ?? undefined;
      const result = await stores.events.getEvents(since ? parseInt(since, 10) : undefined, type);
      json(res, 200, result);
    },
  },

  // ─── Discoveries ─────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/discoveries$/,
    handler: async (req, res, stores, _match, body) => {
      const topic = body.topic as string;
      const content = body.content as string;
      if (!topic || !content) {
        json(res, 400, { error: 'Missing required fields: topic, content' });
        return;
      }
      const agentId = getAgentId(req, body);
      const discovery = await stores.discoveries.publish(topic, content, agentId, body.category as string | undefined);
      json(res, 200, { published: true, discovery });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/discoveries$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const query = url.searchParams.get('query') ?? undefined;
      const category = url.searchParams.get('category') ?? undefined;
      const results = await stores.discoveries.search(query, category);
      json(res, 200, { count: results.length, discoveries: results });
    },
  },

  // ─── Messages ─────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/messages$/,
    handler: async (req, res, stores, _match, body) => {
      const to = body.to as string;
      const content = body.content as string;
      if (!to || !content) {
        json(res, 400, { error: 'Missing required fields: to, content' });
        return;
      }
      const agentId = getAgentId(req, body);
      const msg = await stores.messages.send(agentId, to, content, body.replyTo as string | undefined);
      json(res, 200, { sent: true, message: msg });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/messages$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const agentId = req.headers['x-agent-id'] as string ?? 'rest_anonymous';
      const since = url.searchParams.get('since') ?? undefined;
      const messages = await stores.messages.getFor(agentId, since);
      json(res, 200, { count: messages.length, messages });
    },
  },

  // ─── Roles ────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/roles\/request$/,
    handler: async (req, res, stores, _match, body) => {
      const role = body.role as string;
      if (!role) {
        json(res, 400, { error: 'Missing required field: role' });
        return;
      }
      const agentId = getAgentId(req, body);
      const current = await stores.roles.getByAgent(agentId);
      const fromRole = current?.role;

      // Server-side: assign the new role (protocol validation happens at a higher layer)
      await stores.roles.assign(agentId, role);
      await stores.events.publish('role.transition', { agent: agentId, from: fromRole ?? null, to: role, reason: body.reason ?? null }, agentId);
      json(res, 200, { approved: true, from: fromRole ?? null, to: role });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/roles$/,
    handler: async (_req, res, stores) => {
      const assignments = await stores.roles.getAssignments();
      json(res, 200, { count: assignments.length, assignments });
    },
  },

  // ─── Help ─────────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/help$/,
    handler: async (req, res, stores, _match, body) => {
      const problem = body.problem as string;
      if (!problem) {
        json(res, 400, { error: 'Missing required field: problem' });
        return;
      }
      const agentId = getAgentId(req, body);
      const request = await stores.help.request(agentId, problem, body.needs_capability as string | undefined, body.urgency as 'low' | 'normal' | 'high' | undefined);
      json(res, 200, { created: true, request });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/help\/([^/]+)\/claim$/,
    handler: async (req, res, stores, match, body) => {
      const requestId = decodeURIComponent(match[1]);
      const agentId = getAgentId(req, body);
      const request = await stores.help.claim(requestId, agentId);
      if (!request) {
        json(res, 200, { claimed: false, reason: 'Request not found or not open' });
        return;
      }
      json(res, 200, { claimed: true, request });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/help\/([^/]+)\/resolve$/,
    handler: async (req, res, stores, match, body) => {
      const requestId = decodeURIComponent(match[1]);
      const agentId = getAgentId(req, body);
      const request = await stores.help.resolve(requestId, agentId);
      if (!request) {
        json(res, 200, { resolved: false, reason: 'Request not found or not claimed' });
        return;
      }
      json(res, 200, { resolved: true, request });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/help$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const status = url.searchParams.get('status') ?? undefined;
      const requests = await stores.help.list(status);
      json(res, 200, { count: requests.length, requests });
    },
  },

  // ─── Progress ─────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/progress$/,
    handler: async (req, res, stores, _match, body) => {
      const claim = body.claim as string;
      const progress = body.progress as number;
      if (!claim || progress === undefined) {
        json(res, 400, { error: 'Missing required fields: claim, progress' });
        return;
      }
      const agentId = getAgentId(req, body);
      const report = await stores.progress.report(claim, agentId, progress, body.note as string | undefined);
      json(res, 200, { reported: true, report });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/progress\/(.+)$/,
    handler: async (_req, res, stores, match) => {
      const claim = decodeURIComponent(match[1]);
      const report = await stores.progress.get(claim);
      if (!report) {
        json(res, 200, { found: false, claim });
        return;
      }
      json(res, 200, { found: true, report });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/progress$/,
    handler: async (_req, res, stores) => {
      const reports = await stores.progress.list();
      json(res, 200, { count: reports.length, reports });
    },
  },

  // ─── Conflicts ────────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/conflicts$/,
    handler: async (req, res, stores, _match, body) => {
      const discovery_a = body.discovery_a as string;
      const discovery_b = body.discovery_b as string;
      const reason = body.reason as string;
      if (!discovery_a || !discovery_b || !reason) {
        json(res, 400, { error: 'Missing required fields: discovery_a, discovery_b, reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      const conflict = await stores.conflicts.flag(agentId, discovery_a, discovery_b, reason);
      json(res, 200, { flagged: true, conflict });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/conflicts\/([^/]+)\/resolve$/,
    handler: async (req, res, stores, match, body) => {
      const conflictId = decodeURIComponent(match[1]);
      const resolution = body.resolution as string;
      if (!resolution) {
        json(res, 400, { error: 'Missing required field: resolution' });
        return;
      }
      const agentId = getAgentId(req, body);
      const conflict = await stores.conflicts.resolve(conflictId, agentId, resolution);
      if (!conflict) {
        json(res, 200, { resolved: false, reason: 'Conflict not found or not open' });
        return;
      }
      json(res, 200, { resolved: true, conflict });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/conflicts$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const status = url.searchParams.get('status') ?? undefined;
      const conflicts = await stores.conflicts.list(status);
      json(res, 200, { count: conflicts.length, conflicts });
    },
  },

  // ─── Reinforcements ──────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/reinforcements$/,
    handler: async (req, res, stores, _match, body) => {
      const role = body.role as string;
      if (!role) {
        json(res, 400, { error: 'Missing required field: role' });
        return;
      }
      const agentId = getAgentId(req, body);
      const count = (body.count as number) ?? 1;
      const request = await stores.reinforcements.request(agentId, role, count, body.reason as string | undefined);
      json(res, 200, { requested: true, request });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reinforcements$/,
    handler: async (_req, res, stores) => {
      const requests = await stores.reinforcements.list();
      json(res, 200, { count: requests.length, requests });
    },
  },

  // ─── Governance ───────────────────────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/governance\/approve$/,
    handler: async (req, res, stores, _match, body) => {
      const action = body.action as string;
      if (!action) {
        json(res, 400, { error: 'Missing required field: action' });
        return;
      }
      const agentId = getAgentId(req, body);
      await stores.events.publish('governance.approval_requested', { action, detail: body.detail, files: body.files, requested_by: agentId }, agentId);
      json(res, 200, { requested: true, action });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/governance\/escalate$/,
    handler: async (req, res, stores, _match, body) => {
      const reason = body.reason as string;
      if (!reason) {
        json(res, 400, { error: 'Missing required field: reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      await stores.events.publish('governance.escalated', { reason, context: body.context, escalated_by: agentId }, agentId);
      json(res, 200, { escalated: true, reason });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/governance\/propose$/,
    handler: async (req, res, stores, _match, body) => {
      const action = body.action as string;
      if (!action) {
        json(res, 400, { error: 'Missing required field: action' });
        return;
      }
      const agentId = getAgentId(req, body);
      const proposal = await stores.proposals.propose(agentId, action, body.detail as string | undefined, body.requires_quorum as number | undefined);
      json(res, 200, { proposed: true, proposal });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/governance\/endorse\/([^/]+)$/,
    handler: async (req, res, stores, match, body) => {
      const proposalId = decodeURIComponent(match[1]);
      const agentId = getAgentId(req, body);
      const proposal = await stores.proposals.endorse(proposalId, agentId);
      if (!proposal) {
        json(res, 200, { endorsed: false, reason: 'Proposal not found or not open' });
        return;
      }
      json(res, 200, { endorsed: true, proposal });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/governance\/proposals$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, `http://localhost`);
      const status = url.searchParams.get('status') ?? undefined;
      const proposals = await stores.proposals.list(status);
      json(res, 200, { count: proposals.length, proposals });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/governance\/rollback$/,
    handler: async (req, res, stores, _match, body) => {
      const reason = body.reason as string;
      if (!reason) {
        json(res, 400, { error: 'Missing required field: reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      await stores.events.publish('governance.rollback.requested', { reason, scope: body.scope, requested_by: agentId }, agentId);
      json(res, 200, { requested: true, reason });
    },
  },

  // ─── Control (halt/pause/resume) ──────────────────────────
  {
    method: 'POST',
    pattern: /^\/api\/control\/halt$/,
    handler: async (req, res, stores, _match, body) => {
      const reason = body.reason as string;
      if (!reason) {
        json(res, 400, { error: 'Missing required field: reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      const status = (body.status as 'completed' | 'failed') ?? 'completed';
      const target = body.target as string | undefined;

      // Per-agent halt: auto-release claims and remove role
      if (target) {
        const claims = await stores.claims.list();
        for (const claim of claims) {
          if (claim.owner === target && claim.status === 'active') {
            await stores.claims.release(claim.resource, target);
          }
        }
        await stores.roles.remove(target);
      }

      const info = await stores.control.halt(reason, agentId, status, target);
      json(res, 200, { halted: true, info });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/control\/pause$/,
    handler: async (req, res, stores, _match, body) => {
      const reason = body.reason as string;
      if (!reason) {
        json(res, 400, { error: 'Missing required field: reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      const target = body.target as string | undefined;
      const info = await stores.control.pause(reason, agentId, target);
      json(res, 200, { paused: true, info });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/control\/resume$/,
    handler: async (req, res, stores, _match, body) => {
      const reason = body.reason as string;
      if (!reason) {
        json(res, 400, { error: 'Missing required field: reason' });
        return;
      }
      const agentId = getAgentId(req, body);
      const target = body.target as string | undefined;
      const resumed = await stores.control.resume(agentId, reason, target);
      json(res, 200, { resumed });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/control\/status$/,
    handler: async (req, res, stores) => {
      const url = new URL(req.url!, 'http://localhost');
      const agentId = url.searchParams.get('agentId') ?? undefined;
      const status = stores.control.getStatus(agentId);
      json(res, 200, status);
    },
  },
];

/**
 * Extract namespace and rewritten path from a URL pathname.
 *
 * /api/_ns          → admin route (returns null namespace)
 * /api/_ns/:name    → admin route (returns null namespace)
 * /api/state/...    → default namespace, path unchanged
 * /api/team-a/state/... → namespace "team-a", path rewritten to /api/state/...
 */
function extractNamespace(pathname: string): { namespace: string | null; rewrittenPath: string } {
  // Strip /api/ prefix to inspect segments
  const afterApi = pathname.slice(5); // after "/api/"
  const slashIdx = afterApi.indexOf('/');
  const firstSegment = slashIdx === -1 ? afterApi : afterApi.slice(0, slashIdx);

  // Admin routes — no namespace
  if (firstSegment === '_ns') {
    return { namespace: null, rewrittenPath: pathname };
  }

  // Known resource keyword → default namespace, path unchanged
  if (RESOURCE_KEYWORDS.has(firstSegment)) {
    return { namespace: 'default', rewrittenPath: pathname };
  }

  // Otherwise, first segment is the namespace — strip it and rewrite
  const rest = slashIdx === -1 ? '' : afterApi.slice(slashIdx);
  return { namespace: firstSegment, rewrittenPath: `/api${rest}` };
}

export async function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: NamespaceRegistry,
  verbose: boolean
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!url.startsWith('/api/')) return false;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    json(res, 204, '');
    return true;
  }

  const body = await parseBody(req);
  const pathname = new URL(url, 'http://localhost').pathname;

  // ─── Admin routes ─────────────────────────────────────────
  if (pathname === '/api/_ns' && req.method === 'GET') {
    const namespaces = [];
    for (const name of registry.list()) {
      const stores = registry.get(name);
      const state = await stores.state.query();
      const claims = await stores.claims.list();
      const events = await stores.events.getEvents();
      const discoveries = await stores.discoveries.search();
      namespaces.push({
        name,
        state: state.length,
        claims: claims.length,
        events: events.cursor,
        discoveries: discoveries.length,
      });
    }
    json(res, 200, { namespaces });
    return true;
  }

  const nsDeleteMatch = pathname.match(/^\/api\/_ns\/(.+)$/);
  if (nsDeleteMatch && req.method === 'DELETE') {
    const name = decodeURIComponent(nsDeleteMatch[1]);
    const deleted = registry.delete(name);
    json(res, 200, { deleted });
    return true;
  }

  // ─── Namespace extraction ─────────────────────────────────
  const { namespace, rewrittenPath } = extractNamespace(pathname);

  if (namespace === null) {
    json(res, 404, { error: `No route: ${req.method} ${pathname}` });
    return true;
  }

  let stores: Stores;
  try {
    stores = registry.get(namespace);
  } catch (err) {
    json(res, 400, { error: (err as Error).message });
    return true;
  }

  // ─── Protocol routes ──────────────────────────────────────
  if (rewrittenPath === '/api/protocol') {
    if (req.method === 'GET') {
      const spec = registry.getProtocol(namespace);
      if (!spec) {
        json(res, 200, { loaded: false });
      } else {
        // Include team assignments if available
        const teamAssignments = await stores.roles.getAssignments();
        json(res, 200, {
          loaded: true,
          spec,
          ...(teamAssignments.length > 0 ? { team: teamAssignments } : {}),
        });
      }
      return true;
    }
    if (req.method === 'PUT') {
      try {
        // Body can be raw YAML/JSON string in "spec" field, or the spec object directly
        let spec;
        if (typeof body.spec === 'string') {
          spec = await parseSpec(body.spec);
        } else if (body.acp && body.name) {
          // Direct object — validate it
          spec = await parseSpec(JSON.stringify(body));
        } else {
          json(res, 400, { error: 'Missing "spec" field (YAML/JSON string) or direct spec object' });
          return true;
        }
        registry.setProtocol(namespace, spec);
        json(res, 200, { loaded: true, name: spec.name, title: spec.title });
      } catch (err) {
        if (err instanceof SpecValidationError) {
          json(res, 400, { error: 'Invalid spec', details: err.errors });
        } else {
          json(res, 400, { error: (err as Error).message });
        }
      }
      return true;
    }
  }

  for (const route of routes) {
    if (req.method !== route.method) continue;
    const match = rewrittenPath.match(route.pattern);
    if (!match) continue;

    if (verbose) {
      const ts = new Date().toISOString().slice(11, 23);
      const agentId = getAgentId(req, body);
      const nsLabel = namespace === 'default' ? '' : `@${namespace}`;
      console.error(`  ${ts} [${agentId}${nsLabel}] REST ${req.method} ${pathname}`);
    }

    try {
      await route.handler(req, res, stores, match, body);
    } catch (err) {
      if (err instanceof CarapaceBlockedError) {
        json(res, 403, {
          error: 'prompt_injection_detected',
          message: err.message,
          score: err.score,
          action: err.action,
          findings: err.findings,
        });
      } else {
        throw err;
      }
    }
    return true;
  }

  json(res, 404, { error: `No route: ${req.method} ${pathname}` });
  return true;
}
