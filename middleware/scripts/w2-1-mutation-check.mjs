#!/usr/bin/env node
/**
 * W2-1 (#544) mutation harness — TEMPORARY, deleted before the branch is pushed.
 *
 * For each invariant: break it in the source, rebuild `@omadia/orchestrator`,
 * re-run `test/mcpPendingInput.test.ts`, and record which assertions turn red.
 * A mutation that leaves the suite green means the test does not actually pin
 * the invariant it claims to pin.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CLIENT = 'packages/harness-orchestrator/src/mcp/mcpClient.ts';
const STORE = 'packages/harness-orchestrator/src/mcp/pendingMcpInput.ts';

const MUTATIONS = [
  {
    id: 'M1',
    label: 'drop the LENIENT_CALL_TOOL_RESULT_SCHEMA extension (SDK 1.29.0 strips the fields)',
    file: CLIENT,
    from: '  resultType: z.string().optional(),\n  inputRequests: z.unknown().optional(),\n',
    to: '',
  },
  {
    id: 'M2',
    label: 'takePending also deletes the keyed record (the "symmetry" refactor)',
    file: STORE,
    from: '    // NOTE: the keyed record is intentionally NOT removed here.',
    to: '    this.entries.delete(serializedKey);\n    // NOTE: the keyed record is intentionally NOT removed here.',
  },
  {
    id: 'M3',
    label: "park audits as 'ok' — claims a result that was never delivered",
    file: CLIENT,
    from: "this.emitCall(cfg, toolName, 'input_required', null, startedAt, actingIdentity);",
    to: "this.emitCall(cfg, toolName, 'ok', null, startedAt, actingIdentity);",
  },
  {
    id: 'M4',
    label: 'key the store on correlationId alone (the #445 shape)',
    file: STORE,
    from: '  return JSON.stringify([key.userId, key.sessionId, key.correlationId]);',
    to: '  return JSON.stringify([key.correlationId]);',
  },
  {
    id: 'M5',
    label: 'key the store on {sessionId, correlationId} — session scope without the user',
    file: STORE,
    from: '  return JSON.stringify([key.userId, key.sessionId, key.correlationId]);',
    to: '  return JSON.stringify([key.sessionId, key.correlationId]);',
  },
  {
    id: 'M6',
    label: 'route the park through handleFailure (error + retry attempt)',
    file: CLIENT,
    from: `        if (isInputRequiredResult(res)) {
          return this.parkInputRequired(`,
    to: `        if (isInputRequiredResult(res)) {
          if (attempt < 2) { lastFailure = rendered; continue; }
          return this.parkInputRequired(`,
  },
  {
    id: 'M7',
    label: 'drop the per-turn first-write-wins guard (second card overwrites the first)',
    file: STORE,
    from: "    if (slotId !== null && this.turnSlots.has(slotId)) return 'already_pending';",
    to: '',
  },
  {
    id: 'M8',
    label: 'drop the replayDepth derivation (a replay can raise card #2 forever)',
    file: CLIENT,
    from: '      replayDepth: REPLAY_ARG_KEY in args ? MCP_INPUT_MAX_REPLAY_DEPTH : 0,',
    to: '      replayDepth: 0,',
  },
  {
    id: 'M9',
    label: 'drop the TTL comparison in take() (expired records stay replayable)',
    file: STORE,
    from: `    this.entries.delete(serializedKey);
    if (entry.expiresAt <= this.now()) return undefined;
    return entry.record;`,
    to: `    this.entries.delete(serializedKey);
    return entry.record;`,
  },
  {
    id: 'M10',
    label: 'collapse every parse failure into one reason',
    file: STORE,
    from: "  if (!Array.isArray(raw)) return { ok: false, reason: 'not_an_array' };",
    to: "  if (!Array.isArray(raw)) return { ok: false, reason: 'empty' };",
  },
];

function build() {
  try {
    execFileSync('npm', ['run', 'build', '-w', '@omadia/orchestrator'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? '') };
  }
}

function runTests() {
  let out = '';
  try {
    out = execFileSync(
      'npx',
      ['tsx', '--test', '--test-reporter=tap', 'test/mcpPendingInput.test.ts'],
      { stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    out = String(err.stdout ?? '') + String(err.stderr ?? '');
  }
  const fail = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? -1);
  const pass = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? -1);
  const red = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((n) => !/^[a-z ()#\\0-9-]+$/i.test(n) || n.includes('CHECK') || n.length > 0);
  return { pass, fail, red };
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ ...m, verdict: 'ANCHOR NOT FOUND' });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  const b = build();
  if (!b.ok) {
    writeFileSync(m.file, original);
    results.push({ ...m, verdict: 'BUILD FAILED (compile-time guard)' });
    continue;
  }
  const r = runTests();
  writeFileSync(m.file, original);
  results.push({ ...m, verdict: r.fail > 0 ? 'RED' : 'STILL GREEN', ...r });
}

// Restore the real build so the tree is left consistent.
build();

console.log('\n================ W2-1 MUTATION RESULTS ================');
for (const r of results) {
  console.log(`\n${r.id} [${r.verdict}] ${r.label}`);
  if (r.fail !== undefined && r.fail >= 0) console.log(`   pass=${r.pass} fail=${r.fail}`);
  for (const n of (r.red ?? []).slice(0, 6)) console.log(`   RED: ${n}`);
}
const survived = results.filter((r) => r.verdict === 'STILL GREEN' || r.verdict === 'ANCHOR NOT FOUND');
console.log(
  `\n${results.length - survived.length}/${results.length} mutations detected.` +
    (survived.length > 0 ? ` SURVIVORS: ${survived.map((s) => s.id).join(', ')}` : ' No survivors.'),
);
