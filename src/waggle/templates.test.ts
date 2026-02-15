import { describe, it, expect } from 'vitest';
import { resolveTemplates } from './templates.js';

describe('resolveTemplates', () => {
  it('returns args unchanged when no $last references', () => {
    const result = resolveTemplates({ key: 'hello', num: 42 }, null);
    expect(result).toEqual({ key: 'hello', num: 42 });
  });

  it('resolves $last to entire previous result', () => {
    const result = resolveTemplates({ value: '$last' }, { status: 'ok', count: 5 });
    expect(result.value).toEqual({ status: 'ok', count: 5 });
  });

  it('resolves $last.field to nested value', () => {
    const result = resolveTemplates({ value: '$last.status' }, { status: 'running', count: 5 });
    expect(result.value).toBe('running');
  });

  it('resolves deeply nested $last.a.b.c', () => {
    const result = resolveTemplates(
      { value: '$last.response.data.items' },
      { response: { data: { items: [1, 2, 3] } } },
    );
    expect(result.value).toEqual([1, 2, 3]);
  });

  it('returns undefined for missing path', () => {
    const result = resolveTemplates({ value: '$last.nonexistent' }, { a: 1 });
    expect(result.value).toBeUndefined();
  });

  it('returns undefined when lastResult is null', () => {
    const result = resolveTemplates({ value: '$last.foo' }, null);
    expect(result.value).toBeUndefined();
  });

  it('resolves $last in nested objects', () => {
    const result = resolveTemplates(
      { data: { key: '$last.name', count: '$last.n' } },
      { name: 'test', n: 42 },
    );
    expect(result.data).toEqual({ key: 'test', count: 42 });
  });

  it('resolves $last in arrays', () => {
    const result = resolveTemplates(
      { items: ['$last.a', '$last.b', 'literal'] },
      { a: 'x', b: 'y' },
    );
    expect(result.items).toEqual(['x', 'y', 'literal']);
  });

  it('preserves non-$last strings', () => {
    const result = resolveTemplates(
      { value: 'not a template', last: '$lastly not a ref' },
      { foo: 'bar' },
    );
    // '$lastly' starts with '$last' so will attempt resolution
    expect(result.value).toBe('not a template');
  });

  it('handles $last when lastResult is a string', () => {
    const result = resolveTemplates({ content: '$last' }, 'raw text');
    expect(result.content).toBe('raw text');
  });

  it('handles $last.field when lastResult is a string (returns undefined)', () => {
    const result = resolveTemplates({ value: '$last.foo' }, 'raw text');
    expect(result.value).toBeUndefined();
  });
});
