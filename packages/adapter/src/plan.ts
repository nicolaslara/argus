// @argus/adapter — parsePlan (P1, Tier-2/3). Statically derives a workflow `.js`
// script's real control-flow structure (phases, agents, fan-out/merge, decisions,
// loops, multiplicity) into a PlanModel — the SIBLING of RunModel. PURE: a source
// string in, a PlanModel out; it NEVER throws and NEVER touches disk (no node:fs).
//
// Pipeline (workpads/architecture/plan-view-design.md §2):
//   1. Tier-1 seed: reuse parseWorkflowMeta for the trustworthy phase-lane spine.
//   2. Meta-strip: reuse discovery.extractBalanced to remove the meta literal and
//      neutralize ALL top-level `export` keywords (the wrapper is a function body).
//   3. ImportDeclaration → straight to a meta-only fallback (code import-detected-fallback);
//      no speculative esbuild path.
//   4. Wrap the body as `async function __wf(agent,parallel,pipeline,phase,log,
//      workflow,budget,args){…}` and acorn.parse(sourceType:'script', ecmaVersion:2022).
//      On any wrap-parse failure → a meta-only skeleton + a coded warning.
//   5. RECURSIVE, DEFAULT-DENY walk: descend if/else (both arms), while/for bodies,
//      and .map/.filter/.flatMap thunk bodies. Recognize phase()/agent()/parallel();
//      degrade everything unresolvable to an opaque `unparsed` node + a coded warning.
//
// All `acorn` knowledge stays here (acorn is an adapter-only, now-explicit dependency;
// it never reaches web). The AST node shapes are ESTree; we keep them loosely typed
// (`AnyNode`) and default-deny on anything we do not explicitly recognize.

import * as acorn from 'acorn';
import type {
  AdapterWarning,
  Confidence,
  DecisionNode,
  LabelTemplate,
  LoopNode,
  Multiplicity,
  PlanContainer,
  PlanEdge,
  PlanLane,
  PlanModel,
  PlanNode,
} from '@argus/contract';
import { extractBalanced, parseWorkflowMeta } from './discovery.ts';

/** Observed-format pin (mirrors ADAPTER_FORMAT; kept local so plan.ts is import-light). */
const PLAN_FORMAT = 'cc-workflow/observed-2026-06-04' as const;

// ESTree nodes — loosely typed; we only read the fields we recognize and default-deny
// on anything else. `start`/`end` are byte offsets into the WRAPPED source.
type AnyNode = Record<string, unknown> & { type: string; start: number; end: number };

