// @argus/web — buildOverlay: the PURE web-side Plan⟷Execution morph join (P2).
//
// Binds a concrete run's agents onto its workflow's plan DAG so one graph can be shown
// two ways (template vs instance). This is the §4.3/§6 join: a function of (PlanModel,
// RunModel) → Overlay, with ZERO I/O, NO React, and a TYPES-ONLY import from the
// contract. It NEVER mutates the inputs and NEVER throws.
//
// Stance 4 (the on-disk schema is observed/untrusted): the binding lives ONLY in the
// Overlay type — `AgentNode`/`RunModel`/`PlanModel` are byte-unchanged. No edges are
// invented from timing; execution inherits Plan edges via this binding only.
//
// §6 three-way classification + tie-break (exact > prefix+index > ambiguous):
//   (1) EXACT  (high)   : the plan node's labelTemplate literal === the run agent label
//                         (a static, hole-free label). Strongest signal; wins ties.
//   (2) PREFIX (medium) : the agent label starts with the plan node's literalPrefix AND
//                         the phase matches (run Phase.title == plan PlanLane.title via
//                         phaseIndex/phaseRef), AND exactly ONE plan node owns the pair.
//   (3) AMBIGUOUS (low) : the prefix+index resolves to >1 plan node (or a phase-only
//                         fallback). Rendered as a coarse group, NO winner picked. The
//                         binding(s) are flagged `ambiguous` and NEVER auto-resolved.
//
// Mismatches are first-class:
//   - planned-not-run  : a plan agent node that bound NO agent → status:'not-run'.
//   - unplanned-agent  : a run agent whose label matched no plan node → unplannedAgentIds.
//   - partial-instance : a fan-out plan node whose bound instances are not all done →
//                         status:'partial' (succeeded<total) — drives the '6/7 done · 1
//                         failed' aggregate chip. (A dropped `.filter(Boolean)` member
//                         surfaces as run.partialFailure; the bound count reflects what ran.)

import type {
  AgentNode,
  LoopRoundBinding,
  LoopRoundInstance,
  Overlay,
  PlanBinding,
  PlanModel,
  PlanNode,
  RunModel,
} from '@argus/contract';

/** A plan agent node we can attempt to bind (has a structured label to join on). */
interface BindableNode {
  node: PlanNode;
  literalPrefix: string;
  /** True when the label is a hole-free literal (an exact-match candidate). */
  isLiteral: boolean;
  /** The plan-side phase title (via phaseRef → PlanLane.title), or null. */
  phaseTitle: string | null;
}

/** A per-agent match candidate against one plan node, tagged by its classification tier. */
interface Candidate {
  planNodeId: string;
  tier: 'exact' | 'prefix';
}

/**
 * Build the Plan⟷Execution overlay. PURE; never throws. The result paints every plan
 * AGENT node (bound or planned-not-run), records unplanned run agents, and reports the
 * observed loop-round count.
 */
