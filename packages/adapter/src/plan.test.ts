import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parsePlan } from './plan.ts';
import type { DecisionNode, LoopNode, PlanModel } from '@argus/contract';

// P1 plan.ts unit tests. parsePlan is PURE (source string in, PlanModel out) and the
// adapter is node:fs-free — but the TEST harness may read the captured real fixtures
// from disk to feed the pure function (mirrors adapter.test.ts reading .argus/fixtures).
//
// Fixtures (the 5 real workflow scripts):
//   plan-research       — fan-out (parallel over a const array)
//   implement           — linear (+ early-return schema-field decision)
//   refine-plan         — loop + loop-back (while, max 3)
//   build-modal-rust-sdk— decision/nesting (Auth/Operations OPTIONAL under BUILD_GREEN)
//   materialize-workpads— spread-mix unbounded ({unbounded, min:n})

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(here, '../../../.argus/fixtures/named-workflows');

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
}

function parseFixture(name: string): PlanModel {
  return parsePlan(loadFixture(name), name);
}

describe('parsePlan — never throws + wrap-parse all 5 fixtures', () => {
  const fixtures = [
    'plan-research.js',
    'implement.js',
    'refine-plan.js',
    'build-modal-rust-sdk.js',
    'materialize-workpads.js',
  ];

  for (const f of fixtures) {
    it(`${f} wrap-parses cleanly → derivedFrom 'static-source'`, () => {
      const plan = parseFixture(f);
      expect(plan.derivedFrom).toBe('static-source');
      // No wrap-parse failure / import-fallback warning on a real fixture.
      expect(plan.warnings.some((w) => w.code === 'meta-only-wrap-parse-failed')).toBe(false);
      expect(plan.warnings.some((w) => w.code === 'import-detected-fallback')).toBe(false);
      expect(plan.format).toBe('cc-workflow/observed-2026-06-04');
    });
  }

  it('seeds lanes from meta.phases (Tier-1, declared)', () => {
    const plan = parseFixture('plan-research.js');
    expect(plan.lanes.map((l) => l.title)).toEqual(['Research', 'Design', 'Review', 'Synthesize']);
    expect(plan.lanes.every((l) => l.confidence === 'declared')).toBe(true);
    expect(plan.workflowName).toBe('modal-rust-plan-research');
  });
});

describe('build-modal-rust-sdk → Auth/Operations OPTIONAL under the BUILD_GREEN diamond', () => {
  const plan = parseFixture('build-modal-rust-sdk.js');

  it('emits a regex-verdict decision diamond (BUILD_GREEN gate)', () => {
    const decisions = plan.nodes.filter((n): n is DecisionNode => n.kind === 'decision');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const gate = decisions.find((d) => /GREEN/.test(d.conditionLabel));
    expect(gate).toBeDefined();
    expect(gate!.conditionKind).toBe('regex-verdict');
  });

  it('Auth (auth+channel) and Operations (typed-ops) are OPTIONAL, parented to the gate', () => {
    const gate = plan.nodes.find((n) => n.kind === 'decision' && /GREEN/.test((n as DecisionNode).conditionLabel))!;

    const auth = plan.nodes.find((n) => n.labelTemplate?.raw === 'auth+channel');
    const ops = plan.nodes.find((n) => n.labelTemplate?.raw === 'typed-ops');
    expect(auth, 'auth+channel agent node present (recursive walk found the else-branch)').toBeDefined();
    expect(ops, 'typed-ops agent node present (recursive walk found the else-branch)').toBeDefined();

    expect(auth!.optional).toBe(true);
    expect(ops!.optional).toBe(true);
    // At least the branch entry is parented to the decision; both are inside its arm.
    const branchParented = plan.nodes.filter((n) => n.parentDecisionId === gate.id);
    expect(branchParented.length).toBeGreaterThanOrEqual(2);
    expect(branchParented.some((n) => n.labelTemplate?.raw === 'auth+channel')).toBe(true);
    expect(branchParented.some((n) => n.labelTemplate?.raw === 'typed-ops')).toBe(true);
  });

  it('is NOT a silently-linear plan (the optional branch exists as a dashed edge)', () => {
    expect(plan.edges.some((e) => e.kind === 'optional')).toBe(true);
  });
});

