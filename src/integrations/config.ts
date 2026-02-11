/**
 * Integration config — reads/writes ~/.honeyb/integrations.json
 * Falls back to legacy ~/.config/honeybee/integrations.json
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

function honeybDir(): string {
  return join(homedir(), '.honeyb');
}

function legacyDir(): string {
  return join(homedir(), '.config', 'honeybee');
}

function configPath(): string {
  const newPath = join(honeybDir(), 'integrations.json');
  if (existsSync(newPath)) return newPath;
  // Fallback to legacy
  const legacyPath = join(legacyDir(), 'integrations.json');
  if (existsSync(legacyPath)) return legacyPath;
  return newPath;
}

function writeConfigPath(): string {
  return join(honeybDir(), 'integrations.json');
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
  const dir = honeybDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(writeConfigPath(), JSON.stringify(config, null, 2) + '\n');
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
