import { describe, it, expect } from 'vitest';
import { createTypeMatcher } from './event-matcher.js';

describe('createTypeMatcher', () => {
  it('matches exact strings', () => {
    const m = createTypeMatcher(['turn', 'game.over']);
    expect(m('turn')).toBe(true);
    expect(m('game.over')).toBe(true);
    expect(m('turn.player_2')).toBe(false);
    expect(m('speech')).toBe(false);
  });

  it('matches glob * within a dot-segment', () => {
    const m = createTypeMatcher(['turn.*']);
    expect(m('turn.player_2')).toBe(true);
    expect(m('turn.seer')).toBe(true);
    expect(m('turn')).toBe(false);
    expect(m('turn.a.b')).toBe(false); // * doesn't cross dots
  });

  it('matches glob prefix wildcard', () => {
    const m = createTypeMatcher(['*.player_2']);
    expect(m('turn.player_2')).toBe(true);
    expect(m('speech.player_2')).toBe(true);
    expect(m('player_2')).toBe(false);
    expect(m('a.b.player_2')).toBe(false);
  });

  it('matches mid-segment wildcard', () => {
    const m = createTypeMatcher(['turn.player_*']);
    expect(m('turn.player_2')).toBe(true);
    expect(m('turn.player_3')).toBe(true);
    expect(m('turn.player_')).toBe(true);
    expect(m('turn.player_2.extra')).toBe(false);
  });

  it('handles mixed exact and glob patterns', () => {
    const m = createTypeMatcher(['game.over', 'turn.*']);
    expect(m('game.over')).toBe(true);
    expect(m('turn.player_3')).toBe(true);
    expect(m('speech')).toBe(false);
  });

  it('returns false for empty patterns', () => {
    const m = createTypeMatcher([]);
    expect(m('anything')).toBe(false);
  });

  it('uses fast path (no regex) when no globs present', () => {
    const m = createTypeMatcher(['a', 'b', 'c']);
    expect(m('a')).toBe(true);
    expect(m('b')).toBe(true);
    expect(m('c')).toBe(true);
    expect(m('d')).toBe(false);
  });

  it('handles multiple wildcards in one pattern', () => {
    const m = createTypeMatcher(['*.*']);
    expect(m('turn.player_2')).toBe(true);
    expect(m('a.b')).toBe(true);
    expect(m('single')).toBe(false);
    expect(m('a.b.c')).toBe(false);
  });
});
