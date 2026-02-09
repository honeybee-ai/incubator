import { describe, it, expect, vi } from 'vitest';
import { loadIntegrationPackage } from './loader.js';

describe('loadIntegrationPackage', () => {
  it('loads a default export factory', async () => {
    const module = {
      name: 'test',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const factory = () => module;

    vi.doMock('test-factory-pkg', () => ({ default: factory }));
    const result = await loadIntegrationPackage('test-factory-pkg');
    expect(result.name).toBe('test');
    expect(typeof result.start).toBe('function');
    vi.doUnmock('test-factory-pkg');
  });

  it('loads a named createIntegration export', async () => {
    const module = {
      name: 'named',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const createIntegration = () => module;

    vi.doMock('test-named-pkg', () => ({ default: null, createIntegration }));
    const result = await loadIntegrationPackage('test-named-pkg');
    expect(result.name).toBe('named');
    vi.doUnmock('test-named-pkg');
  });

  it('loads a direct module default export', async () => {
    const module = {
      name: 'direct',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    vi.doMock('test-direct-pkg', () => ({ default: module }));
    const result = await loadIntegrationPackage('test-direct-pkg');
    expect(result.name).toBe('direct');
    vi.doUnmock('test-direct-pkg');
  });

  it('handles CJS double-default interop', async () => {
    const module = {
      name: 'cjs',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const factory = () => module;

    vi.doMock('test-cjs-pkg', () => ({ default: { default: factory } }));
    const result = await loadIntegrationPackage('test-cjs-pkg');
    expect(result.name).toBe('cjs');
    vi.doUnmock('test-cjs-pkg');
  });

  it('throws for invalid package', async () => {
    vi.doMock('test-bad-pkg', () => ({ default: 'not a function or module' }));
    await expect(loadIntegrationPackage('test-bad-pkg')).rejects.toThrow(
      'does not export a valid IntegrationFactory',
    );
    vi.doUnmock('test-bad-pkg');
  });

  it('throws for factory returning non-module', async () => {
    const factory = () => ({ name: 'bad' }); // missing start/stop
    vi.doMock('test-noop-pkg', () => ({ default: factory }));
    await expect(loadIntegrationPackage('test-noop-pkg')).rejects.toThrow(
      'does not export a valid IntegrationFactory',
    );
    vi.doUnmock('test-noop-pkg');
  });
});
