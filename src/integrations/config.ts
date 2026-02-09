/**
 * Integration config — reads/writes ~/.config/honeybee/integrations.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface IntegrationEntry {
  package: string;
  enabled: boolean;
  config: Record<string, string>;
}

export type IntegrationsConfig = Record<string, IntegrationEntry>;

function configDir(): string {
  return join(homedir(), '.config', 'honeybee');
}

function configPath(): string {
  return join(configDir(), 'integrations.json');
}

export function loadIntegrationsConfig(): IntegrationsConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveIntegrationsConfig(config: IntegrationsConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n');
}

export function enableIntegration(name: string, pkg: string, userConfig: Record<string, string> = {}): void {
  const config = loadIntegrationsConfig();
  config[name] = { package: pkg, enabled: true, config: userConfig };
  saveIntegrationsConfig(config);
}

export function disableIntegration(name: string): void {
  const config = loadIntegrationsConfig();
  if (config[name]) {
    config[name].enabled = false;
    saveIntegrationsConfig(config);
  }
}

export function removeIntegration(name: string): void {
  const config = loadIntegrationsConfig();
  delete config[name];
  saveIntegrationsConfig(config);
}
