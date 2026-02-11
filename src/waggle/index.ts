export { compoundHandler, normalizeWait, createHandlerMap } from './compound.js';
export type { CompoundContext } from './compound.js';
export { WaggleToolClient } from './client.js';
export type {
  WaggleInput, WaggleResult, WaitSpec, NormalizedWait,
  Operation, OpResult, AcpBackend, Primitives,
} from './types.js';

import type { ToolDef } from '../agent/types.js';

/** All known waggle action names. */
export const ALL_ACTIONS = [
  // Env
  'read_file', 'write_file', 'patch_file', 'list_files', 'glob', 'grep',
  'shell', 'git_status', 'git_diff', 'git_commit', 'git_log',
  'fetch', 'scrape',
  // ACP
  'publish', 'claim', 'release', 'get_state', 'set_state',
] as const;

export const ENV_ACTIONS = ALL_ACTIONS.slice(0, 13);
export const ACP_ACTIONS = ALL_ACTIONS.slice(13);

/**
 * Single tool definition for the LLM.
 * The agent sees exactly ONE tool, no matter how many capabilities exist underneath.
 */
export const WAGGLE_TOOL_DEF: ToolDef = {
  type: 'function',
  function: {
    name: 'waggle',
    description: [
      'Execute operations and optionally wait for events. Ops run sequentially.',
      'Actions: read_file, write_file, patch_file, list_files, glob, grep, shell,',
      'git_status, git_diff, git_commit, git_log, fetch, scrape,',
      'publish, claim, release, get_state, set_state.',
      'Wait: true (any event), "type" (specific), ["a","b"] (any of), number (sleep ms), {types,timeout}.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        dance: {
          type: 'string',
          description: 'JSON array of operations. Each op: { "do": "action", ...params }. Example: [{"do":"read_file","path":"src/index.ts"},{"do":"publish","type":"file.read","data":{"path":"src/index.ts"}}]',
        },
        wait: {
          type: 'string',
          description: 'Optional wait spec after ops. true, "event_type", ["a","b"], 30000, or {"types":["a"],"timeout":5000}. Omit for no wait.',
        },
      },
      required: ['dance'],
    },
  },
};

/**
 * Parse the LLM's waggle tool call args into WaggleInput.
 * The LLM sends ops as a JSON string (or already-parsed array).
 */
export function parseWaggleArgs(args: Record<string, unknown>): { dance: Array<{ do: string; [k: string]: unknown }>; wait?: unknown } {
  const raw = args.dance;
  let dance: unknown[];
  if (typeof raw === 'string') {
    dance = JSON.parse(raw);
  } else if (Array.isArray(raw)) {
    dance = raw;
  } else {
    dance = [];
  }

  let wait: unknown;
  if (args.wait !== undefined) {
    if (typeof args.wait === 'string') {
      try {
        wait = JSON.parse(args.wait);
      } catch {
        wait = args.wait; // plain string event type
      }
    } else {
      wait = args.wait;
    }
  }

  return { dance: dance as Array<{ do: string; [k: string]: unknown }>, wait };
}
