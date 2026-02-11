declare module '@honeybee-ai/carapace' {
  interface ScanResult {
    pass: boolean;
    score: number;
    action: 'PASS' | 'LOG' | 'WARN' | 'BLOCK';
    findings: Array<{ category: string; severity: string; description: string }>;
    summary: string;
  }

  export function scan(text: string, options?: Record<string, unknown>): ScanResult;
  export function isSafe(text: string): boolean;
  export function sanitize(text: string): string;
  export function assertSafe(text: string): void;
}