export function buildOverlay(plan: PlanModel, run: RunModel): Overlay {
  // Resolve the run's phaseIndex → title (Phase.title; AgentNode has NO phaseTitle).
  // A loop body re-run records a ROUND-SUFFIXED phase (`Critique r1`, `Critique r2`);
  // normalize that suffix so the round phases all join onto the one declared plan lane.
  const runPhaseTitle = new Map<number, string>();
  for (const p of run.phases) runPhaseTitle.set(p.index, stripRoundSuffix(p.title));

  // Resolve the plan's phaseRef → PlanLane.title.
  const planLaneTitle = new Map<number, string>();
  for (const l of plan.lanes) planLaneTitle.set(l.index, l.title);

  // The bindable plan agent nodes (only kind:'agent' with a labelTemplate join key).
  const bindables: BindableNode[] = [];
  for (const node of plan.nodes) {
    if (node.kind !== 'agent' || !node.labelTemplate) continue;
    const lt = node.labelTemplate;
    bindables.push({
      node,
      literalPrefix: lt.literalPrefix,
      isLiteral: lt.holes.length === 0,
      phaseTitle: node.phaseRef != null ? (planLaneTitle.get(node.phaseRef) ?? null) : null,
    });
  }

  // --- per-agent candidate resolution (§6 tie-break) --------------------------------
  // For each run agent, collect candidate plan nodes; classify each agent into exactly
  // one bucket (exact > prefix-unique > ambiguous), or unplanned if no candidate.
  const agentToNode = new Map<string, { planNodeId: string; tier: 'exact' | 'prefix'; ambiguous: boolean }>();
  const unplannedAgentIds: string[] = [];
  // nodeId → set of agentIds that any plan node matched >1 time would mark ambiguous; we
  // track which plan nodes a given agent matched to detect 'one agent matches >1 node'.
  const ambiguousNodeIds = new Set<string>();

  for (const agent of run.agents) {
    const aPhaseTitle = runPhaseTitle.get(agent.phaseIndex) ?? null;
    const candidates = candidatesFor(agent, aPhaseTitle, bindables);

    if (candidates.length === 0) {
      unplannedAgentIds.push(agent.agentId);
      continue;
    }

    // Tie-break: prefer an EXACT match. An exact match wins outright (even over multiple
    // prefix matches) — it is the strongest signal.
    const exacts = candidates.filter((c) => c.tier === 'exact');
    if (exacts.length === 1) {
      agentToNode.set(agent.agentId, { planNodeId: exacts[0]!.planNodeId, tier: 'exact', ambiguous: false });
      continue;
    }
    if (exacts.length > 1) {
      // Two plan nodes with the SAME literal label — genuinely ambiguous, never resolved.
      for (const c of exacts) ambiguousNodeIds.add(c.planNodeId);
      // Bind to the first deterministically but flag the binding ambiguous.
      agentToNode.set(agent.agentId, { planNodeId: exacts[0]!.planNodeId, tier: 'exact', ambiguous: true });
      continue;
    }

    // No exact: fall to prefix+phaseIndex. Unique → medium; >1 → ambiguous group.
    const prefixes = candidates.filter((c) => c.tier === 'prefix');
    if (prefixes.length === 1) {
      agentToNode.set(agent.agentId, { planNodeId: prefixes[0]!.planNodeId, tier: 'prefix', ambiguous: false });
      continue;
    }
    // prefix+index AMBIGUOUS (>1 plan node owns the pair): a coarse group, NO winner.
    for (const c of prefixes) ambiguousNodeIds.add(c.planNodeId);
    agentToNode.set(agent.agentId, { planNodeId: prefixes[0]!.planNodeId, tier: 'prefix', ambiguous: true });
  }

  // --- aggregate bound agents per plan node -----------------------------------------
  const boundByNode = new Map<string, AgentNode[]>();
  const ambiguousByNode = new Map<string, boolean>();
  for (const agent of run.agents) {
    const m = agentToNode.get(agent.agentId);
    if (!m) continue;
    if (!boundByNode.has(m.planNodeId)) boundByNode.set(m.planNodeId, []);
    boundByNode.get(m.planNodeId)!.push(agent);
    if (m.ambiguous || ambiguousNodeIds.has(m.planNodeId)) ambiguousByNode.set(m.planNodeId, true);
  }

  // --- emit one PlanBinding per plan AGENT node (bound or planned-not-run) -----------
  const bindings: PlanBinding[] = [];
  for (const b of bindables) {
    const bound = boundByNode.get(b.node.id) ?? [];
    const failed = bound.filter(isFailedInstance).length;
    // succeeded = instances that actually COMPLETED (state 'done'). A still-RUNNING instance
    // (live run) is neither succeeded nor failed — it must NOT count as done (R8b).
    const succeeded = bound.filter((a) => a.state === 'done').length;
    const total = computeTotal(b.node, bound.length);
    const ambiguous = ambiguousByNode.get(b.node.id) === true;
    const confidence = classify(bound, agentToNode, b.node.id, ambiguous);
    const status = aggregateStatus(bound, succeeded, failed, total);
    bindings.push({
      planNodeId: b.node.id,
      agentIds: bound.map((a) => a.agentId),
      status,
      succeeded,
      failed,
      total,
      confidence,
      ambiguous,
    });
  }

  // --- per-round split for loop-body fans (drives the clickable round axis → DetailPanel) ---
  // `bindings` folds ALL rounds of a loop body onto one plan node; a loop-body fan's agents
  // are reached via the loop's ROUND AXIS, so we additionally split each loop body's bound
  // agents by round (re-derived per-agent from the same `:rN` / ` rN` signals observeRounds
  // reads). Buckets are grouped under the ENCLOSING loop container id (PlanNode.loopRef).
  const loopRounds: Record<string, LoopRoundBinding[]> = {};
  // phaseTitle (round-suffix STRIPPED) lookup is in runPhaseTitle; we need the RAW title to
  // recover the round, so index the raw phase title by index too.
  const runPhaseRawTitle = new Map<number, string>();
  for (const p of run.phases) runPhaseRawTitle.set(p.index, p.title);
  // Per loop id, a round → instances accumulator (a loop MAY contain >1 body node).
  const loopRoundAcc = new Map<string, Map<number, LoopRoundInstance[]>>();

  for (const b of bindables) {
    if (b.node.loopRef == null) continue; // only loop-body plan nodes feed a round axis
    const bound = boundByNode.get(b.node.id);
    if (!bound || bound.length === 0) continue;
    const loopId = b.node.loopRef;
    if (!loopRoundAcc.has(loopId)) loopRoundAcc.set(loopId, new Map());
    const byRound = loopRoundAcc.get(loopId)!;
    for (const agent of bound) {
      const round = roundOf(agent, runPhaseRawTitle.get(agent.phaseIndex) ?? null);
      if (!byRound.has(round)) byRound.set(round, []);
      byRound.get(round)!.push({ agentId: agent.agentId, label: agent.label, state: agent.state });
    }
  }

  for (const [loopId, byRound] of loopRoundAcc) {
    loopRounds[loopId] = [...byRound.entries()]
      .sort(([a], [c]) => a - c)
      .map(([round, instances]) => ({
        round,
        agentIds: instances.map((i) => i.agentId),
        instances,
      }));
  }

  return {
    bindings,
    unplannedAgentIds,
    rounds: observeRounds(run),
    ...(Object.keys(loopRounds).length > 0 ? { loopRounds } : {}),
  };
}

