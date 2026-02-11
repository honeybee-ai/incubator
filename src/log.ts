/**
 * Structured logging utility for the incubator.
 *
 * Supports two formats:
 *   - text (default): Human-readable ANSI output to stderr
 *   - json: JSONL output to stderr (machine-parseable)
 *
 * Set via --log-format=json flag.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

let currentFormat: LogFormat = 'text';
let currentLevel: LogLevel = 'info';
let prefix = '[incubator]';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogFormat(format: LogFormat): void {
  currentFormat = format;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setLogPrefix(p: string): void {
  prefix = p;
}

export function getLogFormat(): LogFormat {
  return currentFormat;
}

/** Log a message at the given level. In JSON mode, outputs JSONL to stderr. */
export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  if (currentFormat === 'json') {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      source: 'incubator',
      msg,
    };
    if (data) entry.data = data;
    console.error(JSON.stringify(entry));
  } else {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`${prefix} ${ts} ${msg}`);
  }
}

/** Convenience: info-level log */
export function logInfo(msg: string, data?: Record<string, unknown>): void {
  log('info', msg, data);
}

/** Convenience: warn-level log */
export function logWarn(msg: string, data?: Record<string, unknown>): void {
  log('warn', msg, data);
}

/** Convenience: error-level log */
export function logError(msg: string, data?: Record<string, unknown>): void {
  log('error', msg, data);
}

/** Convenience: debug-level log */
export function logDebug(msg: string, data?: Record<string, unknown>): void {
  log('debug', msg, data);
}
