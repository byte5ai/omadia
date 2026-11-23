/**
 * #2088 — every reader of `agents` and of a table that references it says
 * whether it means live agents or all rows.
 *
 * Deleting an agent keeps its row as a tombstone (migration 0072) and drops
 * nothing that references it. A query written without that in mind would
 * bring a deleted agent back: its schedules would fire, its grants would be
 * listed, its identity would be walked. This test reads the source and fails
 * when a query on one of these tables is neither scoped to one agent, nor
 * filtered with `ofLiveAgent` / `liveAgentRow`, nor on the list below with
 * its reason.
 *
 * It is a source check on purpose: the failure it guards against is a NEW
 * query somebody adds later, which no behavioural test written today covers.
 */

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `agents` and every table with a foreign key to it. */
const TABLES = [
  'agents',
  'agent_identities',
  'agent_plugins',
  'agent_tool_grants',
  'agent_persona_skills',
  'agent_subagents',
  'agent_schedules',
  'agent_channel_policies',
  'channel_bindings',
  'conversation_message_subscriptions',
  'agent_teams_identities',
  // #2055 — the management layer's tables (migrations 0081–0083).
  'agent_default_entries',
  'agent_selections',
  'agent_availability_principals',
];

/** A query that is about ONE agent, row or key: its id came from a caller
 *  that already holds a live agent (or addresses a row directly). */