function isNode(v: unknown): v is AnyNode {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

/**
 * R5: classify a decision arm that produced no plan node by its top-level control-flow
 * effect (break → exit the enclosing loop, continue → next round, return → return). Used
 * to render a visible terminal for the branch so its destination is never invisible.
 */
function branchControlFlow(node: AnyNode): 'break' | 'continue' | 'return' | null {
  const stmts =
    node.type === 'BlockStatement' ? (node.body as unknown[]).filter(isNode) : [node];
  for (const s of stmts) {
    if (s.type === 'BreakStatement') return 'break';
    if (s.type === 'ContinueStatement') return 'continue';
    if (s.type === 'ReturnStatement') return 'return';
  }
  return null;
}

// ============================================================================
// Public entry — PURE, never throws.
// ============================================================================

export function parsePlan(source: string, file = ''): PlanModel {
  const meta = parseWorkflowMeta(source, file);
  const lanes: PlanLane[] = (meta?.phases ?? []).map((p, i) => ({
    index: i + 1,
    title: p.title,
    detail: p.detail,
    confidence: 'declared' as Confidence,
  }));
  const workflowName = meta?.name ?? '';
  const workflowFile = meta?.file ?? (file ? basename(file) : '');

  // A meta-only skeleton: just the declared lanes, no inner structure. Used as the
  // graceful-degradation floor for import / wrap-parse failures.
  const skeleton = (warnings: AdapterWarning[]): PlanModel => ({
    workflowFile,
    workflowName,
    lanes,
    nodes: [],
    edges: [],
    containers: lanesToContainers(lanes),
    warnings,
    derivedFrom: 'meta-only',
    coverageRatio: 0,
    format: PLAN_FORMAT,
  });

  // --- meta-strip: remove the meta literal + neutralize ALL top-level exports ---
  const body = stripMetaAndExports(source);

  // --- import detection → meta-only (no speculative esbuild) ---
  // Top-level import is illegal inside the function wrapper; detect it BEFORE wrapping
  // so we emit the precise code rather than a generic parse failure.
  if (hasTopLevelImport(body)) {
    return skeleton([{ code: 'import-detected-fallback' }]);
  }

  // --- wrap + parse ---
  const wrapped = wrap(body);
  let program: acorn.Program;
  try {
    program = acorn.parse(wrapped, { sourceType: 'script', ecmaVersion: 2022 });
  } catch {
    return skeleton([{ code: 'meta-only-wrap-parse-failed' }]);
  }

  // The single top-level statement is `async function __wf(...) { …body… }`.
  const fn = (program.body[0] as unknown as AnyNode | undefined) ?? null;
  if (!fn || fn.type !== 'FunctionDeclaration' || !isNode(fn.body)) {
    return skeleton([{ code: 'meta-only-wrap-parse-failed' }]);
  }
  const fnBody = fn.body as AnyNode; // BlockStatement
  const stmts = (fnBody.body as unknown[]).filter(isNode);

  // --- build the const-literal scope (top level only; for multiplicity resolution) ---
  const scope = collectConstArrays(stmts);
  const caps = collectNumericCaps(stmts);

  // --- recursive default-deny walk ---
  const builder = new PlanBuilder(lanes, scope, caps);
  builder.walkSequence(stmts, { phaseRef: lanes.length > 0 ? 1 : null, loopRef: null, optional: false, parentDecisionId: null });

  return {
    workflowFile,
    workflowName,
    lanes,
    nodes: builder.nodes,
    edges: builder.edges,
    containers: [...lanesToContainers(lanes), ...builder.loopContainers],
    warnings: builder.warnings,
    derivedFrom: 'static-source',
    coverageRatio: builder.coverage(),
    format: PLAN_FORMAT,
  };
}

// ============================================================================
// Meta-strip + wrap (reuse extractBalanced; no second brace regex).
// ============================================================================

/**
 * Remove the `export const meta = {…}` literal and neutralize ALL top-level export
 * keywords so the body is a valid function-body statement list. We blank (with
 * same-length spaces, to preserve byte offsets) the meta declaration, then strip the
 * `export ` keyword from any other `export const`/`export default`/`export function`.
 * extractBalanced is the SINGLE brace-balancer used here (no second weaker regex).
 */
export function stripMetaAndExports(source: string): string {
  let out = source;

  // 1. The meta literal: find `export const meta = {`, extract the balanced {…},
  //    and blank the whole `export const meta = {…}` span with spaces (preserve len).
  const metaStart = out.search(/export\s+const\s+meta\s*=\s*\{/);
  if (metaStart >= 0) {
    const braceStart = out.indexOf('{', metaStart);
    if (braceStart >= 0) {
      const literal = extractBalanced(out, braceStart);
      if (literal !== null) {
        const end = braceStart + literal.length;
        out = blank(out, metaStart, end);
      }
    }
  }

  // 2. Neutralize remaining top-level `export ` keywords (export const X / export
  //    default / export function). Replace ONLY the keyword with spaces (same length)
  //    so the declaration survives as a plain statement and byte offsets are preserved.
  out = out.replace(/(^|\n)(\s*)export\s+default\s+/g, (_m, p1: string, p2: string) =>
    `${p1}${p2}${' '.repeat('export default '.length)}`,
  );
  out = out.replace(/(^|\n)(\s*)export\s+/g, (_m, p1: string, p2: string) =>
    `${p1}${p2}${' '.repeat('export '.length)}`,
  );

  return out;
}

/** Replace [start,end) of `s` with spaces (newlines kept) to preserve byte offsets. */
function blank(s: string, start: number, end: number): string {
  const region = s.slice(start, end).replace(/[^\n]/g, ' ');
  return s.slice(0, start) + region + s.slice(end);
}

const WRAP_PREFIX = 'async function __wf(agent,parallel,pipeline,phase,log,workflow,budget,args){';
const WRAP_SUFFIX = '\n}';

function wrap(body: string): string {
  return WRAP_PREFIX + '\n' + body + WRAP_SUFFIX;
}

/** Map a byte offset in the WRAPPED source back to the original body offset. */
function unwrapOffset(offsetInWrapped: number): number {
  // prefix + '\n' precedes the body verbatim.
  return offsetInWrapped - (WRAP_PREFIX.length + 1);
}

/**
 * Detect a top-level ESM import. We only need a cheap, conservative check (the body is
 * the post-strip source). Matches `import …` / `import(` would be dynamic (allowed),
 * so we require the static `import` statement forms: `import x`, `import {`, `import *`,
 * `import '…'`. Default-deny: a false positive merely downgrades to meta-only.
 */
function hasTopLevelImport(body: string): boolean {
  return /(^|\n)\s*import\s+(?:[a-zA-Z_$*{'"]|from\b)/.test(body);
}

// ============================================================================
// Scope: in-scope const arrays-of-literals (for multiplicity).
// ============================================================================

interface ConstArrayInfo {
  /** Number of literal (non-spread) elements; null when not a literal array. */
  literalCount: number;
  /** True if EVERY element is a plain literal (→ {fixed,n}); false if it has spreads/computed. */
  allLiteral: boolean;
}

/** Collect top-level `const NAME = [ … ]` array sizes for multiplicity resolution. */
function collectConstArrays(stmts: AnyNode[]): Map<string, ConstArrayInfo> {
  const scope = new Map<string, ConstArrayInfo>();
  for (const s of stmts) {
    if (s.type !== 'VariableDeclaration') continue;
    const decls = (s.declarations as unknown[]).filter(isNode);
    for (const d of decls) {
      const id = d.id as AnyNode | undefined;
      const init = d.init as AnyNode | undefined;
      if (!id || id.type !== 'Identifier' || !init || init.type !== 'ArrayExpression') continue;
      const elements = (init.elements as unknown[]).filter(isNode);
      const hasSpread = elements.some((e) => e.type === 'SpreadElement');
      const allLiteral = !hasSpread && elements.every((e) => isPlainArrayElement(e));
      const literalCount = elements.filter((e) => e.type !== 'SpreadElement').length;
      scope.set(String(id.name), { literalCount, allLiteral });
    }
  }
  return scope;
}

/**
 * Collect top-level `const NAME = … || <number>` numeric caps (the corpus shape
 * `const MAX_ROUNDS = (args && args.maxRounds) || 3` — the literal `3` is the readable
 * loop cap). Also accepts a bare `const NAME = <number>`.
 */
function collectNumericCaps(stmts: AnyNode[]): Map<string, number> {
  const caps = new Map<string, number>();
  for (const s of stmts) {
    if (s.type !== 'VariableDeclaration') continue;
    for (const d of (s.declarations as unknown[]).filter(isNode)) {
      const id = d.id as AnyNode | undefined;
      const init = d.init as AnyNode | undefined;
      if (!id || id.type !== 'Identifier' || !init) continue;
      const cap = numericFallback(init);
      if (cap !== null) caps.set(String(id.name), cap);
    }
  }
  return caps;
}

/** Extract a readable number from `X || N`, `N`, or `(X) || N`. */
function numericFallback(node: AnyNode): number | null {
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'LogicalExpression' && String(node.operator) === '||') {
    const right = node.right as AnyNode | undefined;
    if (right && right.type === 'Literal' && typeof right.value === 'number') return right.value;
  }
  return null;
}

/** A "plain" array element for fixed-N: an object/string/number literal (a const item). */
function isPlainArrayElement(e: AnyNode): boolean {
  return (
    e.type === 'ObjectExpression' ||
    e.type === 'Literal' ||
    e.type === 'TemplateLiteral' ||
    e.type === 'ArrayExpression'
  );
}

// ============================================================================
// The recursive default-deny walk.
// ============================================================================

interface WalkCtx {
  phaseRef: number | null;
  loopRef: string | null;
  optional: boolean;
  parentDecisionId: string | null;
}

class PlanBuilder {
  nodes: PlanNode[] = [];
  edges: PlanEdge[] = [];
  warnings: AdapterWarning[] = [];
  loopContainers: PlanContainer[] = [];

  private ordinal = 0;
  private lastNodeId: string | null = null; // for flow edges in the active sequence
  private recognized = 0;
  // R5: when an if has NO else, its fall-through continuation IS the other branch — label
  // the decision's next flow edge with that branch's verdict (so both paths are clear).
  private pendingBranchLabel = new Map<string, string>();
  private total = 0;

  constructor(
    private readonly lanes: PlanLane[],
    private readonly scope: Map<string, ConstArrayInfo>,
    private readonly caps: Map<string, number>,
  ) {}

  coverage(): number {
    return this.total === 0 ? 1 : Math.min(1, this.recognized / this.total);
  }

  private nextId(prefix: string): string {
    this.ordinal += 1;
    return `${prefix}-${this.ordinal}`;
  }

  /** Resolve a phase title literal to a 1-based lane index (else null). */
  private phaseRefForTitle(title: string | null): number | null {
    if (title === null) return null;
    // Exact match first; else a prefix match (template phase titles like `Critique r${n}`
    // start with the declared lane title).
    const exact = this.lanes.find((l) => l.title === title);
    if (exact) return exact.index;
    const prefix = this.lanes.find((l) => title.startsWith(l.title) || l.title.startsWith(title.split(/\s+r?\$?\{?/)[0] ?? title));
    return prefix ? prefix.index : null;
  }

  /** Add a flow edge from the previous node in the active sequence to `toId`. */
  private flowTo(toId: string, _ctx: WalkCtx): void {
    if (this.lastNodeId && this.lastNodeId !== toId) {
      // R5: a decision with no else labels its continuation edge with the missing verdict.
      const pending = this.pendingBranchLabel.get(this.lastNodeId);
      if (pending !== undefined) {
        this.edges.push({ id: this.nextId('e-optional'), from: this.lastNodeId, to: toId, kind: 'optional', label: pending });
        this.pendingBranchLabel.delete(this.lastNodeId);
      } else {
        this.edges.push({ id: this.nextId('e-flow'), from: this.lastNodeId, to: toId, kind: 'flow' });
      }
    }
    this.lastNodeId = toId;
  }

  /** Walk an ordered statement list, threading the active-sequence cursor. */
  walkSequence(stmts: AnyNode[], ctx: WalkCtx): void {
    for (const s of stmts) {
      this.walkStatement(s, ctx);
    }
  }

  private walkStatement(s: AnyNode, ctx: WalkCtx): void {
    this.total += 1;
    switch (s.type) {
      case 'ExpressionStatement':
        this.recognized += 1;
        this.walkExpr(s.expression as AnyNode, ctx);
        return;
      case 'VariableDeclaration': {
        this.recognized += 1;
        // Walk each initializer for embedded agent()/parallel() (e.g. `const x = await parallel([...])`).
        for (const d of (s.declarations as unknown[]).filter(isNode)) {
          if (isNode(d.init)) this.walkExpr(d.init as AnyNode, ctx);
        }
        return;
      }
      case 'IfStatement':
        this.recognized += 1;
        this.walkIf(s, ctx);
        return;
      case 'WhileStatement':
      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement':
        this.recognized += 1;
        this.walkLoop(s, ctx);
        return;
      case 'ReturnStatement': {
        this.recognized += 1;
        // The return sink is an output terminal; also descend its argument for embedded calls.
        if (isNode(s.argument)) this.walkExpr(s.argument as AnyNode, ctx);
        this.emitOutput(ctx);
        return;
      }
      case 'BlockStatement':
        this.recognized += 1;
        this.walkSequence((s.body as unknown[]).filter(isNode), ctx);
        return;
      case 'TryStatement': {
        this.recognized += 1;
        if (isNode(s.block)) this.walkStatement(s.block as AnyNode, ctx);
        if (isNode(s.handler) && isNode((s.handler as AnyNode).body)) {
          this.walkStatement((s.handler as AnyNode).body as AnyNode, ctx);
        }
        return;
      }
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'EmptyStatement':
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        // Structurally inert for the plan (no top-level effect to model). Counted as
        // recognized — they are understood, just not plan-bearing.
        this.recognized += 1;
        return;
      default:
        // DEFAULT-DENY: an unrecognized statement that might carry a call → unparsed node.
        this.emitUnparsed(s, ctx, 'unparsed-statement');
        return;
    }
  }

  /** Walk an expression, recognizing the DSL calls; default-deny otherwise. */
  private walkExpr(e: AnyNode, ctx: WalkCtx): void {
    // `await X` / `(X)` → unwrap.
    if (e.type === 'AwaitExpression' && isNode(e.argument)) {
      this.walkExpr(e.argument as AnyNode, ctx);
      return;
    }
    if (e.type === 'ParenthesizedExpression' && isNode(e.expression)) {
      this.walkExpr(e.expression as AnyNode, ctx);
      return;
    }
    // `parallel(...).filter(Boolean)` / `.flatMap(...)` etc → unwrap the outer member-call
    // to find the inner DSL call (the source pattern `(await parallel(...)).filter(Boolean)`).
    if (e.type === 'CallExpression' && isNode(e.callee)) {
      const callee = e.callee as AnyNode;
      // Member call on a DSL result: descend the object, then the thunk args (for .map etc).
      if (callee.type === 'MemberExpression') {
        if (isNode(callee.object)) this.walkExpr(callee.object as AnyNode, ctx);
        // .map/.filter/.flatMap thunk bodies are descended where they appear as parallel() args.
        return;
      }
      if (callee.type === 'Identifier') {
        const name = String(callee.name);
        const calleeArgs = (e.arguments as unknown[]).filter(isNode);
        if (name === 'phase') {
          this.handlePhase(e, ctx);
          return;
        }
        if (name === 'agent') {
          this.handleAgent(e, ctx);
          return;
        }
        if (name === 'parallel') {
          this.handleParallel(e, ctx);
          return;
        }
        if (name === 'log') {
          // narration — inert, recognized.
          return;
        }
        if (name === 'pipeline' || name === 'workflow') {
          this.emitOpaqueContainer(e, name, ctx);
          return;
        }
        // Unknown identifier call that takes a thunk/array argument that may hide an
        // agent() — descend args; if it directly wraps an agent() helper-style and we
        // cannot resolve it, default-deny.
        let descended = false;
        for (const a of calleeArgs) {
          if (containsAgentCall(a)) {
            this.walkThunkOrExpr(a, ctx);
            descended = true;
          }
        }
        if (!descended && callContainsDslSomewhere(e)) {
          this.emitUnparsed(e, ctx, 'unparsed-statement');
        }
        return;
      }
    }
    // Sequence/assignment etc. that may embed a DSL call → descend conservatively.
    if (containsAgentCall(e) || containsParallelCall(e)) {
      // Descend known sub-expressions; default-deny if it's a shape we cannot place.
      for (const child of childExprs(e)) this.walkExpr(child, ctx);
    }
  }

  // --- phase(title) → switch the active lane (no node; phases are lanes/containers) ---
  private handlePhase(call: AnyNode, ctx: WalkCtx): void {
    const args = (call.arguments as unknown[]).filter(isNode);
    const title = literalOrTemplateString(args[0]);
    const ref = this.phaseRefForTitle(title);
    if (ref !== null) ctx.phaseRef = ref;
    // A phase() with an unresolvable title is tolerated (lanes seeded from meta);
    // it simply does not switch the lane. Not an unparsed node (it is a recognized call).
  }

  // --- agent(prompt, opts) → an agent PlanNode + a flow edge ---
  private handleAgent(call: AnyNode, ctx: WalkCtx, mult: Multiplicity = { kind: 'one' }): string | null {
    const args = (call.arguments as unknown[]).filter(isNode);
    const opts = args.length >= 2 && (args[1] as AnyNode).type === 'ObjectExpression' ? (args[1] as AnyNode) : null;
    // DEFAULT-DENY: an agent() with no resolvable opts object → unparsed (helper-wrapped,
    // spread opts, etc.). The label/phase carry the plan identity; without them it is opaque.
    if (!opts) {
      return this.emitUnparsed(call, ctx, 'unparsed-statement');
    }
    const labelTemplate = labelFromOpts(opts);
    const phaseTitle = optStringLike(opts, 'phase');
    const phaseRef = phaseTitle !== null ? (this.phaseRefForTitle(phaseTitle) ?? ctx.phaseRef) : ctx.phaseRef;
    const agentType = optStringLike(opts, 'agentType') ?? optStringLike(opts, 'agent_type');
    const typed = hasOptKey(opts, 'schema');

    const id = labelTemplate ? `agent:${labelTemplate.raw}:${this.nextOrdinalTag()}` : this.nextId('agent');
    const title = labelTemplate ? labelTemplate.literalPrefix || labelTemplate.raw : 'agent';
    const node: PlanNode = {
      id,
      kind: 'agent',
      title,
      labelTemplate,
      agentType,
      phaseRef,
      multiplicity: mult,
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: {
        subtitle: laneDetail(this.lanes, phaseRef),
        typed,
        source: 'static',
      },
      confidence: 'static',
    };
    this.nodes.push(node);
    this.flowTo(id, ctx);
    return id;
  }

  private ordTag = 0;
  private nextOrdinalTag(): number {
    this.ordTag += 1;
    return this.ordTag;
  }

  // --- parallel(...) → fanout split + N nodes + merge barrier ---
  // Two source shapes are resolvable:
  //   parallel([t1, t2, …])          — a literal array of arms (possibly with spreads)
  //   parallel(ARR.map(() => …))     — a single data-fanout arm (the common corpus shape)
  // Anything else (parallel(buildThunks()), parallel(x)) → unresolvable → unparsed.
  private handleParallel(call: AnyNode, ctx: WalkCtx): void {
    const args = (call.arguments as unknown[]).filter(isNode);
    const arg0 = args[0];
    let elements: AnyNode[];
    if (arg0 && arg0.type === 'ArrayExpression') {
      elements = (arg0.elements as unknown[]).filter(isNode);
    } else if (arg0 && asArrayMapCall(arg0)) {
      // `parallel(ARR.map(thunk))` — treat the single .map() call as one fanout arm.
      elements = [arg0];
    } else {
      this.emitUnparsed(call, ctx, 'unparsed-statement');
      return;
    }

    const fanoutId = this.nextId('fanout');
    // The split point: a process node anchoring the fan-out.
    this.nodes.push(this.makeProcess(fanoutId, 'fan-out', ctx, 'split'));
    this.flowTo(fanoutId, ctx);

    const armIds: string[] = [];
    let unboundedMin = 0;
    let unbounded = false;
    let unboundedExpr: string | undefined;

    for (const el of elements) {
      if (el.type === 'SpreadElement') {
        // `...ARR.map(() => agent(...))` → unbounded, contributing ARR's literalCount to min.
        unbounded = true;
        const inner = (el as AnyNode).argument as AnyNode | undefined;
        const sub = inner ? this.fanoutArm(inner, fanoutId, ctx, true) : null;
        if (sub) {
          armIds.push(sub.id);
          unboundedMin += sub.min;
          unboundedExpr = sub.sourceExpr ?? unboundedExpr;
        }
        continue;
      }
      // A literal arm: `() => agent(...)` thunk, or a bare `agent(...)`, or `ARR.map(...)`.
      const sub = this.fanoutArm(el, fanoutId, ctx, false);
      if (!sub) continue;
      armIds.push(sub.id);
      if (sub.unbounded) {
        unbounded = true;
        unboundedMin += sub.min;
        unboundedExpr = sub.sourceExpr ?? unboundedExpr;
      } else {
        unboundedMin += sub.min;
      }
    }

    // The merge barrier (N→1). Edges from each arm node converge here.
    const mergeId = this.nextId('merge');
    this.nodes.push(this.makeProcess(mergeId, 'merge', ctx, 'merge'));
    for (const armId of armIds) {
      this.edges.push({ id: this.nextId('e-merge'), from: armId, to: mergeId, kind: 'merge' });
    }
    // The active-sequence cursor continues from the barrier.
    this.lastNodeId = mergeId;

    // Stamp an aggregate multiplicity onto the fanout split for the UI summary chip.
    const splitNode = this.nodes.find((n) => n.id === fanoutId);
    if (splitNode) {
      splitNode.multiplicity = unbounded
        ? { kind: 'unbounded', min: unboundedMin, max: 'N', sourceExpr: unboundedExpr }
        : { kind: 'fixed', n: unboundedMin || armIds.length };
    }
  }

  /**
   * One arm of a parallel([...]) array. Returns the arm node id + its multiplicity
   * contribution, plus a fanout edge from the split. Recognizes:
   *   - `() => agent(opts)` arrow thunk            → one agent node
   *   - `agent(opts)`                              → one agent node
   *   - `ARR.map((x) => agent(opts))`              → one agent node, multiplicity from ARR
   *   - `ARR.map(...) ` inside a SpreadElement     → unbounded
   * Default-deny: an arm we cannot resolve → an unparsed node.
   */
  private fanoutArm(
    el: AnyNode,
    fanoutId: string,
    ctx: WalkCtx,
    inSpread: boolean,
  ): { id: string; min: number; unbounded: boolean; sourceExpr?: string } | null {
    const armCtx: WalkCtx = { ...ctx };
    const prevLast = this.lastNodeId;
    this.lastNodeId = null; // arms branch from the split, not from the previous arm

    let result: { id: string; min: number; unbounded: boolean; sourceExpr?: string } | null = null;

    // ARR.map(thunk) → multiplicity from the const array; the thunk body holds agent().
    const mapInfo = asArrayMapCall(el);
    if (mapInfo) {
      const info = mapInfo.arrayName ? this.scope.get(mapInfo.arrayName) : undefined;
      const fixed = !inSpread && info && info.allLiteral;
      const min = info ? info.literalCount : 0;
      const mult: Multiplicity = fixed
        ? { kind: 'fixed', n: info!.literalCount }
        : { kind: 'unbounded', min, max: 'N', sourceExpr: mapInfo.arrayName ? `one per item in ${mapInfo.arrayName}` : undefined };
      const id = this.emitAgentFromThunk(mapInfo.thunkBody, armCtx, mult);
      if (id) {
        this.edges.push({ id: this.nextId('e-fanout'), from: fanoutId, to: id, kind: 'fanout' });
        result = { id, min, unbounded: !fixed, sourceExpr: mapInfo.arrayName ? `one per item in ${mapInfo.arrayName}` : undefined };
      }
    } else {
      // A thunk `() => agent(...)` or a bare `agent(...)`.
      const id = this.emitAgentFromThunk(el, armCtx, { kind: 'one' });
      if (id) {
        this.edges.push({ id: this.nextId('e-fanout'), from: fanoutId, to: id, kind: 'fanout' });
        result = { id, min: 1, unbounded: false };
      }
    }

    this.lastNodeId = prevLast;
    return result;
  }

  /**
   * Extract the agent() call from a thunk/arm and emit it. Handles:
   *   `() => agent(...)`, `(x) => agent(...)`, `() => { … return agent(...) }`, `agent(...)`.
   * Default-deny: no agent() found → an unparsed node.
   */
  private emitAgentFromThunk(el: AnyNode, ctx: WalkCtx, mult: Multiplicity): string | null {
    const agentCall = findAgentCall(el);
    if (agentCall) {
      return this.handleAgent(agentCall, ctx, mult);
    }
    return this.emitUnparsed(el, ctx, 'unparsed-statement');
  }

  /** Descend a thunk/expr that we know contains an agent() (helper-call args, etc.). */
  private walkThunkOrExpr(el: AnyNode, ctx: WalkCtx): void {
    const agentCall = findAgentCall(el);
    if (agentCall) {
      this.handleAgent(agentCall, ctx);
    } else {
      this.emitUnparsed(el, ctx, 'unparsed-statement');
    }
  }

  // --- if/else → decision diamond + optional (dashed) branches ---
  private walkIf(s: AnyNode, ctx: WalkCtx): void {
    const test = s.test as AnyNode | undefined;
    const { conditionKind, conditionLabel } = classifyCondition(test);
    const decisionId = this.nextId('decision');
    const decision: DecisionNode = {
      id: decisionId,
      kind: 'decision',
      title: conditionLabel,
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static' },
      confidence: 'static',
      conditionKind,
      conditionLabel,
    };
    this.nodes.push(decision);
    this.flowTo(decisionId, ctx);

    // R5: classifyCondition de-negates the displayed label (`!implGreen` → "implGreen?"),
    // so when the test is negated the CONSEQUENT runs on the *false* verdict and the
    // ALTERNATE on *true* — swap the arm labels to match the displayed question.
    const negated = isNode(test) && test.type === 'UnaryExpression' && (test as AnyNode).operator === '!';
    const consequentLabel = negated ? 'false' : 'true';
    const alternateLabel = negated ? 'true' : 'false';

    // Both arms are OPTIONAL (conditional) and parented to this decision. The
    // active-sequence cursor restarts from the decision for each arm so branch nodes
    // attach to the diamond via dashed `optional` edges (not to each other linearly).
    const branchCtx: WalkCtx = { ...ctx, optional: true, parentDecisionId: decisionId };

    const consEmitted = isNode(s.consequent)
      ? this.walkBranch(s.consequent as AnyNode, branchCtx, decisionId, consequentLabel)
      : false;
    const altEmitted = isNode(s.alternate)
      ? this.walkBranch(s.alternate as AnyNode, branchCtx, decisionId, alternateLabel)
      : false;
    // R5: label the decision's CONTINUATION (fall-through) edge with the verdict of the arm
    // that produced no node — so both paths read clearly even when one arm just falls
    // through (no else → the implicit else; or a node-less arm like `{ log(...) }`).
    let pending: string | undefined;
    if (!isNode(s.alternate) || !altEmitted) pending = alternateLabel;
    if (isNode(s.consequent) && !consEmitted) pending = consequentLabel;
    if (pending !== undefined) this.pendingBranchLabel.set(decisionId, pending);
    // After the if/else, the sequence continues from the decision node.
    this.lastNodeId = decisionId;
  }

  /** Walk one decision arm; the first node of the arm gets a dashed `optional` edge.
   *  Returns true iff the arm produced a node (or a control-flow terminal) + its edge. */
  private walkBranch(node: AnyNode, ctx: WalkCtx, decisionId: string, label: string): boolean {
    const before = this.nodes.length;
    const savedLast = this.lastNodeId;
    this.lastNodeId = null;
    if (node.type === 'BlockStatement') {
      this.walkSequence((node.body as unknown[]).filter(isNode), ctx);
    } else {
      this.walkStatement(node, ctx);
    }
    let firstNew: PlanNode | undefined = this.nodes.slice(before)[0];
    if (!firstNew) {
      // R5: the arm produced no plan node. If it is a control-flow EXIT (break/continue/
      // return), emit a tiny terminal so the branch + its destination are VISIBLE — this
      // fixes "the true branch goes nowhere / both go to the same place" (e.g. refine-plan's
      // `if (material.length===0) break`). A pure fall-through (no exit) needs no node.
      const cf = branchControlFlow(node);
      if (cf) {
        const title = cf === 'break' ? 'exit loop' : cf === 'continue' ? 'next round' : 'return';
        this.pushBranchTerminal(title, ctx);
        firstNew = this.nodes[this.nodes.length - 1];
      }
    }
    if (firstNew) {
      this.edges.push({
        id: this.nextId('e-optional'),
        from: decisionId,
        to: firstNew.id,
        kind: 'optional',
        label,
      });
    }
    this.lastNodeId = savedLast;
    return firstNew !== undefined;
  }

  /** A tiny terminal pill for a control-flow-only decision arm (break/continue/return). */
  private pushBranchTerminal(title: string, ctx: WalkCtx): void {
    this.nodes.push({
      id: this.nextId('branch'),
      kind: 'output',
      title,
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: true,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static' },
      confidence: 'static',
    });
  }

  // --- while/for → loop container + dashed loop-back + stop-condition ---
  private walkLoop(s: AnyNode, ctx: WalkCtx): void {
    const loopId = this.nextId('loop');
    const maxRounds = readLoopCap(s, this.caps);
    const stopCondition = describeStopCondition(s, maxRounds);
    const loop: LoopNode = {
      id: loopId,
      kind: 'loop',
      title: 'loop',
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: stopCondition, typed: false, source: 'static' },
      confidence: 'static',
      stopCondition,
      maxRounds,
    };
    this.nodes.push(loop);
    this.flowTo(loopId, ctx);

    const bodyCtx: WalkCtx = { ...ctx, loopRef: loopId };
    const before = this.nodes.length;
    const savedLast = this.lastNodeId;
    this.lastNodeId = loopId;
    if (isNode(s.body)) {
      if ((s.body as AnyNode).type === 'BlockStatement') {
        this.walkSequence(((s.body as AnyNode).body as unknown[]).filter(isNode), bodyCtx);
      } else {
        this.walkStatement(s.body as AnyNode, bodyCtx);
      }
    }
    const loopBodyNodes = this.nodes.slice(before);
    const container: PlanContainer = {
      id: loopId,
      kind: 'loop',
      title: loop.title,
      detail: stopCondition,
      childIds: loopBodyNodes.map((n) => n.id),
    };
    this.loopContainers.push(container);

    // The dashed loop-back edge: last body node → loop head, labeled with the stop condition.
    const lastBody = this.lastNodeId;
    if (lastBody && lastBody !== loopId) {
      this.edges.push({
        id: this.nextId('e-loopback'),
        from: lastBody,
        to: loopId,
        kind: 'loop-back',
        label: stopCondition,
      });
    }
    // After the loop, the sequence continues from the loop node.
    this.lastNodeId = savedLast === null ? loopId : loopId;
  }

  // --- terminals + opaque containers + unparsed ---

  private emitOutput(ctx: WalkCtx): void {
    // Only one output terminal per sequence cursor; collapse repeats.
    const existing = this.nodes.find((n) => n.kind === 'output' && n.loopRef === ctx.loopRef && n.parentDecisionId === ctx.parentDecisionId);
    if (existing) {
      this.flowTo(existing.id, ctx);
      return;
    }
    const id = this.nextId('output');
    this.nodes.push({
      id,
      kind: 'output',
      title: 'return',
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static' },
      confidence: 'static',
    });
    this.flowTo(id, ctx);
  }

  private makeProcess(id: string, title: string, ctx: WalkCtx, kindTag: string): PlanNode {
    return {
      id,
      kind: 'process',
      title: kindTag === 'split' ? 'fan-out' : title,
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static' },
      confidence: 'static',
    };
  }

  private emitOpaqueContainer(call: AnyNode, name: string, ctx: WalkCtx): void {
    const id = this.nextId(name);
    this.nodes.push({
      id,
      kind: name === 'pipeline' ? 'pipeline' : 'subworkflow',
      title: name,
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static' },
      confidence: 'static',
    });
    this.flowTo(id, ctx);
  }

  /** Default-deny: an unresolvable construct → an `unparsed` node + a coded warning. */
  private emitUnparsed(node: AnyNode, ctx: WalkCtx, code: string): string {
    const id = this.nextId('unparsed');
    const start = unwrapOffset(node.start);
    const end = unwrapOffset(node.end);
    this.nodes.push({
      id,
      kind: 'unparsed',
      title: 'unparsed',
      labelTemplate: null,
      agentType: null,
      phaseRef: ctx.phaseRef,
      multiplicity: { kind: 'one' },
      optional: ctx.optional,
      loopRef: ctx.loopRef,
      parentDecisionId: ctx.parentDecisionId,
      annotation: { subtitle: null, typed: false, source: 'static', span: { start, end } },
      confidence: 'heuristic',
    });
    this.warnings.push({ code, detail: node.type });
    this.flowTo(id, ctx);
    return id;
  }
}

// ============================================================================
// AST helpers (pure, ESTree-shape readers; default-deny on anything unexpected).
// ============================================================================

function lanesToContainers(lanes: PlanLane[]): PlanContainer[] {
  return lanes.map((l) => ({
    id: `lane-${l.index}`,
    kind: 'lane' as const,
    title: l.title,
    detail: l.detail,
    childIds: [],
  }));
}

function laneDetail(lanes: PlanLane[], phaseRef: number | null): string | null {
  if (phaseRef === null) return null;
  return lanes.find((l) => l.index === phaseRef)?.detail ?? null;
}

/** Build the structured LabelTemplate from an opts object's `label` value. */
function labelFromOpts(opts: AnyNode): LabelTemplate | null {
  const labelNode = objectPropValue(opts, 'label');
  if (!labelNode) return null;
  return labelTemplateFromNode(labelNode);
}

function labelTemplateFromNode(node: AnyNode): LabelTemplate | null {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { literalPrefix: node.value, holes: [], raw: node.value };
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = (node.quasis as unknown[]).filter(isNode);
    const exprs = (node.expressions as unknown[]).filter(isNode);
    // literalPrefix = the leading static cooked text up to the first hole.
    const firstCooked =
      quasis.length > 0 ? String(((quasis[0] as AnyNode).value as { cooked?: unknown })?.cooked ?? '') : '';
    const holes = exprs.map((e) => exprToSource(e));
    // raw: reconstruct `prefix${hole}…` from quasis + holes (best-effort, for ids).
    let raw = '';
    for (let i = 0; i < quasis.length; i += 1) {
      raw += String(((quasis[i] as AnyNode).value as { cooked?: unknown })?.cooked ?? '');
      if (i < holes.length) raw += '${' + holes[i] + '}';
    }
    return { literalPrefix: firstCooked, holes, raw };
  }
  return null;
}

/** A best-effort textual rendering of a simple expression (for holes / ids). */
function exprToSource(e: AnyNode): string {
  switch (e.type) {
    case 'Identifier':
      return String(e.name);
    case 'MemberExpression': {
      const obj = isNode(e.object) ? exprToSource(e.object as AnyNode) : '?';
      const prop = isNode(e.property) ? exprToSource(e.property as AnyNode) : '?';
      return (e.computed as boolean) ? `${obj}[${prop}]` : `${obj}.${prop}`;
    }
    case 'Literal':
      return String(e.value);
    default:
      return e.type;
  }
}

function literalOrTemplateString(node: AnyNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const tpl = labelTemplateFromNode(node);
    return tpl ? tpl.literalPrefix || tpl.raw : null;
  }
  return null;
}

/** Read a string-ish opt value (Literal or TemplateLiteral prefix). */
function optStringLike(opts: AnyNode, key: string): string | null {
  const v = objectPropValue(opts, key);
  return v ? literalOrTemplateString(v) : null;
}

function hasOptKey(opts: AnyNode, key: string): boolean {
  return objectPropValue(opts, key) !== null;
}

/** Return the value node of an object property by (literal/identifier) key. */
function objectPropValue(obj: AnyNode, key: string): AnyNode | null {
  if (obj.type !== 'ObjectExpression') return null;
  for (const p of (obj.properties as unknown[]).filter(isNode)) {
    if (p.type !== 'Property') continue;
    const k = p.key as AnyNode;
    const name = k.type === 'Identifier' ? String(k.name) : k.type === 'Literal' ? String(k.value) : null;
    if (name === key && isNode(p.value)) return p.value as AnyNode;
  }
  return null;
}

/** Match `ARR.map(thunk)` (or `.flatMap`/`.filter` carrying a thunk). */
function asArrayMapCall(el: AnyNode): { arrayName: string | null; thunkBody: AnyNode } | null {
  if (el.type !== 'CallExpression') return null;
  const callee = el.callee as AnyNode | undefined;
  if (!callee || callee.type !== 'MemberExpression') return null;
  const prop = callee.property as AnyNode | undefined;
  const method = prop && prop.type === 'Identifier' ? String(prop.name) : null;
  if (method !== 'map' && method !== 'flatMap') return null;
  const obj = callee.object as AnyNode | undefined;
  const arrayName = obj && obj.type === 'Identifier' ? String(obj.name) : null;
  const args = (el.arguments as unknown[]).filter(isNode);
  const thunk = args[0];
  if (!thunk) return null;
  return { arrayName, thunkBody: thunk };
}

/**
 * Find the agent() CallExpression inside a thunk / arrow / expression. Handles:
 *   `() => agent(...)`, `(x) => () => agent(...)` (curried), `() => { return agent(...) }`,
 *   `agent(...)`, `await agent(...)`.
 */
function findAgentCall(node: AnyNode): AnyNode | null {
  if (node.type === 'CallExpression' && isAgentCallee(node)) return node;
  if (node.type === 'AwaitExpression' && isNode(node.argument)) return findAgentCall(node.argument as AnyNode);
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    const body = node.body as AnyNode | undefined;
    if (body) return findAgentCall(body);
  }
  if (node.type === 'BlockStatement') {
    for (const s of (node.body as unknown[]).filter(isNode)) {
      if (s.type === 'ReturnStatement' && isNode(s.argument)) {
        const found = findAgentCall(s.argument as AnyNode);
        if (found) return found;
      }
      if (s.type === 'ExpressionStatement' && isNode(s.expression)) {
        const found = findAgentCall(s.expression as AnyNode);
        if (found) return found;
      }
    }
  }
  if (node.type === 'ReturnStatement' && isNode(node.argument)) return findAgentCall(node.argument as AnyNode);
  return null;
}

function isAgentCallee(call: AnyNode): boolean {
  const callee = call.callee as AnyNode | undefined;
  return !!callee && callee.type === 'Identifier' && String(callee.name) === 'agent';
}

/** Does this subtree contain an `agent(...)` call anywhere? (cheap structural scan) */
function containsAgentCall(node: AnyNode): boolean {
  return containsCallNamed(node, 'agent');
}
function containsParallelCall(node: AnyNode): boolean {
  return containsCallNamed(node, 'parallel');
}
function callContainsDslSomewhere(node: AnyNode): boolean {
  return containsAgentCall(node) || containsParallelCall(node) || containsCallNamed(node, 'phase');
}

function containsCallNamed(node: AnyNode, name: string): boolean {
  let found = false;
  walkAst(node, (n) => {
    if (
      n.type === 'CallExpression' &&
      isNode(n.callee) &&
      (n.callee as AnyNode).type === 'Identifier' &&
      String((n.callee as AnyNode).name) === name
    ) {
      found = true;
    }
  });
  return found;
}

/** Immediate child expressions to descend (conservative; structural). */
function childExprs(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const v = (node as Record<string, unknown>)[key];
    if (isNode(v)) out.push(v);
    else if (Array.isArray(v)) for (const item of v) if (isNode(item)) out.push(item);
  }
  return out;
}

