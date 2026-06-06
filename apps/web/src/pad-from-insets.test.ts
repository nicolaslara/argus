import { describe, it, expect } from 'vitest';
import { padFromInsets } from './pad-from-insets.ts';

// The no-overlap padding MATH (extracted from App.tsx's chromeAwareFitOptions). App measures
// chrome insets from the live DOM; this pure helper turns them into React Flow v12 Padding
// (per-side pixel STRINGS with the same +20/+40 margins the inline math used).

describe('padFromInsets', () => {
  it('zero insets → only the per-side margins (+20 top/left, +40 right/bottom)', () => {
    expect(padFromInsets({ top: 0, left: 0, bottom: 0 })).toEqual({
      top: '20px',
      left: '20px',
      right: '40px',
      bottom: '40px',
    });
  });

  it('adds the margins onto each measured inset', () => {
    expect(padFromInsets({ top: 100, left: 50, bottom: 75 })).toEqual({
      top: '120px',
      left: '70px',
      right: '40px',
      bottom: '115px',
    });
  });

  it('clamps negative insets to 0 before adding margins', () => {
    expect(padFromInsets({ top: -30, left: -5, bottom: -100 })).toEqual({
      top: '20px',
      left: '20px',
      right: '40px',
      bottom: '40px',
    });
  });

  it('rounds fractional insets (getBoundingClientRect returns floats)', () => {
    expect(padFromInsets({ top: 99.4, left: 50.6, bottom: 10.5 })).toEqual({
      top: '119px', // round(99.4)=99 +20
      left: '71px', // round(50.6)=51 +20
      right: '40px',
      bottom: '51px', // round(10.5)=11 +40 (note: Math.round(10.5)=11)
    });
  });

  it('an explicit right inset overrides the default 40px gutter (no extra margin added)', () => {
    expect(padFromInsets({ top: 0, left: 0, bottom: 0, right: 88 })).toEqual({
      top: '20px',
      left: '20px',
      right: '88px',
      bottom: '40px',
    });
  });

  it('a negative explicit right inset is clamped to 0px', () => {
    expect(padFromInsets({ top: 0, left: 0, bottom: 0, right: -10 }).right).toBe('0px');
  });

  it('every output is a px STRING (never a unitless number)', () => {
    const pad = padFromInsets({ top: 12, left: 34, bottom: 56, right: 78 });
    for (const v of Object.values(pad)) {
      expect(typeof v).toBe('string');
      expect(v.endsWith('px')).toBe(true);
    }
  });

  it('large insets round correctly', () => {
    expect(padFromInsets({ top: 1000.49, left: 2000.51, bottom: 3000 })).toEqual({
      top: '1020px',
      left: '2021px',
      right: '40px',
      bottom: '3040px',
    });
  });
});
