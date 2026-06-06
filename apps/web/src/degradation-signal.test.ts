import { describe, it, expect } from 'vitest';
import type { AdapterWarning } from '@argus/contract';
import {
  warningCountLabel,
  summarizeWarningCodes,
  coveragePercent,
  isDegraded,
  planCoverageLabel,
  planCoverageTitle,
} from './degradation-signal.ts';

// The PURE formatting seam behind the calm run-header warning chip + the plan-header coverage
// badge. These turn the adapter's honest degradation signals (warnings + coverageRatio) into
// human strings WITHOUT silently hiding a degraded run/plan (boundaries §honesty).

const w = (code: string, detail?: string): AdapterWarning => ({ code, ...(detail ? { detail } : {}) });

describe('degradation-signal — run/plan honesty formatting', () => {
  describe('warningCountLabel', () => {
    it('is empty when there are no warnings (a clean run stays silent)', () => {
      expect(warningCountLabel([])).toBe('');
    });
    it('singularizes one warning', () => {
      expect(warningCountLabel([w('live-incomplete')])).toBe('1 warning');
    });
    it('pluralizes many warnings', () => {
      expect(warningCountLabel([w('a'), w('b'), w('c')])).toBe('3 warnings');
    });
  });

  describe('summarizeWarningCodes', () => {
    it('is empty for no warnings', () => {
      expect(summarizeWarningCodes([])).toBe('');
    });
    it('lists distinct codes comma-separated', () => {
      expect(summarizeWarningCodes([w('live-incomplete'), w('live-unbound-anonymous')])).toBe(
        'live-incomplete, live-unbound-anonymous',
      );
    });
    it('collapses repeats into a ×count suffix (no noisy triple-list)', () => {
      expect(
        summarizeWarningCodes([w('journal-bad-lines'), w('journal-bad-lines'), w('journal-bad-lines')]),
      ).toBe('journal-bad-lines ×3');
    });
    it('mixes singletons and repeats', () => {
      expect(summarizeWarningCodes([w('a'), w('b'), w('a')])).toBe('a ×2, b');
    });
  });

  describe('coveragePercent', () => {
    it('treats absent/non-finite coverage as full (100)', () => {
      expect(coveragePercent(null)).toBe(100);
      expect(coveragePercent(undefined)).toBe(100);
      expect(coveragePercent(Number.NaN)).toBe(100);
    });
    it('rounds a fractional ratio to a whole percent', () => {
      expect(coveragePercent(0.824)).toBe(82);
      expect(coveragePercent(0.5)).toBe(50);
      expect(coveragePercent(1)).toBe(100);
      expect(coveragePercent(0)).toBe(0);
    });
    it('clamps out-of-range ratios', () => {
      expect(coveragePercent(1.4)).toBe(100);
      expect(coveragePercent(-0.2)).toBe(0);
    });
  });

  describe('isDegraded', () => {
    it('is false for full coverage and no warnings (clean plan)', () => {
      expect(isDegraded(1, [])).toBe(false);
    });
    it('is true when coverage is below full', () => {
      expect(isDegraded(0.82, [])).toBe(true);
    });
    it('is true when warnings exist even at full coverage', () => {
      expect(isDegraded(1, [w('import-detected-fallback')])).toBe(true);
    });
  });

  describe('planCoverageLabel', () => {
    it('is empty for a clean plan (renders nothing)', () => {
      expect(planCoverageLabel(1, [])).toBe('');
    });
    it('shows percent parsed when coverage is below full', () => {
      expect(planCoverageLabel(0.82, [w('unparsed-statement')])).toBe('82% parsed');
    });
    it('falls back to a calm "partial" when full coverage but warnings exist', () => {
      expect(planCoverageLabel(1, [w('import-detected-fallback')])).toBe('partial');
    });
  });

  describe('planCoverageTitle', () => {
    it('states percent parsed with no codes when there are no warnings', () => {
      expect(planCoverageTitle(0.5, [])).toBe('50% of the plan source was parsed');
    });
    it('appends the warning codes when present', () => {
      expect(planCoverageTitle(0.5, [w('unparsed-statement'), w('unparsed-statement')])).toBe(
        '50% of the plan source was parsed · unparsed-statement ×2',
      );
    });
  });
});