describe('R5 — decision branches: de-negation + visible break terminal + labeled continuation', () => {
  it('de-negates `if (!x) { } else { agent }` so the ELSE (run-when-true) is labeled true', () => {
    const src = `export const meta = { name: 'x', description: 'd', phases: [{ title: 'P' }] }
phase('P')
const ok = await agent('impl', { label: 'impl', phase: 'P' })
const green = /GREEN/.test(ok)
if (!green) { log('skip') } else { await agent('verify it', { label: 'verify', phase: 'P' }) }
await agent('review it', { label: 'review', phase: 'P' })`;
    const plan = parsePlan(src, 'neg.js');
    const dec = plan.nodes.find((n) => n.kind === 'decision')!;
    const verify = plan.nodes.find((n) => n.labelTemplate?.raw === 'verify')!;
    const toVerify = plan.edges.find((e) => e.from === dec.id && e.to === verify.id);
    expect(toVerify?.kind).toBe('optional');
    expect(toVerify?.label).toBe('true'); // the else runs when the de-negated condition is true
    // the node-less consequent (`{ log }`) → the continuation edge carries the FALSE verdict.
    const falseEdge = plan.edges.find((e) => e.from === dec.id && e.label === 'false');
    expect(falseEdge).toBeDefined();
  });

  it('renders a visible "exit loop" terminal for an `if (cond) break` arm; continuation = false', () => {
    const src = `export const meta = { name: 'x', description: 'd', phases: [{ title: 'C' }, { title: 'R' }] }
let dry = false
while (!dry) {
  phase('C')
  const issues = await agent('critique', { label: 'critique', phase: 'C' })
  if (issues.length === 0) { dry = true; break }
  phase('R')
  await agent('revise', { label: 'revise', phase: 'R' })
}`;
    const plan = parsePlan(src, 'loop.js');
    const dec = plan.nodes.find((n) => n.kind === 'decision')!;
    const exit = plan.nodes.find((n) => n.kind === 'output' && n.title === 'exit loop');
    expect(exit, 'a visible "exit loop" terminal for the break arm').toBeDefined();
    const trueEdge = plan.edges.find((e) => e.from === dec.id && e.to === exit!.id);
    expect(trueEdge?.label).toBe('true');
    const revise = plan.nodes.find((n) => n.labelTemplate?.raw === 'revise')!;
    const falseEdge = plan.edges.find((e) => e.from === dec.id && e.to === revise.id);
    expect(falseEdge?.label).toBe('false'); // the continuation (no else) carries the false verdict
  });
});

describe('plan-research → fan-out over a const array (fixed N)', () => {
  const plan = parseFixture('plan-research.js');

  it('the Research fan-out resolves to {fixed, 7} (RESEARCH = 7 literal objects)', () => {
    const split = plan.nodes.find((n) => n.kind === 'process' && n.multiplicity.kind === 'fixed' && n.multiplicity.n === 7);
    expect(split, 'a fanout split with fixed n=7 (the 7 RESEARCH dimensions)').toBeDefined();
    expect(plan.edges.some((e) => e.kind === 'fanout')).toBe(true);
    expect(plan.edges.some((e) => e.kind === 'merge')).toBe(true);
  });

  it('agent label templates carry the structured prefix (research:)', () => {
    const research = plan.nodes.find((n) => n.kind === 'agent' && n.labelTemplate?.literalPrefix === 'research:');
    expect(research).toBeDefined();
    expect(research!.labelTemplate!.holes.length).toBeGreaterThan(0); // ${r.key} runtime hole
  });
});

describe('implement → linear with an early-return schema-field decision', () => {
  const plan = parseFixture('implement.js');

  it('is not linear-only: the blocked_reason guard is a schema-field decision', () => {
    const decisions = plan.nodes.filter((n): n is DecisionNode => n.kind === 'decision');
    const guard = decisions.find((d) => d.conditionKind === 'schema-field');
    expect(guard, 'the if (selection.blocked_reason) early-return guard').toBeDefined();
    expect(guard!.conditionLabel).toContain('blocked_reason');
  });

  it('emits flow edges along the Select→Implement→Verify→Record sequence', () => {
    expect(plan.edges.some((e) => e.kind === 'flow')).toBe(true);
    // The four sequential agents (select/implement/verify/record) are present.
    const labels = plan.nodes.filter((n) => n.kind === 'agent').map((n) => n.labelTemplate?.literalPrefix);
    expect(labels).toContain('select');
    expect(labels.some((l) => l === 'implement:' || l === 'implement')).toBe(true);
  });
});

describe('refine-plan → loop container + dashed loop-back (max 3)', () => {
  const plan = parseFixture('refine-plan.js');

  it('emits a loop node with maxRounds=3 and a stop-condition subtitle', () => {
    const loop = plan.nodes.find((n): n is LoopNode => n.kind === 'loop');
    expect(loop, 'the while(round < MAX_ROUNDS) loop').toBeDefined();
    expect(loop!.maxRounds).toBe(3); // const MAX_ROUNDS = (args && args.maxRounds) || 3
    expect(loop!.stopCondition).toContain('max 3');
  });

  it('emits a dashed loop-back edge labeled with the stop condition', () => {
    const back = plan.edges.find((e) => e.kind === 'loop-back');
    expect(back, 'the loop-back edge').toBeDefined();
    expect(back!.label).toContain('max 3');
  });

  it('the critique fan-out + revise live inside the loop (loopRef set)', () => {
    const inLoop = plan.nodes.filter((n) => n.loopRef !== null);
    expect(inLoop.length).toBeGreaterThan(0);
    expect(inLoop.some((n) => n.labelTemplate?.literalPrefix === 'critique:')).toBe(true);
  });
});