/**
 * Re-derive a bound agent's loop round from the SAME signals `observeRounds` reads:
 *   1. a `:rN` suffix on the agent label (`critique:…:r2`).
 *   2. a ` rN` round-suffixed phase title (`Critique r2`).
 * Falls back to round 1 (the conservative whole-body bucket) when neither is present —
 * matching `observeRounds`'s "no unrolling ⇒ a single body" default. Never invents a round.
 */
function roundOf(agent: AgentNode, rawPhaseTitle: string | null): number {
  const lm = /:r(\d+)\b/i.exec(agent.label);
  if (lm) return Number(lm[1]);
  if (rawPhaseTitle) {
    const pm = /\sr(\d+)$/i.exec(rawPhaseTitle);
    if (pm) return Number(pm[1]);
  }
  return 1;
}

/** Collect candidate plan nodes for one run agent, tagged exact|prefix. */
function candidatesFor(
  agent: AgentNode,
  agentPhaseTitle: string | null,
  bindables: BindableNode[],
): Candidate[] {
  const label = agent.label;
  if (!label) return [];
  const out: Candidate[] = [];
  for (const b of bindables) {
    // EXACT: a hole-free literal label equal to the run label.
    if (b.isLiteral && b.literalPrefix === label) {
      out.push({ planNodeId: b.node.id, tier: 'exact' });
      continue;
    }
    // PREFIX + phaseIndex: the run label starts with the static prefix AND the phase
    // (resolved to a title on both sides) matches. A non-empty prefix is required so a
    // bare/empty prefix never matches everything.
    if (
      b.literalPrefix.length > 0 &&
      label.startsWith(b.literalPrefix) &&
      phasesMatch(agentPhaseTitle, b.phaseTitle)
    ) {
      out.push({ planNodeId: b.node.id, tier: 'prefix' });
    }
  }
  return out;
}

/**
 * Phases match if both titles are known and equal. When a plan node has no resolvable
 * phase (phaseRef null), we do NOT block the prefix match on phase (the prefix carries
 * the identity) — but we never invent a phase the model lacks.
 */
function phasesMatch(agentTitle: string | null, planTitle: string | null): boolean {
  if (planTitle === null) return true; // plan node outside a declared lane: prefix-only
  if (agentTitle === null) return false; // plan expects a phase the agent can't resolve
  return agentTitle === planTitle;
}

/** The bound total: a concrete count, or 'N' when the template is unbounded and nothing bound. */
function computeTotal(node: PlanNode, boundCount: number): number | 'N' {
  if (boundCount > 0) return boundCount;
  // No instances bound. For an unbounded fan-out template, the count is unknown ('N');
  // for a fixed/one template we report 0 (planned-not-run with a known cardinality).
  if (node.multiplicity.kind === 'unbounded') return 'N';
  return 0;
}