/** Depth-first AST visitor over every node-shaped value (for cheap structural scans). */
function walkAst(node: AnyNode, visit: (n: AnyNode) => void): void {
  visit(node);
  for (const child of childExprs(node)) walkAst(child, visit);
}

// --- decision classification ---

/**
 * Classify an if-test into the design's condition kinds:
 *   - `regex-verdict`: a `/RE/.test(x)` (or a const initialized from one) — the BUILD_GREEN gate.
 *   - `schema-field`: a bare schema-field guard (`selection.blocked_reason`, `x.field`).
 *   - `expr`: anything else.
 * The label is best-effort, human-readable, and ends with `?`.
 */
function classifyCondition(
  test: AnyNode | undefined,
): { conditionKind: DecisionNode['conditionKind']; conditionLabel: string } {
  if (!test) return { conditionKind: 'expr', conditionLabel: 'condition?' };

  // `!green` / `green` where the named const was `= /RE/.test(...)` → regex-verdict.
  // We classify by the test SHAPE here; the const-origin is captured by the name.
  const unary = test.type === 'UnaryExpression' && String(test.operator) === '!' ? (test.argument as AnyNode) : null;
  const core = unary ?? test;

  // Direct `/RE/.test(x)`
  if (isRegexTest(core)) {
    return { conditionKind: 'regex-verdict', conditionLabel: regexTestLabel(core) };
  }
  // `green` (Identifier) — name often derives from a regex .test() result.
  if (core.type === 'Identifier') {
    const name = String(core.name);
    return { conditionKind: 'regex-verdict', conditionLabel: `${name.toUpperCase()}?` };
  }
  // `x.field` schema-field guard (e.g. selection.blocked_reason).
  if (core.type === 'MemberExpression') {
    const prop = core.property as AnyNode | undefined;
    const field = prop && prop.type === 'Identifier' ? String(prop.name) : 'field';
    return { conditionKind: 'schema-field', conditionLabel: `${field}?` };
  }
  // `material.length === 0` etc → expr.
  if (core.type === 'BinaryExpression' || core.type === 'LogicalExpression') {
    return { conditionKind: 'expr', conditionLabel: shortExpr(core) };
  }
  return { conditionKind: 'expr', conditionLabel: 'condition?' };
}

