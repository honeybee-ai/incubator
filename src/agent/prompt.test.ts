import { describe, it, expect } from 'vitest';
import { generateSystemPrompt, generateFallbackPrompt } from './prompt.js';
import type { ToolDef } from './types.js';

const mockTools: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a file',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Content' } }, required: ['path', 'content'] },
    },
  },
];

describe('generateSystemPrompt', () => {
  it('includes agent ID and role', () => {
    const prompt = generateSystemPrompt('dev-1', 'developer', mockTools);
    expect(prompt).toContain('dev-1');
    expect(prompt).toContain('developer');
  });

  it('lists available tools', () => {
    const prompt = generateSystemPrompt('dev-1', 'developer', mockTools);
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
  });

  it('includes DONE instruction', () => {
    const prompt = generateSystemPrompt('dev-1', 'developer', mockTools);
    expect(prompt).toContain('DONE');
  });

  it('includes protocol info when provided', () => {
    const protocol = {
      protocol: { name: 'test-protocol', title: 'Test Protocol' },
      role: { name: 'developer', description: 'Writes code' },
      current_phase: 'implementation',
      instructions: 'Write the code according to spec',
      phases: {
        planning: { description: 'Plan the work' },
        implementation: { description: 'Write the code' },
        review: { description: 'Review the code', terminal: true },
      },
      team: [
        { agent: 'dev-1', role: 'developer' },
        { agent: 'rev-1', role: 'reviewer' },
      ],
    };

    const prompt = generateSystemPrompt('dev-1', 'developer', mockTools, protocol);
    expect(prompt).toContain('Test Protocol');
    expect(prompt).toContain('Writes code'); // role description
    expect(prompt).toContain('implementation');
    expect(prompt).toContain('(CURRENT)');
    expect(prompt).toContain('(TERMINAL)');
    expect(prompt).toContain('rev-1');
    // Protocol mode uses protocol-specific instructions, not code-focused ones
    expect(prompt).toContain('Follow the steps above');
    expect(prompt).not.toContain('Run tests');
  });
});

describe('generateFallbackPrompt', () => {
  it('generates a valid prompt without protocol', () => {
    const prompt = generateFallbackPrompt('dev-1', 'developer', mockTools);
    expect(prompt).toContain('dev-1');
    expect(prompt).toContain('developer');
    expect(prompt).toContain('read_file');
    expect(prompt).not.toContain('Protocol');
  });
});
