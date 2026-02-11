/**
 * Duck-typed wait parameter normalization.
 * Same logic as incubator/src/waggle/compound.ts — kept standalone to avoid dep.
 */

import type { WaitSpec, NormalizedWait } from './types.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export function normalizeWait(spec: WaitSpec): NormalizedWait {
  if (spec === true) {
    return { types: null, timeout: DEFAULT_TIMEOUT, pureDelay: false };
  }
  if (typeof spec === 'number') {
    return { types: null, timeout: spec, pureDelay: true };
  }
  if (typeof spec === 'string') {
    return { types: [spec], timeout: DEFAULT_TIMEOUT, pureDelay: false };
  }
  if (Array.isArray(spec)) {
    return { types: spec, timeout: DEFAULT_TIMEOUT, pureDelay: false };
  }
  if (typeof spec === 'object' && spec !== null) {
    return {
      types: spec.types ?? null,
      timeout: spec.timeout ?? DEFAULT_TIMEOUT,
      pureDelay: false,
    };
  }
  return { types: null, timeout: DEFAULT_TIMEOUT, pureDelay: false };
}