describe('materialize-workpads → spread-mix → {unbounded, min:n}', () => {
  const plan = parseFixture('materialize-workpads.js');

  it('the Workpads parallel([...WORKPADS.map(...), ()=>agent(...)]) is unbounded with a literal floor', () => {
    // WORKPADS has 5 literal entries; the spread makes the whole parallel unbounded, and
    // the extra `() => agent(...)` literal arm adds 1 → min >= 1 (the literal floor).
    const unbounded = plan.nodes.find(
      (n) => n.kind === 'process' && n.multiplicity.kind === 'unbounded',
    );
    expect(unbounded, 'a fanout split with unbounded multiplicity (spread-mix)').toBeDefined();
    const m = unbounded!.multiplicity;
    expect(m.kind).toBe('unbounded');
    if (m.kind === 'unbounded') {
      expect(m.max).toBe('N');
      // min reflects the in-scope const literal count contributed by the spread (WORKPADS=5).
      expect(m.min).toBeGreaterThanOrEqual(5);
      expect(m.sourceExpr).toMatch(/WORKPADS/);
    }
  });

  it('the Contracts parallel([()=>agent, ()=>agent]) is a fixed N=2 fan-out', () => {
    const fixed2 = plan.nodes.find(
      (n) => n.kind === 'process' && n.multiplicity.kind === 'fixed' && n.multiplicity.n === 2,
    );
    expect(fixed2, 'the 2-arm literal fan-out in the Contracts phase').toBeDefined();
  });
});

describe('default-deny + graceful degradation', () => {
  it('a malformed body → meta-only skeleton + a coded warning (lanes survive)', () => {
    const malformed = `
export const meta = {
  name: 'broken',
  phases: [{ title: 'Only', detail: 'one phase' }],
}
phase('Only')
await agent('do a thing', { label: 'x' )   // <- deliberate syntax error: ')' not '}'
return { done: true }
`;
    const plan = parsePlan(malformed, 'broken.js');
    expect(plan.derivedFrom).toBe('meta-only');
    expect(plan.warnings.some((w) => w.code === 'meta-only-wrap-parse-failed')).toBe(true);
    // The declared lane spine still survives the degradation.
    expect(plan.lanes.map((l) => l.title)).toEqual(['Only']);
    expect(plan.nodes).toEqual([]);
  });

  it('a top-level import → meta-only with code import-detected-fallback (no esbuild path)', () => {
    const withImport = `
export const meta = { name: 'imp', phases: [{ title: 'P', detail: null }] }
import { helper } from './helper.js'
phase('P')
await agent('x', { label: 'a' })
`;
    const plan = parsePlan(withImport, 'imp.js');
    expect(plan.derivedFrom).toBe('meta-only');
    expect(plan.warnings.some((w) => w.code === 'import-detected-fallback')).toBe(true);
    expect(plan.nodes).toEqual([]);
  });

  it('an unresolvable construct → an unparsed node + a coded warning (never silent)', () => {
    // A helper-wrapped agent() whose opts cannot be resolved to a literal object:
    // `parallel(buildThunks())` is unresolvable; and a bare agent() with no opts object.
    const unresolvable = `
export const meta = { name: 'uns', phases: [{ title: 'P', detail: null }] }
phase('P')
const thunks = buildThunks()
await parallel(buildThunks())
`;
    const plan = parsePlan(unresolvable, 'uns.js');
    expect(plan.derivedFrom).toBe('static-source'); // it DID wrap-parse
    const unparsed = plan.nodes.filter((n) => n.kind === 'unparsed');
    expect(unparsed.length).toBeGreaterThanOrEqual(1);
    expect(plan.warnings.some((w) => w.code === 'unparsed-statement')).toBe(true);
    // The unparsed node carries a source span (for view-source).
    expect(unparsed[0]!.annotation.span).toBeDefined();
    expect(unparsed[0]!.annotation.span!.end).toBeGreaterThan(unparsed[0]!.annotation.span!.start);
  });

  it('a file with no meta AND an unparseable body still returns a (never-null) PlanModel', () => {
    const plan = parsePlan('this is (not javascript <<<', 'junk.js');
    expect(plan).toBeTruthy();
    expect(plan.derivedFrom).toBe('meta-only');
    expect(plan.lanes).toEqual([]);
  });
});

describe('coverageRatio + format pin', () => {
  it('a clean fixture reports a high coverage ratio', () => {
    const plan = parseFixture('implement.js');
    expect(plan.coverageRatio).toBeGreaterThan(0.8);
    expect(plan.coverageRatio).toBeLessThanOrEqual(1);
  });
});
