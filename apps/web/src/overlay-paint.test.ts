import { describe, it, expect } from 'vitest';
import { resolveHighlight } from './overlay-paint.ts';

// ARCH-1: resolveHighlight is the PURE agentId→node cross-highlight resolver. A graph node passes
// the agentId(s) it represents — `[agent.agentId]` for a single instance card/chip, or a plan
// node's `bindAgentIds` for a collapsed aggregate. It returns ONLY the set flags so spreading the
// result is a no-op when nothing matches (mirrors the failure-point patch). `highlighted` = the
// SELECTED table row (persistent ring); `hovered` = the HOVERED row (transient glow).
describe('resolveHighlight', () => {
  it('returns {} when neither the selected nor hovered id is set', () => {
    expect(resolveHighlight(['a'], null, null)).toEqual({});
  });

  it('marks highlighted when the SELECTED id matches', () => {
    expect(resolveHighlight(['a'], 'a', null)).toEqual({ highlighted: true });
  });

  it('marks hovered when the HOVERED id matches', () => {
    expect(resolveHighlight(['a'], null, 'a')).toEqual({ hovered: true });
  });

  it('marks BOTH when the same id is selected and hovered', () => {
    expect(resolveHighlight(['a'], 'a', 'a')).toEqual({ highlighted: true, hovered: true });
  });

  it('a collapsed AGGREGATE node (many bindAgentIds) lights up if it contains the agent', () => {
    expect(resolveHighlight(['a', 'b', 'c'], 'b', null)).toEqual({ highlighted: true });
    expect(resolveHighlight(['a', 'b', 'c'], null, 'c')).toEqual({ hovered: true });
  });

  it('returns {} when the id does not match any of the node agentIds', () => {
    expect(resolveHighlight(['a', 'b'], 'z', 'y')).toEqual({});
  });

  it('returns {} for an empty or undefined agentIds list (never matches)', () => {
    expect(resolveHighlight([], 'a', 'a')).toEqual({});
    expect(resolveHighlight(undefined, 'a', 'a')).toEqual({});
  });

  it('selected + hovered are independent (different ids on a multi-agent node)', () => {
    expect(resolveHighlight(['a', 'b'], 'a', 'b')).toEqual({ highlighted: true, hovered: true });
  });
});
