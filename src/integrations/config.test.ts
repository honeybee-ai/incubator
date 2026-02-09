import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to mock homedir to use a temp directory
const tempHome = mkdtempSync(join(tmpdir(), 'honeybee-test-'));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tempHome,
  };
});

// Import after mocking
const { loadIntegrationsConfig, saveIntegrationsConfig, enableIntegration, disableIntegration, removeIntegration } =
  await import('./config.js');

describe('integration config', () => {
  const configDir = join(tempHome, '.config', 'honeybee');
  const configFile = join(configDir, 'integrations.json');

  beforeEach(() => {
    // Clean up config between tests
    if (existsSync(configFile)) {
      rmSync(configFile);
    }
  });

  afterEach(() => {
    if (existsSync(configFile)) {
      rmSync(configFile);
    }
  });

  it('loadIntegrationsConfig returns empty object when no file', () => {
    const config = loadIntegrationsConfig();
    expect(config).toEqual({});
  });

  it('saveIntegrationsConfig creates file and dirs', () => {
    saveIntegrationsConfig({
      webhook: { package: '@honeybee-ai/integration-webhook', enabled: true, config: {} },
    });

    expect(existsSync(configFile)).toBe(true);
    const content = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(content.webhook.package).toBe('@honeybee-ai/integration-webhook');
    expect(content.webhook.enabled).toBe(true);
  });

  it('loadIntegrationsConfig reads saved config', () => {
    saveIntegrationsConfig({
      slack: { package: 'slack-pkg', enabled: false, config: { TOKEN: 'abc' } },
    });

    const config = loadIntegrationsConfig();
    expect(config.slack.package).toBe('slack-pkg');
    expect(config.slack.enabled).toBe(false);
    expect(config.slack.config.TOKEN).toBe('abc');
  });

  it('enableIntegration adds entry with enabled: true', () => {
    enableIntegration('webhook', '@honeybee-ai/integration-webhook', { WEBHOOK_URL: 'https://example.com' });

    const config = loadIntegrationsConfig();
    expect(config.webhook.enabled).toBe(true);
    expect(config.webhook.package).toBe('@honeybee-ai/integration-webhook');
    expect(config.webhook.config.WEBHOOK_URL).toBe('https://example.com');
  });

  it('disableIntegration sets enabled to false', () => {
    enableIntegration('webhook', 'pkg');
    disableIntegration('webhook');

    const config = loadIntegrationsConfig();
    expect(config.webhook.enabled).toBe(false);
  });

  it('disableIntegration is a no-op for missing entry', () => {
    disableIntegration('nonexistent');
    const config = loadIntegrationsConfig();
    expect(config.nonexistent).toBeUndefined();
  });

  it('removeIntegration deletes the entry', () => {
    enableIntegration('webhook', 'pkg');
    removeIntegration('webhook');

    const config = loadIntegrationsConfig();
    expect(config.webhook).toBeUndefined();
  });

  it('removeIntegration is a no-op for missing entry', () => {
    removeIntegration('nonexistent');
    const config = loadIntegrationsConfig();
    expect(config).toEqual({});
  });

  it('loadIntegrationsConfig handles corrupt JSON gracefully', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configFile, 'not json!!!');

    const config = loadIntegrationsConfig();
    expect(config).toEqual({});
  });
});
