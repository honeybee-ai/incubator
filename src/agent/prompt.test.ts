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

describe('bootstrap negotiation prompt', () => {
  it('generates negotiation prompt when peerCount > 1 and no protocol', () => {
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, null, { peerCount: 3 });
    expect(prompt).toContain('3 agents');
    expect(prompt).toContain('spec_author');
    expect(prompt).toContain('AUTHOR');
    expect(prompt).toContain('REVIEWER');
    expect(prompt).toContain('load_protocol');
    expect(prompt).toContain('spec.proposed');
    expect(prompt).toContain('spec.vote');
    expect(prompt).toContain('spec.activated');
  });

  it('generates self-spec prompt when peerCount === 1 and no protocol', () => {
    const prompt = generateSystemPrompt('solo-1', 'worker', mockTools, null, { peerCount: 1 });
    expect(prompt).toContain('only agent');
    expect(prompt).toContain('load_protocol');
    expect(prompt).not.toContain('REVIEWER');
    expect(prompt).not.toContain('spec_author');
  });

  it('uses generic fallback when peerCount undefined and no protocol', () => {
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, null);
    expect(prompt).toContain('check if a protocol is already loaded');
    expect(prompt).not.toContain('spec_author');
  });

  it('ignores peerCount when protocol is provided', () => {
    const protocol = {
      protocol: { name: 'test', title: 'Test' },
      role: { name: 'worker', description: 'Does work' },
      current_phase: 'main',
      instructions: 'Work hard',
      phases: { main: { description: 'Main phase' } },
    };
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, protocol, { peerCount: 5 });
    expect(prompt).toContain('Follow the steps above');
    expect(prompt).not.toContain('Bootstrap');
    expect(prompt).not.toContain('spec_author');
  });

  it('negotiation prompt includes max 5 rounds limit', () => {
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, null, { peerCount: 2 });
    expect(prompt).toContain('max 5 rounds');
  });

  it('negotiation prompt handles late joiners', () => {
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, null, { peerCount: 4 });
    expect(prompt).toContain('spec_status');
    expect(prompt).toContain('activated');
  });
});
