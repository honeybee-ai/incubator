import { z } from 'zod';
import type { Guard } from '../guard.js';
import type { ToolResult } from './types.js';
import { readFileHandler, writeFileHandler, patchFileHandler, listFilesHandler, globHandler, grepHandler } from './filesystem.js';
import { runHandler } from './shell.js';
import { gitStatusHandler, gitDiffHandler, gitCommitHandler, gitLogHandler } from './git.js';
import { fetchHandler, scrapePageHandler } from './web.js';

/** LLM-facing tool definition (OpenAI function-calling format). */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

/** A tool entry: LLM def + Zod schema (for MCP) + pre-bound handler. */
export interface ToolEntry {
  def: ToolDef;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Build all Propolis tool entries for a given workDir and guard.
 * Both NativeToolClient and createServer() consume this.
 */
export function TOOL_DEFS(workDir: string, guard: Guard | null, verbose?: boolean): ToolEntry[] {
  return [
    // ─── Filesystem ──────────────────────────────────
    {
      def: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file relative to the working directory',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to working directory' },
            },
            required: ['path'],
          },
        },
      },
      schema: { path: z.string().describe('File path relative to working directory') },
      handler: (args) => readFileHandler(args as { path: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file. Creates parent directories automatically.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to working directory' },
              content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
          },
        },
      },
      schema: {
        path: z.string().describe('File path relative to working directory'),
        content: z.string().describe('Content to write'),
      },
      handler: (args) => writeFileHandler(args as { path: string; content: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'patch_file',
          description: 'Find and replace text in a file. The search string must match exactly.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to working directory' },
              search: { type: 'string', description: 'Exact text to find' },
              replace: { type: 'string', description: 'Text to replace with' },
            },
            required: ['path', 'search', 'replace'],
          },
        },
      },
      schema: {
        path: z.string().describe('File path relative to working directory'),
        search: z.string().describe('Exact text to find'),
        replace: z.string().describe('Text to replace with'),
      },
      handler: (args) => patchFileHandler(args as { path: string; search: string; replace: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List files in a directory. Skips node_modules, .git, and similar directories.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path relative to working directory (default: root)' },
              recursive: { type: 'string', description: 'List recursively (default: false)' },
            },
            required: [],
          },
        },
      },
      schema: {
        path: z.string().optional().describe('Directory path relative to working directory (default: root)'),
        recursive: z.boolean().optional().describe('List recursively (default: false)'),
      },
      handler: (args) => listFilesHandler(args as { path?: string; recursive?: boolean }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'glob',
          description: 'Find files matching a glob pattern (e.g. "**/*.ts")',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern to match' },
              path: { type: 'string', description: 'Base directory for the search' },
            },
            required: ['pattern'],
          },
        },
      },
      schema: {
        pattern: z.string().describe('Glob pattern to match'),
        path: z.string().optional().describe('Base directory for the search'),
      },
      handler: (args) => globHandler(args as { pattern: string; path?: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'grep',
          description: 'Search file contents using a regex pattern',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Regex pattern to search for' },
              path: { type: 'string', description: 'Directory to search in' },
              glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
            },
            required: ['pattern'],
          },
        },
      },
      schema: {
        pattern: z.string().describe('Regex pattern to search for'),
        path: z.string().optional().describe('Directory to search in'),
        glob: z.string().optional().describe('File glob filter (e.g. "*.ts")'),
      },
      handler: (args) => grepHandler(args as { pattern: string; path?: string; glob?: string }, workDir, guard, verbose),
    },

    // ─── Shell ───────────────────────────────────────
    {
      def: {
        type: 'function',
        function: {
          name: 'run',
          description: 'Execute a shell command. 60s timeout, 100KB output cap.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to execute' },
              cwd: { type: 'string', description: 'Working directory relative to sandbox root' },
              timeout: { type: 'string', description: 'Timeout in milliseconds (default: 60000)' },
            },
            required: ['command'],
          },
        },
      },
      schema: {
        command: z.string().describe('Shell command to execute'),
        cwd: z.string().optional().describe('Working directory relative to sandbox root'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000)'),
      },
      handler: (args) => runHandler(args as { command: string; cwd?: string; timeout?: number }, workDir, guard, verbose),
    },

    // ─── Git ─────────────────────────────────────────
    {
      def: {
        type: 'function',
        function: {
          name: 'git_status',
          description: 'Show git status (porcelain format)',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
      schema: {},
      handler: () => gitStatusHandler({} as Record<string, never>, workDir),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'git_diff',
          description: 'Show git diff. Optionally for a specific path or staged changes.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path to diff' },
              staged: { type: 'string', description: 'Show staged changes' },
            },
            required: [],
          },
        },
      },
      schema: {
        path: z.string().optional().describe('File path to diff'),
        staged: z.boolean().optional().describe('Show staged changes'),
      },
      handler: (args) => gitDiffHandler(args as { path?: string; staged?: boolean }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'git_commit',
          description: 'Stage files and create a git commit',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Commit message' },
              files: { type: 'string', description: 'Comma-separated file paths to stage (default: all)' },
            },
            required: ['message'],
          },
        },
      },
      schema: {
        message: z.string().describe('Commit message'),
        files: z.string().optional().describe('Comma-separated file paths to stage (default: all)'),
      },
      handler: (args) => gitCommitHandler(args as { message: string; files?: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'git_log',
          description: 'Show recent git commits (oneline format)',
          parameters: {
            type: 'object',
            properties: {
              count: { type: 'string', description: 'Number of commits to show (default: 10)' },
            },
            required: [],
          },
        },
      },
      schema: {
        count: z.number().optional().describe('Number of commits to show (default: 10)'),
      },
      handler: (args) => gitLogHandler(args as { count?: number }, workDir),
    },

    // ─── Web ──────────────────────────────────────────
    {
      def: {
        type: 'function',
        function: {
          name: 'fetch',
          description: 'Make an HTTP request. Returns status, headers, and body. Blocks localhost/private IPs.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to fetch' },
              method: { type: 'string', description: 'HTTP method (default: GET)' },
              body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
            },
            required: ['url'],
          },
        },
      },
      schema: {
        url: z.string().describe('URL to fetch'),
        method: z.string().optional().describe('HTTP method (default: GET)'),
        body: z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
      },
      handler: (args) => fetchHandler(args as { url: string; method?: string; body?: string }, workDir, guard, verbose),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'scrape_page',
          description: 'Fetch a web page and extract readable text (strips HTML tags, scripts, styles). Blocks localhost/private IPs.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL of the page to scrape' },
            },
            required: ['url'],
          },
        },
      },
      schema: {
        url: z.string().describe('URL of the page to scrape'),
      },
      handler: (args) => scrapePageHandler(args as { url: string }, workDir, guard, verbose),
    },
  ];
}
