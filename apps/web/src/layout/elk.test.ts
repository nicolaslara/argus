import { describe, it, expect } from 'vitest';
import { planLayout, type PlanLayoutInput } from './elk.ts';

// elk.ts is the elkjs-backed PLAN-AST layout engine. elkjs (elk.bundled) runs
// SYNCHRONOUSLY in-thread, so these are real (sub-second) layout passes — not mocks.
// `planLayout` owns three behaviours independent of elk's internal placement math, and
// those are what we pin here:
//   (b) phase partitioning is activated IFF EVERY top-level node carries `partition`;
//   (c) nested container child coordinates are flattened (parent offsets summed in);
//   (d) a fixed CONTAINER_HEADER (44px) is reserved at the top of a loop container;
//   (e) the synthetic 'root' node is never emitted as a placement.
//
// Timeout guard (a) is NOT unit-tested: the elk instance is a module-private const with no
// injection seam, real passes here complete in well under the 8s cap, and a genuine
// pathological-DAG pass would hang the suite. So we can't fault-inject a slow layouter
// without editing source (forbidden) — noted as a coverage gap, not exercised.

// Round helper — elk returns sub-pixel floats; structure (not exact px) is what matters.
const rx = (n: number) => Math.round(n);

describe('planLayout — phase partitioning gate (b)', () => {
  // Two UNCONNECTED top-level nodes are the cleanest probe: with partitioning OFF the
  // layered algorithm is free to pack them into the SAME layer (identical x under the
  // RIGHT direction); with partitioning ON they are forced into disjoint horizontal bands
  // (distinct x). The x relationship therefore tells us whether the gate fired.
  const nodes = (over: Partial<Record<'a' | 'b', { partition?: number | null }>> = {}) => [
    { id: 'a', width: 100, height: 40, parentId: null, isContainer: false, ...(over.a ?? {}) },
    { id: 'b', width: 100, height: 40, parentId: null, isContainer: false, ...(over.b ?? {}) },
  ];
  const layout = (n: PlanLayoutInput['nodes']) => planLayout({ nodes: n, edges: [] });

  it('activates partitioning when EVERY top-level node has a partition (disjoint bands)', async () => {
    const { placements } = await layout(nodes({ a: { partition: 1 }, b: { partition: 2 } }));
    const a = placements.get('a')!;
    const b = placements.get('b')!;
    // partition 1 vs 2 ⇒ b is pushed into a later band, never sharing a's column.
    expect(rx(b.x)).toBeGreaterThan(rx(a.x));
  });

  it('disables partitioning when ANY top-level node lacks a partition field', async () => {
    const { placements } = await layout(nodes({ a: { partition: 1 } /* b: missing */ }));
    // No gate ⇒ the two unconnected nodes are free to share a layer (same column).
    expect(rx(placements.get('a')!.x)).toBe(rx(placements.get('b')!.x));
  });

  it('treats an explicit null partition as "absent" (the `!= null` gate), so partitioning stays off', async () => {
    const { placements } = await layout(nodes({ a: { partition: 1 }, b: { partition: null } }));
    expect(rx(placements.get('a')!.x)).toBe(rx(placements.get('b')!.x));
  });

  it('keeps partitioning off when NO node carries a partition (the default workflow)', async () => {
    const { placements } = await layout(nodes());
    expect(rx(placements.get('a')!.x)).toBe(rx(placements.get('b')!.x));
  });
});

describe('planLayout — nested container flattening + header padding (c, d)', () => {
  const containerInput: PlanLayoutInput = {
    nodes: [
      { id: 'loop', width: 0, height: 0, parentId: null, isContainer: true },
      { id: 'k1', width: 80, height: 30, parentId: 'loop', isContainer: false },
      { id: 'k2', width: 80, height: 30, parentId: 'loop', isContainer: false },
    ],
    edges: [{ id: 'e1', from: 'k1', to: 'k2' }],
  };

  it('flattens child coordinates to absolute canvas space (child = parent offset + relative)', async () => {
    const { placements } = await planLayout(containerInput);
    const loop = placements.get('loop')!;
    const k1 = placements.get('k1')!;
    const k2 = placements.get('k2')!;
    // Children live INSIDE the container both horizontally and vertically once flattened.
    expect(k1.x).toBeGreaterThan(loop.x);
    expect(k2.x).toBeGreaterThan(loop.x);
    expect(k1.y).toBeGreaterThan(loop.y);
    // The container is sized to enclose its flattened children.
    expect(loop.x + loop.width).toBeGreaterThanOrEqual(k2.x + k2.width);
    expect(loop.y + loop.height).toBeGreaterThanOrEqual(k1.y + k1.height);
  });

  it('reserves the 44px CONTAINER_HEADER band: children sit at least one header below the container top', async () => {
    const { placements } = await planLayout(containerInput);
    const loop = placements.get('loop')!;
    const k1 = placements.get('k1')!;
    const k2 = placements.get('k2')!;
    const topChildY = Math.min(k1.y, k2.y);
    // The top child's inset from the container top is exactly the header band (top padding=44).
    expect(rx(topChildY - loop.y)).toBe(44);
  });
});

describe('planLayout — root exclusion + result shape (e)', () => {
  it('never emits the synthetic root node as a placement', async () => {
    const { placements } = await planLayout({
      nodes: [{ id: 'only', width: 50, height: 50, parentId: null, isContainer: false }],
      edges: [],
    });
    expect(placements.has('root')).toBe(false);
    expect(placements.has('only')).toBe(true);
    expect(placements.size).toBe(1);
  });

  it('returns a placement for every input node (top-level + nested), keyed by id', async () => {
    const { placements } = await planLayout({
      nodes: [
        { id: 'loop', width: 0, height: 0, parentId: null, isContainer: true },
        { id: 'child', width: 60, height: 20, parentId: 'loop', isContainer: false },
        { id: 'sibling', width: 60, height: 20, parentId: null, isContainer: false },
      ],
      edges: [],
    });
    expect([...placements.keys()].sort()).toEqual(['child', 'loop', 'sibling']);
    // Each placement carries the full rect contract.
    for (const p of placements.values()) {
      expect(p).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      });
    }
  });

  it('handles an empty graph without throwing (empty placements map)', async () => {
    const { placements } = await planLayout({ nodes: [], edges: [] });
    expect(placements.size).toBe(0);
  });
});