/**
 * The §6 classification of a binding:
 *   - 'low'    : ambiguous (never auto-resolved), OR no winner.
 *   - 'high'   : at least one bound agent matched this node EXACTLY (literal).
 *   - 'medium' : bound via prefix+phaseIndex (unique).
 * A planned-not-run node (no bound agents) carries 'low' (nothing to be confident about).
 */
function classify(
  bound: AgentNode[],
  agentToNode: Map<string, { planNodeId: string; tier: 'exact' | 'prefix'; ambiguous: boolean }>,
  planNodeId: string,
  ambiguous: boolean,
): PlanBinding['confidence'] {
  if (ambiguous) return 'low';
  if (bound.length === 0) return 'low';
  const tiers = bound
    .map((a) => agentToNode.get(a.agentId))
    .filter((m): m is { planNodeId: string; tier: 'exact' | 'prefix'; ambiguous: boolean } => !!m && m.planNodeId === planNodeId);
  if (tiers.some((t) => t.tier === 'exact')) return 'high';
  return 'medium';
}

/**
 * A bound member that ran but FAILED. A genuinely failed fan-out member (e.g. the
 * `parallel[N] failed: subagent completed without calling StructuredOutput` case) is
 * dropped by the workflow's `.filter(Boolean)` and so NEVER appears in
 * `workflowProgress` — it surfaces instead as a fan-out SHORTFALL (bound count < the
 * template floor, handled in aggregateStatus) plus the run-level `partialFailure`. So a
 * bound, present agent counts as failed ONLY on a terminal failure STATE
 * (error/interrupted). Crucially, `tokens === 0` is NOT a failure — a `done` agent that
 * reports zero tokens after tool work is a token-accounting quirk of a SUCCESSFUL agent
 * (the M1 "tokens=0 ≠ nothing" rule, rendered as `tok —`); treating it as failed
 * false-flagged real done agents (e.g. review:red-team) as a partial-instance.
 */
function isFailedInstance(a: AgentNode): boolean {
  return a.state === 'error' || a.state === 'interrupted';
}

/**
 * Aggregate run status painted onto a template node:
 *   - 'not-run'  : nothing bound.
 *   - 'complete' : something bound, no failed instance, and the bound count meets the
 *                  template floor.
 *   - 'partial'  : something bound but a member failed (partial-instance), or the bound
 *                  count is below the planned floor (a member was dropped).
 */
function aggregateStatus(
  bound: AgentNode[],
  succeeded: number,
  failed: number,
  total: number | 'N',
): PlanBinding['status'] {
  if (bound.length === 0) return 'not-run';
  // If the template floor exceeds the bound count, a member was dropped → partial.
  const shortfall = typeof total === 'number' && total > bound.length;
  // 'complete' only when EVERY bound instance finished successfully (none failed, none
  // still running) and the planned floor is met. A running instance (live) → 'partial'.
  return failed === 0 && !shortfall && succeeded === bound.length ? 'complete' : 'partial';
}

/** Strip a trailing ` rN` round suffix from a phase title (`Critique r2` → `Critique`). */
function stripRoundSuffix(title: string): string {
  return title.replace(/\s+r\d+$/i, '');
}

/**
 * Observe the loop-round count from the run (folded↔unrolled mode switch). Loop unrolling
 * surfaces three observable ways, in priority order:
 *   1. a `:rN` suffix on agent labels (`critique:…:r2`) — the highest round wins.
 *   2. a ` rN` round-suffixed PHASE title (`Critique r2`) — the highest round wins.
 *   3. a base label repeated within the same phase (a `:retry` attempt loop).
 * Returns the max observed round, or `null` when no unrolling is seen. Conservative:
 * never invents rounds from timing.
 */
function observeRounds(run: RunModel): number | null {
  let maxRound = 1;
  // (1) label `:rN` suffix.
  for (const a of run.agents) {
    const m = /:r(\d+)\b/i.exec(a.label);
    if (m) maxRound = Math.max(maxRound, Number(m[1]));
  }
  // (2) phase title ` rN` suffix.
  for (const p of run.phases) {
    const m = /\sr(\d+)$/i.exec(p.title);
    if (m) maxRound = Math.max(maxRound, Number(m[1]));
  }
  if (maxRound > 1) return maxRound;
  // (3) repeated base label within one phase (a retry loop).
  const counts = new Map<string, number>();
  for (const a of run.agents) {
    const base = a.label.replace(/:retry$/, '');
    const key = `${a.phaseIndex}::${base}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let maxRep = 1;
  for (const c of counts.values()) maxRep = Math.max(maxRep, c);
  return maxRep > 1 ? maxRep : null;
}
