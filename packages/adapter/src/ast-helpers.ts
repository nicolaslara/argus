// @argus/adapter — pure AST helpers for the workflow-plan parser, extracted from plan.ts (AV13)
// so that file stays focused on the acorn wrap-parse + the PlanBuilder walk. These are format-aware
// (they read the SHAPE of a Claude Code workflow `.js`), so they live INSIDE THE ADAPTER like
// plan.ts — but they are pure + dependency-light: they operate on the local `AnyNode` structural
// view of an acorn node and reference only the contract's DecisionNode/LabelTemplate types. No I/O,
// no React, no node:*. One-directional: plan.ts imports from here; this file never imports plan.ts.

import type { DecisionNode, LabelTemplate } from '@argus/contract';

/** A structural view of an acorn AST node (we read node shapes defensively, not acorn's typed tree). */
export type AnyNode = Record<string, unknown> & { type: string; start: number; end: number };

export function isNode(v: unknown): v is AnyNode {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

export function labelTemplateFromNode(node: AnyNode): LabelTemplate | null {
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
export function exprToSource(e: AnyNode): string {
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

export function literalOrTemplateString(node: AnyNode | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    const tpl = labelTemplateFromNode(node);
    return tpl ? tpl.literalPrefix || tpl.raw : null;
  }
  return null;
}

/** Read a string-ish opt value (Literal or TemplateLiteral prefix). */
export function optStringLike(opts: AnyNode, key: string): string | null {
  const v = objectPropValue(opts, key);
  return v ? literalOrTemplateString(v) : null;
}

export function hasOptKey(opts: AnyNode, key: string): boolean {
  return objectPropValue(opts, key) !== null;
}

/** Return the value node of an object property by (literal/identifier) key. */
export function objectPropValue(obj: AnyNode, key: string): AnyNode | null {
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
export function asArrayMapCall(el: AnyNode): { arrayName: string | null; thunkBody: AnyNode } | null {
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
export function findAgentCall(node: AnyNode): AnyNode | null {
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

export function isAgentCallee(call: AnyNode): boolean {
  const callee = call.callee as AnyNode | undefined;
  return !!callee && callee.type === 'Identifier' && String(callee.name) === 'agent';
}

/** Does this subtree contain an `agent(...)` call anywhere? (cheap structural scan) */
export function containsAgentCall(node: AnyNode): boolean {
  return containsCallNamed(node, 'agent');
}
export function containsParallelCall(node: AnyNode): boolean {
  return containsCallNamed(node, 'parallel');
}
export function callContainsDslSomewhere(node: AnyNode): boolean {
  return containsAgentCall(node) || containsParallelCall(node) || containsCallNamed(node, 'phase');
}

export function containsCallNamed(node: AnyNode, name: string): boolean {
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
export function childExprs(node: AnyNode): AnyNode[] {
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
export function walkAst(node: AnyNode, visit: (n: AnyNode) => void): void {
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
export function classifyCondition(
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

export function isRegexTest(node: AnyNode): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as AnyNode | undefined;
  if (!callee || callee.type !== 'MemberExpression') return false;
  const prop = callee.property as AnyNode | undefined;
  if (!prop || prop.type !== 'Identifier' || String(prop.name) !== 'test') return false;
  const obj = callee.object as AnyNode | undefined;
  return !!obj && obj.type === 'Literal' && obj.regex !== undefined;
}

export function regexTestLabel(node: AnyNode): string {
  const callee = node.callee as AnyNode;
  const obj = callee.object as AnyNode;
  const regex = obj.regex as { pattern?: string } | undefined;
  const pat = regex?.pattern ?? '';
  // Pull a readable token out of the pattern (e.g. BUILD_GREEN).
  const token = /([A-Z][A-Z0-9_]{2,})/.exec(pat);
  return token ? `${token[1]}?` : 'verdict?';
}

export function shortExpr(node: AnyNode): string {
  if (node.type === 'BinaryExpression') {
    const left = isNode(node.left) ? exprToSource(node.left as AnyNode) : '?';
    return `${left} ${String(node.operator)} …?`;
  }
  return 'condition?';
}

// --- loop stop-condition + cap ---

export function describeStopCondition(s: AnyNode, maxRounds: number | null): string {
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
export function readLoopCap(s: AnyNode, caps: Map<string, number>): number | null {
  const name = loopBoundName(s);
  if (name === null) return null;
  return caps.get(name) ?? null;
}

/** Find the upper-bound identifier in a `x < BOUND` style while/for test. */
export function loopBoundName(s: AnyNode): string | null {
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

export function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
