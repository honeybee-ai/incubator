/** Type-only declaration for optional @honeybee-ai/propolis dependency. */
declare module '@honeybee-ai/propolis' {
  import type { ToolEntry } from '@honeybee-ai/hivemind-sdk/integrations';

  export interface FSBackend {
    readFile(path: string): string | null;
    writeFile(path: string, content: string): void;
    deleteFile(path: string): boolean;
    exists(path: string): boolean;
    stat(path: string): { size: number; mtime: number; isDirectory: boolean } | null;
    readdir(dir: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    mkdir(dir: string): void;
  }

  export class MemFS implements FSBackend {
    seedFromDir(dir: string, opts?: { ignore?: string[] }): void;
    readFile(path: string): string | null;
    writeFile(path: string, content: string): void;
    deleteFile(path: string): boolean;
    exists(path: string): boolean;
    stat(path: string): { size: number; mtime: number; isDirectory: boolean } | null;
    readdir(dir: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    mkdir(dir: string): void;
    glob(pattern: string, base?: string): string[];
    grep(pattern: string, path?: string, fileGlob?: string): Array<{ file: string; line: number; text: string }>;
    getChangeset(): Map<string, string | null>;
    getChangedFiles(): string[];
    get fileCount(): number;
  }

  export function TOOL_DEFS(workDir: string, guard: unknown, verbose: boolean, fs?: FSBackend): ToolEntry[];
  export function createPlugin(): import('@honeybee-ai/hivemind-sdk/integrations').IncubatorPlugin;
}
