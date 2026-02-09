/**
 * Dynamic loader for integration npm packages.
 *
 * Each integration package must default-export an IntegrationFactory,
 * or export a named `createIntegration` factory.
 */

import type { IntegrationModule, IntegrationFactory } from '@honeybee-ai/integration-sdk';

export async function loadIntegrationPackage(packageName: string): Promise<IntegrationModule> {
  // Use string indirection to avoid TS module resolution errors for optional deps
  const mod = await import(packageName);

  // Support: default export factory, named createIntegration, or direct module
  const factory: IntegrationFactory | undefined =
    mod.default?.default ??  // double-default for CJS interop
    mod.default ??
    mod.createIntegration;

  if (typeof factory === 'function') {
    const integration = factory();
    if (integration && typeof integration.start === 'function' && typeof integration.stop === 'function') {
      return integration;
    }
  }

  // Maybe the module IS the integration (already instantiated)
  if (mod.default && typeof mod.default.start === 'function') {
    return mod.default;
  }

  throw new Error(
    `Package "${packageName}" does not export a valid IntegrationFactory or IntegrationModule. ` +
    `Expected default export function returning { name, start, stop }.`
  );
}
