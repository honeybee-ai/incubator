import { textResult, errorResult, type ToolResult } from './types.js';
import type { Guard } from '../guard.js';
import { scanInput } from '../guard.js';

// ─── SSRF prevention ──────────────────────────────────────────────

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd|fe80)/i;
const LOCALHOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;

function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return LOCALHOST_RE.test(url.hostname) || PRIVATE_IP_RE.test(url.hostname);
  } catch {
    return true; // Invalid URL = reject
  }
}

const MAX_RESPONSE_SIZE = 512 * 1024; // 512KB
const FETCH_TIMEOUT_MS = 30_000;

// ─── fetch tool ───────────────────────────────────────────────────

export async function fetchHandler(
  args: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  _workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const { url, method = 'GET', headers = {}, body } = args;

  // SSRF guard
  if (isPrivateUrl(url)) {
    return errorResult('Blocked: cannot fetch localhost or private IP addresses');
  }

  // Carapace scan
  const scanErr = scanInput(guard, [url, body], verbose);
  if (scanErr) return errorResult(scanErr);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD' ? body : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    // Read body with size limit
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          chunks.push(Buffer.from(value.slice(0, MAX_RESPONSE_SIZE - (totalSize - value.length))));
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }

    const responseBody = Buffer.concat(chunks).toString('utf-8');
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { responseHeaders[k] = v; });

    return textResult({
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
      truncated: totalSize > MAX_RESPONSE_SIZE,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return errorResult(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    return errorResult(`Fetch failed: ${msg}`);
  }
}

// ─── scrape_page tool ─────────────────────────────────────────────

export async function scrapePageHandler(
  args: { url: string },
  _workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const { url } = args;

  // SSRF guard
  if (isPrivateUrl(url)) {
    return errorResult('Blocked: cannot scrape localhost or private IP addresses');
  }

  // Carapace scan
  const scanErr = scanInput(guard, [url], verbose);
  if (scanErr) return errorResult(scanErr);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return errorResult(`HTTP ${res.status}: ${res.statusText}`);
    }

    // Read body with size limit
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          chunks.push(Buffer.from(value.slice(0, MAX_RESPONSE_SIZE - (totalSize - value.length))));
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }

    const html = Buffer.concat(chunks).toString('utf-8');

    // Strip HTML to text
    const text = stripHtml(html);

    return textResult({
      url,
      status: res.status,
      text,
      truncated: totalSize > MAX_RESPONSE_SIZE,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return errorResult(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    return errorResult(`Scrape failed: ${msg}`);
  }
}

/** Strip HTML tags, scripts, and styles to produce readable text. */
function stripHtml(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Replace block-level tags with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