const SCOPED = [
  /\bagent_id\s*=\s*\$\d/,
  /\bparent_agent_id\s*=\s*\$\d/,
  /\ba\.(id|slug)\s*=\s*\$\d/,
  /\bWHERE\s+id\s*=\s*\$\d/i,
  /\bs\.id\s*=\s*/,
  /\bid\s*=\s*ANY\(/,
  /\bsubscription_id\s*=\s*\$\d/,
];
const FILTERED = [/ofLiveAgent\(/, /liveAgentRow\(/, /LIVE_AGENT/];

/**
 * Reads that deliberately include tombstones, or that are not about agents
 * at all. `file::table::marker` → why. The marker is a piece of the query, so
 * an entry cannot silently cover a different query in the same file.
 */
const DELIBERATE: Record<string, string> = {
  'packages/harness-orchestrator/src/registry/configStore.ts::channel_bindings::ORDER BY channel_type, channel_key':
    'a conversation bound to a deleted agent must be seen as bound: routing refuses it instead of handing it to the default agent',
  'packages/harness-orchestrator/src/registry/configStore.ts::channel_bindings::channel_type = $1':
    'a binding is addressed by its channel key; one that points to a deleted agent is refused by routing',
  'packages/harness-orchestrator/src/registry/configStore.ts::agent_teams_identities::app_id IS NOT NULL':
    "a deleted agent's bot must stay known as an agent's own bot: it goes quiet, it never falls back to another agent",
  'packages/harness-orchestrator/src/registry/configStore.ts::agents::a.deleted_at IS NOT NULL':
    'the list of tombstones itself',
  'packages/harness-orchestrator/src/registry/configStore.ts::agent_identities::a.deleted_slug':
    'the list of tombstones itself, with the name each one wore',
  'packages/harness-orchestrator/src/registry/tombstones.ts::agents::deleted_at':
    'the tombstone condition itself',
  'src/channels/conversationMessages/pgStore.ts::conversation_message_subscriptions::channel_type = $1':
    'a subscription is addressed by conversation and identity; it was ended when its agent was deleted',
  'packages/harness-orchestrator/src/registry/routingTables.ts::agent_default_entries::ORDER BY principal NULLS LAST':
    'a default-agent entry that names a deleted agent keeps naming it: the message gets "<name> was deleted", never another agent (#2055, spec 2042 §5.10)',
  'packages/harness-orchestrator/src/registry/routingTables.ts::agent_selections::conversation_key, principal, agent_id, selected_at':
    'a selection that names a deleted agent keeps naming it until the user chooses again: "<name> was deleted", never another agent (#2055)',
  'src/channels/conversationMessages/pgStore.ts::conversation_message_subscriptions::ended_at IS NOT NULL':
    'the purge of ended subscriptions, whoever they belonged to',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'migrations' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Finding {
  readonly file: string;
  readonly table: string;
  readonly line: number;
  readonly statement: string;
}

/** Every SELECT that reads one of the tables, with the text of its statement. */
function reads(): Finding[] {
  const findings: Finding[] = [];
  const files = [
    ...sourceFiles(join(ROOT, 'src')),
    ...readdirSync(join(ROOT, 'packages')).flatMap((pkg) => {
      const src = join(ROOT, 'packages', pkg, 'src');
      try {
        return statSync(src).isDirectory() ? sourceFiles(src) : [];
      } catch {
        return [];
      }
    }),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const table of TABLES) {
      const pattern = new RegExp(`\\b(FROM|JOIN)\\s+${table}\\b`, 'g');
      for (const match of text.matchAll(pattern)) {
        const at = match.index ?? 0;
        // The statement: back to the SELECT / DELETE / UPDATE that opens it,
        // forward to the end of the string literal(s) it is written in.
        const before = text.slice(Math.max(0, at - 600), at);
        const opener = Math.max(before.lastIndexOf('SELECT'), before.lastIndexOf('DELETE'), before.lastIndexOf('UPDATE'));
        const head = opener >= 0 ? before.slice(opener) : '';
        const tail = text.slice(at, at + 700).split(/\);|\n\s*\n/)[0] ?? '';
        const statement = head + tail;
        // A comment that merely names a table is not a query.
        const lineStart = text.lastIndexOf('\n', at) + 1;
        if (/^\s*(\*|\/\/)/.test(text.slice(lineStart, at))) continue;
        // Writes that remove or address rows are not reads of other agents.
        if (/^DELETE\b/.test(head) || (/^UPDATE\b/.test(head) && !/\bSELECT\b/.test(head.slice(6)))) continue;
        findings.push({
          file: relative(ROOT, file),
          table,
          line: text.slice(0, at).split('\n').length,
          statement,
        });
      }
    }
  }
  return findings;
}

describe('readers of agents and its children exclude tombstones', () => {
  const all = reads();

  it('finds the queries it is meant to check', () => {
    assert.ok(all.length >= 25, `only ${String(all.length)} reads found: the scan is not looking at the source`);
    for (const table of TABLES) {
      assert.ok(all.some((f) => f.table === table), `no read of ${table} found`);
    }
  });

  it('every read is scoped to one agent, filtered, or deliberately includes tombstones', () => {
    const used = new Set<string>();
    const unexplained = all.filter((finding) => {
      if (SCOPED.some((re) => re.test(finding.statement))) return false;
      if (FILTERED.some((re) => re.test(finding.statement))) return false;
      const key = Object.keys(DELIBERATE).find((k) => {
        const [file, table, marker] = k.split('::');
        return file === finding.file && table === finding.table && finding.statement.includes(marker!);
      });
      if (key) {
        used.add(key);
        return false;
      }
      return true;
    });
    assert.deepEqual(
      unexplained.map((f) => `${f.file}:${String(f.line)} reads ${f.table} across agents without ofLiveAgent(): ${f.statement.replace(/\s+/g, ' ').slice(0, 160)}`),
      [],
      'a deleted agent (tombstone) would be read by these queries; filter with ofLiveAgent(), or add the query to DELIBERATE with its reason',
    );
    assert.deepEqual(
      Object.keys(DELIBERATE).filter((k) => !used.has(k)),
      [],
      'entries of DELIBERATE that match no query any more: remove them',
    );
  });

  it('`agents` itself is read in the config store only', () => {
    const elsewhere = all.filter(
      (f) =>
        f.table === 'agents' &&
        !f.file.endsWith('registry/configStore.ts') &&
        !f.file.endsWith('registry/tombstones.ts') &&
        // `ofLiveAgent` expands to a sub-select on agents: that IS the filter.
        !FILTERED.some((re) => re.test(f.statement)),
    );
    assert.deepEqual(elsewhere.map((f) => `${f.file}:${String(f.line)}`), []);
  });
});