function isRegexTest(node: AnyNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as AnyNode | undefined;
  if (!callee || callee.type !== 'MemberExpression') return false;
  const prop = callee.property as AnyNode | undefined;
  if (!prop || prop.type !== 'Identifier' || String(prop.name) !== 'test') return false;
  const obj = callee.object as AnyNode | undefined;
  return !!obj && obj.type === 'Literal' && obj.regex !== undefined;
}

function regexTestLabel(node: AnyNode): string {
  const callee = node.callee as AnyNode;
  const obj = callee.object as AnyNode;
  const regex = obj.regex as { pattern?: string } | undefined;
  const pat = regex?.pattern ?? '';
  // Pull a readable token out of the pattern (e.g. BUILD_GREEN).
  const token = /([A-Z][A-Z0-9_]{2,})/.exec(pat);
  return token ? `${token[1]}?` : 'verdict?';
}

function shortExpr(node: AnyNode): string {
  if (node.type === 'BinaryExpression') {
    const left = isNode(node.left) ? exprToSource(node.left as AnyNode) : '?';
    return `${left} ${String(node.operator)} …?`;
  }
  return 'condition?';
}

// --- loop stop-condition + cap ---

function describeStopCondition(s: AnyNode, maxRounds: number | null): string {
  if (maxRounds !== null) return `until done · max ${maxRounds}`;
  if (s.type === 'WhileStatement') return 'until condition';
  if (s.type === 'ForOfStatement' || s.type === 'ForInStatement') return 'per item';
  return 'loop';
}

/**
 * Read a static loop cap. The corpus shape is `while (round < MAX_ROUNDS && !dry)` with
 * `const MAX_ROUNDS = (args && args.maxRounds) || 3` at top level — the literal `3` is
 * readable. Scan the test for an Identifier compared with `<`/`<=` and look it up in the
 * numeric-caps scope. Returns null if unreadable.
 */
function readLoopCap(s: AnyNode, caps: Map<string, number>): number | null {
  const name = loopBoundName(s);
  if (name === null) return null;
  return caps.get(name) ?? null;
}

/** Find the upper-bound identifier in a `x < BOUND` style while/for test. */
function loopBoundName(s: AnyNode): string | null {
  const test = s.test as AnyNode | undefined;
  if (!test) return null;
  let found: string | null = null;
  walkAst(test, (n) => {
    if (n.type === 'BinaryExpression' && (String(n.operator) === '<' || String(n.operator) === '<=')) {
      const right = n.right as AnyNode | undefined;
      if (right && right.type === 'Identifier') found = String(right.name);
    }
  });
  return found;
}

function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
